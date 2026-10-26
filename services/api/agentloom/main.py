import asyncio
import hashlib
import json
import time
from typing import Literal
from urllib.parse import urlparse, quote
from fastapi import FastAPI, HTTPException, UploadFile, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from .db import (
    Session,
    App,
    Version,
    Run,
    NodeRecord,
    Approval,
    ToolCall,
    KnowledgeBase,
    Document,
    Chunk,
    Event,
    PlatformSetting,
    now,
)
from .events import emit, event_json
from .config import snapshot, settings
from .graph import validate_graph
from .knowledge import search
from .providers import model_client, embed, embedding_signature
from .executor import public_error

app = FastAPI(title="AgentLoom 智织", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
TERMINAL = {"completed", "failed", "cancelled", "needs_attention"}


def require(s, cls, id):
    obj = s.get(cls, id)
    if obj is None:
        raise HTTPException(404, "记录不存在")
    return obj


def app_json(s, a):
    versions = s.scalars(select(Version).where(Version.app_id == a.id).order_by(Version.number.desc())).all()
    return {
        "id": a.id,
        "name": a.name,
        "description": a.description,
        "draft": a.draft,
        "revision": a.revision,
        "createdAt": a.created_at.isoformat(),
        "versions": [{"id": v.id, "number": v.number, "createdAt": v.created_at.isoformat()} for v in versions],
    }


@app.get("/api/health")
def health():
    with Session() as s:
        s.execute(select(1))
    return {"status": "ok"}


@app.get("/api/apps")
def apps():
    with Session() as s:
        return [app_json(s, a) for a in s.scalars(select(App).order_by(App.created_at))]


class AppBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    graph: dict
    revision: int | None = None


@app.post("/api/apps", status_code=201)
def create_app(body: AppBody):
    with Session.begin() as s:
        a = App(name=body.name, description=body.description, draft=body.graph)
        s.add(a)
        s.flush()
        return app_json(s, a)


@app.get("/api/apps/{id}")
def get_app(id: str):
    with Session() as s:
        return app_json(s, require(s, App, id))


@app.put("/api/apps/{id}")
def save_app(id: str, body: AppBody):
    with Session.begin() as s:
        a = s.scalar(select(App).where(App.id == id).with_for_update())
        if not a:
            raise HTTPException(404, "应用不存在")
        if body.revision != a.revision:
            raise HTTPException(409, "草稿已更新，请刷新后重试")
        a.name = body.name
        a.description = body.description
        a.draft = body.graph
        a.revision += 1
        return app_json(s, a)


@app.post("/api/apps/{id}/duplicate", status_code=201)
def duplicate(id: str):
    with Session.begin() as s:
        old = require(s, App, id)
        a = App(name=old.name + " 副本", description=old.description, draft=old.draft)
        s.add(a)
        s.flush()
        return app_json(s, a)


@app.post("/api/validate")
def validate(body: dict):
    return {"errors": validate_graph(body)}


class PublishBody(BaseModel):
    revision: int


@app.post("/api/apps/{id}/publish", status_code=201)
def publish(id: str, body: PublishBody):
    with Session.begin() as s:
        a = s.scalar(select(App).where(App.id == id).with_for_update())
        if not a:
            raise HTTPException(404, "应用不存在")
        if a.revision != body.revision:
            raise HTTPException(409, "发布草稿版本冲突")
        errors = validate_graph(a.draft)
        if errors:
            raise HTTPException(422, errors)
        number = (s.scalar(select(func.max(Version.number)).where(Version.app_id == id)) or 0) + 1
        v = Version(app_id=id, number=number, graph=a.draft)
        s.add(v)
        s.flush()
        return {"id": v.id, "number": v.number}


@app.get("/api/versions/{id}")
def version(id: str):
    with Session() as s:
        v = require(s, Version, id)
        return {"id": v.id, "number": v.number, "graph": v.graph, "appId": v.app_id}


class RunBody(BaseModel):
    versionId: str
    input: dict[str, str] = Field(max_length=30)


@app.post("/api/runs", status_code=201)
def create_run(body: RunBody, idempotency_key: str = Header(min_length=8, max_length=128)):
    digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def existing(s):
        old = s.scalar(select(Run).where(Run.idempotency_key == idempotency_key))
        if old:
            if old.request_hash != digest:
                raise HTTPException(409, "幂等键已用于不同的执行输入")
            return {"id": old.id, "status": old.status, "reused": True}

    config = snapshot()
    try:
        with Session.begin() as s:
            old = existing(s)
            if old:
                return old
            v = require(s, Version, body.versionId)
            fields = next(n["data"]["fields"] for n in v.graph["nodes"] if n["type"] == "start")
            if set(fields) != set(body.input) or any(not x.strip() or len(x) > 20000 for x in body.input.values()):
                raise HTTPException(422, "输入必须包含 Start 声明的字段，且为非空文本（每字段最多 20000 字符）")
            r = Run(
                version_id=v.id, idempotency_key=idempotency_key, request_hash=digest, input=body.input, config=config
            )
            s.add(r)
            s.flush()
            return {"id": r.id, "status": r.status, "reused": False}
    except IntegrityError:
        with Session() as s:
            old = existing(s)
            if old:
                return old
        raise


def run_json(s, r, detail=False):
    v = s.get(Version, r.version_id)
    data = {
        "id": r.id,
        "versionId": r.version_id,
        "appId": v.app_id,
        "version": v.number,
        "status": r.status,
        "input": r.input,
        "output": r.output,
        "error": r.error,
        "config": r.config,
        "createdAt": r.created_at.isoformat(),
        "eventCursor": r.event_seq,
    }
    if detail:
        data["nodes"] = [
            {
                "nodeId": n.node_id,
                "status": n.status,
                "input": n.input,
                "output": n.output,
                "elapsedMs": n.elapsed_ms,
                "retries": n.retries,
                "usage": n.usage,
                "modelSteps": n.model_steps,
            }
            for n in s.scalars(select(NodeRecord).where(NodeRecord.run_id == r.id))
        ]
        data["approvals"] = [
            {"id": a.id, "nodeId": a.node_id, "status": a.status, "proposed": a.proposed, "decision": a.decision}
            for a in s.scalars(select(Approval).where(Approval.run_id == r.id))
        ]
        data["tools"] = [
            {
                "id": t.id,
                "nodeId": t.node_id,
                "name": t.name,
                "arguments": t.arguments,
                "argsHash": t.args_hash,
                "status": t.status,
                "result": t.result,
                "retries": t.retries,
            }
            for t in s.scalars(select(ToolCall).where(ToolCall.run_id == r.id))
        ]
    return data


@app.get("/api/runs")
def runs():
    with Session() as s:
        return [run_json(s, r) for r in s.scalars(select(Run).order_by(Run.created_at.desc()).limit(100))]


@app.get("/api/runs/{id}")
def get_run(id: str):
    with Session() as s:
        return run_json(s, require(s, Run, id), True)


@app.post("/api/runs/{id}/cancel")
def cancel(id: str):
    with Session.begin() as s:
        r = s.scalar(select(Run).where(Run.id == id).with_for_update())
        if not r:
            raise HTTPException(404, "执行不存在")
        if r.status in TERMINAL:
            raise HTTPException(409, "执行已结束")
        if r.status in {"queued", "paused"}:
            r.status = "cancelled"
            r.finished_at = now()
            emit(id, "run.cancelled", {"reason": "取消未执行或已暂停的任务"}, key="terminal", session=s)
        else:
            r.status = "cancelling"
            emit(id, "run.cancellation_requested", key="cancel-request", session=s)
        return {"status": r.status}


class Decision(BaseModel):
    approved: bool
    text: str | None = Field(default=None, max_length=100000)


@app.post("/api/approvals/{id}/resolve")
def resolve(id: str, body: Decision):
    with Session.begin() as s:
        # Lock run before approval everywhere to keep a consistent lock order.
        a = require(s, Approval, id)
        r = s.scalar(select(Run).where(Run.id == a.run_id).with_for_update())
        a = s.scalar(select(Approval).where(Approval.id == id).with_for_update())
        if a.status != "pending":
            raise HTTPException(409, "此审批已处理，不可重复提交")
        if r.status != "paused":
            raise HTTPException(409, "执行尚未持久化暂停或已结束，请刷新后重试")
        a.status = "resolved"
        a.decision = body.model_dump()
        r.status = "queued"
        emit(r.id, "approval.resolved", {"approvalId": id, "approved": body.approved}, a.node_id, f"{id}:resolved", s)
        return {"runId": r.id, "status": r.status}


@app.get("/api/runs/{id}/events")
def events(id: str, after: int = 0):
    with Session() as s:
        require(s, Run, id)
        return [
            event_json(e)
            for e in s.scalars(
                select(Event).where(Event.run_id == id, Event.event_id > after).order_by(Event.event_id).limit(1000)
            )
        ]


@app.get("/api/runs/{id}/stream")
async def stream(id: str, request: Request, after: int = 0, last_event_id: str | None = Header(default=None)):
    with Session() as s:
        require(s, Run, id)
    if last_event_id:
        try:
            after = max(after, int(last_event_id))
        except ValueError:
            raise HTTPException(400, "无效事件游标")

    def read(cursor):
        with Session() as s:
            r = s.get(Run, id)
            batch = [
                event_json(e)
                for e in s.scalars(
                    select(Event).where(Event.run_id == id, Event.event_id > cursor).order_by(Event.event_id).limit(200)
                )
            ]
            return batch, r.status, r.event_seq

    async def generate():
        cursor = after
        last_ping = 0
        yield "retry: 1500\n\n"
        while not await request.is_disconnected():
            batch, status, seq = await asyncio.to_thread(read, cursor)
            for e in batch:
                cursor = e["eventId"]
                yield f"id: {cursor}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
            if status in TERMINAL and cursor >= seq:
                yield f"event: settled\ndata: {json.dumps({'status': status})}\n\n"
                break
            if time.monotonic() - last_ping > 10:
                yield ": heartbeat\n\n"
                last_ping = time.monotonic()
            await asyncio.sleep(0.4)

    return StreamingResponse(
        generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.get("/api/runs/{id}/report", response_class=PlainTextResponse)
def report(id: str):
    with Session() as s:
        r = require(s, Run, id)
        if not r.output:
            raise HTTPException(409, "报告尚未生成")
        return PlainTextResponse(
            r.output.get("text", ""), headers={"Content-Disposition": f'attachment; filename="agentloom-{id}.md"'}
        )


class NameBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@app.get("/api/knowledge")
def knowledge_bases():
    with Session() as s:
        return [{"id": k.id, "name": k.name} for k in s.scalars(select(KnowledgeBase))]


@app.post("/api/knowledge", status_code=201)
def create_kb(body: NameBody):
    with Session.begin() as s:
        k = KnowledgeBase(name=body.name)
        s.add(k)
        s.flush()
        return {"id": k.id, "name": k.name}


@app.get("/api/knowledge/{id}/documents")
def documents(id: str):
    with Session() as s:
        require(s, KnowledgeBase, id)
        return [
            {
                "id": d.id,
                "name": d.name,
                "status": d.status,
                "error": d.error,
                "indexVersion": d.index_version,
                "chunks": s.scalar(select(func.count()).select_from(Chunk).where(Chunk.document_id == d.id)),
            }
            for d in s.scalars(select(Document).where(Document.kb_id == id))
        ]


@app.post("/api/knowledge/{id}/documents", status_code=201)
def upload(id: str, file: UploadFile):
    name = (file.filename or "unnamed").replace("\\", "/").split("/")[-1]
    if not name.lower().endswith((".md", ".markdown", ".txt", ".pdf")):
        raise HTTPException(415, "仅支持 TXT、Markdown 与可提取文本的 PDF，暂不支持 OCR")
    content = file.file.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "文件不能超过 10 MiB")
    with Session.begin() as s:
        require(s, KnowledgeBase, id)
        d = Document(kb_id=id, name=name, content=content)
        s.add(d)
        s.flush()
        return {"id": d.id, "status": d.status}


@app.post("/api/documents/{id}/reindex")
def reindex(id: str):
    with Session.begin() as s:
        d = s.scalar(select(Document).where(Document.id == id).with_for_update())
        if not d:
            raise HTTPException(404, "文件不存在")
        if d.status in {"queued", "indexing"}:
            raise HTTPException(409, "正在索引")
        d.status = "queued"
        d.error = None
        return {"status": d.status}


@app.get("/api/documents/{id}/source")
def source(id: str):
    from fastapi.responses import Response

    with Session() as s:
        d = require(s, Document, id)
        return Response(
            d.content,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(d.name)}"},
        )


