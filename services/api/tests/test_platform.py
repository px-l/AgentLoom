import copy
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from agentloom.main import app
from agentloom.db import Session, App, Version, Run, now
from agentloom.seed import seed, presets
from agentloom.config import snapshot
from agentloom.graph import validate_graph, condition
from agentloom.executor import retry_tool, calculator, TransientToolError, citations
from agentloom.worker import claim, process, recover
from agentloom.knowledge import index_document, split_pages, extract

client = TestClient(app)


def setup():
    seed()
    for i in range(3):
        index_document(f"example-doc-{i}", snapshot())


def create(version="example-version-0", input=None, key=None):
    if input is None:
        input = {"question": "人工审批如何恢复？"}
    r = client.post(
        "/api/runs", json={"versionId": version, "input": input}, headers={"Idempotency-Key": key or str(uuid4())}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def execute(owner="test-worker"):
    job = claim(owner)
    assert job
    process(*job, owner)
    return job


def get(id):
    return client.get(f"/api/runs/{id}").json()


def wait_status(id, expected, timeout=15):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        r = get(id)
        if r["status"] in expected:
            return r
        time.sleep(0.1)
    raise AssertionError(get(id))


def worker_process():
    return subprocess.Popen(
        [sys.executable, "-m", "agentloom.worker"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()


def test_graph_validation():
    for _, _, g in presets():
        assert validate_graph(g) == []
    graph = copy.deepcopy(presets()[0][2])
    graph["edges"].append({"id": "cycle", "source": "end", "target": "start"})
    assert any("无环" in e for e in validate_graph(graph))
    graph = copy.deepcopy(presets()[0][2])
    graph["nodes"][2]["data"]["prompt"] = "{{end.text}}"
    assert any("上游" in e for e in validate_graph(graph))
    graph["nodes"][1]["data"]["topK"] = 999
    assert any("topK" in e for e in validate_graph(graph))


def test_idempotency_concurrent_and_conflict():
    setup()
    key = str(uuid4())
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _: create(key=key), range(4)))
    assert len(set(ids)) == 1
    r = client.post(
        "/api/runs",
        json={"versionId": "example-version-0", "input": {"question": "不同输入"}},
        headers={"Idempotency-Key": key},
    )
    assert r.status_code == 409
    assert create() != ids[0]


def test_version_and_configuration_snapshot():
    setup()
    id = create()
    with Session.begin() as s:
        a = s.get(App, "example-app-0")
        g = copy.deepcopy(a.draft)
        g["nodes"][-1]["data"]["template"] = "修改后的草稿"
        a.draft = g
    config = client.get("/api/settings").json()
    config["max_tool_calls"] = 1
    assert client.put("/api/settings", json=config).status_code == 200
    execute()
    r = get(id)
    assert r["status"] == "completed" and r["output"]["text"] != "修改后的草稿"
    assert r["config"]["max_tool_calls"] == 4
    assert all(n["usage"] is None for n in r["nodes"])
    assert r["output"]["citations"]


def test_worker_claim_is_exclusive():
    setup()
    id = create()
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = list(pool.map(claim, ["a", "b", "c", "d"]))
    assert sum(j == ("run", id) for j in jobs) == 1


def test_pause_restart_resume_and_duplicate_approval():
    setup()
    id = create("example-version-1", {"requirement": "设计一个可恢复的人工审批系统"})
    p = worker_process()
    try:
        r = wait_status(id, {"paused"})
    finally:
        stop(p)
    assert not r["output"] and len(r["tools"]) == 1
    approval = r["approvals"][0]
    decision = {"approved": True, "text": "# 经人工修订的评审报告\n\n已确认恢复策略。 [example-doc-0-0]"}
    assert client.post(f"/api/approvals/{approval['id']}/resolve", json=decision).status_code == 200
    assert client.post(f"/api/approvals/{approval['id']}/resolve", json=decision).status_code == 409
    # A fresh Python process creates a fresh LangGraph instance and reloads durable checkpoints.
    p = worker_process()
    try:
        r = wait_status(id, {"completed", "failed"})
    finally:
        stop(p)
    assert r["status"] == "completed", r
    assert r["output"]["text"] == decision["text"]
    assert len(r["tools"]) == 1
    assert r["output"]["citations"][0]["chunkId"] == "example-doc-0-0"


def test_rejection_is_terminal():
    setup()
    id = create("example-version-1", {"requirement": "评审"})
    execute()
    r = get(id)
    a = r["approvals"][0]
    assert client.post(f"/api/approvals/{a['id']}/resolve", json={"approved": False}).status_code == 200
    execute()
    r = get(id)
    assert r["status"] == "failed" and "拒绝" in r["error"]


def test_crash_after_node_commit_recovers_without_duplicate_completion():
    setup()
    id = create()
    code = """
import os
from agentloom.worker import claim,process
from agentloom.executor import Execution
original=Execution.node
def crash(self,node,state):
    result=original(self,node,state)
    if node['type']=='start': os._exit(17)
    return result
Execution.node=crash
process(*claim('crashed-worker'),'crashed-worker')
"""
    p = subprocess.run([sys.executable, "-c", code], capture_output=True)
    assert p.returncode == 17, p.stderr
    with Session.begin() as s:
        run = s.get(Run, id)
        run.lease_until = now() - timedelta(seconds=1)
    execute("replacement")
    r = get(id)
    assert r["status"] == "completed", r
    events = client.get(f"/api/runs/{id}/events").json()
    assert len([e for e in events if e["type"] == "node.completed" and e["nodeId"] == "start"]) == 1
    assert any(e["type"] == "run.recovering" for e in events)


def test_sse_cursor_last_event_id_and_replay():
    setup()
    id = create()
    execute()
    all_events = client.get(f"/api/runs/{id}/events").json()
    cursor = all_events[5]["eventId"]
    replay = client.get(f"/api/runs/{id}/stream?after=1", headers={"Last-Event-ID": str(cursor)})
    assert replay.status_code == 200
    received = [json.loads(line[6:]) for line in replay.text.splitlines() if line.startswith('data: {"runId"')]
    assert [e["eventId"] for e in received] == [e["eventId"] for e in all_events if e["eventId"] > cursor]
    assert "retry: 1500" in replay.text and "event: settled" in replay.text
    assert len({e["eventId"] for e in all_events}) == len(all_events)


def test_cancel_queued_paused_and_cooperative_running():
    setup()
    id = create()
    assert client.post(f"/api/runs/{id}/cancel").json()["status"] == "cancelled"
    id = create()
    job = claim("owner")
    assert job == ("run", id)
    assert client.post(f"/api/runs/{id}/cancel").json()["status"] == "cancelling"
    process(*job, "owner")
    assert get(id)["status"] == "cancelled"
    id = create("example-version-1", {"requirement": "审批"})
    execute()
    assert get(id)["status"] == "paused"
    assert client.post(f"/api/runs/{id}/cancel").json()["status"] == "cancelled"


def test_cancellation_lost_worker_needs_attention():
    setup()
    id = create()
    claim("lost")
    client.post(f"/api/runs/{id}/cancel")
    with Session.begin() as s:
        s.get(Run, id).lease_until = now() - timedelta(seconds=1)
    with Session.begin() as s:
        recover(s)
    assert get(id)["status"] == "needs_attention"


def test_branch_selection_and_merge():
    setup()
    g = {
        "nodes": [
            {"id": "start", "type": "start", "data": {"label": "输入", "fields": ["question"]}},
            {
                "id": "branch",
                "type": "condition",
                "data": {"label": "判断", "ref": "{{input.question}}", "operator": "equals", "value": "yes"},
            },
            {"id": "yes", "type": "llm", "data": {"label": "真分支", "prompt": "{{input.question}}"}},
            {"id": "no", "type": "llm", "data": {"label": "假分支", "prompt": "{{input.question}}"}},
            {"id": "end", "type": "end", "data": {"label": "输出", "template": "{{input.question}}"}},
        ],
        "edges": [
            {"id": "a", "source": "start", "target": "branch"},
            {"id": "b", "source": "branch", "target": "yes", "sourceHandle": "true"},
            {"id": "c", "source": "branch", "target": "no", "sourceHandle": "false"},
            {"id": "d", "source": "yes", "target": "end"},
            {"id": "e", "source": "no", "target": "end"},
        ],
    }
    assert validate_graph(g) == []
    with Session.begin() as s:
        s.add(Version(id="branch-version", app_id="example-app-0", number=2, graph=g))
    for question, expected, skipped in [("yes", "yes", "no"), ("no", "no", "yes")]:
        id = create("branch-version", {"question": question})
        execute()
        r = get(id)
        assert r["status"] == "completed", r
        ids = {n["nodeId"] for n in r["nodes"]}
        assert expected in ids and skipped not in ids
    assert condition({"ref": "{{input.x}}", "operator": "equals", "value": True}, {"input": {"x": "true"}}) is False


def test_tool_retry_boundary_and_no_arbitrary_execution():
    calls = []

    def transient():
        calls.append(1)
        if len(calls) < 3:
            raise TransientToolError()
        return {"value": 8}

    observed = []
    assert retry_tool(transient, sleep=lambda _: None, on_retry=observed.append) == ({"value": 8}, 2)
    assert observed == [1, 2]
    calls = []

    def permanent():
        calls.append(1)
        raise ValueError("bad input")

    with pytest.raises(ValueError):
        retry_tool(permanent, sleep=lambda _: None)
    assert len(calls) == 1
    for expression in ['__import__("os").getcwd()', "2**999999", "[1]*999999999", 'open("/etc/passwd")']:
        with pytest.raises(ValueError):
            calculator(expression)
    assert calculator("(12 * 8) / 3") == {"value": 32.0}


def test_file_chunk_and_citation_association():
    setup()
    content = "人工审批需持久化状态。".encode()
    r = client.post(
        "/api/knowledge/example-knowledge/documents", files={"file": ("../source.md", content, "text/markdown")}
    )
    assert r.status_code == 201
    id = r.json()["id"]
    index_document(id, snapshot())
    chunks = client.get(f"/api/documents/{id}/chunks").json()
    assert chunks[0]["chunkId"] == f"{id}-0" and chunks[0]["ordinal"] == 0
    assert client.get(f"/api/documents/{id}/source").content == content
    assert client.get("/api/knowledge/example-knowledge/documents").json()[-1]["name"] == "source.md"
    hits = client.post("/api/knowledge/example-knowledge/search", json={"query": "人工审批持久化", "k": 10}).json()[
        "hits"
    ]
    linked = citations(f"[{id}-0] [fabricated-source]", hits)
    assert len(linked) == 1 and linked[0]["documentId"] == id
    assert (
        client.post("/api/knowledge/example-knowledge/documents", files={"file": ("test.py", b"bad")}).status_code
        == 415
    )


def test_embedding_signature_excludes_other_models():
    setup()
    config = client.get("/api/settings").json()
    config["embedding_mode"] = "openai"
    assert client.put("/api/settings", json=config).status_code == 200
    # Without a key the real-mode path fails clearly; it never silently falls back to demo.
    r = client.post("/api/knowledge/example-knowledge/search", json={"query": "恢复"})
    assert r.status_code == 422 and "EMBEDDING_API_KEY" in r.text


def test_limits_graph_revision_and_scan_pdf():
    setup()
    a = client.get("/api/apps/example-app-0").json()
    body = {"name": a["name"], "description": a["description"], "graph": a["draft"], "revision": a["revision"] - 1}
    assert client.put("/api/apps/example-app-0", json=body).status_code == 409
    with pytest.raises(ValueError):
        split_pages([(None, "")])
    from io import BytesIO
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=100, height=100)
    b = BytesIO()
    w.write(b)
    with pytest.raises(ValueError, match="OCR"):
        extract("scan.pdf", b.getvalue())


