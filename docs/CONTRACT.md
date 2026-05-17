# Coolto CV Agent Contract

> Status: Draft v0.2, P8.0-P10.1 implemented through LLM-backed agents, streaming generation, artifact decisions, product copilot backend, product asset loop, CopilotOrchestrator, and product-level SSE stream  
> Scope: frontend ↔ backend API ↔ cv-agent kernel / SDK  
> Principle: backend owns authentication and request context; Agent Kernel owns document ingestion, experience knowledge, generation, evidence chains, and graph projections.

This document defines the contract for future development of `cv-agent`. It is intended to keep frontend, backend, and Agent Kernel work aligned before adding real LLM-backed agents, auth, frontend clients, file storage, and production deployment.

---

## 1. Architectural Boundary

### 1.1 Layers

```text
Frontend / Mini Program
  - UI, upload widgets, chat/task flow, evidence-chain panel
  - never decides trusted user identity
  - never calls Agent Kernel directly

Backend API
  - authentication / session resolution
  - request validation
  - file upload parsing
  - API response envelope
  - rate limit / logging / error mapping
  - calls CvAgentKernel facade

CvAgentKernel / Agent SDK
  - document parsing
  - FrontDesk orchestration
  - experience ingestion
  - resume generation
  - evidence chain and graph query
  - generation persistence
  - repository abstraction

Persistence / Providers
  - PostgreSQL / InMemory / SQLite demo adapters
  - DeepSeek / Mock provider
  - future object storage / vector store / job queue
```

### 1.2 Hard Rules

1. Frontend must not send trusted `userId` in request body.
2. Backend must resolve user identity from auth/session/token and inject it into kernel context.
3. Backend routes must call a stable kernel facade or kernel ports, not low-level repositories.
4. Agent Kernel must not depend on HTTP framework types.
5. Repository implementations must remain swappable.
6. PostgreSQL schema intentionally avoids database-level foreign-key constraints. Referential integrity is enforced at application/service layer.
7. Tests must not require real PostgreSQL or real DeepSeek by default.

---

## 2. Environment Modes

### 2.1 API Runtime Mode

```env
DATABASE_URL=postgres://...
```

If `DATABASE_URL` exists, API mode is `postgres`. If it is absent, API mode is `in_memory`.

`in_memory` mode is only for local demo and tests. It must not be used as production persistence.

### 2.2 Auth Mode

Future backend should support:

```env
AUTH_MODE=dev_header | cookie_session | bearer_token | service
```

Current implemented behavior uses `x-user-id` only through the `dev_header` resolver. `AUTH_MODE` defaults to `dev_header` for local development and tests. In `NODE_ENV=production`, `AUTH_MODE` must be set explicitly. `bearer_token` and `service` are reserved but not implemented yet.

| Mode | Source of user identity | Intended use |
|---|---|---|
| `dev_header` | `x-user-id` header | local development / tests only |
| `cookie_session` | signed session cookie | web app production path |
| `bearer_token` | Authorization header | API clients / mini program bridge |
| `service` | trusted internal service credential | background jobs / admin tools |

### 2.3 LLM Mode

Do not delete mock/deterministic paths. Real LLM should be configurable.

```env
AGENT_PROVIDER=mock | deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat

FRONTDESK_AGENT_MODE=mock | llm
EXPERIENCE_EXTRACTOR_MODE=deterministic | llm
ARTIFACT_GENERATOR_MODE=deterministic | llm
CRITIC_AGENT_MODE=deterministic | llm
REVISION_AGENT_MODE=deterministic | llm
```

Default test mode:

```env
AGENT_PROVIDER=mock
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
```

Production / staging may gradually enable:

```env
AGENT_PROVIDER=deepseek
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
```

P8.1-P8.7 implementation notes:

1. `AgentProviderFactory` creates `ModelClient` instances for `mock` or `deepseek`.
2. Non-production defaults to `AGENT_PROVIDER=mock`.
3. Production defaults to `AGENT_PROVIDER=deepseek` and requires `DEEPSEEK_API_KEY`.
4. `ALLOW_MOCK_FALLBACK` defaults to true outside production and false in production.
5. `FRONTDESK_AGENT_MODE=mock` forces MockProvider and ignores DeepSeek config for FrontDesk routing.
6. `FRONTDESK_AGENT_MODE=llm` routes FrontDeskAgent through `AgentProviderFactory`.
7. FrontDeskAgent validates JSON, repairs once, and falls back to an `unknown` decision unless fallback is disabled.
8. `EXPERIENCE_EXTRACTOR_MODE=deterministic` keeps the default deterministic ingestion path.
9. `EXPERIENCE_EXTRACTOR_MODE=llm` routes experience extraction through `AgentProviderFactory`.
10. LLMExperienceExtractor validates JSON, repairs once, and falls back to deterministic extraction when fallback is enabled.
11. ExperienceExtractor.extract returns ExperienceExtractionResult with experiences[] and warnings.
12. LLMExperienceExtractor preserves all returned experiences instead of ingesting only the first.
13. A single source document can create multiple Experience records with separate Evidence records and merged/de-duplicated Skill records.
14. `ARTIFACT_GENERATOR_MODE=deterministic` keeps the default deterministic generation path.
15. `ARTIFACT_GENERATOR_MODE=llm` routes artifact generation through `AgentProviderFactory` and `LLMArtifactGenerator`.
16. LLMArtifactGenerator validates JSON, repairs once, and falls back to deterministic generation when fallback is enabled.
17. Generated artifacts include `metadata.enhancement` with status, claims, support levels, risk levels, and confirmation questions.
18. Deterministic no-evidence draft artifacts are marked consistently as `needs_review` with `metadata.enhancement.status=needs_confirmation`.
19. `CRITIC_AGENT_MODE=deterministic` keeps the default deterministic critique path.
20. `CRITIC_AGENT_MODE=llm` routes artifact critique through `AgentProviderFactory` and `LLMArtifactCritic`.
21. LLMArtifactCritic validates JSON, repairs once, and falls back to deterministic critique when fallback is enabled.
22. CriticAgent is not a RevisionAgent: it reviews risk and suggestions but does not rewrite final artifacts.
23. Critic output may include `claimReviews`, `confirmationQuestions`, and `safeRewriteSuggestion` in addition to the stable verdict/risk fields.
24. DeterministicArtifactCritic performs numeric secondary validation against cited evidence excerpts and requires confirmation for unsupported numeric tokens.
25. `REVISION_AGENT_MODE=deterministic` keeps the default safe revision path.
26. `REVISION_AGENT_MODE=llm` routes artifact revision through `AgentProviderFactory` and `LLMArtifactRevisionAgent`.
27. RevisionAgent consumes artifact, critique item, evidence chain, user instruction, and optional user confirmations.
28. Revised artifacts preserve source experience/evidence IDs, refresh `metadata.enhancement`, and add `metadata.revision`.
29. The minimal API entrypoint is `POST /generations/artifacts/revise`.
30. `KernelRequestContext.events` supports public agent events for frontend progress display without exposing model raw chain-of-thought.
31. `POST /generations/stream` returns experimental NDJSON progress events and a final generation result.
32. Artifact decisions support accept/reject/revision/metric-confirmation/unsafe/preferred-variant review flows.
33. PostgreSQL mode persists artifact decisions through `PostgresArtifactDecisionRepository`.
34. `ModelClient.stream()` remains separate from `/generations/stream`; structured JSON agents still use `chat()` for schema validation, repair, and fallback.

