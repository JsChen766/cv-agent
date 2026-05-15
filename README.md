# Coolto Agent Runtime

TypeScript agent runtime foundation for Coolto. The project currently focuses on runtime primitives, document ingestion, a deterministic knowledge pipeline, generation persistence, and a thin backend API. It still avoids frontend code, full auth, real vector databases, Neo4j, pgvector, and production file storage.

P8.6 LLM-backed CriticAgent is implemented. The default path remains deterministic; LLM artifact generation and LLM critique are opt-in through `ARTIFACT_GENERATOR_MODE=llm` and `CRITIC_AGENT_MODE=llm`.

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
3. `BaseAgent` passes tool schemas to `ModelClient.chat`. `runWithMessages()` lets runners and orchestrators provide a complete message context directly while still prepending the agent system prompt.
4. `AgentToolRunner` runs the loop: agent output `toolCalls` -> execute tools -> append assistant/tool messages -> continue the agent -> final `AgentOutput`.

DeepSeek tool calls follow the OpenAI-compatible function-calling shape:

- Tools are sent as `type: "function"` schemas.
- `tool_choice` supports `auto`, `none`, `required`, or a provider-compatible string.
- Assistant messages with tool calls are preserved with `tool_calls`.
- Tool results are returned as `role: "tool"` messages with `tool_call_id` and JSON-serialized execution results.
- When reasoning is present, DeepSeek assistant messages can preserve `reasoning_content` through the tool continuation request.
- `AgentToolRunner` uses `BaseAgent.runWithMessages()` internally, so it does not need runner-specific flags in `AgentInput`. `skipAppendingUserContent` remains available for compatibility, but new runner/orchestrator code should prefer `runWithMessages()`.

Current demos:

- `npm run dev:tool`: manually constructs `ToolCall` objects and executes them with `ToolExecutor`.
- `npm run dev:agent-tool-runner`: uses a fake provider to demonstrate an agent returning `toolCalls`, automatic tool execution, tool result messages, and a final answer.

Business document tools now live under `src/tools/document/`. They are still parser-only tools: they do not call agents or write Experience/Evidence records.

## Text Tool Strategy

Future text-reading tools should return `ExtractedTextDocument` from `src/tools/text/types.ts`:

```ts
{
  documentId: string;
  sourceType: "manual_text" | "markdown" | "pdf_text" | "docx_text" | "github_text";
  title?: string;
  text: string;
  textPreview: string;
  textLength: number;
  sourceRef: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

Text tools may return the full `text`, but agents and orchestrators should not permanently stuff large extracted text into `ConversationSession`. Long text should be controlled before it enters the model context through `TokenBudgetManager`, `ContextAssembler`, and a future `ExtractedDocumentStore` or retrieval layer. Tool responses should include `textPreview`, `textLength`, `metadata`, `sourceRef`, and `sourceType` so callers can inspect and route large documents without relying on the full text every turn.

Text-reading tools do not call `ArchivistAgent`, write `Experience` or `Evidence` records, or decide whether text is resume experience. Those decisions belong to `FrontDeskAgent`, an orchestrator, or `ExperienceIngestionService`.

## Agent Side Product Kernel v0.2

The project now includes a minimal product kernel that can ingest real document inputs and expose them through a thin HTTP API:

- `src/tools/document/` defines `DocumentInput`, `ExtractedTextDocument`, `DocumentParserRegistry`, and `DocumentLoaderTool`.
- `DocumentLoaderTool` accepts file-facing inputs (`filePath`, `buffer`, future `url`) and routes by `mimeType`, `extension`, or `fileName`.
- Markdown, plain text, PDF, and DOCX parsing are implemented. PDF uses text extraction only; scanned/image-only PDFs return `PDF contains no extractable text. Scanned or image-based PDFs are not supported.` DOCX uses Mammoth raw-text extraction and returns warnings in metadata when Mammoth reports them.
- Document parsing returns full `text`, `textPreview`, `textLength`, `sourceRef`, `sourceType`, and parser metadata. It does not call `ArchivistAgent` and does not write Experience or Evidence records.
- `FrontDeskAgent` classifies user intent into structured `FrontDeskDecision` JSON, validated with zod.
- `FrontDeskOrchestrator` executes the decision by calling document loading, `ExperienceIngestionService`, and `ResumeGenerationService`. It supports multi-document `ingest_resume_document` and multiple experiences per document, keeping first-experience compatibility fields while returning `extractedDocuments`, `experiences`, and per-document results.
- Query services under `src/application/query/` expose persisted evidence-chain and graph-view snapshots for `explain_evidence_chain` and `show_experience_graph`.
- `src/persistence/sqlite/` provides SQLite-backed repositories for experiences, evidences, skills, JD requirements, and generated artifacts. It uses `sql.js` so the kernel can run on Node 20 without native SQLite bindings.
- `DocumentIngestionService` is the persistence wrapper for documents. `DocumentLoaderTool` still only parses files; saving the parsed document is an application-service concern.
- `GenerationPersistenceService` saves generation sessions, evidence-chain snapshots, graph-view snapshots, and artifact bundle links after `ResumeGenerationService` has produced the generation result.

Run the kernel demo:

```bash
npm run dev:agent-kernel
```

The demo imports a simulated Markdown resume document, extracts text, ingests Experience/Evidence/Skill records into SQLite, generates resume artifacts for a JD, and prints frontend-consumable JSON containing artifacts, evidence chains, graph views, coverage, gap, and critique reports.

Run the multi-document ingestion demo:

```bash
npm run dev:multi-document-ingestion
```

It ingests `resume.md` and `project-note.txt`, creates one or more experiences per source document, merges evidence and skills, and prints a compact JSON summary with source document ids.

## Minimal Backend API

The API is intentionally thin. It uses cv-agent as an Agent Kernel / SDK: routes parse HTTP requests, resolve identity through an `AuthResolver`, build a `KernelRequestContext`, and delegate to the stable `CvAgentKernel` facade. There is no full auth system, frontend, production file storage, Neo4j, pgvector, Prisma, Drizzle, TypeORM, or database-level foreign keys.

Keep this boundary for future backend work:

```text
HTTP layer -> AuthResolver -> KernelRequestContext -> CvAgentKernel -> Agent/Application services -> Repositories
```

Routes should call `kernel.cvAgentKernel`, not low-level repositories or internal services. `ApiKernel` still exposes internal service fields during migration for tests and demos, but they are not the route-facing contract. In PostgreSQL mode, generation persistence uses `createPostgresGenerationPersistenceService(database)` so generation sessions, evidence-chain snapshots, graph-view snapshots, and bundles are saved in one transaction. In `in_memory` mode, the kernel uses the generic non-transactional `GenerationPersistenceService`.

### P8.0 Contract Hardening

This repository now implements the P8.0 contract hardening layer from `docs/CONTRACT.md`:

- `src/kernel/context.ts` defines `KernelRequestContext` and `createTestKernelContext()`.
- `src/kernel/` exposes the `CvAgentKernel` facade for document ingestion, generation, evidence-chain queries, graph queries, health, and close.
- `src/api/auth/` defines the `AuthResolver` abstraction. `AUTH_MODE=dev_header` reads `x-user-id` and is development/test only. `AUTH_MODE=cookie_session` is an explicit stub that returns `INVALID_AUTH` until real auth is implemented.
- API routes return the response envelope `{ ok, data, meta }` or `{ ok: false, error, meta }`.
- `docs/CONTRACT.md` is the source of truth for backend/API/kernel boundaries.

`AUTH_MODE` defaults to `dev_header` outside production so local development and tests remain simple. In `NODE_ENV=production`, `AUTH_MODE` must be set explicitly. `bearer_token` and `service` are reserved but not implemented yet. Do not treat `x-user-id` as production authentication.

Run it:

```bash
npm run dev:api
```

`DATABASE_URL` is optional. If it is missing, the API starts in `in_memory` mode. If set, the API initializes the PostgreSQL schema and uses Postgres repositories.

Health:

```bash
curl http://127.0.0.1:3000/health
```

Successful responses use this envelope:

```ts
{
  ok: true;
  data: unknown;
  meta: {
    requestId: string;
    traceId?: string;
    mode: "postgres" | "in_memory";
    warnings?: string[];
  };
}
```

Error responses use:

```ts
{
  ok: false;
  error: {
    code: string;
    message: string;
  };
  meta: {
    requestId: string;
    traceId?: string;
    mode: "postgres" | "in_memory";
  };
}
```

Ingest a text or Markdown document:

```bash
curl -X POST http://127.0.0.1:3000/documents/ingest \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d "{\"fileName\":\"resume.md\",\"mimeType\":\"text/markdown\",\"text\":\"# Resume\nBuilt React and TypeScript systems.\"}"
```

Generate artifacts:

```bash
curl -X POST http://127.0.0.1:3000/generations \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d "{\"jdText\":\"React TypeScript performance role\",\"targetRole\":\"Frontend Engineer\"}"
```

Query persisted evidence chains and graph snapshots:

```bash
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/generations/:sessionId/evidence-chains
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/graphs/:scopeType/:scopeId
```

`/documents/ingest` currently supports JSON input with either `text` or `base64`. Multipart upload and production file storage are future work.

## Persistence Strategy

- `InMemory` repositories are for deterministic tests and small demos.
- `SQLite/sql.js` repositories are the local demo adapter. They remain in place and are not the production storage target.
- `PostgreSQL` is the production storage direction. The current adapter uses lightweight SQL through `pg`, not Prisma, Drizzle, TypeORM, or an HTTP server.
- Graph DB is not introduced yet. `GraphView` is currently a projection/snapshot persisted for frontend display, not a Neo4j-backed graph model.

### No database-level foreign keys

The PostgreSQL schema intentionally avoids database foreign keys. Referential integrity is enforced at the application/service layer. The reason: historical agent snapshots, evidence chains, graph projections, and generated artifacts must stay stable even if source records are edited or deleted. Do not add FOREIGN KEY / REFERENCES unless the persistence strategy is explicitly changed.

### API-safe repository usage

Future backend/API code must use user-scoped repository methods such as `getByIdForUser(userId, id)` and `deleteForUser(userId, id)` instead of exposing legacy `getById(id)` / `delete(id)` methods directly. Legacy methods exist only to satisfy current repository interfaces and are annotated as such. See `PostgresExperienceRepository`, `PostgresEvidenceRepository`, `PostgresGeneratedArtifactRepository`, `PostgresSkillRepository`, and `PostgresJDRequirementRepository` for the annotation pattern.

### Document lineage

Document ingestion links parsed documents to generated `Experience` and `Evidence` records through `sourceDocumentId`. Experience and Evidence metadata now stores document, parser, source, and chunk information from the ingestion pipeline:

- `Experience.metadata.document`: file name, source type, parser, text length.
- `Evidence.metadata.chunk`: evidence index and excerpt length within the source document.
- `Evidence.metadata.document`: same document metadata for direct evidence-to-document traceability.

`FrontDeskOrchestrator` and `postgres-kernel-demo` pass `documentMetadata` from `DocumentIngestionService` results into `ExperienceIngestionService.ingest()` so the full document lineage is recorded.

### Generation persistence

The generic `GenerationPersistenceService` does not own transaction boundaries; it performs sequential writes through the provided repositories. For PostgreSQL, always use `createPostgresGenerationPersistenceService(database)` so that all session, snapshot, and bundle writes share the same transaction. The factory creates transaction-scoped repositories inside `database.transaction`. The backend API's Postgres kernel path uses this factory through the `GenerationPersistencePort` interface.

### Migrations

`schema.sql` is the full schema for new databases. The `migrations/` directory under `src/persistence/postgres/` is reserved for incremental schema changes:

- `0001_initial_schema.sql` — baseline marker (new databases use schema.sql).
- `0002_add_generation_session_generation.sql` — example incremental migration for the generation column.

`PostgresDatabase.initializeSchema()` runs `schema.sql`. `PostgresDatabase.runMigrations()` runs `schema.sql` plus all `*.sql` files in `migrations/` in filename order. Migration statements are split on semicolons for simple multi-statement execution. For future migrations, add a new numbered file in `migrations/` and call `runMigrations()`.

PostgreSQL schema lives in `src/persistence/postgres/schema.sql` and is repeatable with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. It includes:

- `documents` for uploaded source metadata, extracted text, parser status, previews, and parser metadata.
- `experiences`, `evidences`, `skills`, `jd_requirements`, and `generated_artifacts` for the core knowledge records.
- `jd_profiles` for preserving a JD input separately from extracted requirements.
- `generation_sessions`, `generation_artifact_bundles`, `evidence_chain_snapshots`, and `graph_view_snapshots` for reloadable generation records that a future frontend can show without recomputing every chain or graph.
- `artifact_decisions`, `coverage_gap_decisions`, and `agent_runs` for future review workflow and audit/debug data.

`generation_sessions` keeps distinct JSONB fields:

- `input`: lightweight input summary for querying and audit.
- `generation`: complete generated result snapshot.
- `result_summary`: list-page/query summary counts.

Use `createPostgresGenerationPersistenceService(database)` for PostgreSQL generation persistence so session, evidence-chain snapshots, graph snapshots, and bundle rows are written in one transaction.

Run the PostgreSQL kernel demo:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/cv_agent npm run dev:postgres-kernel
```

