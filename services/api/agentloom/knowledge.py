from io import BytesIO
from sqlalchemy import select, delete, func
from pgvector.sqlalchemy import Vector
from pypdf import PdfReader
from .db import Session, Document, Chunk, KnowledgeBase
from .providers import embed, embedding_signature


def extract(name, content):
    if name.lower().endswith(".pdf"):
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise ValueError("不支持加密 PDF")
        pages = [(i + 1, p.extract_text() or "") for i, p in enumerate(reader.pages)]
        if not any(t.strip() for _, t in pages):
            raise ValueError("PDF 无可提取文本；扫描 PDF 的 OCR 暂不支持")
        return pages
    if not name.lower().endswith((".txt", ".md", ".markdown")):
        raise ValueError("仅支持 TXT、Markdown 和文本 PDF")
    try:
        return [(None, content.decode("utf-8-sig"))]
    except UnicodeDecodeError:
        raise ValueError("文本文件必须使用 UTF-8 编码")


def split_pages(pages, size=600, overlap=80):
    result = []
    for page, text in pages:
        for start in range(0, len(text), size - overlap):
            part = text[start : start + size].strip()
            if part:
                result.append((page, part))
    if not result:
        raise ValueError("文件内容为空")
    if len(result) > 1000:
        raise ValueError("首版单文件最多 1000 个分块")
    return result


def index_document(doc_id, config, owner=None):
    with Session() as s:
        d = s.get(Document, doc_id)
        parts = split_pages(extract(d.name, d.content))
        kb = d.kb_id
    vectors = []
    for start in range(0, len(parts), 32):
        vectors.extend(embed([p[1] for p in parts[start : start + 32]], config))
    signature = embedding_signature(config)
    with Session.begin() as s:
        d = s.scalar(select(Document).where(Document.id == doc_id).with_for_update())
        if owner and d.owner != owner:
            return
        s.execute(delete(Chunk).where(Chunk.document_id == doc_id))
        for i, ((page, text), vector) in enumerate(zip(parts, vectors)):
            s.add(
                Chunk(
                    id=f"{doc_id}-{i}",
                    document_id=doc_id,
                    kb_id=kb,
                    ordinal=i,
                    page=page,
                    text=text,
                    embedding=vector,
                    index_version=signature,
                )
            )
        d.status = "ready"
        d.index_version = signature
        d.error = None
        d.owner = None
        d.lease_until = None


def search(kb_id, query, k, config):
    with Session() as s:
        if not s.get(KnowledgeBase, kb_id):
            raise ValueError("指定知识库不存在")
    vector = embed([query], config)[0]
    signature = embedding_signature(config)
    with Session() as s:
        # Restrict model/index signature before vector distance: pgvector vectors have different dimensions in demo/real.
        sub = select(Chunk).where(Chunk.kb_id == kb_id, Chunk.index_version == signature).subquery()
        from sqlalchemy.orm import aliased

        c = aliased(Chunk, sub)
        rows = s.execute(
            select(c, Document.name, c.embedding.cast(Vector(len(vector))).cosine_distance(vector).label("distance"))
            .join(Document, Document.id == c.document_id)
            .where(Document.status == "ready", func.vector_dims(c.embedding) == len(vector))
            .order_by("distance")
            .limit(k)
        ).all()
        return [
            {
                "chunkId": c.id,
                "documentId": c.document_id,
                "file": name,
                "page": c.page,
                "ordinal": c.ordinal,
                "text": c.text,
                "indexVersion": c.index_version,
                "score": round(1 - float(distance), 5),
            }
            for c, name, distance in rows
        ]
