# Coolto/CV Agent Backend Quality Assessment

Date: 2026-07-01
Runtime: Docker API on `http://127.0.0.1:3000`, Postgres mode, `x-user-id: dev-user`
Model runtime: DeepSeek provider configured, `deepseek-v4-flash`, API key present

## Executive Summary

Current conclusion: not ready for formal production launch.

The backend is structurally strong and most API surfaces respond correctly, but the live Docker/Postgres/LLM run exposed several launch-blocking or launch-near-blocking issues:

- API contract reliability: 62/65 broad probe calls behaved as expected. Three real issues were found in user API key creation, resume item patching, and export deletion.
- AI quality: JD matching is usable, streaming works, and generation/export can complete, but text import and resume generation quality are not consistently production-grade.
- Code quality: test and typecheck are green, but live-only Postgres behavior revealed gaps in repository update semantics, runtime config validation, and error mapping.

## Validation Performed

### Commands and Runtime Checks

- `docker ps`: `coolto-agent-api` on port 3000 and `coolto-postgres` healthy.
- `GET /health`: 200, postgres mode, no kernel warnings.
- `GET /debug/model`: 200, DeepSeek provider/model configured.
- `npm run typecheck`: passed.
- `npm test`: passed with exit code 0.
- `npx vitest run --reporter=dot`: passed with exit code 0.

### API Surface Covered

Covered route groups:

- Health: `/health`
- Auth: `/auth/me`, `/auth/dev-login`, `/auth/logout`, `/auth/api-keys`
- Copilot: `/copilot/chat`, `/copilot/chat/stream`, `/copilot/actions`, `/copilot/sessions`, `/copilot/sidebar`, `/copilot/pending-actions`
- Product: dashboard, experiences, JDs, resumes, resume items, generations, imports, preferences, RAG preview/reindex/outcome
- Files: upload, list, get, parse, parsed document
- Jobs: list, create, get, cancel
- Exports: create, list, get, render, download, delete
- Debug: agent tools, model smoke

Broad API probe result: 65 calls, 62 passed, 3 failed.

## API Findings

### P0/P1 Failures

1. `POST /auth/api-keys` returns 500 when `USER_API_KEY_ENCRYPTION_SECRET` is not configured.
   - Evidence: live request returned internal error; Docker logs show `USER_API_KEY_ENCRYPTION_SECRET is required to store user API keys`.
   - Impact: BYOK/user model configuration is unusable in this environment and fails as an internal server error instead of a clear configuration error.
   - Recommendation: fail fast at startup when API key routes are enabled, or return a typed 503 `CONFIGURATION_REQUIRED` response.

2. `PATCH /product/resume-items/:id` returns 500 for a normal partial patch.
   - Evidence: patching `{ pinned: true, contentSnapshot: ... }` triggered Postgres `null value in column "title"` error.
   - Root cause: route passes optional fields as `undefined`; repository merges `{ ...current, ...patch }`, so `title: undefined` overwrites the stored title.
   - Recommendation: compact patch objects before service/repository update, or make repository updates field-wise with `COALESCE`/dynamic SQL.

3. `DELETE /exports/:id` soft-deletes but returns 404.
   - Evidence: `GET /exports/:id` succeeded, delete with no JSON body returned 404 because repository updates status to `deleted` then `getExport` filters deleted rows.
   - Additional issue: `DELETE` with `Content-Type: application/json` and no body produced Fastify parser 500.
   - Recommendation: return the pre-delete or updated deleted record from repository, and map Fastify empty JSON parser errors to 400.

### API Quality Notes

- Response envelopes are generally consistent for implemented API routes: `{ ok, data, meta }` on success and `{ ok:false, error, meta }` on handled failures.
- Plain Fastify 404 routes, such as `/docs`, do not use the standard envelope. This is acceptable for unknown routes but should be documented.
- Several expensive operations are synchronous from the caller perspective:
  - `POST /product/experiences` took about 50s due to claim/evidence indexing.
  - `POST /product/rag/evidence/reindex` took about 72s.
  - `POST /product/generations/from-jd` took about 155s.
- For launch, these should either be background jobs or have explicit client timeout/progress semantics.

## AI Quality Evaluation

Rubric used for launch readiness:

- Intent routing: chooses correct workflow/tool.
- Grounding: uses stored experience/JD evidence and avoids unsupported claims.
- Structured output: produces frontend-consumable artifacts, not only prose.
- Action chain reliability: pending action/job/generation/export state is recoverable.
- User-facing quality: concise, professional, no raw internal payloads.
- Failure quality: clear, typed, actionable errors.

### Results

1. Copilot JD matching
   - Status: passed functionally, acceptable quality.
   - Runtime: about 35s.
   - Output: assistant correctly summarized 19 matched experiences, 2 high matches, and exposed a structured `match_experiences_against_jd` tool result.
   - Quality score: 78/100.
   - Issues: `jdAnalysis.targetRole` captured too much of the full requirements text, so parsing is still somewhat coarse.

