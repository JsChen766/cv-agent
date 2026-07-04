# 部署教程 — Docker

## 目录

1. [前置要求](#一前置要求)
2. [本地开发启动](#二本地开发启动)
3. [生产部署](#三生产部署)
4. [环境变量说明](#四环境变量说明)
5. [数据库迁移](#五数据库迁移)
6. [日志与监控](#六日志与监控)
7. [常见问题](#七常见问题)

---

## 一、前置要求

- Docker >= 24.0
- Docker Compose >= 2.20
- 服务器至少 1GB 内存（推荐 2GB+，LLM 调用是网络 IO，不是本地计算）
- 一个 LLM API Key（OpenAI / Anthropic / DeepSeek 等）

---

## 二、本地开发启动

```bash
# 1. 克隆项目
git clone <your-repo> cv-be && cd cv-be

# 2. 复制环境变量文件
cp .env.docker .env.docker.local
# 编辑 .env.docker.local，填入真实的 LLM_API_KEY

# 3. 启动全部服务（postgres + 自动迁移 + api）
docker compose --env-file .env.docker.local up --build

# 启动成功后访问：
# API 文档：http://localhost:8000/docs
# 健康检查：http://localhost:8000/v1/health
```

> **注意**：首次启动会自动执行 `alembic upgrade head`，无需手动迁移。

---

## 三、生产部署

### 3.1 准备环境变量

```bash
cp .env.docker .env.production
```

编辑 `.env.production`，**必须修改**：

```env
SECRET_KEY=<用 openssl rand -hex 32 生成>
LLM_API_KEY=<你的 API Key>
DATABASE_URL=postgresql+asyncpg://cvbe:<强密码>@postgres:5432/cvbe
ENVIRONMENT=production
```

同时修改 `docker-compose.yml` 中 postgres 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 保持一致。

### 3.2 启动

```bash
# 后台运行
docker compose --env-file .env.production up --build -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f api
```

### 3.3 验证

```bash
curl http://localhost:8000/v1/health
# 期望返回：{"status":"ok","version":"0.1.0"}
```

---

## 四、环境变量说明

| 变量 | 说明 | 必填 |
|---|---|---|
| `DATABASE_URL` | asyncpg 连接串，Docker 内 host 填 `postgres` | ✅ |
| `SECRET_KEY` | JWT 签名密钥，生产必须换 | ✅ |
| `LLM_PROVIDER` | `openai` 或 `anthropic` | ✅ |
| `LLM_MODEL` | 模型名，如 `gpt-4o`、`claude-opus-4-8` | ✅ |
| `LLM_API_KEY` | 对应平台的 API Key | ✅ |
| `LLM_BASE_URL` | 非官方接口时填写（Azure/DeepSeek/Qwen 等） | ❌ |
| `EMBEDDING_MODEL` | 嵌入模型，默认 `text-embedding-3-small` | ❌ |
| `ENVIRONMENT` | `development`（开启 /docs）或 `production` | ❌ |

### 使用国产模型（如 DeepSeek）

DeepSeek 兼容 OpenAI format，只需：

```env
LLM_PROVIDER=openai
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.deepseek.com/v1
EMBEDDING_MODEL=text-embedding-3-small  # 仍需 OpenAI 的 embedding
```

---

## 五、数据库迁移

`migrate` 服务在每次 `docker compose up` 时自动运行 `alembic upgrade head`，幂等安全。

**手动迁移（如需）：**

```bash
docker compose run --rm migrate alembic upgrade head

# 回滚一个版本
docker compose run --rm migrate alembic downgrade -1

# 查看当前版本
docker compose run --rm migrate alembic current
```

**本地新增迁移文件：**

```bash
# 先确保本地 python 环境有依赖
pip install -e ".[dev]"

# 生成迁移
alembic revision -m "add_xxx_table"
# 编辑生成的文件后提交
```

---

## 六、日志与监控

```bash
# 实时查看 api 日志
docker compose logs -f api

# 只看最近 100 行
docker compose logs --tail=100 api

# 进入容器调试
docker compose exec api bash
```

健康检查端点：`GET /v1/health`（无需鉴权），可直接接 Nginx / 负载均衡器的 upstream check。

---

## 七、常见问题

**Q: `migrate` 服务报 `Connection refused`**

postgres 还没就绪。`migrate` 已配置 `depends_on: condition: service_healthy`，如果仍报错，说明 postgres 健康检查未通过，检查磁盘空间和 postgres 日志：`docker compose logs postgres`

**Q: `api` 服务启动后立即退出**

查看日志：`docker compose logs api`。常见原因：`.env.docker` 中 `DATABASE_URL` 的 host 写成了 `localhost` 而非 `postgres`。

**Q: 想更换 postgres 密码**

1. 修改 `docker-compose.yml` 中 `POSTGRES_PASSWORD`
2. 修改 `.env.production` 中 `DATABASE_URL` 密码部分保持一致
3. 删除旧 volume 并重启：`docker compose down -v && docker compose up -d`

**Q: 生产环境想加 Nginx 反代**

在 `docker-compose.yml` 中加一个 `nginx` service，监听 80/443，proxy_pass 到 `api:8000`。`api` 服务的 `ports` 映射可以去掉（只保持内网通信）。

**Q: 如何备份数据库**

```bash
docker compose exec postgres pg_dump -U cvbe cvbe > backup_$(date +%Y%m%d).sql
```
