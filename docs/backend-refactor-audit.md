# P12 Backend Refactor Audit

## Keep

- `src/product/**`: real product services and repositories for experiences, JD records, resumes, imports, and generations.
- `src/exports/**`, `src/files/**`, `src/jobs/**`: export, upload, storage, and background job foundations.
- `src/auth/**`, `src/api/auth/**`, `src/api/context.ts`, `src/api/errors/**`: auth and API request safety.
- `src/copilot/services/**` and `src/copilot/persistence/**`: session, message, workspace, and activity persistence.
- `src/agent-core/model/**`, `src/providers/**`: model invocation boundary.

## Fake Agent / Redundant Compatibility / Temporary Patch Areas

- Old `src/agents`, `src/core`, `src/kernel`, `src/application`, `src/knowledge`, and `src/tools` code has now been removed. New runtime writes workspace patches only from real tool results.
- New registry separates mutability and confirmation.
- `src/copilot/CopilotPresenter.ts`: legacy presenter merged assistant text from action/card results. New orchestrator composes responses from tool results and pending confirmations.
- New `src/agent-core/tools/ToolRegistry.ts` is the only runtime registry.
- Old deterministic frontdesk fallback paths that return "saved" style messages without confirmed writes are not used by `/copilot/chat` after this refactor.

## Rewritten / Migrated

- `/copilot/chat` and `/copilot/actions` now enter `src/agent-core/runtime/AgentOrchestrator.ts` through `src/copilot/CopilotOrchestrator.ts`.
- Pending confirmation APIs are exposed under `/copilot/pending-actions`.
- Experience library operations moved to `src/agent-tools/experience/**` and call real `productServices.experienceService`.
- Prompt text moved from TypeScript strings into `src/agent-core/prompts/prompts/*.md`.
- Tool metadata moved to `ToolDefinition` with owner, schema, mutability, confirmation, and risk fields.

## Interfaces Kept Compatible

- `POST /copilot/chat`
- `POST /copilot/actions`
- `POST /copilot/chat/stream`
- `CopilotChatResponse` top-level fields: `sessionId`, `turnId`, `assistantMessage`, `timeline`, `workspace`, `nextActions`, `raw`

New raw fields are additive: `raw.agentTrace`, `raw.toolResults`, `raw.actionResults`, `raw.pendingActions`.

## Target Directory Structure

```text
src/agent-core/
  runtime/
  agents/
  planning/
  tools/
  confirmation/
  prompts/
  validation/
  memory/
src/agent-tools/
  experience/
  jd/
  resume/
  export/
  evidence/
src/api/routes/
  copilot.ts
  agentDebug.ts
  pendingActions.ts
```

## Current Scope

Implemented the real runtime core, structured trace, model-backed agent contract, registry/executor, pending confirmation service, prompt registry, and real experience tools. RAG, reflection, long-term memory, and evaluation remain explicit extension points under `agent-core/memory` and agent output validation.
