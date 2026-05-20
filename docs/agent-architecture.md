# Agent Architecture

## Canonical Runtime

The only formal Copilot agent runtime is `src/agent-core`.

- Runtime orchestration: `src/agent-core/runtime/AgentOrchestrator.ts`
- Agent contracts and five product agents: `src/agent-core/agents`
- Planning contracts: `src/agent-core/planning`
- Trace and error model: `src/agent-core/runtime/AgentTrace.ts`, `AgentError.ts`
- Prompt loading: `src/agent-core/prompts`
- Validation schemas: `src/agent-core/validation`

The old `src/agents`, `src/core`, `src/kernel`, `src/application`, `src/knowledge`, `src/tools`, `src/workflows`, and `src/examples` trees have been removed from `src`. They were the previous demo/kernel/application framework and are no longer production entrypoints.

## Canonical Tool Framework

The only formal tool framework is `src/agent-core/tools`.

- `Tool.ts`: `ToolDefinition` metadata and execution contract
- `ToolRegistry.ts`: runtime registry
- `ToolExecutor.ts`: schema validation and execution trace
- `ToolResult.ts`: tool result contract
- `ToolPermissions.ts`: owner, mutability, and risk metadata

There must not be another production `ToolRegistry`. Business tools are aggregated only by `createAgentTools()` from `src/agent-tools/index.ts`.

## Business Tools

The only formal business tool directory is `src/agent-tools`.

- `experience`: real product experience library tools
- `jd`: JD read/save tools
- `resume`: resume read/generate/revise tools
- `export`: export preview and export tools
- `evidence`: evidence and unsupported-claim tools

Each tool must define `name`, `description`, `ownerAgent`, `inputSchema`, `outputSchema`, `mutability`, `requiresConfirmation`, `riskLevel`, and `execute`.

## Removed Legacy Frameworks

The repository no longer keeps a second agent/runtime/tool framework under `src`.

- Old agents: removed from `src/agents`
- Old generic runtime/kernel: removed from `src/core` and `src/kernel`
- Old application pipeline: removed from `src/application`
- Old knowledge/RAG prototype: removed from `src/knowledge`
- Old external demo tools: removed from `src/tools`
- Old demos/workflows/contracts: removed from `src/examples`, `src/workflows`, and `src/api-contracts`

Model invocation now lives under `src/agent-core/model`. Real provider adapters are limited to `src/providers/DeepSeekProvider.ts` and `src/providers/OpenAICompatibleProvider.ts`; mock/provider-factory code has been removed.

## API Execution Paths

`POST /copilot/chat`

1. `src/api/routes/copilot.ts`
2. `src/copilot/CopilotOrchestrator.ts`
3. `AgentOrchestrator.handleChat`
4. build `AgentContext`
5. `FrontDeskAgent` routes
6. specialist agent plans
7. `ToolExecutor` executes read tools or `PendingActionService` creates confirmation records
8. response returns `raw.agentTrace`, `raw.toolResults`, `raw.actionResults`, and `raw.pendingActions`

`POST /copilot/actions`

1. `src/api/routes/copilot.ts`
2. `CopilotOrchestrator.handleAction`
3. `AgentOrchestrator.handleExplicitAction`
4. deterministic action-to-tool mapping
5. read tools execute directly; write/delete/export tools create pending actions
6. unsupported actions return failed `actionResult`

Explicit actions do not get converted into natural-language chat messages and do not run FrontDesk routing.

`/copilot/pending-actions`

1. `src/api/routes/pendingActions.ts`
2. `PendingActionService`
3. `PendingActionRepository`
4. confirm executes the original tool only after ownership, expiry, status, tool existence, and schema checks pass

## Confirmation Tools

The following tools require confirmation:

- `save_experience_from_text`
- `update_experience`
- `delete_experience`
- `save_jd_from_text`
- `generate_resume_from_jd`
- `revise_resume_item`
- `export_resume`

Read and prepare tools do not require confirmation.

## Pending Action Persistence

`PendingActionService` depends on `PendingActionRepository`.

Current implementation:

- `src/agent-core/confirmation/PendingActionRepository.ts`
- `src/agent-core/confirmation/InMemoryPendingActionRepository.ts`

The in-memory repository is the default. PostgreSQL/Neon support should be added by implementing the same repository interface, then injecting it into `PendingActionService`. Runtime and route code should not change for persistence.

## Extension Points

Future RAG, memory, reflection, and evaluation should not be added directly to `AgentOrchestrator`.

- RAG and product context providers: `src/agent-core/memory`
- Agent memory contracts: `ContextProvider`
- Reflection/evaluation: add new `agent-core/evaluation` or `agent-core/reflection` modules, then feed validated summaries into `AgentContext.productContext`
- New business capabilities: add tools under `src/agent-tools`, register them through `createAgentTools()`, and expose them through agent `allowedTools`
