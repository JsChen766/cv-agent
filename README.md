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
  +-> Tools -> ToolExecutor -> AgentToolRunner
  |
  +-> MemoryManager -> StorageAdapter
  |
  +-> Orchestrator -> sequential multi-agent pipeline
```

## Tool Calling Runtime

The runtime now supports a complete OpenAI-compatible tool-calling loop:

1. `ToolDefinition` defines a tool name, description, JSON schema parameters, and `execute` function.
2. `ToolExecutor` registers tools and executes model-returned `ToolCall` objects.
3. `BaseAgent` passes tool schemas to `ModelClient.chat`.
4. `AgentToolRunner` runs the loop: agent output `toolCalls` -> execute tools -> append assistant/tool messages -> continue the agent -> final `AgentOutput`.

DeepSeek tool calls follow the OpenAI-compatible function-calling shape:

- Tools are sent as `type: "function"` schemas.
- `tool_choice` supports `auto`, `none`, `required`, or a provider-compatible string.
- Assistant messages with tool calls are preserved with `tool_calls`.
- Tool results are returned as `role: "tool"` messages with `tool_call_id` and JSON-serialized execution results.
- When reasoning is present, DeepSeek assistant messages can preserve `reasoning_content` through the tool continuation request.

Current demos:

- `npm run dev:tool`: manually constructs `ToolCall` objects and executes them with `ToolExecutor`.
- `npm run dev:agent-tool-runner`: uses a fake provider to demonstrate an agent returning `toolCalls`, automatic tool execution, tool result messages, and a final answer.

This round does not add PDF, Markdown, GitHub, or other business tools. A next step is to add text extraction tools and register them with a future `FrontDeskAgent`.

## Conversation Runtime

The conversation runtime provides the in-memory context layer that tool-calling agents can use before adding larger text-reading tools:

- `ConversationSession` manages single-run or short-term conversation messages. It stores `user`, `assistant`, and `tool` messages with `id` and `createdAt`, and can produce snapshots for future persistence.
- `AgentToolRunner` can now use a `ConversationSession` to preserve user input, assistant tool-call messages, and tool result messages across tool rounds. `finalMessages` is derived from the session.
- `TokenBudgetManager` provides conservative char-based approximate token estimation with trimming by message count and approximate token budget. It defaults to preserving system and recent messages while allowing long tool results to be removed.
- `ContextAssembler` builds the final model context from a session plus optional injected context. It is the placeholder path for future retrieval chunks, user profiles, style memory, experience evidence, and task constraints.
- `ConversationRepository` and `InMemoryConversationRepository` define the persistence boundary without connecting a database. `ContextProvider` and `NoopContextProvider` define the future retrieval or long-term memory injection boundary.

This is not a long-term memory system yet. It is runtime context management. Future PDF, Markdown, GitHub, or other text-reading tools should avoid permanently stuffing large raw outputs into messages. Large text should be controlled through retrieval and `ContextAssembler` injections.

Demo:

```bash
npm run dev:conversation-runtime
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
  coverageReport: ArtifactCoverageReport;
  coverageGapReport: CoverageGapReport;
  critiqueReport: ArtifactCritiqueReport;
}
```

The artifact, evidence-chain, and graph-view array lengths are kept aligned by index. It no longer returns single `artifact`, `evidenceChain`, or `graphView` compatibility fields. `coverageReport` describes whole-JD requirement coverage, `coverageGapReport` suggests how to handle uncovered requirements, and `critiqueReport` reviews artifact quality without modifying generated content.

## Dual Implementation Architecture

The pipeline now supports **two implementations** for each key processing step:

### Deterministic implementation (default, for demo/tests)

Rule-based extraction without any LLM calls. Used by `createInMemoryCooltoDemoService()` and all existing tests.

| Component | Class | Location |
|---|---|---|
| Experience extraction | `DeterministicExperienceExtractor` | `src/knowledge/ingestion/extractors/` |
| JD requirement extraction | `DeterministicJDRequirementExtractor` | `src/application/extractors/` |
| Artifact generation | `DeterministicArtifactGenerator` | `src/application/generators/` |
| Coverage evaluation | `ArtifactCoverageEvaluator` | `src/application/evaluation/` |
| Coverage gap advice | `DeterministicCoverageGapAdvisor` | `src/application/coverage-gaps/` |
| Artifact critique | `DeterministicArtifactCritic` | `src/application/critique/` |

### Agent-backed implementation (for real LLM integration)

Calls a `BaseAgent` subclass and validates the JSON output with zod schemas. Throws on invalid output — no silent fallback.

| Component | Agent used | Class | Location |
|---|---|---|---|
| Experience extraction | `ArchivistAgent` (or any `BaseAgent`) | `AgentExperienceExtractor` | `src/knowledge/ingestion/extractors/` |
| JD requirement extraction | `StrategistAgent` (or any `BaseAgent`) | `AgentJDRequirementExtractor` | `src/application/extractors/` |
| Artifact generation | `ArchitectAgent` (or any `BaseAgent`) | `AgentArtifactGenerator` | `src/application/generators/` |
| Coverage gap advice | any `BaseAgent` | `AgentCoverageGapAdvisor` | `src/application/coverage-gaps/` |
| Artifact critique | `CriticAgent` (or any `BaseAgent`) | `AgentArtifactCritic` | `src/application/critique/` |

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
  criticAgent,       // Optional CriticAgent instance
  useAgentCritic,    // Optional; defaults to false, deterministic critic is used otherwise
  coverageGapAgent,  // Optional BaseAgent for coverage gap advice
  useAgentCoverageGapAdvisor, // Optional; defaults to false
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

The same response also includes `coverageReport` for whole-JD requirement coverage, `coverageGapReport` for uncovered-requirement suggestions, and `critiqueReport` for artifact-level review verdicts.

Contract mappers live in `src/application/mappers/` and translate internal service results into contract responses. `CooltoDemoService` in `src/application/CooltoDemoService.ts` runs the in-memory product demo flow:

```text
raw experience -> IngestExperienceResponse -> GenerateResumeResponse
```

Use `createInMemoryCooltoDemoService()` for local prototypes and tests.

## Real Agent Demo

The deterministic demo remains the stable default path and does not require API keys:

```bash
npm run dev:coolto-demo
```

Use `agent-ingest-demo` first to validate `ArchivistAgent` / `AgentExperienceExtractor`:

```bash
npm run dev:agent-ingest
```

It defaults to `DEFAULT_PROVIDER=mock`. To run it with a real provider on Windows PowerShell:

```powershell
$env:DEFAULT_PROVIDER="deepseek"
$env:DEFAULT_MODEL="deepseek-v4-pro"
$env:DEEPSEEK_API_KEY="your_api_key"
npm run dev:agent-ingest
```

On macOS / Linux:

```bash
DEFAULT_PROVIDER=deepseek DEFAULT_MODEL=deepseek-v4-pro DEEPSEEK_API_KEY=your_api_key npm run dev:agent-ingest
```

For OpenRouter, set `DEFAULT_PROVIDER=openrouter`, `DEFAULT_MODEL=openai/gpt-4o-mini`, and `OPENROUTER_API_KEY`.

Use `agent-coolto-demo` after ingest is stable to run the complete agent-backed pipeline:

```bash
npm run dev:agent-coolto
```

It also defaults to mock and can be switched to DeepSeek or OpenRouter with the same environment variables. It is a manual demo and is not a test dependency.

Recommended real-agent debugging order:

1. Verify `ArchivistAgent` / `AgentExperienceExtractor` with `npm run dev:agent-ingest`.
2. Tune `ArchivistAgent` prompt from the extracted experience/evidence output.
3. Run `npm run dev:agent-coolto`.
4. Tune `StrategistAgent` / `AgentJDRequirementExtractor` and `ArchitectAgent` / `AgentArtifactGenerator` from requirements and artifact bundles.

Agent JSON output is parsed through `parseAgentJson`, which handles JSON code fences, short explanatory text before or after the JSON, and object/array root validation. Prompts still require pure JSON because tolerant parsing is only a recovery layer.

Evidence alignment and risk calibration are intentionally conservative:

- `ExperienceIngestionService` runs `EvidenceCompletenessGuard` after extraction. The guard only restores important source sentences already present in `rawText`; it does not invent or paraphrase new evidence. This prevents agent `evidenceExcerpts` under-recall from leaving skills such as Accessibility or API Integration with empty `evidenceIds`, improving downstream artifact coverage and evidence-chain completeness.
- `AgentArtifactGenerator` filters illegal IDs returned by the model, then tries to fill related `sourceEvidenceIds` from artifact content and matched skills. It only links existing evidence IDs and does not invent evidence. Broad requirements such as collaboration, adoption, product impact, or organization-wide scope are kept only when both artifact content and linked evidence explicitly support them.
- `EvidenceChainBuilder` evaluates only the requirements listed in `artifact.targetRequirementIds` when present, so one artifact is not penalized for failing to cover the entire JD. It also warns on unsupported numbers, unsupported broad requirements, organization-wide/company-wide scope expansion, and high-risk claim phrases.
- `ExperienceIngestionService` builds STAR fields with separate scoring for situation, task, action, and result. Result selection now prefers outcome/metric evidence such as "reduced", "improved", percentages, or "from X to Y" changes.

Coverage and critique now happen after artifact generation:

- `ArtifactCoverageEvaluator` produces an `ArtifactCoverageReport` for the whole generated result. Requirement statuses are `covered`, `weakly_covered`, `evidence_available_but_not_used`, `no_evidence`, and `not_targeted`.
- `covered` means a generated artifact targets the requirement and the matching evidence chain has supporting evidence, a match score of at least 0.5, and low risk.
- `weakly_covered` means an artifact targets the requirement, but evidence is missing or weak, match score is below 0.5, risk is not low, or broad requirement support is not explicit enough.
- `evidence_available_but_not_used` means retrieved experience/skill evidence exists but no artifact targets the requirement.
- `no_evidence` means the retrieved experience set does not currently support the requirement.
- `CoverageGapAdvisor` produces a `CoverageGapReport` from the coverage report. For `evidence_available_but_not_used`, it creates conservative supplemental artifact suggestions that cite existing evidence IDs only. For `no_evidence`, it creates evidence request prompts that ask the user to add a real experience or metric instead of forcing a claim into the resume. These suggestions are not added to the main `artifacts` array or saved to the artifact repository.
- `ArtifactCritic` produces an `ArtifactCritiqueReport`. The default demo path uses `DeterministicArtifactCritic` for stable local output; future agent-backed critique can use `AgentArtifactCritic` with `CriticAgent`.
- `CriticAgent` is JSON-only and reviews artifacts from `EvidenceChain` plus `ArtifactCoverageReport`. It does not edit artifacts or generate replacements; it only returns pass/revise/reject decisions and conservative rewrite suggestions.

`createAgentBackedCooltoDemoService()` now exists as an in-memory skeleton for the complete agent-backed pipeline. It wires agent-backed ingestion, JD extraction, artifact generation, retrieval, evidence chains, graph views, and contract mapping, but the safer first validation point is still `agent-ingest-demo`.

Current non-goals remain unchanged: no frontend, no HTTP API server, no vector database, no Neo4j, and no production persistence.

## Generation Session and User Decisions

`GenerationSession` stores one complete `GenerateResumeResponse` plus user decision state for a future interactive review flow. Decisions are separate from the generated objects, so accepting or rejecting a bullet does not mutate the original artifact bundle.

- `ArtifactDecision` supports `accepted`, `rejected`, and `needs_revision`, with `undecided` as the default session state.
- `CoverageGapDecision` supports `generate_supplemental_artifact`, `request_more_evidence`, `ignore`, and `mark_not_relevant`, with `undecided` as the default.
- `SupplementalArtifactDraft` is created only when the user explicitly chooses to generate a supplemental artifact from a coverage gap suggestion. Drafts stay in `supplementalArtifactDrafts`; they are not merged into the main `generation.artifacts` array and are not saved to the artifact repository.
- Session decision inputs are runtime-validated with zod, so empty IDs and `undecided` user submissions are rejected before state changes.
- `InMemoryGenerationSessionRepository` is the current storage layer. There is no database, frontend, or HTTP API server.
- `src/api-contracts/session.ts` exposes request/response types for future API wiring.
- Deterministic demo bullets are generated from source evidence excerpts instead of mechanical matched-skill summaries, so local product demos look closer to real resume content.

Run the default local session demo. It uses the real deterministic generation result and does not inject artificial coverage gaps:

```bash
npm run dev:generation-session
```

Run the forced-gap session demo when you specifically want to demonstrate supplemental draft creation:

```bash
npm run dev:generation-session-forced-gap
```

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
npm run dev:agent-tool-runner
npm run dev:memory
npm run dev:knowledge
npm run dev:knowledge-pipeline
npm run dev:coolto-demo
npm run dev:generation-session
npm run dev:generation-session-forced-gap
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
