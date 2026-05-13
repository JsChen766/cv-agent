# Coolto Agent Runtime

TypeScript agent runtime foundation for Coolto. The project currently focuses on runtime primitives plus a minimal knowledge pipeline. It still avoids real LLM calls, real vector databases, Neo4j, and frontend code.

## Framework Goal

- Data ingestion layer: collect raw experience text and turn it into structured experience knowledge.
- Structured knowledge layer: keep experiences, evidence, skills, JD requirements, generated artifacts, evidence chains, and graph views behind replaceable repository interfaces.
- Reasoning layer: use deterministic mock services today where future `ArchivistAgent`, `StrategistAgent`, and `ArchitectAgent` implementations can be plugged in.
- Presentation layer: expose `EvidenceChain` and `GraphView` data that a future frontend panel can consume.

## Architecture

Runtime modules remain low-coupled:

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

Knowledge pipeline modules:

```text
Raw Experience Input
  -> ExperienceIngestionService
  -> Experience / Evidence / Skill repositories
  -> KeywordExperienceRetriever
  -> ResumeGenerationService
  -> GeneratedArtifact
  -> EvidenceChainBuilder
  -> GraphViewBuilder
```

## Knowledge Pipeline

The pipeline demo implements the current smallest real business loop:

1. Input raw experience text.
2. Deterministically extract structured `Experience`, `Evidence`, and `Skill` records.
3. Input JD text and target role.
4. Deterministically create `JDRequirement` records.
5. Retrieve matching experiences with `KeywordExperienceRetriever`.
6. Generate a `GeneratedArtifact`.
7. Build an `EvidenceChain`.
8. Build a frontend-ready local `GraphView`.

Current constraints:

- No real vector database.
- No Neo4j or external graph database.
- No frontend.
- No real LLM calls.
- Repositories are `interface` + in-memory implementations so they can be replaced later.

Next intended step: add an API server and a frontend panel on top of this pipeline.

## Directory Structure

```text
src/
  application/   Application services such as ResumeGenerationService
  core/          Runtime interfaces and base implementations
  providers/     DeepSeek, OpenRouter, and Mock providers
  agents/        Minimal example agents
  tools/         Example tools
  workflows/     Workflow placeholders
  knowledge/     Knowledge types, repositories, ingestion, retrieval, graph builders
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

All demos use mock or deterministic local behavior by default and do not require API keys.

```bash
npm run dev:single
npm run dev:multi
npm run dev:tool
npm run dev:memory
npm run dev:knowledge
npm run dev:knowledge-pipeline
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
      systemPrompt: "Do one clear job.",
    });
  }
}
```

Then register it:

```ts
registry.register(new MyAgent({ modelClient }));
```

The current demo agents map to future Coolto roles:

- `ArchivistAgent`: convert raw experience text into structured JSON drafts.
- `StrategistAgent`: analyze JD requirements.
- `ArchitectAgent`: draft resume bullets.
- `CriticAgent`: review output from an HR perspective.

## Current Non-Goals

- No complete RAG.
- No real vector store.
- No Neo4j integration.
- No frontend.
- No production resume generator.
- No real user system.
- No complex multi-agent self-loop.