@app.get("/api/documents/{id}/chunks")
def chunks(id: str):
    with Session() as s:
        require(s, Document, id)
        return [
            {"chunkId": c.id, "text": c.text, "page": c.page, "ordinal": c.ordinal, "indexVersion": c.index_version}
            for c in s.scalars(select(Chunk).where(Chunk.document_id == id).order_by(Chunk.ordinal))
        ]


class SearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    k: int = Field(default=3, ge=1, le=10)


@app.post("/api/knowledge/{id}/search")
def retrieval_test(id: str, body: SearchBody):
    with Session() as s:
        require(s, KnowledgeBase, id)
    try:
        return {"hits": search(id, body.query, body.k, snapshot())}
    except Exception as e:
        raise HTTPException(422, public_error(e))


class RuntimeConfig(BaseModel):
    model_mode: Literal["demo", "openai"]
    model_base_url: str
    model_name: str = Field(min_length=1, max_length=120)
    embedding_mode: Literal["demo", "openai"]
    embedding_base_url: str
    embedding_model: str = Field(min_length=1, max_length=120)
    embedding_dimensions: int = Field(ge=1, le=3072)
    max_run_seconds: int = Field(ge=10, le=1800)
    max_agent_steps: int = Field(ge=1, le=12)
    max_tool_calls: int = Field(ge=1, le=10)
    max_model_tokens: int = Field(ge=64, le=16000)

    @field_validator("model_base_url", "embedding_base_url")
    @classmethod
    def url(cls, v):
        p = urlparse(v)
        if p.scheme not in {"https", "http"} or not p.hostname or p.username or p.password or p.query:
            raise ValueError("接口 URL 必须是无凭据的 HTTP(S) 地址")
        return v.rstrip("/")


