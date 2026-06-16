# Agent Internal Architecture v2

This document describes the internal Agent Runtime architecture after the phased refactor. It is a developer guide for changing internals without changing frontend or API contracts.

## Public Contract Boundary

The following contracts are public for product and frontend integration. Do not change their shape or semantics during internal refactors:

- API routes: `POST /copilot/chat`, `POST /copilot/chat/stream`, `POST /copilot/actions`, pending action routes, product routes, files, exports, jobs, and debug routes.
- Copilot request and response types in `src/copilot/types.ts`, including `CopilotChatRequest`, `CopilotChatResponse`, `CopilotActionRequest`, `CopilotActionResult`, `CopilotMessageMetadata`, `CopilotWorkspace`, `DisplaySnapshot`, and SSE event envelopes.
- Agent output schemas in `src/agent-core/validation/AgentOutputSchemas.ts`, including `AgentDecisionSchema`, `PlanStepSchema`, `CriticReviewSchema`, and `AgentNameSchema`.
- Tool contracts in `src/agent-core/tools`, including `ToolDefinition`, `ToolResult`, `requiresConfirmation`, `riskLevel`, `mutability`, `ownerAgent`, input schema validation, and output schema validation.
- Product blocks and workspace surfaces consumed by the frontend, including `experience_list`, `experience_card`, `experience_detail`, `experience_candidate_form`, `jd_analysis_result`, `action_result`, `experience_match_results`, and `jd_match_results`.

Internal modules can be added freely only when final API responses and stored message metadata remain backward compatible.

## Runtime Shape

`AgentOrchestrator` remains the facade used by `CopilotOrchestrator`, but most specialized responsibilities now live in smaller internal services:

- `runtime/ContextAssemblyPipeline.ts`: builds `AgentContext` and attaches internal capability context under `productContext.capabilities`.
- `runtime/PlanExecutionService.ts`: executes plan steps, hydrates arguments, enforces ID and scope guards, creates pending actions, and records internal learning events.
- `runtime/AgentDecisionRunner.ts`: wraps `agent.decide` and decision trace completion.
- `runtime/ReviewPipeline.ts`: wraps `CriticGate`, `ReviewPolicy`, critic review events, and evaluation hooks.
- `runtime/AgentResultAssembler.ts`: assembles response text, product blocks, workspace patch, display snapshot, `AgentRoomEvent`, metadata, and raw debug fields.
- `flow/ExplicitActionMapper.ts`: maps `/copilot/actions` product actions to deterministic plan steps, `needs_input`, or `unsupported`.
- `flow/ProductFlowRouter.ts`: reserved product-flow boundary for future deterministic product state routing.
- `capabilities/AgentCapabilityRegistry.ts`: aggregates context, retrieval, memory, reflection, and evaluation providers.

The important rule is simple: orchestration coordinates services; domain-specific capability logic belongs in domain modules, tools, or capability providers.

## Internal Extension Points

Use these modules instead of expanding the orchestrator:

- Context: `src/agent-core/context`
- Capability registry: `src/agent-core/capabilities`
- Retrieval: `src/agent-core/retrieval`
- Evidence: `src/agent-core/evidence`
- Memory: `src/agent-core/memory`
- Reflection: `src/agent-core/reflection`
- Evaluation: `src/agent-core/evaluation`
- Flow mapping: `src/agent-core/flow`
- Domain registration: `src/agent-core/domain`
- Tools: `src/agent-tools`

Future RAG, memory, reflection, and evaluation work must enter through these extension points. Do not add vector search, persistent learning, or scoring logic directly to `AgentOrchestrator`.

## Request Paths

`POST /copilot/chat`:

1. `src/api/routes/copilot.ts`
2. `src/copilot/CopilotOrchestrator.ts`
3. `AgentOrchestrator.handleChat`
4. `ContextAssemblyPipeline`
5. `AgentDecisionRunner` for frontdesk routing
6. specialist loop
7. `PlanExecutionService`
8. `ReviewPipeline`
9. `AgentResultAssembler`

`POST /copilot/actions`:

1. `src/api/routes/copilot.ts`
2. `CopilotOrchestrator.handleAction`
3. `AgentOrchestrator.handleExplicitAction`
4. `ProductFlowRouter`
5. `ExplicitActionMapper`
6. `PlanExecutionService`
7. `AgentResultAssembler`

Pending action confirm and cancel still enter through `AgentOrchestrator`, but execution and display updates are delegated to `PendingActionService`, `PlanExecutionService` behavior, and workspace projectors.

## Compatibility Checks

Run these checks after internal architecture changes:

```bash
npm run typecheck
npx vitest run tests/agentContractFreeze.test.ts tests/agentPromptContract.test.ts
npm test
git diff --check
```

For action mapping changes, also run:

```bash
npx vitest run tests/ExplicitActionMapper.test.ts tests/copilotExplicitActions.test.ts
```
