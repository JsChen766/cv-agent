# Coolto Agent Runtime

TypeScript agent runtime foundation for Coolto. The project currently focuses on runtime primitives, a deterministic knowledge pipeline, and frontend-facing data contracts. It still avoids real LLM calls, real vector databases, Neo4j, HTTP API servers, and frontend code.

## Framework Goal

- Data ingestion layer: collect raw experience text and turn it into structured experience knowledge.
- Structured knowledge layer: keep experiences, evidence, skills, JD requirements, generated artifacts, evidence chains, and graph views behind replaceable repository interfaces.
- Reasoning layer: use deterministic mock services today where future `ArchivistAgent`, `StrategistAgent`, and `ArchitectAgent` implementations can be plugged in.
- Presentation layer: expose zod-validated `EvidenceChain`, `GraphView`, and API contract data that a future frontend panel can consume.

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
  -> GeneratedArtifact[]
  -> EvidenceChainBuilder
  -> GraphViewBuilder
  -> Contract Mappers
```

## Knowledge Pipeline

The pipeline demo implements the current smallest real business loop:

1. Input raw experience text.
2. Deterministically extract structured `Experience`, `Evidence`, and `Skill` records.
3. Input JD text and target role.
4. Deterministically create `JDRequirement` records.
5. Retrieve matching experiences with `KeywordExperienceRetriever`.
6. Generate at least three `GeneratedArtifact` variants.
7. Build one `EvidenceChain` per artifact.
8. Build one frontend-ready local `GraphView` per artifact.
9. Map the internal result into frontend-facing contract bundles.

Runtime validation is handled with zod schemas in `src/knowledge/schemas/`. The schema set covers the core frontend boundary objects: `Experience`, `Evidence`, `Skill`, `JDRequirement`, `ExperienceVariant`, `GeneratedArtifact`, `EvidenceChain`, and `GraphView`.

`EvidenceChain` is now the direct data structure for a future Evidence Panel. It includes the generated artifact, a summary, requirement-level matches, source experiences, source evidences, source skills, risk assessment, scores, and creation time.

`ResumeGenerationService` is fully multi-artifact. It returns:

```ts
{
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  graphViews: GraphView[];
}
```

The array lengths are kept aligned by index. It no longer returns single `artifact`, `evidenceChain`, or `graphView` compatibility fields.

## Dual Implementation Architecture

The pipeline now supports **two implementations** for each key processing step:

### Deterministic implementation (default, for demo/tests)

Rule-based extraction without any LLM calls. Used by `createInMemoryCooltoDemoService()` and all existing tests.

| Component | Class | Location |
|---|---|---|
| Experience extraction | `DeterministicExperienceExtractor` | `src/knowledge/ingestion/extractors/` |
| JD requirement extraction | `DeterministicJDRequirementExtractor` | `src/application/extractors/` |
| Artifact generation | `DeterministicArtifactGenerator` | `src/application/generators/` |

### Agent-backed implementation (for real LLM integration)

Calls a `BaseAgent` subclass and validates the JSON output with zod schemas. Throws on invalid output — no silent fallback.

| Component | Agent used | Class | Location |
|---|---|---|---|
| Experience extraction | `ArchivistAgent` (or any `BaseAgent`) | `AgentExperienceExtractor` | `src/knowledge/ingestion/extractors/` |
| JD requirement extraction | `StrategistAgent` (or any `BaseAgent`) | `AgentJDRequirementExtractor` | `src/application/extractors/` |
| Artifact generation | `ArchitectAgent` (or any `BaseAgent`) | `AgentArtifactGenerator` | `src/application/generators/` |

### Abstracted interfaces (the "what")

| Interface | Method | Purpose |
|---|---|---|
| `ExperienceExtractor` | `extract(input) => Promise<ExtractedExperience>` | Extract structured experience from raw text |
| `JDRequirementExtractor` | `extract(input) => Promise<ExtractJDRequirementsResult>` | Extract requirements from a job description |
| `ArtifactGenerator` | `generate(input) => Promise<GeneratedArtifact[]>` | Generate resume artifacts from requirements and experiences |

`ResumeGenerationService` now receives these via **constructor dependency injection** and acts purely as an orchestrator. It no longer contains `mockStrategist` or `mockArchitect` methods.

### Agent-backed factory

For future real-LLM wiring, use the skeleton factory:

```ts
import { createAgentBackedResumeGenerationService } from "./application/factories/createAgentBackedResumeGenerationService.js";

