# Coolto Agent Runtime

TypeScript backend for a ChatGPT/Gemini-style job-search Copilot. The product entrypoint is `/copilot/chat`: users talk naturally, the LLM-first `FrontDeskAgent` produces a schema-validated decision, and `AgentRuntime` executes product/kernel tools against persisted sessions and workspace snapshots.

Current architecture:

```text
HTTP API
  -> AuthResolver
  -> Copilot API adapter (/copilot/chat, /copilot/actions, /copilot/chat/stream)
  -> AgentRuntime
  -> LLM-first FrontDeskAgent
  -> AgentToolRegistry
      -> Product tools: experiences, JDs, resumes, imports, dashboard/sidebar
      -> Kernel tools: generation, revision, evidence, decisions
  -> Product Data Layer / CvAgentKernel / repositories
```

Boundary summary:

- `AgentRuntime` is the product chat runtime and owns session loading, memory, workspace snapshots, tool execution, run logs, locks, quota checks, and response persistence.
- `FrontDeskAgent` is LLM-first. It emits structured `AgentDecision` JSON and never exposes chain-of-thought, provider raw payloads, system prompts, or tool arguments.
- `AgentToolRegistry` is the only tool boundary. LLM output can request tools, but tools own all writes.
- Product services manage durable business assets: experiences, JDs, resumes, imports, product generations, and recent read models.
- `Copilot API` is a product protocol layer, not a second business kernel.
- `CvAgentKernel` remains the lower-level kernel facade for document ingestion, generation, evidence queries, graph queries, revision, and decisions.

Key API groups:

- `/copilot/chat`, `/copilot/actions`, `/copilot/chat/stream` - conversational product entrypoints.
- `/copilot/sessions`, `/copilot/sidebar` - persisted chat/workspace read model.
- `/product/*` - structured product data APIs for experiences, JDs, resumes, imports, generations, and dashboard.
- `/jobs` - minimal background job skeleton for future long-running work.
- `/debug/agent-modes`, `/debug/agent-runs` - runtime/debug views; run logs are dev/test only by default.

Runtime modes:

- Development/production default to real LLM provider config and fail fast without required API keys.
- Mock/fake runtime is allowed only in tests or explicit local fallback.
- Deterministic kernel modes are allowed only in tests or when `ALLOW_DETERMINISTIC_RUNTIME=true` is explicitly set for local debugging.
- PostgreSQL mode runs migrations and uses Postgres repositories. Without `DATABASE_URL`, the API uses in-memory repositories for local/test work.

Minimal `.env` for local real runtime:

```env
NODE_ENV=development
AUTH_MODE=dev_header
DATABASE_URL=postgres://user:pass@localhost:5432/cv_agent
AGENT_PROVIDER=deepseek
AGENT_MODEL=deepseek-chat
AGENT_BASE_URL=https://api.deepseek.com
AGENT_API_KEY=...
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false
ALLOW_DETERMINISTIC_ROUTER=false
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PER_USER_PER_MINUTE=30
AGENT_DAILY_MESSAGE_QUOTA=200
AGENT_DAILY_TOOL_CALL_QUOTA=500
AGENT_DAILY_GENERATION_QUOTA=50
COPILOT_SESSION_LOCK_TTL_MS=60000
FINAL_ANSWER_SYNTHESIS=off
DEBUG_ROUTES_ENABLED=false
```

Local start:

```bash
npm run dev:api
```

Tests:

```bash
npm run typecheck
npm run test
```

Security constraints:

- Never return chain-of-thought, `reasoning_content`, provider raw payloads, system prompts, API keys, or internal tool arguments.
- User identity comes from `AuthResolver`, never from request body.
- PostgreSQL schema intentionally avoids database-level foreign keys.
- Tests do not require real Neon/Postgres or DeepSeek by default.

## Backend Hardening

The backend includes a shared hardening layer:

