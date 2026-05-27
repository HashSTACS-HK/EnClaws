# Matter engine Docker image — builds team-pivot-web (Python FastAPI).
#
# Build context must be the team-pivot-web directory:
#   docker build -f ../EnClaws/matter-engine/Dockerfile -t matter-engine .
#
# In docker-compose, context is set to ../team-pivot-web relative to this repo.
#
# matter engine Docker 镜像：构建 team-pivot-web（Python FastAPI）。
# docker-compose 中 context 指向 ../team-pivot-web，Dockerfile 指向本文件。

FROM python:3.12-slim

# Install uv (fast Python package manager used by team-pivot-web)
# 安装 uv（team-pivot-web 使用的快速包管理器）
RUN pip install --no-cache-dir uv

WORKDIR /app

# Copy dependency manifests first for layer caching.
# 先复制依赖清单，利用 Docker 层缓存。
COPY pyproject.toml uv.lock ./

# Install production dependencies only (no dev extras).
# 仅安装生产依赖，跳过 dev extras。
RUN uv sync --frozen --no-dev

# Copy the rest of the application source.
# 复制应用源码。
COPY . .

# Data volume for SQLite DB and uploaded files.
# SQLite 数据库和上传文件的持久化目录。
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8001

# Run via uv so the virtual environment is correctly activated.
# 通过 uv 启动，确保虚拟环境正确激活。
CMD ["uv", "run", "uvicorn", "server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8001"]
