from .db import Session, App, Version, KnowledgeBase, Document
from .executor import checkpointer

KB_ID = "example-knowledge"
TEXTS = [
    (
        "恢复与审批.md",
        "智织运行在独立 worker 中执行。人工审批使用持久化检查点暂停，审批时释放执行资源。重启 worker 后可恢复原任务。审批记录只允许处理一次，重复审批返回冲突。",
    ),
    (
        "事件与幂等.md",
        "智织事件先写入 PostgreSQL，再通过 SSE 推送。浏览器使用事件游标补拉历史并按事件 ID 去重。一次提交的网络重试必须复用幂等键，新执行使用新键。检查点无法保证外部副作用 exactly-once。",
    ),
    (
        "知识库指南.md",
        "知识库支持 UTF-8 TXT、Markdown 与可提取文本的 PDF。扫描 PDF 暂不支持 OCR。分块保留文件、页码、段落序号、分块 ID 与索引版本。切换 Embedding 模型后必须重新索引。Recall@k 是相关分块被前 k 个检索结果覆盖的比例，不等于最终回答质量。",
    ),
]


def presets():
    def node(id, type, x, **data):
        return {"id": id, "type": type, "position": {"x": x, "y": 160}, "data": data}

    def chain(nodes):
        return {
            "nodes": nodes,
            "edges": [
                {"id": f"e{i}", "source": a["id"], "target": b["id"]} for i, (a, b) in enumerate(zip(nodes, nodes[1:]))
            ],
        }

    qa = chain(
        [
            node("start", "start", 0, label="提问", fields=["question"]),
            node("retrieve", "retrieval", 260, label="检索参考资料", kbId=KB_ID, query="{{input.question}}", topK=3),
            node(
                "answer",
                "llm",
                520,
                label="生成来源回答",
                prompt="回答问题：{{input.question}}\n参考：{{retrieve.text}}",
            ),
            node("end", "end", 780, label="输出回答", template="{{answer.text}}"),
        ]
    )
    review = chain(
        [
            node("start", "start", 0, label="输入需求", fields=["requirement"]),
            node("retrieve", "retrieval", 250, label="检索参考", kbId=KB_ID, query="{{input.requirement}}", topK=3),
            node(
                "analyst",
                "agent",
                500,
                label="Agent 评审",
                prompt="评审以下需求：{{input.requirement}}",
                tools=["knowledge_search", "calculator"],
                kbId=KB_ID,
                maxSteps=4,
                maxTools=3,
            ),
            node("approval", "approval", 750, label="人工确认与修改", text="{{analyst.text}}"),
            node("end", "end", 1000, label="输出评审报告", template="{{approval.text}}"),
        ]
    )
    return [
        ("知识问答", "检索真实分块，生成带来源的回答", qa),
        ("需求评审", "Agent 分析 → 持久化审批 → Markdown 报告", review),
    ]


def seed():
    with checkpointer() as saver:
        saver.setup()
    with Session.begin() as s:
        if not s.get(KnowledgeBase, KB_ID):
            s.add(KnowledgeBase(id=KB_ID, name="智织示例资料"))
            s.flush()
        for i, (name, text) in enumerate(TEXTS):
            if not s.get(Document, f"example-doc-{i}"):
                s.add(Document(id=f"example-doc-{i}", kb_id=KB_ID, name=name, content=text.encode()))
        for i, (name, description, graph) in enumerate(presets()):
            if not s.get(App, f"example-app-{i}"):
                a = App(id=f"example-app-{i}", name=name, description=description, draft=graph)
                s.add(a)
                s.flush()
                s.add(Version(id=f"example-version-{i}", app_id=a.id, number=1, graph=graph))
    print("Seed ready. Run worker to index sample documents.")


if __name__ == "__main__":
    seed()
