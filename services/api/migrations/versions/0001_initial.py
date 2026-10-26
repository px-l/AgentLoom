"""Initial platform schema (frozen DDL). Checkpoints are managed by PostgresSaver.setup()."""

from alembic import op

revision = "0001"
down_revision = None

STATEMENTS = [
    "CREATE TABLE apps (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR(120) NOT NULL, \n\tdescription TEXT NOT NULL, \n\tdraft JSON NOT NULL, \n\trevision INTEGER NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "CREATE TABLE knowledge_bases (\n\tid VARCHAR NOT NULL, \n\tname VARCHAR(120) NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "CREATE TABLE platform_settings (\n\tid VARCHAR NOT NULL, \n\tvalue JSON NOT NULL, \n\tPRIMARY KEY (id)\n)",
    "CREATE TABLE documents (\n\tid VARCHAR NOT NULL, \n\tkb_id VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tcontent BYTEA NOT NULL, \n\tstatus VARCHAR NOT NULL, \n\terror TEXT, \n\tindex_version VARCHAR NOT NULL, \n\towner VARCHAR, \n\tlease_until TIMESTAMP WITH TIME ZONE, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(kb_id) REFERENCES knowledge_bases (id)\n)",
    "CREATE TABLE versions (\n\tid VARCHAR NOT NULL, \n\tapp_id VARCHAR NOT NULL, \n\tnumber INTEGER NOT NULL, \n\tgraph JSON NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (app_id, number), \n\tFOREIGN KEY(app_id) REFERENCES apps (id)\n)",
    "CREATE TABLE chunks (\n\tid VARCHAR NOT NULL, \n\tdocument_id VARCHAR NOT NULL, \n\tkb_id VARCHAR NOT NULL, \n\tordinal INTEGER NOT NULL, \n\tpage INTEGER, \n\ttext TEXT NOT NULL, \n\tindex_version VARCHAR NOT NULL, \n\tembedding VECTOR NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(document_id) REFERENCES documents (id), \n\tFOREIGN KEY(kb_id) REFERENCES knowledge_bases (id)\n)",
    "CREATE TABLE runs (\n\tid VARCHAR NOT NULL, \n\tversion_id VARCHAR NOT NULL, \n\tidempotency_key VARCHAR(128) NOT NULL, \n\trequest_hash VARCHAR NOT NULL, \n\tconfig JSON NOT NULL, \n\tinput JSON NOT NULL, \n\toutput JSON, \n\tstatus VARCHAR NOT NULL, \n\terror TEXT, \n\towner VARCHAR, \n\tlease_until TIMESTAMP WITH TIME ZONE, \n\tstarted_at TIMESTAMP WITH TIME ZONE, \n\tcreated_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\tfinished_at TIMESTAMP WITH TIME ZONE, \n\tevent_seq INTEGER NOT NULL, \n\trecoveries INTEGER NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(version_id) REFERENCES versions (id), \n\tUNIQUE (idempotency_key)\n)",
    "CREATE TABLE approvals (\n\tid VARCHAR NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tnode_id VARCHAR NOT NULL, \n\tstatus VARCHAR NOT NULL, \n\tproposed TEXT NOT NULL, \n\tdecision JSON, \n\tPRIMARY KEY (id), \n\tUNIQUE (run_id, node_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (id)\n)",
    "CREATE TABLE events (\n\tid SERIAL NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tevent_id INTEGER NOT NULL, \n\tdedupe_key VARCHAR, \n\ttype VARCHAR NOT NULL, \n\tnode_id VARCHAR, \n\tdata JSON NOT NULL, \n\ttime TIMESTAMP WITH TIME ZONE NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (run_id, event_id), \n\tUNIQUE (run_id, dedupe_key), \n\tFOREIGN KEY(run_id) REFERENCES runs (id)\n)",
    "CREATE TABLE node_records (\n\tid VARCHAR NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tnode_id VARCHAR NOT NULL, \n\tstatus VARCHAR NOT NULL, \n\tinput JSON NOT NULL, \n\toutput JSON, \n\telapsed_ms INTEGER, \n\tretries INTEGER NOT NULL, \n\tusage JSON, \n\tPRIMARY KEY (id), \n\tUNIQUE (run_id, node_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (id)\n)",
    "CREATE TABLE tool_calls (\n\tid VARCHAR NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tnode_id VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\targs_hash VARCHAR NOT NULL, \n\targuments JSON NOT NULL, \n\tstatus VARCHAR NOT NULL, \n\tresult JSON, \n\tretries INTEGER NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(run_id) REFERENCES runs (id)\n)",
    "CREATE INDEX ix_documents_status ON documents (status)",
    "CREATE INDEX ix_documents_kb_id ON documents (kb_id)",
    "CREATE INDEX ix_chunks_document_id ON chunks (document_id)",
    "CREATE INDEX ix_chunks_kb_id ON chunks (kb_id)",
    "CREATE INDEX ix_runs_status ON runs (status)",
    "CREATE INDEX ix_approvals_run_id ON approvals (run_id)",
    "CREATE INDEX ix_events_run_id ON events (run_id)",
    "CREATE INDEX ix_node_records_run_id ON node_records (run_id)",
    "CREATE INDEX ix_tool_calls_run_id ON tool_calls (run_id)",
]


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade():
    op.execute("DROP TABLE tool_calls CASCADE")
    op.execute("DROP TABLE node_records CASCADE")
    op.execute("DROP TABLE events CASCADE")
    op.execute("DROP TABLE approvals CASCADE")
    op.execute("DROP TABLE runs CASCADE")
    op.execute("DROP TABLE chunks CASCADE")
    op.execute("DROP TABLE versions CASCADE")
    op.execute("DROP TABLE documents CASCADE")
    op.execute("DROP TABLE platform_settings CASCADE")
    op.execute("DROP TABLE knowledge_bases CASCADE")
    op.execute("DROP TABLE apps CASCADE")