- Unified error envelope with stable error codes such as `INVALID_BODY`, `UNAUTHORIZED`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `SESSION_LOCKED`, `QUOTA_EXCEEDED`, and `INTERNAL_ERROR`.
- `Idempotency-Key` support for key mutating routes. Same user/key/body replays the cached response; same key with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- Per-session Copilot lock prevents concurrent writes to the same workspace. Lock conflicts return `409 SESSION_LOCKED`.
- Optional request rate limiting and daily agent quotas.
- Agent run and tool run logs with sanitized input/output summaries.
- Optional `FINAL_ANSWER_SYNTHESIS=llm` final response synthesis from safe summaries only.

Error response:

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Usage limit exceeded.",
    "retryable": true
  },
  "meta": {
    "requestId": "req-...",
    "traceId": "trace-...",
    "mode": "postgres"
  }
}
```

Idempotency example:

```bash
curl -X POST http://127.0.0.1:3000/copilot/actions \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -H "Idempotency-Key: accept-variant-1" \
  -d '{"sessionId":"...","action":{"type":"accept","variantId":"..."}}'
```

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

Experimental NDJSON event stream:

```bash
curl -N -X POST http://127.0.0.1:3000/generations/stream \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d "{\"jdText\":\"React TypeScript performance role\",\"targetRole\":\"Frontend Engineer\"}"
```

Each line contains `{ "event": AgentEvent }`; the final line contains `{ "final": CreateGenerationResult }`. The synchronous `/generations` endpoint remains supported. This is an Agent Event Stream for progress and final result delivery, not a raw model token stream.

Query persisted evidence chains and graph snapshots:

```bash
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/generations/:sessionId/evidence-chains
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/graphs/:scopeType/:scopeId
```

Record artifact review decisions:

```bash
curl -X POST http://127.0.0.1:3000/generations/artifacts/decisions \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d "{\"artifactId\":\"artifact-1\",\"sessionId\":\"session-1\",\"decision\":\"accept\"}"

curl -H "x-user-id: demo-user" http://127.0.0.1:3000/generations/artifacts/:artifactId/decisions
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/generations/:sessionId/artifact-decisions
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
| Artifact revision | `DeterministicArtifactRevisionAgent` | `src/application/revision/` |

### Agent-backed implementation (for real LLM integration)

Calls a `BaseAgent` subclass and validates the JSON output with zod schemas. Throws on invalid output — no silent fallback.

| Component | Agent used | Class | Location |
|---|---|---|---|
| Experience extraction | `ArchivistAgent` (or any `BaseAgent`) | `AgentExperienceExtractor` | `src/knowledge/ingestion/extractors/` |
| JD requirement extraction | `StrategistAgent` (or any `BaseAgent`) | `AgentJDRequirementExtractor` | `src/application/extractors/` |
| Artifact generation | `ArchitectAgent` (or any `BaseAgent`) | `AgentArtifactGenerator` | `src/application/generators/` |
| Coverage gap advice | any `BaseAgent` | `AgentCoverageGapAdvisor` | `src/application/coverage-gaps/` |
| Artifact critique | `CriticAgent` (or any `BaseAgent`) | `AgentArtifactCritic` | `src/application/critique/` |
| Artifact revision | Revision model client | `LLMArtifactRevisionAgent` | `src/application/revision/` |

### Abstracted interfaces (the "what")

| Interface | Method | Purpose |
|---|---|---|
| `ExperienceExtractor` | `extract(input) => Promise<ExperienceExtractionResult>` | Extract one or more structured experiences from raw text |
| `JDRequirementExtractor` | `extract(input) => Promise<ExtractJDRequirementsResult>` | Extract requirements from a job description |
| `ArtifactGenerator` | `generate(input) => Promise<GenerateArtifactsResult>` | Generate evidence-aware resume artifacts from requirements and experiences |
| `ArtifactCritic` | `critique(input) => Promise<ArtifactCritiqueReport>` | Review generated artifacts for truthfulness, evidence strength, and rewrite guidance |
| `ArtifactRevisionAgent` | `revise(input) => Promise<ArtifactRevisionResult>` | Rewrite one artifact from critique, evidence, instruction, and confirmations |

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

