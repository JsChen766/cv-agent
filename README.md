# Coolto Agent Runtime

「库投 Coolto」的 TypeScript 多 Agent Runtime 底座。当前仓库只实现 Infrastructure / Framework / Runtime，不实现完整求职业务逻辑。

## Framework Goal
- 第一层：数据采集与感知层 你在日常中产生的所有学习/工作痕迹（Markdown笔记代码提交、面试复盘等）作为数据源，也直接通过和agent聊天进行上传（包括文本输入和简历文件上传）。 通过各种tools进行外部进行获取，由经历编目员Agent（Archivist） 实时监控并将原始信息转化为结构化的“经历JSON”。 
- 第二层：结构化知识库 经历分块、向量化存入向量数据库，并与知识图谱联动建立技能-项目关联。 经历版本流：同一段真实经历保留多个面向不同JD的话术变体，并追踪每个变体的使用次数与成功率。 时效性衰减：根据时间动态调整经历权重，过时或方向偏离的内容降权。 技能树：自动从经历中抽取技能标签，用于后续盲区检测。 
- 第三层：逻辑推理与策略层 （多智能体协作核心） Strategist 拿到岗位JD后，深度解析出真正的关键需求。 Architect 根据需求从知识库检索经历，优先选择高成功率的话术版本，或生成新描述。 Critic 以HR视角按照STAR原则逐项审计，同时从用户偏好学习器获取你的风格规则，确保输出“像你”。 审计与修改形成最多3轮的闭环循环，直到输出质量达标。 
- 第四层：表现层 最终交付个性化简历、求职信，以及基于你真实经历可能被追问的模拟面试题。 
- 第五层：自我进化层 （让系统随使用变“聪明”） 结果追踪器记录每份简历投递后的状态（邀请/拒信/追问点），或者也可以记录其他任何事务。 有效性回灌器将面试反馈转化为对经历版本成功率的更新，高共鸣经历被增强，低效话术触发重写。 技能盲区检测比对JD高频要求的技能与知识库已有技能，主动提醒你补足。


## Architecture

Runtime is split into low-coupled modules:

```text
Agent -> ModelClient -> LLMProvider
  |          |
  |          +-> DeepSeek / OpenRouter / Mock
  |
  +-> Tools -> ToolExecutor
  |
  +-> MemoryManager -> StorageAdapter
  |
  +-> Orchestrator -> sequential multi-agent pipeline
```

The current demo agents map to future Coolto roles:

- `ArchivistAgent`: convert raw experience text into structured JSON drafts.
- `StrategistAgent`: analyze JD requirements.
- `ArchitectAgent`: draft resume bullets.
- `CriticAgent`: review output from an HR perspective.

## Directory Structure

```text
src/
  core/          Runtime interfaces and base implementations
  providers/     DeepSeek, OpenRouter, and Mock providers
  agents/        Minimal example agents
  tools/         Example tools
  workflows/     Workflow placeholders
  examples/      Runnable demos
  config/        Node.js environment loading
tests/           Vitest tests
```

## Install

```bash
npm install
```

Requires Node.js 20+.

## Environment

Copy `.env.example` to `.env` when using real providers:

```bash
DEEPSEEK_API_KEY=
OPENROUTER_API_KEY=
DEFAULT_PROVIDER=mock
DEFAULT_MODEL=deepseek-v4-pro
```

Core classes do not read `process.env` directly. `src/config/env.ts` is only a Node.js example layer.

## Run Demos

All demos use `MockProvider` by default and do not require API keys.

```bash
npm run dev:single
npm run dev:multi
npm run dev:tool
npm run dev:memory
```

## Test

```bash
npm run typecheck
npm run test
```

## Add an Agent

Create a class extending `BaseAgent`:

```ts
export class MyAgent extends BaseAgent {
  constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt">) {
    super({
      ...config,
      name: "my-agent",
      role: "My role",
      systemPrompt: "Do one clear job."
    });
  }
}
```

Then register it:

```ts
registry.register(new MyAgent({ modelClient }));
```

## Add a Provider

Implement `LLMProvider`:

```ts
export class MyProvider implements LLMProvider {
  name = "my-provider";
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    return { content: "normalized response" };
  }
}
```

Providers must convert raw API responses into `LLMChatResponse`.

Switch providers at runtime through `ModelClient`:

```ts
client.setProvider(new MyProvider());
```

## Add a Tool

Create a `ToolDefinition` and register it with `ToolExecutor`:

```ts
executor.register({
  name: "myTool",
  description: "Do a small deterministic task.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(args) {
    return { ok: true, args };
  }
});
```

## Add a StorageAdapter

Implement the storage interface:

```ts
export class KVStorageAdapter implements StorageAdapter {
  get<T>(key: string): Promise<T | null> {}
  set<T>(key: string, value: T): Promise<void> {}
  delete(key: string): Promise<void> {}
  list(prefix?: string): Promise<string[]> {}
}
```

`MemoryManager` depends only on `StorageAdapter`, so it can move from local files to D1/KV without changing memory logic.

## Node.js and Cloudflare Workers

- Providers use `fetch` instead of SDK clients.
- Core runtime does not depend on Node-only APIs.
- `FileSystemStorageAdapter` and `config/env.ts` are Node-specific examples.
- Future Workers deployments should replace file storage with KV/D1 and pass env bindings explicitly.

## Current Non-Goals

- No complete RAG.
- No knowledge graph.
- No frontend.
- No complete resume generator.
- No real user system.
- No complex multi-agent self-loop.

## Suggested Next Steps

- Connect the real `DeepSeekProvider`.
- Add D1/KV storage adapters.
- Add an Experience JSON schema.
- Add a Retriever interface for RAG.
- Expand `resumeWorkflow`.
- Add an API server or Cloudflare Workers handler.