If `DATABASE_URL` is not set, the demo exits cleanly with a setup hint. It still uses deterministic/mock agents and does not call DeepSeek.

Run the optional real PostgreSQL integration test:

```bash
RUN_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://user:pass@localhost:5432/cv_agent npm run test -- PostgresRepositories.integration.test.ts
```

Current non-goals remain: no frontend, no full auth system, no Neo4j, no pgvector, no production file storage, no database-level foreign keys, and no scanned PDF OCR.

## Conversation Runtime

The conversation runtime provides the in-memory context layer that tool-calling agents can use before adding larger text-reading tools:

- `ConversationSession` manages single-run or short-term conversation messages. It stores `user`, `assistant`, and `tool` messages with `id` and `createdAt`, and can produce snapshots for future persistence.
- `AgentToolRunner` can now use a `ConversationSession` to preserve user input, assistant tool-call messages, and tool result messages across tool rounds. `finalMessages` is derived from the session. When a caller provides an existing `ConversationSession`, `input.messages` are not appended by default to avoid duplicating prior history across repeated runs. Set `appendInputMessagesOnRun: true` when the caller explicitly wants to append those messages into the provided session. For runner-created sessions, `input.messages` are still appended by default.
- `TokenBudgetManager` provides conservative char-based approximate token estimation with trimming by message count and approximate token budget. It defaults to preserving system and recent messages while allowing long tool results to be removed.
- `ContextAssembler` builds the final model context from a session plus optional injected context. Injected context messages use temporary ids prefixed with `ctx-injection:` and keep the original injection id in `metadata.injectionId`, which keeps `removedMessageIds` and `injectedMessageIds` distinct from normal session message ids. It is the placeholder path for future retrieval chunks, user profiles, style memory, experience evidence, and task constraints.
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
| `ExperienceExtractor` | `extract(input) => Promise<ExperienceExtractionResult>` | Extract one or more structured experiences from raw text |
| `JDRequirementExtractor` | `extract(input) => Promise<ExtractJDRequirementsResult>` | Extract requirements from a job description |
| `ArtifactGenerator` | `generate(input) => Promise<GenerateArtifactsResult>` | Generate evidence-aware resume artifacts from requirements and experiences |
| `ArtifactCritic` | `critique(input) => Promise<ArtifactCritiqueReport>` | Review generated artifacts for truthfulness, evidence strength, and rewrite guidance |

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

