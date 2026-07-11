# 部署与本地开发指南

## 目录

1. [前置要求](#一前置要求)
2. [本地开发](#二本地开发)
3. [生产部署](#三生产部署)
4. [环境变量说明](#四环境变量说明)
5. [数据库迁移](#五数据库迁移)
6. [日志与监控](#六日志与监控)
7. [常见问题](#七常见问题)

---

## 一、前置要求

- Python 3.12+
- Docker >= 24.0
- Docker Compose >= 2.20
- 一个 LLM API Key（OpenAI / Anthropic / DeepSeek 等）
- 生产服务器至少 1GB 内存（推荐 2GB+，LLM 调用是网络 IO，不是本地计算）

---

## 二、本地开发

本地开发默认使用本机 Python 进程运行 API，读取根目录 `.env`。

不要用 Docker 跑本地 API；Docker API 服务读取 `.env.docker`，更接近生产部署路径。开发时可以只用 Docker 跑 PostgreSQL。

### 2.1 准备 `.env`

```bash
cp .env.example .env
```

编辑 `.env`，至少确认：

```env
DATABASE_URL=postgresql+asyncpg://cvbe:cvbe@localhost:5432/cvbe
SECRET_KEY=change-me-in-production-use-openssl-rand-hex-32
LLM_PROVIDER=openai
LLM_MODEL=deepseek-v4-flash
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.deepseek.com
ENVIRONMENT=development
DEV_AUTO_AUTH=false
```

本地 API 连本地端口，所以 `DATABASE_URL` 的 host 应为 `localhost`。

### 2.2 启动本地依赖

只启动 PostgreSQL：

```bash
docker compose up -d postgres
```

不要执行 `docker compose up api` 或 `docker compose up` 作为本地开发启动方式。

### 2.3 安装依赖并迁移数据库

```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -e ".[dev]"
alembic upgrade head
```

### 2.4 启动本地 API

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

启动成功后访问：

- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/v1/health

---

## 三、生产部署

生产部署使用全 Docker：PostgreSQL、迁移服务、API 都由 Docker Compose 启动。

当前 `docker-compose.yml` 中 `migrate` 和 `api` 固定读取 `.env.docker`，所以生产服务器上应准备 `.env.docker` 文件。

### 3.1 准备 `.env.docker`

```bash
cp .env.docker.example .env.docker
```

编辑 `.env.docker`，必须修改：

```env
DATABASE_URL=postgresql+asyncpg://cvbe:<强密码>@postgres:5432/cvbe
SECRET_KEY=<用 openssl rand -hex 32 生成>
LLM_API_KEY=<你的 API Key>
ENVIRONMENT=production
```

同时修改 `docker-compose.yml` 中 postgres 的 `POSTGRES_PASSWORD`，并确保它与 `.env.docker` 里的 `DATABASE_URL` 密码一致。

生产 Docker 内部连接 PostgreSQL，所以 `DATABASE_URL` 的 host 应为 `postgres`，不是 `localhost`。

### 3.2 启动

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

`migrate` 服务会在 PostgreSQL 健康后执行 `alembic upgrade head`，API 会等待迁移完成后启动。

### 3.3 验证

```bash
curl http://localhost:8000/v1/health
# 期望返回：{"status":"ok","version":"0.1.0"}
```

---

## 四、环境变量说明

| 变量 | 本地开发 `.env` | 生产 `.env.docker` | 必填 |
|---|---|---|---|
| `DATABASE_URL` | host 用 `localhost` | host 用 `postgres` | ✅ |
| `SECRET_KEY` | 可用开发占位值 | 必须换成强随机值 | ✅ |
| `LLM_PROVIDER` | `openai` 或 `anthropic` | `openai` 或 `anthropic` | ✅ |
| `LLM_MODEL` | 模型名，如 `deepseek-v4-flash` | 模型名 | ✅ |
| `LLM_API_KEY` | 对应平台 API Key | 对应平台 API Key | ✅ |
| `LLM_BASE_URL` | 非官方接口时填写 | 非官方接口时填写 | ❌ |
| `EMBEDDING_PROVIDER` | `local` 或 `openai` | `local` 或 `openai` | ❌ |
| `EMBEDDING_MODEL` | 嵌入模型 | 嵌入模型 | ❌ |
| `EMBEDDING_API_KEY` | 独立 embedding 服务的 Key | 同左 | ❌ |
| `EMBEDDING_BASE_URL` | 独立 embedding 服务地址 | 同左 | ❌ |
| `EMBEDDING_DIMENSIONS` | 嵌入维度 | 嵌入维度 | ❌ |
| `EMBEDDING_LOCAL_FILES_ONLY` | 本地模型可设 `true` | 按镜像内模型情况设置 | ❌ |
| `ENVIRONMENT` | `development` | `production` | ❌ |

### 使用 DeepSeek 等 OpenAI-compatible 模型

DeepSeek 兼容 OpenAI format，可这样配置：

```env
LLM_PROVIDER=openai
LLM_MODEL=deepseek-v4-flash
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.deepseek.com
```

---

## 五、数据库迁移

本地开发迁移：

```bash
alembic upgrade head
alembic current
```

生产迁移由 Compose 的 `migrate` 服务自动执行。需要手动执行时：

```bash
docker compose run --rm migrate alembic upgrade head
docker compose run --rm migrate alembic current
```

回滚一个版本：

```bash
# 本地
alembic downgrade -1

# 生产 Docker
docker compose run --rm migrate alembic downgrade -1
```

新增迁移文件：

```bash
alembic revision -m "add_xxx_table"
# 编辑生成的文件后提交
```

---

## 六、日志与监控

本地开发：

```bash
# API 日志在 uvicorn 终端中查看
docker compose logs -f postgres
```

生产 Docker：

```bash
docker compose logs -f api
docker compose logs --tail=100 api
docker compose exec api bash
```

健康检查端点：`GET /v1/health`（无需鉴权），可直接接 Nginx / 负载均衡器的 upstream check。

---

## 七、常见问题

**Q: 本地开发应该用 `.env` 还是 `.env.docker`？**

本地开发用 `.env`。本地 API 是本机 Python 进程，配置读取 `.env`；`.env.docker` 留给 Docker Compose 的 `migrate` 和 `api` 服务。

**Q: 本地开发能用 Docker PostgreSQL 吗？**

可以。推荐只跑 `docker compose up -d postgres`，然后本地执行 `alembic upgrade head` 和 `uvicorn app.main:app --reload`。

**Q: 本地 API 连不上数据库**

检查 `.env` 中 `DATABASE_URL` 的 host 是否是 `localhost`，并确认 PostgreSQL 已启动：

```bash
docker compose ps postgres
docker compose logs postgres
```

**Q: 生产 `migrate` 服务报 `Connection refused`**

PostgreSQL 还没就绪。`migrate` 已配置 `depends_on: condition: service_healthy`，如果仍报错，检查磁盘空间和 postgres 日志：

```bash
docker compose logs postgres
```

**Q: 生产 `api` 服务启动后立即退出**

查看日志：

```bash
docker compose logs api
```

常见原因是 `.env.docker` 中 `DATABASE_URL` 的 host 写成了 `localhost`，生产 Docker 内应写 `postgres`。

**Q: 想更换生产 PostgreSQL 密码**

1. 修改 `docker-compose.yml` 中 `POSTGRES_PASSWORD`
2. 修改 `.env.docker` 中 `DATABASE_URL` 密码部分
3. 删除旧 volume 并重启：

```bash
docker compose down -v
docker compose up --build -d
```

**Q: 生产环境想加 Nginx 反代**

在 `docker-compose.yml` 中加一个 `nginx` service，监听 80/443，`proxy_pass` 到 `api:8000`。`api` 服务的 `ports` 映射可以去掉，只保持 Docker 内网通信。

**Q: 如何备份数据库**

```bash
docker compose exec postgres pg_dump -U cvbe cvbe > backup_$(date +%Y%m%d).sql
```
