# Coolto CV Agent Contract

> Status: Draft v0.1, P8.0-P8.3 implemented through LLM-backed FrontDeskAgent and ExperienceExtractor  
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
```

P8.1-P8.3 implementation notes:

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
11. ArtifactGenerator and CriticAgent mode env vars are parsed for future use, but their LLM implementations are not enabled yet.

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
};
```

Internal services may continue to use `userId`, but SDK/facade boundaries should accept `KernelRequestContext`.

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
4. Future LLM generation must not fabricate unsupported claims.

### 6.4 List Evidence Chains by Session

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

### 6.5 Get Graph by Scope

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

### P9 Feedback Loop

- Artifact decisions.
- Revision requests.
- Conservative rewrite.
- Evidence augmentation.
- Session updater.

### P10 Product Backend

- Multipart upload.
- Object storage.
- Rate limit.
- Logging/tracing.
- Production auth.

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
