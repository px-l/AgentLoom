import json
import re
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict

KINDS = {"start", "llm", "retrieval", "agent", "condition", "approval", "end"}
REF = re.compile(r"{{\s*([\w-]+)\.([\w]+)\s*}}")


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
    type: Literal["start", "llm", "retrieval", "agent", "condition", "approval", "end"]
    position: dict[str, float] = Field(default_factory=lambda: {"x": 0, "y": 0})
    data: dict


class Edge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    source: str
    target: str
    sourceHandle: str | None = None


class Graph(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nodes: list[Node] = Field(min_length=2, max_length=500)
    edges: list[Edge] = Field(max_length=2000)


OUTPUTS = {
    "start": {"text"},
    "llm": {"text", "citations"},
    "retrieval": {"text", "hits"},
    "agent": {"text", "citations"},
    "condition": {"value"},
    "approval": {"text", "approved"},
    "end": {"text", "citations"},
}


def _validate_graph(raw):
    try:
        g = Graph.model_validate(raw)
    except Exception as e:
        return [str(e)]
    errors = []
    nodes = {n.id: n for n in g.nodes}
    if len(nodes) != len(g.nodes):
        errors.append("节点 ID 重复")
    if any(n.id in {"router", "input", "__start__", "__end__"} for n in g.nodes):
        errors.append("节点使用保留 ID")
    starts = [n.id for n in g.nodes if n.type == "start"]
    ends = [n.id for n in g.nodes if n.type == "end"]
    if len(starts) != 1 or len(ends) != 1:
        errors.append("需要且只能有一个 Start 和 End")
    if len({e.id for e in g.edges}) != len(g.edges):
        errors.append("连线 ID 重复")
    pairs = [(e.source, e.target, e.sourceHandle) for e in g.edges]
    if len(set(pairs)) != len(pairs):
        errors.append("连线重复")
    incoming = {n: [] for n in nodes}
    outgoing = {n: [] for n in nodes}
    for e in g.edges:
        if e.source not in nodes or e.target not in nodes:
            errors.append("连线引用不存在的节点")
            continue
        incoming[e.target].append(e)
        outgoing[e.source].append(e)
        if nodes[e.source].type != "condition" and e.sourceHandle:
            errors.append("只有 Condition 支持分支端口")
    order = []
    degree = {n: len(incoming[n]) for n in nodes}
    ready = [n for n in nodes if degree[n] == 0]
    while ready:
        n = ready.pop(0)
        order.append(n)
        for e in outgoing[n]:
            degree[e.target] -= 1
            if degree[e.target] == 0:
                ready.append(e.target)
    if len(order) != len(nodes):
        errors.append("工作流必须为有向无环图")
    ancestors = {}
    for n in order:
        ancestors[n] = set()
        for e in incoming[n]:
            ancestors[n] |= {e.source} | ancestors.get(e.source, set())
    fields = nodes[starts[0]].data.get("fields", []) if starts else []
    for n in g.nodes:
        d = n.data
        if not str(d.get("label", "")).strip():
            errors.append(f"{n.id}: 节点名称必填")
        if n.type == "start":
            if incoming[n.id]:
                errors.append("Start 不可有输入连线")
            if (
                not isinstance(fields, list)
                or not fields
                or any(not isinstance(f, str) or not re.fullmatch(r"[a-zA-Z]\w*", f) for f in fields)
                or len(set(fields)) != len(fields)
            ):
                errors.append("输入字段需为不重复的英文标识符列表")
        elif not incoming[n.id]:
            errors.append(f"{n.id}: 节点没有输入连线")
        if n.type == "end":
            if outgoing[n.id]:
                errors.append("End 不可有输出连线")
        elif not outgoing[n.id]:
            errors.append(f"{n.id}: 节点没有输出连线")
        if starts and n.id != starts[0] and starts[0] not in ancestors.get(n.id, set()):
            errors.append(f"{n.id}: 无法从 Start 到达")
        if ends and n.id != ends[0] and n.id not in ancestors.get(ends[0], set()):
            errors.append(f"{n.id}: 无法到达 End")
        required = {
            "llm": ["prompt"],
            "agent": ["prompt"],
            "retrieval": ["query", "kbId"],
            "condition": ["ref"],
            "approval": ["text"],
            "end": ["template"],
        }.get(n.type, [])
        for key in required:
            if not isinstance(d.get(key), str) or not d[key].strip():
                errors.append(f"{n.id}: {key} 必填")
        if n.type == "condition":
            if d.get("path") and (
                not isinstance(d["path"], str) or not re.fullmatch(r"[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*", d["path"])
            ):
                errors.append(f"{n.id}: JSON 字段路径无效")
            if sorted(e.sourceHandle or "" for e in outgoing[n.id]) != ["false", "true"]:
                errors.append(f"{n.id}: 需要 true / false 各一条分支")
            if d.get("operator") not in {"equals", "contains", "truthy"}:
                errors.append(f"{n.id}: 不支持的条件操作符")
            if d.get("operator") == "equals" and "value" not in d:
                errors.append(f"{n.id}: equals 缺少 value")
        if n.type == "retrieval" and (type(d.get("topK", 3)) is not int or not 1 <= d.get("topK", 3) <= 10):
            errors.append(f"{n.id}: topK 范围为 1–10")
        if n.type == "agent":
            if not isinstance(d.get("tools", []), list) or not set(d.get("tools", [])) <= {
                "calculator",
                "knowledge_search",
            }:
                errors.append(f"{n.id}: 工具不在白名单")
            for key, cap in [("maxSteps", 12), ("maxTools", 10)]:
                if type(d.get(key, 4)) is not int or not 1 <= d.get(key, 4) <= cap:
                    errors.append(f"{n.id}: {key} 超出范围")
        for key, value in d.items():
            if not isinstance(value, str) or key == "label":
                continue
            if "{{" in REF.sub("", value) or "}}" in REF.sub("", value):
                errors.append(f"{n.id}: 无效变量语法")
            for source, field in REF.findall(value):
                if source == "input":
                    if field not in fields:
                        errors.append(f"{n.id}: 未声明输入 {field}")
                elif source not in ancestors.get(n.id, set()) or field not in (
                    set(fields) if nodes[source].type == "start" else OUTPUTS.get(nodes[source].type, set())
                ):
                    errors.append(f"{n.id}: 变量 {source}.{field} 必须引用上游有效输出")
    return list(dict.fromkeys(errors))


def topo(raw):
    nodes = {n["id"]: n for n in raw["nodes"]}
    order = []
    while len(order) < len(nodes):
        ready = [
            n for n in nodes if n not in order and all(e["source"] in order for e in raw["edges"] if e["target"] == n)
        ]
        if not ready:
            raise ValueError("图包含环")
        order.extend(ready)
    return order


def render(template, state):
    def replace(m):
        source, field = m.groups()
        value = (
            state.get("input", {}).get(field)
            if source == "input"
            else state.get("outputs", {}).get(source, {}).get(field)
        )
        if value is None:
            raise ValueError(f"变量 {source}.{field} 不可用（可能引用了未执行分支）")
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

    return REF.sub(replace, template)


def condition(data, state):
    ref = data["ref"]
    match = REF.fullmatch(ref.strip())
    if match:
        source, field = match.groups()
        value = state["input"].get(field) if source == "input" else state["outputs"].get(source, {}).get(field)
    else:
        value = render(ref, state)
    if data.get("path"):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                raise ValueError("Condition 需要合法 JSON 结构化结果")
        for key in data["path"].split("."):
            if not isinstance(value, dict) or key not in value:
                raise ValueError(f"结构化结果不存在字段 {data['path']}")
            value = value[key]
    if data["operator"] == "equals":
        return value == data.get("value")
    if data["operator"] == "contains":
        return str(data.get("value", "")) in str(value)
    return bool(value)


def validate_graph(raw):
    try:
        return _validate_graph(raw)
    except (TypeError, KeyError, ValueError, AttributeError):
        return ["节点参数类型无效，请检查字段、工具和模板配置"]