def test_live_executor_advisory_lock_blocks_takeover():
    from agentloom.db import engine
    from sqlalchemy import text

    setup()
    id = create()
    claim("live-worker")
    with Session.begin() as s:
        s.get(Run, id).lease_until = now() - timedelta(seconds=1)
    with engine.connect() as guard:
        guard.execute(text("SELECT pg_advisory_lock(hashtextextended(:id, 0))"), {"id": id})
        try:
            with Session.begin() as s:
                recover(s)
            assert get(id)["status"] == "running"
        finally:
            guard.execute(text("SELECT pg_advisory_unlock(hashtextextended(:id, 0))"), {"id": id})
            guard.commit()
    with Session.begin() as s:
        recover(s)
    assert get(id)["status"] == "queued"


def test_real_openai_protocol_with_injected_transport(monkeypatch):
    """No paid API: verify installed SDK's actual SSE and embeddings request/response protocol."""
    import httpx
    from openai import OpenAI
    import agentloom.executor as executor
    import agentloom.providers as providers

    setup()
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append((request.url.path, body))
        if request.url.path.endswith("/embeddings"):
            assert body["model"] == "text-embedding-3-small" and body["dimensions"] == 1536
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "model": body["model"],
                    "data": [{"object": "embedding", "index": 0, "embedding": [1.0] + [0.0] * 1535}],
                    "usage": {"prompt_tokens": 3, "total_tokens": 3},
                },
            )
        text = "人工审批状态已持久化。 [example-doc-0-0] [invented-source]"
        data = [
            {
                "id": "mock",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "fixture",
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
            },
            {
                "id": "mock",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "fixture",
                "choices": [],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            },
        ]
        content = "".join("data: " + json.dumps(x) + "\n\n" for x in data) + "data: [DONE]\n\n"
        return httpx.Response(200, content=content, headers={"content-type": "text/event-stream"})

    client_mock = OpenAI(
        api_key="test-only",
        base_url="https://fixture.invalid/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(executor, "model_client", lambda _: client_mock)
    monkeypatch.setattr(providers, "OpenAI", lambda **_: client_mock)
    monkeypatch.setattr(providers.settings, "embedding_api_key", "test-only")
    config = client.get("/api/settings").json()
    config["model_mode"] = "openai"
    assert client.put("/api/settings", json=config).status_code == 200
    id = create()
    execute()
    r = get(id)
    assert r["status"] == "completed", r
    assert r["nodes"][2]["usage"]["total_tokens"] == 20
    assert "[invented-source]" not in r["output"]["text"]
    assert len(r["output"]["citations"]) == 1
    conf = snapshot()
    conf["embedding_mode"] = "openai"
    assert len(providers.embed(["测试"], conf)[0]) == 1536
    assert {x[0] for x in requests} == {"/v1/chat/completions", "/v1/embeddings"}


def test_agent_real_tool_loop_protocol_and_budget(monkeypatch):
    import httpx
    from openai import OpenAI
    import agentloom.executor as executor

    setup()
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "calc-1",
                        "type": "function",
                        "function": {"name": "calculator", "arguments": '{"expression":"12*8"}'},
                    }
                ],
            }
        else:
            assert body["messages"][-1]["tool_call_id"] == "calc-1"
            message = {
                "role": "assistant",
                "content": "# 需求摘要\n计算结果 96\n## 待澄清问题\n无\n## 风险\n待核实\n## 验收建议\n人工确认",
            }
        return httpx.Response(
            200,
            json={
                "id": "mock",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture",
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    mock = OpenAI(
        api_key="test-only",
        base_url="https://fixture.invalid/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(executor, "model_client", lambda _: mock)
    with Session.begin() as s:
        v = s.get(Version, "example-version-1")
        g = copy.deepcopy(v.graph)
        g["nodes"][2]["data"]["tools"] = ["calculator"]
        s.add(Version(id="tool-version", app_id=v.app_id, number=2, graph=g))
    config = client.get("/api/settings").json()
    config["model_mode"] = "openai"
    client.put("/api/settings", json=config)
    id = create("tool-version", {"requirement": "测试计算工具"})
    execute()
    r = get(id)
    assert r["status"] == "paused", r
    assert len(r["tools"]) == 1 and r["tools"][0]["result"] == {"value": 96}
    assert next(n for n in r["nodes"] if n["nodeId"] == "analyst")["usage"]["total_tokens"] == 30


def test_unconfigured_real_model_fails_and_persists_node_error():
    setup()
    conf = client.get("/api/settings").json()
    conf["model_mode"] = "openai"
    client.put("/api/settings", json=conf)
    id = create()
    p = worker_process()
    try:
        r = wait_status(id, {"failed"}, timeout=8)
    finally:
        stop(p)
    assert "MODEL_API_KEY" in r["error"]
    assert any(n["status"] == "failed" and n["nodeId"] == "answer" for n in r["nodes"])
    events = client.get(f"/api/runs/{id}/events").json()
    assert any(e["type"] == "node.failed" for e in events)
    assert all(e["type"] != "run.completed" for e in events)


def test_agent_steps_and_usage_survive_transient_retry(monkeypatch):
    import httpx
    from openai import OpenAI
    import agentloom.executor as executor

    setup()
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        if len(requests) > 1:
            return httpx.Response(429, json={"error": {"message": "fixture rate limit", "type": "rate_limit"}})
        return httpx.Response(
            200,
            json={
                "id": "mock",
                "object": "chat.completion",
                "created": 0,
                "model": "fixture",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "c",
                                    "type": "function",
                                    "function": {"name": "calculator", "arguments": '{"expression":"1+1"}'},
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    mock = OpenAI(
        api_key="test-only",
        base_url="https://fixture.invalid/v1",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(executor, "model_client", lambda _: mock)
    with Session.begin() as s:
        v = s.get(Version, "example-version-1")
        g = copy.deepcopy(v.graph)
        g["nodes"][2]["data"].update(tools=["calculator"], maxSteps=2, maxTools=1)
        s.add(Version(id="budget-version", app_id=v.app_id, number=2, graph=g))
    conf = client.get("/api/settings").json()
    conf["model_mode"] = "openai"
    client.put("/api/settings", json=conf)
    id = create("budget-version", {"requirement": "验证预算"})
    execute()
    r = get(id)
    assert r["status"] == "failed" and len(requests) == 2
    assert len(r["tools"]) == 1
    node = next(n for n in r["nodes"] if n["nodeId"] == "analyst")
    assert node["modelSteps"] == 2 and node["usage"]["total_tokens"] == 15 and node["usage"]["unknown_requests"] == 1


def test_condition_reads_typed_structured_json_result():
    state = {"input": {}, "outputs": {"classify": {"text": '{"review":{"required":true,"risk":"high"}}'}}}
    data = {"ref": "{{classify.text}}", "path": "review.required", "operator": "equals", "value": True}
    assert condition(data, state) is True
    data["value"] = "true"
    assert condition(data, state) is False
    data["path"] = "review.missing"
    with pytest.raises(ValueError, match="不存在字段"):
        condition(data, state)
    state["outputs"]["classify"]["text"] = "not json"
    with pytest.raises(ValueError, match="合法 JSON"):
        condition(data, state)
