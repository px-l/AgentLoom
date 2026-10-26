import hashlib
import math
import re
from openai import OpenAI, APIConnectionError, APITimeoutError, RateLimitError, InternalServerError
from .config import settings

TRANSIENT = (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError)


def model_client(config):
    if not settings.model_api_key:
        raise ValueError("真实模型未配置 MODEL_API_KEY，请配置后重启 API 与 worker")
    return OpenAI(api_key=settings.model_api_key, base_url=config["model_base_url"], timeout=25, max_retries=0)


def demo_vector(text, dimensions=256):
    # Deterministic character bigrams: intentionally a lexical demonstration, not a semantic model.
    text = re.sub(r"\s+", "", text.lower())
    vector = [0.0] * dimensions
    for token in list(text) + [text[i : i + 2] for i in range(len(text) - 1)]:
        h = int.from_bytes(hashlib.sha256(token.encode()).digest()[:4], "big")
        vector[h % dimensions] += 1
    norm = math.sqrt(sum(v * v for v in vector)) or 1
    return [v / norm for v in vector]


def embedding_signature(config):
    if config["embedding_mode"] == "demo":
        return "demo-bigram-v1:256"
    return f"openai:{config['embedding_base_url']}:{config['embedding_model']}:{config['embedding_dimensions']}"


def embed(texts, config):
    if config["embedding_mode"] == "demo":
        return [demo_vector(t) for t in texts]
    if not settings.embedding_api_key:
        raise ValueError("真实 Embedding 未配置 EMBEDDING_API_KEY")
    client = OpenAI(
        api_key=settings.embedding_api_key, base_url=config["embedding_base_url"], timeout=25, max_retries=0
    )
    result = client.embeddings.create(
        model=config["embedding_model"], input=texts, dimensions=config["embedding_dimensions"]
    )
    if sorted(x.index for x in result.data) != list(range(len(texts))):
        raise ValueError("Embedding 返回条目数量或索引不完整")
    vectors = [x.embedding for x in sorted(result.data, key=lambda x: x.index)]
    if any(len(v) != config["embedding_dimensions"] for v in vectors):
        raise ValueError("Embedding 维度与配置不一致")
    if any(not all(math.isfinite(x) for x in v) or not any(v) for v in vectors):
        raise ValueError("Embedding 包含无效向量")
    return vectors


def demo_answer(prompt, hits, report=False):
    sources = "\n".join(f"- {h['text'][:220]} [{h['chunkId']}]" for h in hits)
    if report:
        return (
            "# 需求评审报告（演示模型）\n\n## 需求摘要\n"
            + prompt[:700]
            + "\n\n## 待澄清问题\n- 谁拥有审批权限？失败后的恢复目标是什么？\n\n## 风险\n- 外部操作存在超时与重复执行风险。\n\n## 验收建议\n- 验证断线补拉、重启恢复及重复审批。\n\n## 参考资料\n"
            + (sources or "当前没有可用的检索来源，请补充知识资料。")
        )
    return "# 回答（演示模型）\n\n" + (
        "根据本次检索的原文摘录：\n" + sources if hits else "未检索到可用资料，无法提供来源支持的回答。"
    )
