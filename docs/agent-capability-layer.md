# Agent Capability Layer

The capability layer is the internal slot system for future context, retrieval, memory, reflection, and evaluation work. It exists so the runtime can grow without putting new intelligence logic inside `AgentOrchestrator`.

## Files

- `src/agent-core/capabilities/AgentCapabilityModule.ts`
- `src/agent-core/capabilities/AgentCapabilityRegistry.ts`
- `src/agent-core/capabilities/defaultCapabilities.ts`
- `src/agent-core/context`
- `src/agent-core/retrieval`
- `src/agent-core/evidence`
- `src/agent-core/memory`
- `src/agent-core/reflection`
- `src/agent-core/evaluation`

## Module Shape

An `AgentCapabilityModule` can provide optional lists:

- `contextProviders`
- `retrievalProviders`
- `memoryProviders`
- `reflectionSinks`
- `evaluationHooks`

All lists are optional. An empty module must be valid. Default runtime uses `core.noop`, which registers Noop memory, reflection, and evaluation behavior and does not connect real retrieval or persistence.

## Registry Responsibilities

`AgentCapabilityRegistry`:

- stores capability modules;
- detects duplicate module IDs;
- lists providers, sinks, and hooks by category;
- gives runtime services a stable internal lookup surface.

The registry does not execute business behavior. Runtime services choose when to call providers or hooks.

## Context Flow

`ContextAssemblyPipeline` builds the base `AgentContext` from session, workspace, tools, recent messages, user asset context, and product context.

Capability context providers can add internal data only under:

```text
AgentContext.productContext.capabilities.context
```

This namespace keeps provider output away from public response fields and avoids accidental frontend contract changes.

## Retrieval Flow

`RetrievalProvider` is reserved for future RAG or search-like capability.

Current default behavior:

- no real vector store;
- no external retrieval call;
- Noop provider returns empty results.

Future retrieval providers should return `RetrievalResult` and attach traceable evidence references. They should feed context or critic flows through internal structures, not direct response mutation.

## Evidence Flow

Evidence contracts live in `src/agent-core/evidence`:

- `EvidenceItem`
- `EvidenceBundle`
- `EvidenceTrace`
- `EvidenceNormalizer`

Evidence normalizers convert source-specific product data into traceable evidence. Evidence is internal support for generation, review, and future retrieval. ProductBlock fields remain unchanged.

## Memory Flow

`MemoryProvider` supports future user preference and strategy memory.

Current default behavior:

- no persistence;
- retrieval returns no records;
- remember operations have no side effect.

Future memory should stay behind `MemoryProvider`, and any stored record should use `MemoryRecord`.

## Reflection Flow

`LearningEventRecorder` receives internal `LearningEvent` values from runtime services.

Current event sources include:

- tool result events in `PlanExecutionService`;
- pending action events in `PlanExecutionService` and `AgentOrchestrator`;
- critic review events in `ReviewPipeline`;
- explicit action preference signals in `AgentOrchestrator`.

`ReflectionSink` receives these events. Default Noop reflection does not persist anything. Recorder or sink failure must never affect the user request.

## Evaluation Flow

`EvaluationHook` is for internal quality and measurement callbacks.

Current hook points include:

- tool result events through `LearningEventService`;
- critic review events through `ReviewPipeline`;
- future run-level before and after hooks.

Evaluation hooks must not mutate `ToolResult`, `ProductBlock`, `AgentDecisionSchema`, or API response objects.

## Adding A Capability Module

1. Create a module with a stable `id`.
2. Add only the providers, sinks, or hooks needed by that module.
3. Register it with `AgentCapabilityRegistry`.
4. Add tests that verify registry listing and default behavior.
5. Confirm public contract tests still pass.

Example shape:

```ts
const module = {
  id: "career.preference-signals",
  memoryProviders: [provider],
  reflectionSinks: [sink],
};
```

## Non-Negotiable Boundaries

- Do not change `AgentDecisionSchema` to carry capability data.
- Do not change `ToolDefinition` or `ToolResult` for a provider.
- Do not add provider output to frontend response metadata unless a public contract migration is explicitly approved.
- Do not add RAG, memory persistence, reflection storage, or evaluation scoring directly to `AgentOrchestrator`.
- Keep all new capability behavior optional and backward compatible.

## Verification

Run:

```bash
npm run typecheck
npx vitest run tests/AgentCapabilityRegistry.test.ts tests/MemoryReflectionEvaluationInterfaces.test.ts tests/RetrievalEvidenceInterfaces.test.ts
npm test
git diff --check
```
