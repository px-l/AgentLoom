from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import create_engine, String, Text, Integer, DateTime, JSON, ForeignKey, UniqueConstraint, LargeBinary
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from pgvector.sqlalchemy import Vector
from .config import settings


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc)


engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=10)
Session = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class App(Base):
    __tablename__ = "apps"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    draft: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Version(Base):
    __tablename__ = "versions"
    __table_args__ = (UniqueConstraint("app_id", "number"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    app_id: Mapped[str] = mapped_column(ForeignKey("apps.id"))
    number: Mapped[int] = mapped_column(Integer)
    graph: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id"))
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    request_hash: Mapped[str] = mapped_column(String)
    config: Mapped[dict] = mapped_column(JSON)
    input: Mapped[dict] = mapped_column(JSON)
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    event_seq: Mapped[int] = mapped_column(Integer, default=0)
    recoveries: Mapped[int] = mapped_column(Integer, default=0)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("run_id", "event_id"), UniqueConstraint("run_id", "dedupe_key"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    event_id: Mapped[int] = mapped_column(Integer)
    dedupe_key: Mapped[str | None] = mapped_column(String, nullable=True)
    type: Mapped[str] = mapped_column(String)
    node_id: Mapped[str | None] = mapped_column(String, nullable=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NodeRecord(Base):
    __tablename__ = "node_records"
    __table_args__ = (UniqueConstraint("run_id", "node_id"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    node_id: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="running")
    input: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retries: Mapped[int] = mapped_column(Integer, default=0)
    usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    model_steps: Mapped[int] = mapped_column(Integer, default=0)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (UniqueConstraint("run_id", "node_id"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    node_id: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="pending")
    proposed: Mapped[str] = mapped_column(Text)
    decision: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ToolCall(Base):
    __tablename__ = "tool_calls"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    node_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    args_hash: Mapped[str] = mapped_column(String)
    arguments: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    retries: Mapped[int] = mapped_column(Integer, default=0)


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    content: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    index_version: Mapped[str] = mapped_column(String, default="")
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text)
    index_version: Mapped[str] = mapped_column(String)
    embedding: Mapped[list] = mapped_column(Vector())


class PlatformSetting(Base):
    __tablename__ = "platform_settings"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)
