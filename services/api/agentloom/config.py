from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")
    database_url: str = "postgresql+psycopg://agentloom:agentloom@127.0.0.1:5438/agentloom"
    model_mode: str = "demo"
    model_base_url: str = "https://api.openai.com/v1"
    model_name: str = "gpt-4.1-mini"
    model_api_key: str = ""
    embedding_mode: str = "demo"
    embedding_base_url: str = "https://api.openai.com/v1"
    embedding_model: str = "text-embedding-3-small"
    embedding_api_key: str = ""
    embedding_dimensions: int = 1536
    upload_dir: str = "./uploads"
    max_run_seconds: int = 180
    max_agent_steps: int = 6
    max_tool_calls: int = 4
    max_model_tokens: int = 2000
    lease_seconds: int = 30


settings = Settings()


def snapshot():
    values = {
        k: v
        for k, v in settings.model_dump().items()
        if k not in {"model_api_key", "embedding_api_key", "database_url", "upload_dir"}
    }

    from .db import Session, PlatformSetting

    with Session() as s:
        row = s.get(PlatformSetting, "runtime")
        if row:
            values.update(row.value)
    return values
