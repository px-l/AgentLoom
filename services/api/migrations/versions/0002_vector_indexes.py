"""Dimension-specific HNSW expression indexes for the demo and default real embedding.
Other dimensions remain supported with exact pgvector distance scans.
"""

from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    for dim in (256, 1536):
        op.execute(
            f"CREATE INDEX chunks_hnsw_{dim} ON chunks USING hnsw ((embedding::vector({dim})) vector_cosine_ops) WHERE vector_dims(embedding) = {dim}"
        )
    op.execute("""CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Published workflow versions are immutable'; END; $$""")
    op.execute(
        "CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE ON versions FOR EACH ROW EXECUTE FUNCTION reject_version_mutation()"
    )


def downgrade():
    op.execute("DROP TRIGGER immutable_versions ON versions")
    op.execute("DROP FUNCTION reject_version_mutation()")
    for dim in (256, 1536):
        op.execute(f"DROP INDEX chunks_hnsw_{dim}")