### Agent Provider Factory

P8.1 adds `AgentProviderFactory` under `src/providers/factory/`. It centralizes `ModelClient` creation for LLM-backed agents while keeping the deterministic/mock pipeline stable.

- `AGENT_PROVIDER=mock|deepseek`
- Non-production defaults to `mock`.
- Production defaults to `deepseek` and requires `DEEPSEEK_API_KEY`.
- `DEEPSEEK_MODEL` defaults to `deepseek-chat`.
- `AGENT_TIMEOUT_MS` defaults to `30000`; `AGENT_MAX_RETRIES` defaults to `0`.
- `ALLOW_MOCK_FALLBACK` defaults to `true` outside production and `false` in production.

FrontDesk mode is now active:

- `FRONTDESK_AGENT_MODE=mock` forces `MockProvider` for `FrontDeskAgent` and does not require `DEEPSEEK_API_KEY`, even if `AGENT_PROVIDER=deepseek`.
- `FRONTDESK_AGENT_MODE=llm` uses `AgentProviderFactory`; with `AGENT_PROVIDER=deepseek` and a key, FrontDesk intent routing uses DeepSeek.
- Invalid FrontDesk JSON is parsed robustly, repaired once, then falls back to an `unknown` decision unless fallback is disabled.

Experience extractor mode is also active:

- `EXPERIENCE_EXTRACTOR_MODE=deterministic` is the default stable mode.
- `EXPERIENCE_EXTRACTOR_MODE=llm` uses `AgentProviderFactory` and `LLMExperienceExtractor`.
- LLM extraction parses JSON, validates with zod, repairs once, and falls back to deterministic extraction when fallback is enabled.
- `ExperienceExtractor.extract()` returns `ExperienceExtractionResult` with `experiences[]`; deterministic and agent-backed extractors wrap their single extraction in that result.
- `LLMExperienceExtractor` preserves every returned LLM experience instead of ingesting only the first.
- One document import can create multiple `Experience` records with separate `Evidence` records and merged/de-duplicated `Skill` records.
- `experience` remains a compatibility field for the first experience, but frontend code should prefer `experiences[]`. `documentIngestionResults[n].experiences` contains the experiences created from that source document.
- Long text may still be truncated before LLM extraction; this is not complex chunking, vector retrieval, or vector-store ingestion.
- FrontDesk and ExperienceExtractor modes are independent.

Artifact generator mode is also active:

- `ARTIFACT_GENERATOR_MODE=deterministic` is the default stable mode.
- `ARTIFACT_GENERATOR_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactGenerator`.
- LLM artifact generation allows evidence-grounded rewriting, reasonable inference, and user-confirmable enhancement candidates.
- It does not allow unsupported high-risk claims to be marked as ready-to-use bullets.
- Every generated artifact includes `sourceExperienceIds`, `sourceEvidenceIds`, and `metadata.enhancement`.
- `metadata.enhancement.status` is `ready`, `needs_confirmation`, or `unsafe`.
- `metadata.enhancement.claims[]` includes claim text, `supportLevel`, `riskLevel`, source evidence ids, and source experience ids.
- Frontends should treat `ready` as directly usable, `needs_confirmation` as requiring user confirmation or extra data, and `unsafe` as not recommended for direct use.

Critic mode is also active:

```bash
FRONTDESK_AGENT_MODE=mock|llm
EXPERIENCE_EXTRACTOR_MODE=deterministic|llm
ARTIFACT_GENERATOR_MODE=deterministic|llm
CRITIC_AGENT_MODE=deterministic|llm
```

- `CRITIC_AGENT_MODE=deterministic` is the default stable mode.
- `CRITIC_AGENT_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactCritic`.
- CriticAgent is not a RevisionAgent. It reviews artifact risk and gives suggestions; it does not rewrite final artifacts.
- The critic reads `artifact.metadata.enhancement.status`, claim `supportLevel` / `riskLevel`, `confirmationQuestions`, and evidence-chain risk.
- Critique output includes `verdict`, `unsupportedClaims`, `missingEvidence`, `rewriteSuggestions`, and optional `claimReviews`, `safeRewriteSuggestion`, and `confirmationQuestions`.
- Deterministic no-evidence draft artifacts are marked consistently as `needs_review` with `metadata.enhancement.status=needs_confirmation`.

Common configurations:

```bash
# Local default
AGENT_PROVIDER=mock
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic

# Local FrontDesk LLM fallback test
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
AGENT_PROVIDER=deepseek
ALLOW_MOCK_FALLBACK=true

# Real DeepSeek ArtifactGenerator only
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false

# Real DeepSeek CriticAgent only
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false

# Real DeepSeek ExperienceExtractor only
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false

# Real DeepSeek FrontDesk
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
ALLOW_MOCK_FALLBACK=false

# Real DeepSeek full P8 chain
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false

# Production recommendation
NODE_ENV=production
AUTH_MODE=cookie_session
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false
```

### Connecting real LLMs (DeepSeek / OpenRouter)

1. Set API keys in `.env`: `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY`.
2. Create a `ModelClient` through `AgentProviderFactory` for DeepSeek:
   ```ts
   const { modelClient } = AgentProviderFactory.create({
     provider: "deepseek",
     apiKey: process.env.DEEPSEEK_API_KEY,
     model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
     allowMockFallback: false,
   });
   ```
3. Create agents with that client:
   ```ts
   const strategistAgent = new StrategistAgent({ modelClient });
   const architectAgent = new ArchitectAgent({ modelClient });
   ```
4. Pass them to `createAgentBackedResumeGenerationService()`.

Optional DeepSeek smoke demo:

```bash
RUN_DEEPSEEK_SMOKE=1 DEEPSEEK_API_KEY=your_api_key npm run dev:deepseek-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:deepseek-smoke` exits cleanly with a skipped message. The default test suite does not call DeepSeek.

Optional FrontDesk LLM smoke demo:

```bash
DEEPSEEK_API_KEY=your_api_key npm run dev:frontdesk-llm-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:frontdesk-llm-smoke` exits cleanly with a skipped message.

Optional ExperienceExtractor LLM smoke demo:

```bash
DEEPSEEK_API_KEY=your_api_key npm run dev:experience-llm-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:experience-llm-smoke` exits cleanly with a skipped message.
With a key, the smoke demo uses a short two-experience input and prints `experienceCount`, experience summaries, `evidenceCount`, skill names, and warnings without writing to a database.

Optional ArtifactGenerator LLM smoke demo:

```bash
DEEPSEEK_API_KEY=your_api_key npm run dev:artifact-llm-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:artifact-llm-smoke` exits cleanly with a skipped message. With a key, it prints artifact count, content, enhancement status, claim support levels, confirmation questions, and warnings without writing to a database.

Optional CriticAgent LLM smoke demo:

```bash
DEEPSEEK_API_KEY=your_api_key npm run dev:critic-llm-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:critic-llm-smoke` exits cleanly with a skipped message. With a key, it reviews ready, needs-confirmation, and unsafe artifacts and prints verdicts, risks, rewrite suggestions, and confirmation questions without writing to a database.

## Frontend Contract