P8.1 added `AgentProviderFactory`; the current P10 architecture uses it as part of the real Agent Runtime. Mock/fake providers are test-only or explicit local fallback, not the default product runtime.

- `AGENT_PROVIDER=deepseek|openai|compatible|mock`
- Development and production default to `deepseek` and require `AGENT_API_KEY` or `DEEPSEEK_API_KEY`.
- Test defaults to `mock`/`fake`.
- `AGENT_MODEL` defaults to `deepseek-chat` for DeepSeek-compatible providers.
- `AGENT_BASE_URL` can override the compatible endpoint.
- `AGENT_TIMEOUT_MS` defaults to `30000`; `AGENT_MAX_RETRIES` defaults to `0`.
- `ALLOW_MOCK_RUNTIME=false` by default outside tests.
- `ALLOW_DETERMINISTIC_RUNTIME=false` by default outside tests.
- `ALLOW_DETERMINISTIC_ROUTER=false` by default.

FrontDesk mode is LLM-first:

- `FRONTDESK_AGENT_MODE=llm` is the dev/prod runtime path.
- `FRONTDESK_AGENT_MODE=fake|mock` is allowed only in `NODE_ENV=test` or when `ALLOW_MOCK_RUNTIME=true`.
- Invalid FrontDesk JSON is schema-validated and becomes a safe clarification unless deterministic fallback is explicitly enabled.

Experience extractor mode is also active. In development and production, deterministic kernel modes require explicit `ALLOW_DETERMINISTIC_RUNTIME=true`; product-quality runtime should use `llm`.

- `EXPERIENCE_EXTRACTOR_MODE=deterministic` is allowed in tests or explicit local debugging.
- `EXPERIENCE_EXTRACTOR_MODE=llm` uses `AgentProviderFactory` and `LLMExperienceExtractor`.
- LLM extraction parses JSON, validates with zod, repairs once, and falls back to deterministic extraction when fallback is enabled.
- `ExperienceExtractor.extract()` returns `ExperienceExtractionResult` with `experiences[]`; deterministic and agent-backed extractors wrap their single extraction in that result.
- `LLMExperienceExtractor` preserves every returned LLM experience instead of ingesting only the first.
- One document import can create multiple `Experience` records with separate `Evidence` records and merged/de-duplicated `Skill` records.
- `experience` remains a compatibility field for the first experience, but frontend code should prefer `experiences[]`. `documentIngestionResults[n].experiences` contains the experiences created from that source document.
- Long text may still be truncated before LLM extraction; this is not complex chunking, vector retrieval, or vector-store ingestion.
- FrontDesk and ExperienceExtractor modes are independent.

Artifact generator mode is also active:

- `ARTIFACT_GENERATOR_MODE=deterministic` is allowed in tests or explicit local debugging.
- `ARTIFACT_GENERATOR_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactGenerator`.
- LLM artifact generation allows evidence-grounded rewriting, reasonable inference, and user-confirmable enhancement candidates.
- It does not allow unsupported high-risk claims to be marked as ready-to-use bullets.
- Every generated artifact includes `sourceExperienceIds`, `sourceEvidenceIds`, and `metadata.enhancement`.
- `metadata.enhancement.status` is `ready`, `needs_confirmation`, or `unsafe`.
- `metadata.enhancement.claims[]` includes claim text, `supportLevel`, `riskLevel`, source evidence ids, and source experience ids.
- Frontends should treat `ready` as directly usable, `needs_confirmation` as requiring user confirmation or extra data, and `unsafe` as not recommended for direct use.

Critic mode is also active:

```bash
FRONTDESK_AGENT_MODE=llm|fake|mock
EXPERIENCE_EXTRACTOR_MODE=deterministic|llm
ARTIFACT_GENERATOR_MODE=deterministic|llm
CRITIC_AGENT_MODE=deterministic|llm
REVISION_AGENT_MODE=deterministic|llm
```

- `CRITIC_AGENT_MODE=deterministic` is allowed in tests or explicit local debugging.
- `CRITIC_AGENT_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactCritic`.
- CriticAgent is not a RevisionAgent. It reviews artifact risk and gives suggestions; it does not rewrite final artifacts.
- The critic reads `artifact.metadata.enhancement.status`, claim `supportLevel` / `riskLevel`, `confirmationQuestions`, and evidence-chain risk.
- Critique output includes `verdict`, `unsupportedClaims`, `missingEvidence`, `rewriteSuggestions`, and optional `claimReviews`, `safeRewriteSuggestion`, and `confirmationQuestions`.
- Deterministic critic also performs a numeric secondary check: numbers in artifact content that are absent from cited evidence require confirmation unless enhancement metadata already marks the claim as `needs_user_confirmation` or `unsupported`.
- Deterministic no-evidence draft artifacts are marked consistently as `needs_review` with `metadata.enhancement.status=needs_confirmation`.
- `REVISION_AGENT_MODE=deterministic` is allowed in tests or explicit local debugging.
- `REVISION_AGENT_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactRevisionAgent`.
- RevisionAgent consumes an artifact, critique item, evidence chain, user instruction, and optional user confirmations, then returns a revised `GeneratedArtifact`.
- RevisionAgent supports `make_more_conservative`, `remove_unsupported_claims`, `apply_user_confirmation`, `make_more_quantified`, `align_to_requirement`, `rewrite_for_tone`, and `custom`.
- Revised artifacts preserve `sourceExperienceIds`, `sourceEvidenceIds`, `metadata.enhancement`, and add `metadata.revision`.
- CriticAgent reviews risk and suggestions; RevisionAgent performs the rewrite.

Common configurations:

```bash
# Local real Agent Runtime
AGENT_PROVIDER=deepseek
AGENT_MODEL=deepseek-chat
AGENT_API_KEY=...
AGENT_BASE_URL=https://api.deepseek.com
FRONTDESK_AGENT_MODE=llm
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false
ALLOW_DETERMINISTIC_ROUTER=false
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm

# Test-only fake runtime
NODE_ENV=test
TEST_MODEL_PROVIDER=fake
FRONTDESK_AGENT_MODE=fake
ALLOW_MOCK_RUNTIME=true
ALLOW_DETERMINISTIC_RUNTIME=true
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
REVISION_AGENT_MODE=deterministic

# Local debugging: real DeepSeek ArtifactGenerator only
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=deterministic
REVISION_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=true

# Local debugging: real DeepSeek CriticAgent only
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=true

# Local debugging: real DeepSeek ExperienceExtractor only
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
REVISION_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=true

# Local debugging: real DeepSeek FrontDesk only
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
REVISION_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
AGENT_MODEL=deepseek-chat
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=true

# Real DeepSeek full P8 chain
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false

# Production recommendation
NODE_ENV=production
AUTH_MODE=cookie_session
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
AGENT_API_KEY=...
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false
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

Optional RevisionAgent LLM smoke demo:

```bash
DEEPSEEK_API_KEY=your_api_key npm run dev:revision-llm-smoke
```

Without `DEEPSEEK_API_KEY`, `npm run dev:revision-llm-smoke` exits cleanly with a skipped message. With a key, it revises a needs-confirmation artifact into safer wording and prints revised content, enhancement status, claim support levels, confirmation questions, and warnings without writing to a database.

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

Artifact revision is exposed through:

```http
POST /generations/artifacts/revise
```

The request body contains the current `artifact`, optional `critiqueItem`, optional `evidenceChain`, a revision `instruction`, optional `customInstruction`, optional `targetRequirementIds`, optional `userConfirmations`, and optional `tone`. The backend uses the authenticated `ctx.user.id`; if `artifact.userId` does not match the authenticated user, the API returns `FORBIDDEN`.

Example request:

```json
{
  "artifact": { "...": "GeneratedArtifact" },
  "critiqueItem": { "...": "ArtifactCritiqueItem" },
  "evidenceChain": { "...": "EvidenceChain" },
  "instruction": "make_more_conservative",
  "tone": "conservative",
  "userConfirmations": [
    {
      "metric": "report preparation time",
      "value": "from 2 hours to 20 minutes",
      "explanation": "Confirmed by internal workflow logs."
    }
  ]
}
```

Response data includes `revisedArtifact`, `metadata.revision`, `metadata.enhancement`, and `warnings`. The current minimal API allows the frontend to pass `artifact`, `evidenceChain`, and `critiqueItem` directly; a production version should prefer `artifactId`/`sessionId` and load records server-side by authenticated `userId`.

### Streaming Strategy

Current production-facing streaming strategy is the Agent Event Stream. `POST /generations/stream` emits public backend process events such as `kernel.started`, `agent.started`, `tool.completed`, `artifact.candidate.created`, `artifact.critique.completed`, `artifact.revision.completed`, `decision.required`, `kernel.completed`, followed by the final generation result. It is not LLM token streaming.

The kernel can emit public agent events for frontend progress display. These events intentionally do not expose model raw chain-of-thought. They may include public step summaries such as `agent.started`, `agent.completed`, `tool.started`, `tool.completed`, `llm.delta`, `llm.preview.completed`, `artifact.candidate.created`, `artifact.critique.completed`, `artifact.revision.completed`, `decision.required`, and `warning`.

`POST /generations/stream` is the experimental NDJSON endpoint for this stream. Each event contains ids, timestamps, request/trace ids, agent/tool names, step, status, message, and safe summary data such as counts, artifact ids, statuses, short previews capped at 120 characters, and warnings.

Provider-level token streaming is separate. `ModelClient.stream()` and `DeepSeekProvider.stream()` can produce token deltas, and `collectStreamPreview()` is retained as an experimental/future helper for bounded safe previews. It is not wired into `FrontDeskAgent`, `ExperienceExtractor`, `ArtifactGenerator`, `CriticAgent`, or `RevisionAgent` main workflows. Structured JSON agents still use `chat()` by default so parse, zod validation, post-validation, repair, and deterministic fallback remain stable. Unvalidated token deltas should not be shown as final user-facing output, and `reasoningDelta` is not surfaced by default.

Frontend validation should use `POST /generations/stream` for agent progress, `POST /generations` for non-streaming generation, `POST /generations/artifacts/revise` for artifact edits, and `POST /generations/artifacts/decisions` for accept/reject/request_revision/confirm_metric/prefer_variant feedback.

### Artifact Decisions and Variants

Artifact decisions are append-only event records created through `POST /generations/artifacts/decisions` with one of `accept`, `reject`, `request_revision`, `confirm_metric`, `mark_unsafe`, or `prefer_variant`. Decision records are scoped to the authenticated user and can be listed by artifact or session. If a user changes from reject to accept, the backend records a new decision instead of overwriting the old one. Frontend code can sort by `createdAt` and treat the last record as current state. In-memory mode uses `InMemoryArtifactDecisionRepository`; PostgreSQL mode uses `PostgresArtifactDecisionRepository` and the `artifact_decisions` table without database foreign keys. A future projection such as `current_decision_status` can be added without changing the append-only log.

Frontend variant display should treat `artifacts[]` as same-generation candidates and `revisedArtifact` as a new candidate. `artifact.metadata.revision.revisedFromArtifactId` links version lineage. `metadata.enhancement.status=ready` means the candidate can be used, `needs_confirmation` means the user should confirm first, and `unsafe` means it should not be used directly. Decision records preserve whether the user accepted, rejected, requested revision, confirmed a metric, marked unsafe, or preferred a variant.

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

Revised artifacts are normal `GeneratedArtifact` records. They preserve lineage fields and add:

```ts
artifact.metadata?.revision = {
  revisedFromArtifactId: string,
  instruction: "make_more_conservative" | "remove_unsupported_claims" | "apply_user_confirmation" | "make_more_quantified" | "align_to_requirement" | "rewrite_for_tone" | "custom",
  customInstruction?: string,
  tone?: "professional" | "concise" | "impactful" | "conservative" | "technical",
  userConfirmations: Array<{ claimText?: string, metric?: string, value?: string, explanation?: string }>,
  createdAt: string
}
```

For frontend review flows, `needs_confirmation` bullets can ask the user for a metric/value and then call the revise endpoint with `instruction=apply_user_confirmation`. The revised artifact can be sent through evidence-chain and critique flows again.

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
- `RevisionAgent` consumes the original artifact, critique item, evidence chain, user instruction, and optional confirmations. It writes a new artifact draft with preserved source ids plus `metadata.enhancement` and `metadata.revision`.

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

## P10.1 Minimal Product Asset Loop

P10.1 adds a Product Data Layer beside the Agent Kernel. The Agent Kernel still owns document ingestion, extraction, generation, critique, revision, evidence chains, and graph projections. The Product Layer owns long-lived business assets: experience library entries, JD records, resume drafts, resume item snapshots, import candidates, and generation records.

Key rules:

- Experiences are long-lived user assets in `product_experience` plus immutable `product_experience_revision` records.
- JD-tailored copy does not overwrite the experience library. Accepted output is stored as `product_resume_item.content_snapshot`.
- LLM/agent code does not write product tables directly. Writes go through Product Services and Repositories.
- PostgreSQL product tables are user-scoped and intentionally avoid database-level foreign keys.
- Default tests use in-memory repositories and deterministic/mock agents; Neon and real DeepSeek are not required.

Product tables added by migration `0004_product_asset_loop.sql`:

```text
product_experience
product_experience_revision
product_experience_variant
product_jd
product_resume
product_resume_item
product_generation
product_import_job
product_import_candidate
product_resume_template
```

Product APIs:

```text
GET/POST /product/experiences
GET/PATCH /product/experiences/:id
POST /product/experiences/:id/revisions
POST /product/experiences/:id/variants
GET/POST /product/jds
GET /product/jds/:id
GET/POST /product/resumes
GET /product/resumes/:id
POST /product/resumes/:id/items
PATCH /product/resume-items/:id
POST /product/resumes/:id/reorder
POST /product/imports/text
GET /product/imports/:id
POST /product/import-candidates/:id/accept
POST /product/import-candidates/:id/reject
POST /product/generations/from-jd
POST /product/generations/:id/accept-variant
```

Copilot now enters through `AgentRuntime` and uses `AgentToolRegistry` for product/kernel tools such as `create_experience`, `list_experiences`, `import_resume_text`, `accept_import_candidate`, `save_jd`, `list_jds`, `generate_resume_variants`, `save_variant_to_resume`, `list_resumes`, `open_resume`, `revise_variant`, `show_evidence`, and `explain_choice`. `/copilot/chat` remains the primary product entrypoint and keeps the P9 response envelope and `workspace.variants` contract.

### P10.1.5 Conversational FrontDeskAgent

`/copilot/chat` now enters through a conversational LLM-first front desk decision layer instead of treating every message as a product command or generation request. The decision schema supports `respond`, `ask_clarification`, `call_tool`, `call_tools`, `generate`, `revise`, and `explain_workspace`.

By default development and production use `FRONTDESK_AGENT_MODE=llm`. Tests may use `FRONTDESK_AGENT_MODE=fake` with `ALLOW_MOCK_RUNTIME=true`. Invalid model output is schema-validated and becomes a safe clarification unless deterministic fallback is explicitly enabled.

Product tools are used only when the user clearly asks for workspace operations such as listing experiences, saving an experience, importing resume text, saving/listing JDs, generating variants from a JD, accepting a variant, or opening resume history. Normal chat, product capability questions, resume writing guidance, job-search advice, and smalltalk return direct assistant text and do not require a JD.

`ProductIntentRouter` is legacy fallback only and is not the default brain. Responses must not expose chain-of-thought, `reasoning_content`, provider raw payloads, internal prompts, or tool arguments.

P10.1.6 adds `suggestedPrompts` for chat-only prompt chips and makes explicit workspace instructions execute directly from chat. For example, "show evidence", "why recommend the first one", "make it more conservative", "make it more quantified", and "use the first one" run against the active or first variant when available.

### P10.2 Copilot Persistence + Sidebar Read Model

P10.2 persists Copilot session state so the chat UI can restore history and workspace snapshots after refresh or service restart. The Product Layer still owns durable business assets; the Copilot layer owns chat sessions, messages, turns, workspace snapshots, and recent activity.

New Copilot persistence tables, added by `0005_copilot_persistence.sql`, are user-scoped and contain no database-level foreign keys:

```text
copilot_session
copilot_message
copilot_turn
copilot_workspace
copilot_activity
```

`CopilotSessionService` handles session creation/restoration, message storage, turn completion/failure, and session listing. `CopilotWorkspaceService` handles workspace snapshot persistence, activity writes, sidebar data, and product dashboard read models. Both in-memory and PostgreSQL implementations exist; default tests still use in-memory repositories and deterministic/mock agents.

New APIs:

```text
GET /copilot/sessions
GET /copilot/sessions/:id
PATCH /copilot/sessions/:id
GET /copilot/sidebar
GET /product/dashboard
GET /product/generations
GET /product/generations/:id
```

Examples:

```bash
curl -H "x-user-id: demo-user" "http://127.0.0.1:3000/copilot/sessions?limit=30"
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/copilot/sessions/:sessionId
curl -X PATCH http://127.0.0.1:3000/copilot/sessions/:sessionId \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d '{"title":"Frontend Engineer application","status":"active"}'
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/copilot/sidebar
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/product/dashboard
curl -H "x-user-id: demo-user" "http://127.0.0.1:3000/product/generations?limit=20"
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/product/generations/:generationId
```

`suggestedPrompts` are locale-aware. `clientState.locale=zh-CN` or primarily Chinese user text returns Chinese prompt chips. `ProductAction` and `SuggestedPrompt` are intentionally separate:

- `ProductAction` is a direct operation on the current workspace, such as accept, revise, show evidence, or explain choice. It calls `/copilot/actions`.
- `SuggestedPrompt` is recommended natural-language continuation. The frontend sends `suggestedPrompt.message` back to `/copilot/chat`; it is not an action.

### Architecture Refactor: Real Agent Runtime

P10.2 now treats Copilot as the product API name and `AgentRuntime` as the execution entrypoint.

```text
/copilot/chat
  -> CopilotApiAdapter
  -> AgentRuntime
  -> LLM-first FrontDeskAgent
  -> AgentToolRegistry
  -> Product Services / Kernel Services