const service = createAgentBackedResumeGenerationService({
  strategistAgent,   // StrategistAgent instance with real ModelClient
  architectAgent,    // ArchitectAgent instance with real ModelClient
  experienceRepo,
  evidenceRepo,
  skillRepo,
  requirementRepo,
  artifactRepo,
  retriever,
});
```

The deterministic demo factory remains unchanged:

```ts
import { createInMemoryCooltoDemoService } from "./application/CooltoDemoService.js";
const demo = createInMemoryCooltoDemoService();
```

### Connecting real LLMs (DeepSeek / OpenRouter)

1. Set API keys in `.env`: `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY`.
2. Create a `ModelClient` with the real provider:
   ```ts
   const provider = new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY! });
   const modelClient = new ModelClient({ provider, defaultModel: "deepseek-v4-pro" });
   ```
3. Create agents with that client:
   ```ts
   const strategistAgent = new StrategistAgent({ modelClient });
   const architectAgent = new ArchitectAgent({ modelClient });
   ```
4. Pass them to `createAgentBackedResumeGenerationService()`.

## Frontend Contract

Frontend-oriented TypeScript contracts live in `src/api-contracts/`. They define request and response shapes only; there is no HTTP server.

`GenerateResumeResponse` uses artifact bundles so the frontend can render a generated bullet and open its right-side evidence panel without joining arrays itself:

```ts
{
  artifact: GeneratedArtifact;
  evidenceChain: EvidenceChain;
  graphView: GraphView;
}
```

Contract mappers live in `src/application/mappers/` and translate internal service results into contract responses. `CooltoDemoService` in `src/application/CooltoDemoService.ts` runs the in-memory product demo flow:

```text
raw experience -> IngestExperienceResponse -> GenerateResumeResponse
```

Use `createInMemoryCooltoDemoService()` for local prototypes and tests.

## Real Agent Demo

The deterministic demo remains the stable default path:

```bash
npm run dev:coolto-demo
```

It does not require API keys and should remain the baseline for tests and local regression checks.

The first real agent-backed demo starts only with ArchivistAgent / experience ingestion:

```bash
npm run dev:agent-ingest
```

It uses the mock provider by default. To switch providers:

```bash
DEFAULT_PROVIDER=deepseek DEFAULT_MODEL=deepseek-v4-pro npm run dev:agent-ingest
DEFAULT_PROVIDER=openrouter DEFAULT_MODEL=openai/gpt-4o-mini npm run dev:agent-ingest
```

`DEFAULT_PROVIDER=deepseek` requires `DEEPSEEK_API_KEY`. `DEFAULT_PROVIDER=openrouter` requires `OPENROUTER_API_KEY`. Core classes do not read `process.env`; demo/config code owns provider setup.

Recommended real-agent rollout order:

1. Verify `ArchivistAgent` / `AgentExperienceExtractor` with `npm run dev:agent-ingest`.
2. Then verify `StrategistAgent` / `AgentJDRequirementExtractor`.
3. Finally verify `ArchitectAgent` / `AgentArtifactGenerator`.

`createAgentBackedCooltoDemoService()` now exists as an in-memory skeleton for the complete agent-backed pipeline. It wires agent-backed ingestion, JD extraction, artifact generation, retrieval, evidence chains, graph views, and contract mapping, but the safer first validation point is still `agent-ingest-demo`.

Current non-goals remain unchanged: no frontend, no HTTP API server, no vector database, no Neo4j, and no production persistence.

## Current Non-Goals

- No frontend.
- No HTTP API server.
- No Qdrant / Cloudflare Vectorize integration.
- No Neo4j or external graph database.
- No production persistence.
- No complete RAG.
- No real embedding pipeline.
- No real user system.
- No complex multi-agent self-loop.

## Directory Structure

```text
src/
  application/           Application services, extractors, generators, mappers, factories
  core/                  Runtime interfaces and base implementations
  providers/             DeepSeek, OpenRouter, and Mock providers
  agents/                Concrete agent implementations
  tools/                 Example tools
  workflows/             Workflow placeholders
  knowledge/             Knowledge types, zod schemas, repositories, ingestion, retrieval, graph builders
  api-contracts/         Frontend-facing request and response types
  examples/              Runnable demos
  config/                Node.js environment loading
tests/                   Vitest tests
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
npm run dev:coolto-demo
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