Common local/LLM configurations:

```env
# Default local
AGENT_PROVIDER=mock
FRONTDESK_AGENT_MODE=mock
EXPERIENCE_EXTRACTOR_MODE=deterministic
ARTIFACT_GENERATOR_MODE=deterministic
CRITIC_AGENT_MODE=deterministic
REVISION_AGENT_MODE=deterministic

# Critic LLM only
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=deterministic
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...

# Full real LLM chain
FRONTDESK_AGENT_MODE=llm
EXPERIENCE_EXTRACTOR_MODE=llm
ARTIFACT_GENERATOR_MODE=llm
CRITIC_AGENT_MODE=llm
REVISION_AGENT_MODE=llm
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
ALLOW_MOCK_FALLBACK=false
```

---

## 3. Frontend ↔ Backend Contract

### 3.1 Authentication Contract

Frontend should eventually authenticate via cookie/session/token.

Production request:

```http
Cookie: coolto_session=...
```

or:

```http
Authorization: Bearer <token>
```

Development-only request:

```http
x-user-id: dev-user-1
```

Rules:

1. Frontend must not put `userId` in request body.
2. Backend must ignore body-level `userId` even if present.
3. Backend must attach resolved user identity to `KernelRequestContext`.
4. `x-user-id` must be rejected unless `AUTH_MODE=dev_header` or test mode.

### 3.2 Response Envelope

All future production APIs should return one of:

```ts
export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: ApiMeta;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ApiMeta;
};

export type ApiMeta = {
  requestId: string;
  traceId?: string;
  mode: "postgres" | "in_memory";
  warnings?: string[];
};
```

Current routes return this envelope for success and failure responses.

### 3.3 Error Codes

Minimum standard error codes:

```text
MISSING_AUTH
INVALID_AUTH
MISSING_USER_ID_DEV_ONLY
INVALID_BODY
UNSUPPORTED_DOCUMENT_TYPE
DOCUMENT_PARSE_FAILED
DOCUMENT_EMPTY_TEXT
GENERATION_FAILED
EVIDENCE_CHAIN_NOT_FOUND
GRAPH_VIEW_NOT_FOUND
LLM_PROVIDER_NOT_CONFIGURED
LLM_SCHEMA_VALIDATION_FAILED
RATE_LIMITED
INTERNAL_ERROR
```

Rules:

1. Do not return stack traces to frontend.
2. Return actionable messages.
3. Include `requestId` in every error response.
4. Log full internal errors server-side.

---

## 4. Backend Auth Contract

### 4.1 Types

```ts
export type AuthenticatedUser = {
  id: string;
  email?: string;
  displayName?: string;
  roles: string[];
};

export type AuthMode =
  | "dev_header"
  | "cookie_session"
  | "bearer_token"
  | "service";

export type AuthContext = {
  mode: AuthMode;
  sessionId?: string;
  tokenId?: string;
};

export type AuthResolver = {
  resolve(request: unknown): Promise<{
    user: AuthenticatedUser;
    auth: AuthContext;
  }>;
};
```

### 4.2 Dev Header Resolver

Only available in development/test mode.

Input:

```http
x-user-id: dev-user-1
```

Output:

```ts
{
  user: {
    id: "dev-user-1",
    roles: ["user"]
  },
  auth: {
    mode: "dev_header"
  }
}
```

### 4.3 Cookie Session Resolver

Future production web app path.

Rules:

1. Validate signed session cookie.
2. Resolve user from database or auth provider.
3. Attach session ID to `KernelRequestContext`.
4. Never trust `userId` from request body.

---

## 5. Backend ↔ Agent Kernel Contract

### 5.1 Kernel Request Context

Backend should call kernel with a context object, not a bare `userId`.

```ts
export type KernelRequestContext = {
  user: {
    id: string;
    email?: string;
    displayName?: string;
    roles?: string[];
  };
  auth: {
    mode: "dev_header" | "cookie_session" | "bearer_token" | "service";
    sessionId?: string;
    tokenId?: string;
  };
  request: {
    requestId: string;
    traceId: string;
    source: "web" | "mini_program" | "api" | "cli" | "test";
    userAgent?: string;
    ipHash?: string;
  };
  tenant?: {
    id?: string;
  };
  events?: AgentEventSink;
};
```

`events` is optional and carries public agent events for UI progress display. It must not expose raw model chain-of-thought, API keys, or complete private resume text. Internal services may continue to use `userId`, but SDK/facade boundaries should accept `KernelRequestContext`.

### 5.2 CvAgentKernel Facade

The long-term SDK surface should converge toward:

```ts
export type CvAgentKernel = {
  mode: "postgres" | "in_memory";

  documents: {
    ingest(
      ctx: KernelRequestContext,
      input: IngestDocumentInput,
    ): Promise<IngestDocumentResult>;
  };

  generations: {
    create(
      ctx: KernelRequestContext,
      input: CreateGenerationInput,
    ): Promise<CreateGenerationResult>;

    getEvidenceChains(
      ctx: KernelRequestContext,
      query: EvidenceChainQuery,
    ): Promise<EvidenceChainQueryResult>;

    getGraph(
      ctx: KernelRequestContext,
      query: GraphQuery,
    ): Promise<GraphViewQueryResult>;

    reviseArtifact(
      ctx: KernelRequestContext,
      input: ReviseArtifactInput,
    ): Promise<ArtifactRevisionResult>;

    recordArtifactDecision(
      ctx: KernelRequestContext,
      input: RecordArtifactDecisionInput,
    ): Promise<ArtifactDecisionRecord>;

    listArtifactDecisions(
      ctx: KernelRequestContext,
      query: ListArtifactDecisionsQuery,
    ): Promise<ArtifactDecisionRecord[]>;
  };

  health(): Promise<KernelHealth>;
  close(): Promise<void>;
};
```

Current `ApiKernel` still exposes internal services during migration for tests and demos. Backend routes now call `cvAgentKernel` instead of those internal services.

### 5.3 SDK Boundary Rules

1. Kernel facade must not import Fastify/Express/Hono request types.
2. Kernel facade must not read cookies or headers.
3. Kernel facade receives trusted user identity from backend.
4. Kernel methods must be user-scoped through `ctx.user.id`.
5. Kernel must return domain results and warnings, not HTTP responses.
6. Backend converts kernel results into API envelopes.

---

## 6. API Endpoint Contract

### 6.1 Health

```http
GET /health
```

Current response:

```ts
{
  ok: true;
  data: {
    ok: true;
    mode: "postgres" | "in_memory";
  };
  meta: ApiMeta;
}
```

### 6.2 Ingest Document

```http
POST /documents/ingest
```

Auth: required.

JSON body fallback:

```ts
export type IngestDocumentRequest = {
  fileName: string;
  mimeType?: string;
  extension?: string;
  text?: string;
  base64?: string;
  sourceRef?: string;
};
```

Future multipart body:

```text
file: binary
metadata?: JSON string
```

Response data:

```ts
export type IngestDocumentResult = {
  extractedDocuments: ExtractedTextDocument[];
  experience?: Experience;
  experiences: Experience[];
  evidences: Evidence[];
  skills: Skill[];
  warnings: string[];
};
```

Rules:

1. Backend resolves `ctx.user.id`.
2. Backend creates `DocumentInput` from text/base64/file.
3. Kernel parses document and ingests experience.
4. Document lineage must include `sourceDocumentId` and `documentMetadata`.
5. Parser must not write Experience/Evidence directly.
6. `experiences[]` is the primary output. `experience` is a compatibility alias for the first extracted experience.
7. `documentIngestionResults[n].experiences` identifies the experiences created from each source document.

### 6.3 Create Generation

```http
POST /generations
```

Request:

```ts
export type CreateGenerationRequest = {
  jdText: string;
  targetRole: string;
};
```

Response data:

```ts
export type CreateGenerationResult = {
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  graphViews: GraphView[];
  coverageReport: ArtifactCoverageReport;
  coverageGapReport: CoverageGapReport;
  critiqueReport: ArtifactCritiqueReport;
  persistedGeneration?: {
    sessionId: string;
    evidenceChainSnapshotCount: number;
    graphViewSnapshotCount: number;
    bundleCount: number;
  };
};
```

Rules:

1. PostgreSQL mode must use transaction-aware generation persistence.
2. In-memory mode may use generic non-transactional persistence.
3. Every generated artifact must be traceable to evidence IDs where possible.
4. ArtifactGenerator may rewrite, infer, or propose user-confirmable enhancements, but unsupported high-risk claims must not be marked ready.
5. `GeneratedArtifact.metadata.enhancement.status` guides frontend use:
   - `ready`: can be used directly.
   - `needs_confirmation`: ask user to confirm or provide missing data first.
   - `unsafe`: do not use directly.
6. Each enhancement claim records `supportLevel`, `riskLevel`, `evidenceIds`, and `sourceExperienceIds`.

### 6.4 Experimental Streaming Generation

```http
POST /generations/stream
```

Request:

```ts
export type CreateGenerationRequest = {
  jdText: string;
  targetRole: string;
};
```

Response stream:

```http
Content-Type: application/x-ndjson
```

Each progress line contains:

```ts
{ event: AgentEvent }
```

The final line contains:

```ts
{ final: CreateGenerationResult }
```

Rules:

1. `/generations` remains the stable synchronous API.
2. This endpoint is an Agent Event Stream. It is not a direct model token stream.
3. Current production-facing streaming strategy is Agent Event Stream only.
4. If an error occurs after streaming starts, the stream reports it as an event/error line.
5. Request auth and body validation happen before opening the NDJSON stream.
6. Events may include `kernel.started`, `agent.started`, `tool.completed`, `artifact.candidate.created`, `artifact.critique.completed`, `artifact.revision.completed`, `decision.required`, `kernel.completed`, and the final result.
7. Frontend code should not treat this endpoint as unvalidated LLM token output.

### 6.5 List Evidence Chains by Session

```http
GET /generations/:sessionId/evidence-chains
```

Response data:

```ts
export type EvidenceChainQueryResult = {
  evidenceChains: EvidenceChainSnapshot[];
  summary: string;
};
```

Rules:

1. Query must be scoped by authenticated user.
2. Missing session returns empty result or not-found depending future product decision.
3. Do not expose other users' snapshots.

### 6.6 Get Graph by Scope

```http
GET /graphs/:scopeType/:scopeId
```

Allowed `scopeType`:

```text
user | experience | generation | artifact
```

Response data:

```ts
export type GraphViewQueryResult = {
  graphViews: GraphViewSnapshot[];
  summary: string;
  warnings: string[];
};
```

Rules:

1. Query must be scoped by authenticated user.
2. Empty result should include warning.
3. Graph snapshots are projections, not source of truth.

### 6.7 Revise Artifact

```http
POST /generations/artifacts/revise
```

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

Response data includes `revisedArtifact`, `revisedArtifact.metadata.revision`, `revisedArtifact.metadata.enhancement`, and `warnings`.

Rules:

1. Current minimal API allows the frontend to pass `artifact`, `evidenceChain`, and `critiqueItem`.
2. Production should prefer `artifactId`/`sessionId`; backend should load records by authenticated `userId`.
3. The revise API uses authenticated `ctx.user.id`; mismatched `artifact.userId` returns `FORBIDDEN`.
4. Revised artifacts are variants; `metadata.revision.revisedFromArtifactId` links lineage.

### 6.8 Artifact Decisions

```http
POST /generations/artifacts/decisions
GET /generations/artifacts/:artifactId/decisions
GET /generations/:sessionId/artifact-decisions
```

Decision input:

```ts
export type ArtifactDecisionInput = {
  artifactId: string;
  sessionId?: string;
  decision:
    | "accept"
    | "reject"
    | "request_revision"
    | "confirm_metric"
    | "mark_unsafe"
    | "prefer_variant";
  reason?: string;
  selectedVariantId?: string;
  confirmation?: {
    metric?: string;
    value?: string;
    explanation?: string;
  };
};
```

Rules:

1. Backend derives `userId` from `KernelRequestContext`; body-level `userId` is ignored.
2. Decisions are append-only event records and do not mutate the artifact.
3. In-memory mode uses `InMemoryArtifactDecisionRepository`; PostgreSQL mode uses `PostgresArtifactDecisionRepository`.
4. `confirm_metric` should include the user-confirmed metric/value where available.
5. The `artifact_decisions` table has no database foreign keys.
6. If a user changes from `reject` to `accept`, the backend records a new decision instead of overwriting history.
7. Frontend code may sort by `createdAt` and treat the last record as the current state.
8. The backend does not enforce a business state machine yet; it records the event log. A future projection such as `current_decision_status` can be added later.

### 6.9 Agent Event Stream

```ts
export type AgentEventType =
  | "kernel.started"
  | "kernel.completed"
  | "kernel.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "llm.started"
  | "llm.delta"
  | "llm.completed"
  | "llm.preview.completed"
  | "llm.repaired"
  | "llm.fallback"
  | "artifact.candidate.created"
  | "artifact.critique.completed"
  | "artifact.revision.completed"
  | "decision.required"
  | "warning";
```

Rules:

1. Events are for frontend progress display.
2. Events must not expose model raw chain-of-thought.
3. Public reasoning summaries, step summaries, action logs, counts, ids, statuses, short previews, and warnings are allowed.
4. Do not put API keys or complete private resume text in event `data`.
5. Artifact events may include `shortPreview`, capped at 120 characters, plus `status` and `enhancementStatus`.

### 6.9.1 Model Token Stream Preview

Provider-level streaming is available through `ModelClient.stream()` and `DeepSeekProvider.stream()`. This is separate from `/generations/stream` and is not enabled in the main agent workflows.

Rules:

1. Structured JSON agents continue to use `chat()` by default for schema validation, repair, and deterministic fallback.
2. `collectStreamPreview()` is an experimental/future helper that can consume a model stream and collect a bounded content preview.
3. `reasoningDelta` is not returned by default.
4. `includeReasoning=true` is reserved for explicit safe preview/debug use; frontend product UI should prefer public reasoning summaries or agent event summaries.
5. The preview helper does not parse JSON and does not replace the main agent response path.
6. `collectStreamPreview()` is not wired into `FrontDeskAgent`, `ExperienceExtractor`, `ArtifactGenerator`, `CriticAgent`, or `RevisionAgent` main flows.
7. Agent outputs are structured JSON and must pass parse, zod validation, post-validation, repair, and fallback before becoming user-facing results.

### 6.9.2 Frontend Streaming Recommendation

Frontend clients should use:

1. `POST /generations/stream` to display public agent progress.
2. `POST /generations` for non-streaming generation.
3. `POST /generations/artifacts/revise` to request artifact changes.
4. `POST /generations/artifacts/decisions` to record accept/reject/request_revision/confirm_metric/prefer_variant feedback.
5. Public `AgentEvent` summaries instead of raw model output or raw chain-of-thought.

### 6.10 Variant Display Guidance

Rules:

1. `artifacts[]` are candidate variants from the same generation.
2. `revisedArtifact` is a new candidate variant.
3. `artifact.metadata.revision.revisedFromArtifactId` links version lineage.
4. `metadata.enhancement.status=ready` means usable directly.
5. `metadata.enhancement.status=needs_confirmation` means ask the user first.
6. `metadata.enhancement.status=unsafe` means do not use directly.
7. Decision records capture `accept`, `reject`, `request_revision`, `confirm_metric`, `mark_unsafe`, and `prefer_variant`.

---

## 7. Document and Evidence Lineage Contract

### 7.1 Extracted Document

```ts
export type ExtractedTextDocument = {
  documentId: string;
  userId: string;
  sourceType: "pdf" | "docx" | "markdown" | "plain_text";
  fileName: string;
  mimeType?: string;
  title?: string;
  text: string;
  textPreview: string;
  textLength: number;
  sourceRef: string;
  metadata: {
    parser: string;
    pageCount?: number;
    wordCount?: number;
    originalSizeBytes?: number;
    [key: string]: unknown;
  };
  createdAt: string;
};
```

### 7.2 Experience / Evidence Lineage

Experience and Evidence should carry:

```ts
sourceDocumentId?: string;
metadata?: {
  sourceDocumentId?: string;
  sourceRef?: string;
  sourceType?: string;
  document?: {
    documentId?: string;
    fileName?: string;
    sourceType?: string;
    sourceRef?: string;
    parser?: string;
    textLength?: number;
  };
  chunk?: {
    evidenceIndex?: number;
    excerptLength?: number;
  };
  ingestion?: {
    createdFrom: string;
    extractor?: string;
  };
  [key: string]: unknown;
};
```

Rules:

1. `sourceDocumentId` links parsed document to generated experience/evidence.
2. Metadata should preserve parser/source/chunk information.
3. Historical generation snapshots must remain stable if source records are edited later.

---

## 8. Persistence Contract

### 8.1 PostgreSQL

PostgreSQL is the formal storage target.

Rules:

1. No database-level foreign-key constraints.
2. Use user-scoped repository methods in backend-facing flows.
3. Historical snapshots should be stored as JSONB projections.
4. Generation persistence in PostgreSQL must use transaction-aware factory.
5. `schema.sql` is the full schema for new databases.
6. `migrations/` stores incremental compatibility changes.

### 8.2 InMemory

Use for tests, local demo, and API boot without `DATABASE_URL`. Do not use for production.

### 8.3 SQLite

Use for legacy/local demo adapter. Do not expand SQLite as the main product storage path unless strategy changes.

---

## 9. Agent Provider Contract

### 9.1 Provider Selection

`AgentProviderFactory` now provides:

```ts
export type AgentProviderConfig = {
  provider: "mock" | "deepseek";
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  allowMockFallback?: boolean;
  runtimeMode?: "test" | "development" | "production";
};
```

Rules:

1. Missing DeepSeek key falls back only if `allowMockFallback` is enabled.
2. Tests and non-production default to mock.
3. Smoke demos may use real API.
4. Production defaults to DeepSeek and fails fast without `DEEPSEEK_API_KEY`.
5. The factory must not make network requests; it only creates providers and `ModelClient`.
6. `FRONTDESK_AGENT_MODE=mock` must not require DeepSeek credentials.
7. `FRONTDESK_AGENT_MODE=llm` is the switch that allows FrontDeskAgent to use the configured provider.

### 9.2 LLM Output Validation

All LLM-backed agents must follow:

```text
LLM output
  → parse JSON
  → zod/schema validate
  → repair once if allowed
  → fallback or fail with typed error
```

No LLM output may be trusted before validation.

### 9.3 LLM-backed Agent Rollout Order

Recommended order:

```text
1. FrontDeskAgent llm mode
2. ExperienceExtractor / Archivist llm mode
3. ArtifactGenerator llm mode
4. CriticAgent llm mode
5. RevisionAgent / Feedback loop
```

---

## 10. Agent Kernel Observability Contract

Future agent run tracing should write to `agent_runs` or equivalent repository.

Minimum fields:

```ts
export type AgentRunRecord = {
  id: string;
  userId: string;
  sessionId?: string;
  requestId: string;
  traceId: string;
  agentName: string;
  provider?: string;
  model?: string;
  status: "started" | "completed" | "failed" | "fallback";
  input: unknown;
  output?: unknown;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

1. Do not store secrets or raw API keys.
2. Consider redaction for sensitive user content.
3. Every LLM-backed agent call should have requestId/traceId.
4. Fallbacks must be observable.

---

## 11. Security and Privacy Contract

### 11.1 User Isolation

1. All backend-facing reads must be user-scoped.
2. Do not expose legacy `getById(id)` / `delete(id)` through API routes.
3. Prefer `getByIdForUser(userId, id)` / `deleteForUser(userId, id)` where available.
4. Kernel facade methods must derive user scope from `KernelRequestContext`.

### 11.2 File Safety

1. Enforce file size limits before parsing.
2. Reject unsupported file types.
3. Scanned PDFs without extractable text should return clear error.
4. Do not run OCR by default.
5. Do not execute file contents.

### 11.3 Prompt Injection

Future LLM-backed agents must treat uploaded documents as untrusted content.

Rules:

1. Documents may contain malicious instructions.
2. Uploaded content must not override system prompts.
3. Tool access should be capability-scoped by agent.
4. Agent actions that mutate records should be explicit application decisions, not raw LLM side effects.

---

## 12. Versioning Contract

Current version:

```text
Contract v0.1
```

Breaking changes include:

1. Changing response envelope shape.
2. Removing API fields.
3. Renaming kernel facade methods.
4. Changing auth identity source.
5. Changing persistence ownership of snapshots.

Future API routes should use `/api/v1/...` when exposed outside local development.

---

## 13. Near-term Implementation Roadmap

### P8.0 Contract Hardening

Status: implemented.

- Added `KernelRequestContext` type.
- Added `AuthResolver` abstraction.
- Kept `x-user-id` behind the dev-only `dev_header` resolver.
- Production now requires explicit `AUTH_MODE`.
- `bearer_token` and `service` return reserved-but-not-implemented errors.
- Added `CvAgentKernel` facade.
- Moved current routes to the API response envelope.
- Routes now resolve auth, build `KernelRequestContext`, and call `cvAgentKernel`.

### P8.1 Real LLM Provider Configuration

Status: implemented.

- Added `AgentProviderFactory`.
- Supports `AGENT_PROVIDER=mock|deepseek`.
- Production defaults to DeepSeek and requires `DEEPSEEK_API_KEY`.
- Non-production defaults to MockProvider.
- Added agent mode env parsing for future LLM-backed rollout.
- `FRONTDESK_AGENT_MODE` now controls FrontDesk provider wiring.
- Default tests remain deterministic and do not call DeepSeek.

### P8.2 LLM-backed FrontDeskAgent

Status: implemented.

- Uses DeepSeek when `FRONTDESK_AGENT_MODE=llm`, `AGENT_PROVIDER=deepseek`, and `DEEPSEEK_API_KEY` is configured.
- Supports `AGENT_PROVIDER=mock` in llm mode for deterministic tests.
- Validates FrontDesk intent JSON.
- Parses raw JSON, fenced JSON, and JSON surrounded by short prose.
- Repairs invalid JSON once.
- Falls back to `unknown` when repair fails and fallback is enabled.
- Includes optional `dev:frontdesk-llm-smoke` demo.

### P8.3 LLM-backed ExperienceExtractor

Status: implemented.

- Converts raw document text into extracted experience, evidence excerpts, and skills through LLM mode.
- Keeps deterministic extraction as the default.
- FrontDesk and ExperienceExtractor modes are independently controlled.
- Validates LLM extraction JSON with zod.
- Parses raw JSON, fenced JSON, and JSON surrounded by prose.
- Repairs invalid extraction JSON once.
- Falls back to deterministic extraction when fallback is enabled.
- Preserves sourceDocumentId and document metadata through ingestion metadata.
- Includes optional `dev:experience-llm-smoke` demo.

### P8.4 Multi-experience Extraction

Status: implemented.

- `ExperienceExtractor.extract(input)` returns `ExperienceExtractionResult`.
- `ExperienceExtractionResult.experiences` may contain multiple `ExtractedExperience` records from one document.
- `DeterministicExperienceExtractor` and `AgentExperienceExtractor` keep their single-experience behavior by returning a one-item `experiences[]`.
- `LLMExperienceExtractor` returns all schema-valid LLM experiences and no longer warns that only the first was ingested.
- `ExperienceIngestionService.ingest()` creates one `Experience` per extracted experience, with evidence IDs scoped to each experience ID.
- Experience and Evidence metadata include `ingestion.experienceIndex` and `ingestion.totalExtractedExperiences`.
- Evidence metadata keeps `chunk.evidenceIndex` as the evidence index within that experience.
- FrontDeskResponse, CvAgentKernel `documents.ingest`, and `/documents/ingest` expose `experiences[]`; `experience` remains the first experience for compatibility.
- This phase does not add complex chunking, vector retrieval, vector-store persistence, database foreign keys, or LLM-backed CriticAgent behavior.

### P8.5 Evidence-aware LLM ArtifactGenerator

Status: implemented.

- Adds an `ArtifactGenerator` interface returning `GenerateArtifactsResult`.
- `DeterministicArtifactGenerator` and `LLMArtifactGenerator` both implement the interface.
- `ResumeGenerationService` depends on the interface and keeps its public `generate()` result shape unchanged.
- `ARTIFACT_GENERATOR_MODE=deterministic` is the default stable mode.
- `ARTIFACT_GENERATOR_MODE=llm` uses `AgentProviderFactory`.
- LLMArtifactGenerator supports evidence-grounded rewriting, reasonable inference, and user-confirmable enhancement candidates.
- It rejects ready artifacts with unsupported claims or high-risk confirmation claims.
- Numeric claims not present in cited evidence must be marked `needs_user_confirmation` or `unsupported`.
- Every generated artifact includes source experience IDs and source evidence IDs.
- `GeneratedArtifact.metadata.enhancement` includes:
  - `status: ready | needs_confirmation | unsafe`
  - `claims[]`
  - `supportLevel`
  - `riskLevel`
  - `confirmationQuestions`
  - source evidence and experience IDs
- Optional smoke demo: `npm run dev:artifact-llm-smoke`.

### P8.5.1 Deterministic No-evidence Artifact Consistency

Status: implemented.

- Deterministic artifacts with source evidence remain `artifact.status=ready` and `metadata.enhancement.status=ready`.
- Deterministic artifacts without source evidence are draft-only:
  - `artifact.status=needs_review`
  - `metadata.enhancement.status=needs_confirmation`
  - `metadata.enhancement.enhancementStrategy=confirmation_needed`
  - claim `supportLevel=needs_user_confirmation`
  - claim `riskLevel=medium`
  - `confirmationQuestions` asks the user to provide source evidence before use.
- No-evidence deterministic drafts must not be treated as ready/supported bullets.

### P8.6 LLM-backed CriticAgent

Status: implemented.

- `CRITIC_AGENT_MODE=deterministic` is the default stable mode.
- `CRITIC_AGENT_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactCritic`.
- `LLMArtifactCritic` reviews generated artifacts, but does not act as a RevisionAgent and does not produce final revised artifacts.
- Critique reads:
  - `artifact.metadata.enhancement.status`
  - claim `supportLevel` and `riskLevel`
  - `confirmationQuestions`
  - evidence-chain risk, cited evidence, missing evidence, and exaggeration warnings
  - coverage report context
- Critique output includes:
  - `verdict: pass | revise | reject`
  - `unsupportedClaims`
  - `missingEvidence`
  - `rewriteSuggestions`
  - optional `claimReviews`
  - optional `safeRewriteSuggestion`
  - optional `confirmationQuestions`
- DeterministicArtifactCritic also reads enhancement metadata and can raise risk for `unsafe`, `needs_confirmation`, `unsupported`, or `needs_user_confirmation` claims. Enhancement metadata may raise a verdict/risk; it must not lower evidence-chain risk.
- Optional smoke demo: `npm run dev:critic-llm-smoke`.
- This phase does not add feedback loop, vector store, complex chunking, agent run tracing, frontend work, or database foreign keys.

### P8.7 RevisionAgent

Status: implemented.

- `REVISION_AGENT_MODE=deterministic` is the default safe revision path.
- `REVISION_AGENT_MODE=llm` uses `AgentProviderFactory` and `LLMArtifactRevisionAgent`.
- RevisionAgent consumes:
  - original artifact
  - critique item or critique report item
  - evidence chain
  - user instruction
  - optional user confirmations
- Supported revision instructions:
  - `make_more_conservative`
  - `remove_unsupported_claims`
  - `apply_user_confirmation`
  - `make_more_quantified`
  - `align_to_requirement`
  - `rewrite_for_tone`
  - `custom`
- Revised artifacts are saved as new `GeneratedArtifact` records when a repository is configured.
- Revised artifacts preserve `sourceExperienceIds`, `sourceEvidenceIds`, and target requirement lineage.
- Revised artifacts include refreshed `metadata.enhancement` and `metadata.revision.revisedFromArtifactId`.
- User-confirmed metrics may move a claim out of `needs_user_confirmation`, but unsupported high-risk claims must not become ready.
- Minimal kernel/API entrypoint:
  - `CvAgentKernel.generations.reviseArtifact(ctx, input)`
  - `POST /generations/artifacts/revise`
- The revise API uses authenticated `ctx.user.id`; mismatched `artifact.userId` returns `FORBIDDEN`.
- Optional smoke demo: `npm run dev:revision-llm-smoke`.
- This phase does not add frontend UI, complete user feedback system, vector store, complex chunking, persistent agent run logging, async job queue, or database foreign keys.

### P8.7.2 Streaming and Decision Persistence Hardening

Status: implemented.

- Added `AgentEvent`, `AgentEventSink`, `NoopAgentEventSink`, and `CollectingAgentEventSink`.
- Kernel facade emits public high-level events for document ingestion, generation, critique, revision, decisions required, and failures.
- `POST /generations/stream` returns experimental NDJSON lines with `{ event }` progress entries and a final `{ final }` generation result.
- Events are public step summaries and must not expose model raw chain-of-thought.
- Artifact candidate/revision events include `status`, `enhancementStatus`, and bounded `shortPreview`.
- Added `ArtifactDecisionService`, in-memory decision repository, and PostgreSQL artifact decision repository.
- Added decision API routes:
  - `POST /generations/artifacts/decisions`
  - `GET /generations/artifacts/:artifactId/decisions`
  - `GET /generations/:sessionId/artifact-decisions`
- Added `artifact_decisions` schema/migration for the six decision types with no database foreign keys.
- Added `llm.delta` and `llm.preview.completed` event types plus safe model stream preview helper.
- `ModelClient.stream()` / `DeepSeekProvider.stream()` are provider token streams; `/generations/stream` remains the backend Agent Event Stream.

### P8.7.3 Frontend Readiness Hardening

Status: implemented.

- Clarified that the current frontend-facing streaming path is Agent Event Stream only.
- Explicitly kept LLM token streaming out of FrontDesk, ExperienceExtractor, ArtifactGenerator, CriticAgent, and RevisionAgent main workflows.
- Marked `collectStreamPreview()` as experimental/future preview infrastructure.
- Made artifact decisions append-only in PostgreSQL and in-memory repositories.
- Documented that changed user choices create new decision records; projections can derive current state later.

### P9 Product Copilot Backend

Status: implemented.

- New `/copilot/*` product-level API layer for GPT-style frontend consumption.
- `/copilot/chat` — conversational chat with clarifying questions, resume ingestion, and generation.
- `/copilot/actions` — unified action handler (accept, reject, prefer, confirm_metric, revise, show_evidence, explain_choice).
- `/copilot/chat/stream` — SSE product event stream (not LLM token stream).
- `/debug/agent-modes` — runtime mode introspection.
- `CopilotOrchestrator` — session management and business logic extracted from routes.
- `CopilotResponseBuilder` — transforms kernel data into product-level responses.
- Product types: `ProductVariant`, `ProductAction`, `ProductTimelineItem` with product semantics.
- Existing `/generations/*` APIs preserved as internal/debug APIs.
- No raw chain-of-thought, reasoning_content, prompts, or tool args in any response.

#### Product Copilot API Contract

##### GET /debug/agent-modes

```bash
curl http://127.0.0.1:3000/debug/agent-modes
```

Response:
```json
{
  "ok": true,
  "data": {
    "provider": "mock",
    "database": "in_memory",
    "runtimeMode": "development",
    "frontDeskMode": "mock",
    "experienceExtractorMode": "deterministic",
    "artifactGeneratorMode": "deterministic",
    "criticAgentMode": "deterministic",
    "revisionAgentMode": "deterministic",
    "allowMockFallback": true,
    "model": "mock",
    "hasDatabaseUrl": false,
    "hasDeepSeekApiKey": false,
    "warnings": ["Provider is in mock mode."]
  },
  "meta": {}
}
```

##### POST /copilot/chat

```bash
# Clarifying question (no context)
curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"message":"Hello"}'

# Full generation (resume + JD)
curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{
    "message":"Generate resume content",
    "resumeText":"Senior engineer with React and TypeScript experience.",
    "jdText":"Looking for a Frontend Engineer with React skills.",
    "targetRole":"Frontend Engineer"
  }'
```

Response: `CopilotChatResponse` with `assistantMessage`, `timeline`, `workspace` (with `ProductVariant[]`), `nextActions`, `raw` (IDs only).

##### POST /copilot/actions

```bash
# Accept a variant
curl -X POST http://127.0.0.1:3000/copilot/actions \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"sessionId":"cs-...","action":{"type":"accept","variantId":"artifact-1"}}'

# Request conservative revision
curl -X POST http://127.0.0.1:3000/copilot/actions \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"sessionId":"cs-...","action":{"type":"revise_more_conservative","variantId":"artifact-1"}}'

# Show evidence
curl -X POST http://127.0.0.1:3000/copilot/actions \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"sessionId":"cs-...","action":{"type":"show_evidence","variantId":"artifact-1"}}'
```

##### POST /copilot/chat/stream

```bash
curl -X POST http://127.0.0.1:3000/copilot/chat/stream \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"message":"Generate content","jdText":"React role","targetRole":"Frontend Engineer"}'
```

SSE event types: `copilot.turn.started`, `copilot.message.created`, `copilot.timeline.updated`, `copilot.workspace.updated`, `copilot.action.required`, `copilot.completed`, `copilot.failed`.

This is a **product event stream**, not an LLM token stream. Never exposes raw chain-of-thought, reasoning_content, prompts, or tool args.

#### ProductVariant Contract

Each variant includes:
- `id`, `artifactId`, `title`, `content` — core identity and text
- `role` — `recommended | alternative | safe | quantified | experimental`
- `status` — `ready | needs_confirmation | unsafe | accepted | rejected`
- `score` — `{ overall, relevance, evidenceStrength }`
- `reason` — human-readable recommendation rationale
- `evidenceSummary` — `{ coverageLabel, items[] }` with natural language explanations
- `riskSummary` — `{ level, unsupportedClaims[], missingEvidence[], warnings[] }`
- `missingInfo` — user-facing questions that need answers
- `sourceExperienceIds[]`, `sourceEvidenceIds[]` — lineage
- `actions[]` — per-variant product actions with `primary` flag and optional `inputSchema`
- `raw` — debug-safe IDs and metadata only

#### Safety Rules

1. `/copilot/*` is the recommended product frontend entry point.
2. `/generations/*`, `/documents/*` remain as internal/debug APIs.
3. `raw` field contains only IDs and metadata; no chain-of-thought, prompts, or tool args.
4. Stream is product event stream, not LLM token stream.
5. All responses pass safety tests that verify no reasoning_content, prompts, or tool args leak.

### P10 Product Backend

#### P10.1 Minimal Product Asset Loop

Status: implemented.

P10.1 introduces the product business asset layer that sits beside the Agent Kernel. It exists so Coolto Copilot can behave like a chat-first job-search copilot while still preserving durable user assets.

The old CVhub concepts are mapped into product assets:

- Experience library -> `product_experience`, `product_experience_revision`, `product_experience_variant`
- JD history -> `product_jd`
- Resume drafts -> `product_resume`, `product_resume_item`
- Resume/text import -> `product_import_job`, `product_import_candidate`
- Generation tracking -> `product_generation`
- Export jobs -> future `product_export_job`

Product tables:

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

Hard rules:

1. Product tables are user-scoped.
2. PostgreSQL product schema has no database-level foreign keys.
3. LLMs and agents do not write product tables directly.
4. Product writes go through Services and Repositories.
5. The experience library stores stable user assets.
6. JD-tailored results are saved into `product_resume_item.content_snapshot`; they do not overwrite `product_experience_revision`.
7. Agent Kernel owns intelligence: extraction, generation, critique, revision, evidence chains.
8. Product Layer owns business state: experiences, JDs, resumes, resume item snapshots, import candidates, generation records.
9. Default tests must not require Neon or a real LLM provider.

Product APIs:

```text
GET /product/experiences
POST /product/experiences
GET /product/experiences/:id
PATCH /product/experiences/:id
POST /product/experiences/:id/revisions
POST /product/experiences/:id/variants

GET /product/jds
POST /product/jds
GET /product/jds/:id

GET /product/resumes
POST /product/resumes
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

Copilot product tools:

```text
create_experience
list_experiences
import_resume_text
accept_import_candidate
save_jd
list_jds
create_resume_from_jd
save_variant_to_resume
list_resumes
open_resume
```

`/copilot/chat` now enters through a conversational FrontDeskAgent decision layer before product tools or generation are considered. Supported decision modes are `chat_only`, `ask_clarification`, `use_product_tool`, `generate_resume_variants`, `explain_workspace`, and `smalltalk`.

The FrontDeskAgent is a job-search chat assistant, not only an intent classifier. Normal chat, product capability questions, job-search advice, resume writing guidance, confusion, and smalltalk return direct assistant text and do not require a JD. Product tools are called only when the user clearly asks for workspace operations such as adding an experience, listing experiences, importing resume text, saving/listing JDs, generating variants for a JD, accepting a variant into a resume draft, listing resumes, or opening product workspaces.

`FRONTDESK_CONVERSATION_MODE=deterministic | llm` controls the decision layer. The default is `deterministic` for stable tests. In `llm` mode, model output is structured JSON and must pass runtime validation before use. Invalid model output or provider failure falls back to deterministic routing.

`ProductIntentRouter` remains as a deterministic fallback and guardrail. The response envelope remains the P9 `CopilotChatResponse`; new workspace fields are additive and `workspace.variants` remains compatible with the minimal frontend. Responses must not expose chain-of-thought, `reasoning_content`, provider raw payloads, internal prompts, or tool arguments.

`/copilot/actions` keeps P9 actions. Accepting a generated variant also saves it to a product resume draft when the current workspace is tied to a `product_generation`.

Curl examples:

```bash
curl -X POST http://127.0.0.1:3000/product/experiences \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"title":"React performance","content":"Built React and TypeScript systems and reduced bundle size by 40%."}'

curl -H "x-user-id: demo-user" http://127.0.0.1:3000/product/experiences

curl -X POST http://127.0.0.1:3000/product/jds \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"rawText":"Looking for React, TypeScript and performance optimization.","targetRole":"Frontend Engineer"}'

curl -X POST http://127.0.0.1:3000/product/resumes \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"title":"Frontend Engineer draft","targetRole":"Frontend Engineer"}'

curl -X POST http://127.0.0.1:3000/product/resumes/:resumeId/items \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"title":"React performance","contentSnapshot":"Reduced bundle size by 40%."}'

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"message":"查看我的经历库","jdText":"React role"}'

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"message":"根据这个 JD 生成简历","jdText":"Looking for React TypeScript performance optimization.","targetRole":"Frontend Engineer"}'

curl -X POST http://127.0.0.1:3000/copilot/chat \
  -H "content-type: application/json" \
  -H "x-user-id: demo-user" \
  -d '{"message":"查看历史简历","jdText":"React role"}'
```

Future P10 work:

- Multipart upload.
- Object storage.
- Rate limit.
- Logging/tracing.
- Production auth.
- PDF export and product export jobs.

---

## 14. Checklist for New Code

Before adding new frontend/backend/kernel features, verify:

```text
[ ] Does frontend avoid trusted userId in body?
[ ] Does backend resolve user through AuthResolver?
[ ] Does backend call kernel facade/port instead of repositories?
[ ] Does kernel receive KernelRequestContext or user-scoped equivalent?
[ ] Are reads/writes user-scoped?
[ ] Are LLM outputs schema-validated?
[ ] Do default tests avoid real Postgres/DeepSeek?
[ ] Does PostgreSQL path avoid database-level foreign-key constraints?
[ ] Are generation writes transaction-aware in Postgres mode?
[ ] Are errors returned through a stable envelope?
```