Frontend-oriented TypeScript contracts live in `src/api-contracts/`. The minimal Fastify API in `src/api/` is a thin service boundary over the kernel; product-specific frontend contracts remain explicit and reusable.

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

`IngestExperienceResponse` and `/documents/ingest` expose `experiences[]`. The `experience` field is kept for compatibility and is always the first item when any experiences were extracted.

Generated artifacts expose evidence-aware enhancement metadata:

```ts
artifact.metadata?.enhancement = {
  status: "ready" | "needs_confirmation" | "unsafe",
  claims: [
    {
      text: string,
      supportLevel: "supported" | "inferred" | "needs_user_confirmation" | "unsupported",
      riskLevel: "low" | "medium" | "high",
      evidenceIds: string[],
      sourceExperienceIds: string[],
      userConfirmationPrompt?: string
    }
  ],
  confirmationQuestions: string[],
  enhancementStrategy: "evidence_rewrite" | "reasonable_inference" | "confirmation_needed" | "unsafe_candidate"
}
```

Critique reports expose artifact review details. `ArtifactCritiqueItem` always includes the core verdict, risks, unsupported claims, missing evidence, and rewrite suggestions. LLM-backed critique may also include:

```ts
{
  confirmationQuestions?: string[];
  safeRewriteSuggestion?: string;
  claimReviews?: Array<{
    claimText: string;
    supportLevel: "supported" | "inferred" | "needs_user_confirmation" | "unsupported";
    riskLevel: "low" | "medium" | "high";
    verdict: "pass" | "revise" | "reject";
    reason: string;
    evidenceIds: string[];
  }>;
}
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
- `ArtifactCritic` produces an `ArtifactCritiqueReport`. The default demo path uses `DeterministicArtifactCritic` for stable local output; `CRITIC_AGENT_MODE=llm` uses `LLMArtifactCritic` through `AgentProviderFactory`.
- `CriticAgent` is JSON-only and reviews artifacts from `artifact.metadata.enhancement`, `EvidenceChain`, and `ArtifactCoverageReport`. It does not edit artifacts or generate replacements; it only returns pass/revise/reject decisions, confirmation questions, claim reviews, and conservative rewrite suggestions.

`createAgentBackedCooltoDemoService()` now exists as an in-memory skeleton for the complete agent-backed pipeline. It wires agent-backed ingestion, JD extraction, artifact generation, retrieval, evidence chains, graph views, and contract mapping, but the safer first validation point is still `agent-ingest-demo`.

Current non-goals remain unchanged where they matter: no frontend, no full auth system, no vector database, no Neo4j, no pgvector, and no production file storage. The backend API is intentionally minimal.

## Generation Session and User Decisions

`GenerationSession` stores one complete `GenerateResumeResponse` plus user decision state for a future interactive review flow. Decisions are separate from the generated objects, so accepting or rejecting a bullet does not mutate the original artifact bundle.

- `ArtifactDecision` supports `accepted`, `rejected`, and `needs_revision`, with `undecided` as the default session state.
- `CoverageGapDecision` supports `generate_supplemental_artifact`, `request_more_evidence`, `ignore`, and `mark_not_relevant`, with `undecided` as the default.
- `SupplementalArtifactDraft` is created only when the user explicitly chooses to generate a supplemental artifact from a coverage gap suggestion. Drafts stay in `supplementalArtifactDrafts`; they are not merged into the main `generation.artifacts` array and are not saved to the artifact repository.
- Session decision inputs are runtime-validated with zod, so empty IDs and `undecided` user submissions are rejected before state changes.
- `InMemoryGenerationSessionRepository` remains the deterministic local storage layer, while PostgreSQL repositories provide the production storage adapter. There is still no frontend or full auth system.
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
- No full auth system.
- No Qdrant / Cloudflare Vectorize integration.
- No Neo4j or external graph database.
- No pgvector.
- No Prisma / Drizzle / TypeORM.
- No production file storage.
- No scanned PDF OCR.
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