```

`FrontDeskAgent` asks the configured model for a schema-validated `AgentDecision`. It can respond, ask clarification, call one or more tools, generate variants, revise a variant, or explain the workspace. It must not expose chain-of-thought, `reasoning_content`, provider raw payloads, internal prompts, or tool arguments.

`AgentToolRegistry` is the single tool boundary. Product tools cover experiences, JDs, resumes, imports, dashboard, and sidebar. Kernel tools cover resume variant generation, revision, evidence display, choice explanation, and variant decisions. LLM output can request tools, but tools own all database writes.

`ProductIntentRouter` and deterministic frontdesk behavior are not the default brain. They are legacy/test fallback paths only when explicitly enabled by env. Development and production should run with real provider config:

```bash
AGENT_PROVIDER=deepseek
AGENT_MODEL=deepseek-chat
AGENT_API_KEY=...
AGENT_BASE_URL=https://api.deepseek.com
AGENT_TEMPERATURE=0.2
AGENT_MAX_TOKENS=2000
FRONTDESK_AGENT_MODE=llm
ALLOW_MOCK_RUNTIME=false
ALLOW_DETERMINISTIC_RUNTIME=false
ALLOW_DETERMINISTIC_ROUTER=false
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
```

Test-only fake mode:

```bash
NODE_ENV=test
TEST_MODEL_PROVIDER=fake
FRONTDESK_AGENT_MODE=fake
ALLOW_MOCK_RUNTIME=true
```

#### P10.2 Architecture Closure

`AgentRuntime` is the only product chat execution entrypoint. `CopilotOrchestrator` remains a compatibility facade for the existing `/copilot/*` API contract. The older `application/frontdesk/FrontDeskOrchestrator` is deprecated and retained only for `cvAgentKernel.documents.ingest()` until document ingestion is split into a direct command pipeline; `/copilot/chat`, `/copilot/actions`, and `/copilot/chat/stream` do not use it.

Development and production now fail fast if kernel agents are configured as deterministic/mock/fake unless `ALLOW_DETERMINISTIC_RUNTIME=true` is explicitly set for local debugging. Test mode still allows fake/mock/deterministic paths.

`AgentToolRegistry` has been split into tool modules:

```text
src/agents/tools/
  AgentToolTypes.ts
  AgentToolRegistry.ts
  schemas.ts
  helpers.ts
  product/
    experienceTools.ts
    jdTools.ts
    resumeTools.ts
    importTools.ts
    dashboardTools.ts
  kernel/
    generationTools.ts
    revisionTools.ts
    evidenceTools.ts
    decisionTools.ts
```

`/debug/agent-modes` now reports structured `agentRuntime`, `legacyKernelAgents`, `database`, and `safety` blocks. Unknown model-requested tools are rejected before execution, logged with request/session/tool names only, and converted into a safe clarification response.

The minimal frontend now displays suggested prompt chips under the latest assistant message and has a lightweight sidebar backed by `/copilot/sidebar`. It can restore a recent session by calling `/copilot/sessions/:id` and rehydrating messages plus workspace.

Local curl checks:

```bash
curl -H "x-user-id: demo-user" http://127.0.0.1:3000/debug/agent-modes

curl -X POST http://127.0.0.1:3000/product/experiences \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"title\":\"React performance\",\"content\":\"Built React and TypeScript systems and reduced bundle size by 40%.\"}"

curl -H "x-user-id: demo-user" http://127.0.0.1:3000/product/experiences

curl -X POST http://127.0.0.1:3000/product/jds \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"rawText\":\"Looking for React, TypeScript and performance optimization.\",\"targetRole\":\"Frontend Engineer\"}"

curl -H "x-user-id: demo-user" http://127.0.0.1:3000/product/jds

curl -X POST http://127.0.0.1:3000/product/resumes \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"title\":\"Frontend Engineer draft\",\"targetRole\":\"Frontend Engineer\"}"

curl -X POST http://127.0.0.1:3000/product/resumes/:resumeId/items \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"title\":\"React performance\",\"contentSnapshot\":\"Reduced bundle size by 40%.\"}"

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"message\":\"查看我的经历库\",\"jdText\":\"React role\"}"

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"message\":\"根据这个 JD 生成简历\",\"jdText\":\"Looking for React TypeScript performance optimization.\",\"targetRole\":\"Frontend Engineer\"}"

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" -H "x-user-id: demo-user" \
  -d "{\"message\":\"查看历史简历\",\"jdText\":\"React role\"}"
```

## Current Non-Goals

- No formal product page buildout in this backend phase.
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