@app.get("/api/settings")
def get_settings():
    return {
        **snapshot(),
        "model_key_configured": bool(settings.model_api_key),
        "embedding_key_configured": bool(settings.embedding_api_key),
    }


@app.put("/api/settings")
def put_settings(body: RuntimeConfig):
    with Session.begin() as s:
        row = s.get(PlatformSetting, "runtime")
        if not row:
            s.add(PlatformSetting(id="runtime", value=body.model_dump()))
        else:
            row.value = body.model_dump()
    return get_settings()


@app.post("/api/settings/test/{kind}")
def connection_test(kind: Literal["model", "embedding"]):
    c = snapshot()
    try:
        if kind == "embedding":
            v = embed(["AgentLoom 连接测试"], c)
            return {
                "ok": True,
                "mode": c["embedding_mode"],
                "dimensions": len(v[0]),
                "indexVersion": embedding_signature(c),
            }
        if c["model_mode"] == "demo":
            return {"ok": True, "mode": "demo", "message": "确定性演示模型可用；未连接真实模型"}
        r = model_client(c).chat.completions.create(
            model=c["model_name"], messages=[{"role": "user", "content": "Reply OK"}], max_completion_tokens=64
        )
        return {
            "ok": True,
            "mode": "openai",
            "message": r.choices[0].message.content,
            "usage": r.usage.model_dump() if r.usage else None,
        }
    except Exception as e:
        raise HTTPException(422, public_error(e))
