"""Tiny labelled retrieval evaluation through the actual pgvector query path."""

import argparse
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "services/api"))
from agentloom.config import snapshot
from agentloom.knowledge import search
from agentloom.db import Session, Chunk
from sqlalchemy import select, func
from agentloom.providers import embedding_signature

parser = argparse.ArgumentParser()
parser.add_argument("--k", nargs="+", type=int, default=[1, 3])
parser.add_argument("--kb", default="example-knowledge")
args = parser.parse_args()
questions = json.loads((root / "eval/questions.json").read_text())
config = snapshot()
with Session() as s:
    count = s.scalar(
        select(func.count())
        .select_from(Chunk)
        .where(
            Chunk.kb_id == args.kb, Chunk.index_version == embedding_signature(config)
        )
    )
result = {
    "embeddingMode": config["embedding_mode"],
    "embeddingModel": config["embedding_model"]
    if config["embedding_mode"] != "demo"
    else "demo-bigram-v1",
    "questionCount": len(questions),
    "corpusChunks": count,
    "definition": "Macro Recall@k = mean(|top_k_ids ∩ relevant_ids| / |relevant_ids|)",
    "results": [],
}
for k in args.k:
    if not 1 <= k <= 10:
        raise SystemExit("k must be between 1 and 10")
    rows = []
    for q in questions:
        hits = search(args.kb, q["question"], k, config)
        found = {h["chunkId"] for h in hits}
        relevant = set(q["relevantChunkIds"])
        rows.append(
            {
                **q,
                "retrievedChunkIds": [h["chunkId"] for h in hits],
                "recall": len(found & relevant) / len(relevant),
            }
        )
    result["results"].append(
        {
            "k": k,
            "macroRecall": sum(r["recall"] for r in rows) / len(rows),
            "queries": rows,
        }
    )
path = root / "eval/results.json"
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(
    json.dumps({k: v for k, v in result.items() if k != "results"}, ensure_ascii=False)
)
for r in result["results"]:
    print(f"Recall@{r['k']}: {r['macroRecall']:.3f}")
print(f"Results: {path}")
