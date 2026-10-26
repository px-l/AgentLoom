import os
import pytest

# Integration tests must never truncate a normal database.
url = os.environ.get("DATABASE_URL", "")
if not url.rsplit("/", 1)[-1].endswith("_test"):
    raise RuntimeError("Run tests via scripts/test.sh using a dedicated *_test database")
from sqlalchemy import text
from alembic.config import Config
from alembic import command
from agentloom.db import engine, Base
from agentloom.executor import checkpointer


@pytest.fixture(scope="session", autouse=True)
def migrate():
    command.upgrade(Config("alembic.ini"), "head")
    with checkpointer() as saver:
        saver.setup()


@pytest.fixture(autouse=True)
def reset_db(migrate):
    with engine.begin() as c:
        tables = ", ".join('"' + t + '"' for t in Base.metadata.tables)
        c.execute(text(f"TRUNCATE {tables}, checkpoints, checkpoint_blobs, checkpoint_writes RESTART IDENTITY CASCADE"))
    yield
