"""Persist model request budget across retries and checkpoint replay."""

from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"


def upgrade():
    op.add_column("node_records", sa.Column("model_steps", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("node_records", "model_steps")
