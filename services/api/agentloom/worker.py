import logging
import signal
import threading
from datetime import timedelta
from sqlalchemy import select, text
from .db import Session, Run, Document, now, uid, engine
from .events import emit
from .config import settings, snapshot
from .executor import Execution, checkpointer, Cancelled, LeaseLost, public_error
from .knowledge import index_document

log = logging.getLogger("agentloom.worker")
STOP = threading.Event()


def recover(s):
    expired = s.scalars(
        select(Run)
        .where(Run.status.in_(["running", "cancelling"]), Run.lease_until < now())
        .with_for_update(skip_locked=True)
    ).all()
    for r in expired:
        # Fence the whole LangGraph invocation, including checkpoint writes. A live connection
        # holding this lock cannot be concurrently recovered just because its heartbeat was late.
        if not s.scalar(text("SELECT pg_try_advisory_xact_lock(hashtextextended(:id, 0))"), {"id": r.id}):
            continue
        r.owner = None
        r.lease_until = None
        r.recoveries += 1
        if r.status == "cancelling":
            r.status = "needs_attention"
            r.finished_at = now()
            r.error = "取消时 worker 失联，无法确认外部调用已经结束，请人工检查"
            emit(r.id, "run.failed", {"error": r.error}, key="terminal", session=s)
        elif r.recoveries > 3:
            r.status = "needs_attention"
            r.error = "异常中断超过三次，需要人工检查后重新执行"
            emit(r.id, "run.failed", {"error": r.error}, key="terminal", session=s)
        else:
            r.status = "queued"
            emit(r.id, "run.recovering", {"recovery": r.recoveries}, session=s)
    docs = s.scalars(
        select(Document)
        .where(Document.status == "indexing", Document.lease_until < now())
        .with_for_update(skip_locked=True)
    ).all()
    for d in docs:
        d.status = "queued"
        d.owner = None


def claim(owner):
    with Session.begin() as s:
        recover(s)
        r = s.scalar(
            select(Run)
            .where(Run.status == "queued")
            .order_by(Run.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if r:
            r.status = "running"
            r.owner = owner
            r.lease_until = now() + timedelta(seconds=settings.lease_seconds)
            if not r.started_at:
                r.started_at = now()
            emit(
                r.id,
                "run.started",
                {"mode": r.config["model_mode"], "recovery": r.recoveries},
                key="started",
                session=s,
            )
            return ("run", r.id)
        d = s.scalar(select(Document).where(Document.status == "queued").with_for_update(skip_locked=True).limit(1))
        if d:
            d.status = "indexing"
            d.owner = owner
            d.lease_until = now() + timedelta(seconds=settings.lease_seconds)
            return ("document", d.id)


def heartbeat(kind, entity_id, owner, stop):
    while not stop.wait(3):
        try:
            with Session.begin() as s:
                cls = Run if kind == "run" else Document
                row = s.scalar(select(cls).where(cls.id == entity_id).with_for_update())
                if not row or row.owner != owner:
                    return
                row.lease_until = now() + timedelta(seconds=settings.lease_seconds)
        except Exception:
            log.warning("Heartbeat database unavailable")


def _process(kind, entity_id, owner):
    stop = threading.Event()
    thread = threading.Thread(target=heartbeat, args=(kind, entity_id, owner, stop), daemon=True)
    thread.start()
    try:
        if kind == "document":
            try:
                index_document(entity_id, snapshot(), owner)
            except Exception as e:
                with Session.begin() as s:
                    d = s.get(Document, entity_id)
                    if d.owner == owner:
                        d.status = "failed"
                        d.error = public_error(e)
                        d.owner = None
                        d.lease_until = None
            return
        try:
            status, output = Execution(entity_id, owner).run()
            error = None
        except LeaseLost:
            return
        except Cancelled as e:
            status, output, error = "cancelled", None, str(e)
        except Exception as e:
            status, output, error = "failed", None, public_error(e)
        with Session.begin() as s:
            r = s.scalar(select(Run).where(Run.id == entity_id).with_for_update())
            if r.owner != owner:
                return
            # Cancellation requested after final node but before commit still wins only here, once execution has ended.
            if r.status == "cancelling":
                status, output = "cancelled", None
            r.status = status
            r.output = output
            r.error = error
            r.owner = None
            r.lease_until = None
            if status != "paused":
                r.finished_at = now()
                emit(r.id, f"run.{status}", {"output": output, "error": error}, key="terminal", session=s)
    finally:
        stop.set()
        thread.join(timeout=4)


def process(kind, entity_id, owner):
    if kind == "document":
        return _process(kind, entity_id, owner)
    with engine.connect() as guard:
        acquired = guard.scalar(text("SELECT pg_try_advisory_lock(hashtextextended(:id, 0))"), {"id": entity_id})
        if not acquired:
            return
        try:
            with Session() as s:
                if s.get(Run, entity_id).owner != owner:
                    return
            return _process(kind, entity_id, owner)
        finally:
            guard.execute(text("SELECT pg_advisory_unlock(hashtextextended(:id, 0))"), {"id": entity_id})
            guard.commit()


def main():
    logging.basicConfig(level=logging.INFO)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    with checkpointer() as saver:
        saver.setup()
    owner = uid()
    log.info("Worker ready: %s", owner)
    while not STOP.is_set():
        try:
            job = claim(owner)
            if job:
                process(*job, owner)
            else:
                STOP.wait(0.5)
        except Exception as e:
            log.error("Worker poll failed: %s", type(e).__name__)
            STOP.wait(2)


if __name__ == "__main__":
    main()