2. Text import AI extraction
   - Status: functionally passed, quality not launch-ready.
   - Runtime: about 7s.
   - Expected: two clean candidates from two experience paragraphs.
   - Actual: three candidates, including date/content fragments such as splitting `Jun 2025 - Sep 2025`; one candidate reported `organization_not_found` despite organization text being present.
   - Quality score: 45/100.
   - Recommendation: improve segmentation before LLM extraction and add post-extraction merge/validation.

3. Resume generation from JD
   - Status: functionally passed, quality borderline/not launch-ready.
   - Runtime: about 155s.
   - Output: generation created 2 variants; accept variant produced a resume with 14 items.
   - Quality report from system: `overallScore=69`, `jdMatchScore=20`, `expressionScore=46`, high risk `jd_match:low_coverage`.
   - Observed content issue: generated resume mixed Chinese and English bullets unnaturally and included weak/non-action bullet starts.
   - Quality score: 62/100.

4. PDF export after generation
   - Status: functionally passed.
   - Output: PDF export job completed, download returned `application/pdf`, about 485 KB.
   - Layout: `fitsPage=true`, `overflowPx=0`, but `underflowPx=160`, about 85% page usage.
   - Content quality inherits generation risks above.
   - Quality score: layout 80/100, final artifact 65/100.

5. Debug model smoke
   - Status: functionally passed.
   - Risk: with no evidence, generated placeholder-like content such as `XX大学` and awards. It correctly reported high unsupported-claim risk, but this should remain debug-only and never be considered product quality.

6. Copilot SSE stream
   - Status: passed.
   - Events included `agent.turn.started`, `agent.thinking`, `agent.route.started`, `agent.route.completed`, `agent.reasoning.snapshot`, `agent.message.completed`, `agent.workspace.updated`, `agent.completed`.

## Code Quality Assessment

### Strengths

- Clear module separation across API routes, agent runtime, product services, persistence, jobs, files, exports, RAG, preference, and auth.
- TypeScript typecheck and full Vitest suite pass.
- Good existing coverage around agent contracts, export pipeline, PDF layout, generation pending flow, RAG, preferences, and security guardrails.
- Idempotency and session locks exist for mutation/chat paths.
- Export pipeline now records fit/quality/critic reports, which gives useful machine-readable quality telemetry.

### Risks

1. Live Postgres paths are less protected than in-memory/test paths.
   - The resume item patch failure is a concrete example.
   - Add contract tests using Postgres-shaped repositories or lower-level repository tests for partial updates.

2. Hand-written body parsing and route helpers create inconsistent behavior.
   - Some routes compact patch fields; others do not.
   - Fastify parser errors can escape as 500.
   - Recommendation: centralize request schemas with Zod/Fastify schemas and shared error mapping.

3. Runtime config validation is incomplete.
   - Missing encryption secret causes runtime 500.
   - Debug routes are available in this dev Docker runtime; production must hard-disable them.
   - Recommendation: add boot-time config report with redacted checks and fail-fast rules for enabled features.

4. AI-heavy operations lack consistent async boundaries.
   - Some endpoints already use jobs; others block for 50-155s.
   - Recommendation: move indexing/reindex/generation to job-first contracts or expose progress APIs consistently.

5. Product quality gates are advisory, not blocking.
   - Resume export completed even with `jd_match:low_coverage` high risk and overall score 69.
   - Recommendation: before formal launch, decide which qualityReport risks should block, warn, or require user confirmation.

6. Logs are useful but noisy.
   - Current logs include many debug lines and partial model config. Secrets are masked, but production logging should use levels and avoid default debug verbosity.

## Launch Readiness Verdict

Not ready for formal production launch.

Recommended gate before launch:

- Fix the three API failures from the live probe.
- Make text import extraction reliable on multi-experience input.
- Require resume generation/export quality to pass minimum thresholds, for example:
  - no high `jd_match` risk,
  - `overallScore >= 80`,
  - `expressionScore >= 70`,
  - no mixed-language malformed bullets,
  - layout usage within agreed range.
- Move or gate long-running AI/indexing paths.
- Add live Docker/Postgres smoke scripts to CI or release checklist.

## Priority Remediation Plan

P0:

- Fix `PATCH /product/resume-items/:id` partial update null overwrite.
- Fix `DELETE /exports/:id` soft-delete response.
- Add `USER_API_KEY_ENCRYPTION_SECRET` handling: boot fail-fast or clear 503.

P1:

- Improve import text segmentation and candidate merge/validation.
- Add launch quality gates for generated resume/export artifacts.
- Convert long synchronous AI/index operations to background jobs or documented progress flows.
- Normalize Fastify parser errors into standard API error envelopes.

P2:

- Generate or maintain a machine-readable API contract.
- Add live Docker smoke scripts for route groups and AI workflows.
- Reduce production log verbosity and audit debug route exposure.
