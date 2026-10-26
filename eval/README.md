# 小型知识检索评测

`questions.json` 是人工标注的 8 个问题与相关 chunkId，语料来自 seed.py 的 3 份简短文档，每份恰好 1 个分块。标注定义为“该块直接含有回答问题需要的规则”。

```bash
# 示例文件已完成索引；从 services/api 运行以读取根目录 .env
uv run --frozen python ../../scripts/evaluate.py --k 1 3
```

脚本查询真实 PostgreSQL/pgvector，与运行时共用 search 函数，写入 `results.json` 的逐题返回 ID、标注和分数。

定义每题 `Recall@k = |top_k_ids ∩ relevant_ids| / |relevant_ids|`，报告各题的宏平均（Macro Recall）。没有相关标注的题目不进入此集合；当前每题恰好一个相关块。

本次演示向量 demo-bigram-v1 实测：Recall@1 = 1.000，Recall@3 = 1.000。8 题 / 3 块的题目与原文词汇高度重合，k=3 时已经覆盖全库，因此 1.000 不具有规模化效果说服力。未使用真实 Embedding 凭据进行评测。

这些指标只验证“相关块有没有被检索到”，不评估最终回答准确性、引用蕴含、幻觉、流畅度或报告质量，也不应该作为真实语义模型的优劣结论。扩展时应加入更大人工标注集、同义表达、难负例、多相关块、无答案问题，并划分开发集和独立测试集。更换分块策略或文件会使 chunkId 改变，必须一起更新标注与索引版本。
