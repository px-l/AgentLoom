FROM python:3.11.15-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY . .
