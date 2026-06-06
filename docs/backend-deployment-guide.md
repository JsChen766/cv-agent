# Coolto Agent Runtime 部署教程

## 1. 环境准备

你需要在本地安装以下工具：

### 必需

- Node.js 20+ 或 22+
  - 推荐用 nvm-windows 管理版本：https://github.com/coreybutler/nvm-windows
  - 安装后运行 `nvm install 22`，然后 `nvm use 22`
- npm 9+（随 Node.js 一起安装）
- Git：https://git-scm.com/download/win

### 可选（使用 PostgreSQL 持久化时需要）

- Docker Desktop：https://www.docker.com/products/docker-desktop
  - 安装后确认 Docker 能正常运行：打开 PowerShell，运行 `docker --version`

不安装 Docker 也可以运行，但数据只存在于内存中，重启后丢失。推荐使用 Docker 运行 PostgreSQL。

---

## 2. 克隆仓库

打开 PowerShell，进入你想要存放项目的目录，然后运行：

```powershell
git clone https://github.com/your-username/cv-agent.git
cd cv-agent
```

---

## 3. 安装依赖

进入项目目录后，运行：

```powershell
npm install
```

这会自动安装所有依赖，通常只需几分钟。安装完成后会生成 `node_modules` 文件夹。

---

## 4. 配置环境变量

### 方式一：直接复制示例文件（推荐）

项目根目录已经有 `.env.example`，复制一份并重命名为 `.env`：

```powershell
copy .env.example .env
```

然后用任意文本编辑器（记事本、VS Code 等）打开 `.env` 文件，按下面的说明修改。

### 方式二：手动创建

如果 `.env.example` 不存在，在 `cv-agent` 根目录下新建一个名为 `.env` 的文件，把下面的内容粘贴进去。

### 最小配置（只用内存模式，不需要数据库）

```env
NODE_ENV=development
AUTH_MODE=dev_header
AGENT_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

说明：

- `AUTH_MODE=dev_header`：开发模式，前端请求时带上 `x-user-id: demo-user` 即可，无需真实登录。
- `AGENT_MODEL_PROVIDER=deepseek`：使用 DeepSeek 作为 AI 模型提供商。
- `DEEPSEEK_API_KEY`：你的 DeepSeek API Key，去 https://platform.deepseek.com 获取。

### 完整配置（使用 PostgreSQL 持久化）

如果你安装了 Docker Desktop，可以用 Docker 一键启动 PostgreSQL：

```powershell
docker compose up -d postgres
```

然后在 `.env` 中添加数据库连接地址：

```env
NODE_ENV=development
AUTH_MODE=dev_header
DATABASE_URL=postgres://coolto:coolto_dev_password@localhost:5432/coolto_agent
AGENT_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

### 其他可用的 AI 模型提供商

如果你想用 OpenAI 而不是 DeepSeek：

```env
AGENT_MODEL_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key_here
# OPENAI_MODEL=gpt-4o  （可选，指定模型）
```

或者使用兼容 OpenAI API 的其他服务（如本地部署的 Ollama、vLLM 等）：

```env
AGENT_MODEL_PROVIDER=compatible
AGENT_MODEL_API_KEY=your_api_key_here
AGENT_MODEL_BASE_URL=https://your-compatible-api.com/v1
# OPENAI_MODEL=your-model-name  （可选）
```

### 配置文件说明

`.env` 文件不会被 Git 追踪（在 `.gitignore` 中），所以可以安全地存放 API Key。千万不要把 `.env` 文件提交到代码仓库。

---

## 5. 启动服务

### 方式一：本地直接运行（推荐用于开发调试）

在 `cv-agent` 根目录下运行：

```powershell
npm run dev:api
```

你会看到类似输出：

```
[api] server listening on http://0.0.0.0:3000
[api] mode: in_memory (no DATABASE_URL set)
[api] auth mode: dev_header
```

服务会在 `http://localhost:3000` 启动。

- 查看健康检查：打开浏览器访问 `http://localhost:3000/health`
- 验证 API 是否正常：PowerShell 中运行 `curl http://localhost:3000/health`

如果要让修改自动生效（热重载）：

```powershell
npm run dev:api:watch
```

### 方式二：使用 Docker 一键启动（包含 PostgreSQL）

项目根目录下有 `docker-compose.yml`，可以一键启动 API + PostgreSQL：

```powershell
# 先复制环境变量文件
copy .env.docker.example .env.docker

# 构建并启动所有服务
docker compose up --build
```

如果要后台运行：

```powershell
docker compose up -d --build
```

启动后：

- API：http://localhost:3000
- pgAdmin（数据库管理工具，需额外启动）：`docker compose --profile tools up -d`，然后访问 http://localhost:5050

查看 API 日志：

```powershell
docker compose logs -f api
```

停止所有服务：

```powershell
docker compose down
```

### 方式三：使用 Docker 但不需要 Docker 时

如果你只想启动 PostgreSQL，API 本地运行：

```powershell
# 启动 PostgreSQL
docker compose up -d postgres

# 然后另一个终端运行
npm run dev:api
```

确保 `.env` 中 `DATABASE_URL` 指向 `localhost:5432`（Docker 映射到了本地 5432 端口）。

---

## 6. 验证安装

### 检查 API 是否正常运行

```powershell
curl http://localhost:3000/health
```

应该返回类似：

```json
{
  "ok": true,
  "data": { "status": "ok" },
  "meta": { "requestId": "...", "mode": "in_memory" }
}
```

如果 `mode` 显示 `postgres`，说明数据库连接成功。

### 检查 TypeScript 编译

```powershell
npm run typecheck
```

应该输出空（无错误）即表示编译通过。

### 运行测试

```powershell
npm test
```

所有测试通过即表示项目正常运行。

---

## 7. 连接前端

后端启动后，前端 `cv_agent_frontend` 项目需要配置 API 地址。

在 `cv_agent_frontend` 目录下创建或编辑 `.env` 文件：

```env
VITE_API_BASE_URL=http://localhost:3000
```

然后启动前端开发服务器（参考前端项目的 README）。

---

## 8. 常见问题

### API Key 错误

如果 API 返回 500 或模型调用失败，检查 `.env` 中的 `DEEPSEEK_API_KEY` 是否正确。

### 端口冲突

如果 3000 端口被占用，可以在 `.env` 中修改端口：

```env
PORT=3001
```

然后访问 `http://localhost:3001`。

### 数据库连接失败

如果使用 PostgreSQL 但连接失败：

1. 确认 PostgreSQL 正在运行：`docker ps` 查看容器状态
2. 检查 `.env` 中的 `DATABASE_URL` 是否正确
3. 重启 API：`npm run dev:api` 或 `docker compose restart api`

### 修改配置后不生效

修改 `.env` 后需要重启服务才能生效。
