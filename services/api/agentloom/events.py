from sqlalchemy import select
from .db import Session, Run, Event


def emit(run_id, kind, data=None, node_id=None, key=None, session=None):
    def write(s):
        run = s.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if key:
            old = s.scalar(select(Event).where(Event.run_id == run_id, Event.dedupe_key == key))
            if old:
                return old
        run.event_seq += 1
        event = Event(
            run_id=run_id, event_id=run.event_seq, type=kind, node_id=node_id, data=data or {}, dedupe_key=key
        )
        s.add(event)
        s.flush()
        return event

    if session is not None:
        return write(session)
    with Session.begin() as s:
        return write(s)


def event_json(e):
    return {
        "runId": e.run_id,
        "eventId": e.event_id,
        "nodeId": e.node_id,
        "time": e.time.isoformat(),
        "type": e.type,
        "data": e.data,
    }
