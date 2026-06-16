# Agent Extension Guide

This guide explains where to add new internal Agent capabilities while preserving the public Copilot contract.

## First Rule

Do not add new RAG, memory, reflection, evaluation, product-flow, or domain logic directly to `AgentOrchestrator`. Add the capability at the matching extension point, then wire it through the existing registry or service.

## Add A ContextProvider

1. Implement `ContextProvider` from `src/agent-core/context/ContextProvider.ts`.
2. Return only internal context data.
3. Register it through an `AgentCapabilityModule`.
4. Let `ContextAssemblyPipeline` attach provider output under `AgentContext.productContext.capabilities.context`.
5. Keep default behavior unchanged by using an empty or Noop provider when the capability is not enabled.

Do not add new top-level `AgentContext` fields unless a public contract review is explicitly planned.

## Add A RetrievalProvider

1. Implement `RetrievalProvider` in `src/agent-core/retrieval`.
2. Accept `RetrievalQuery` and `RetrievalScope`.
3. Return `RetrievalResult` values with evidence references where possible.
4. Register the provider in an `AgentCapabilityModule`.
5. Keep the default provider as `NoopRetrievalProvider` unless real retrieval is explicitly enabled.

Retrieval output should feed internal context or evidence structures. It should not directly change `CopilotChatResponse`.

## Add A MemoryProvider

1. Implement `MemoryProvider` in `src/agent-core/memory`.
2. Use `MemoryRecord` for internal memory items.
3. Register the provider through the capability registry.
4. Add tests showing the provider can retrieve or accept records without changing public response shape.

Persistence is optional and must be introduced behind the provider interface, not inside runtime orchestration.

## Add A ReflectionSink

1. Implement `ReflectionSink` in `src/agent-core/reflection`.
2. Accept `LearningEvent` values from `LearningEventRecorder`.
3. Ensure failures are contained and never affect user-facing execution.
4. Register the sink through `AgentCapabilityModule.reflectionSinks`.

Default runtime uses Noop reflection, so adding a sink must be an explicit internal configuration change.

## Add An EvaluationHook

1. Implement `EvaluationHook` in `src/agent-core/evaluation`.
2. Support the hook methods needed by the feature, such as `onToolResult` or `onCriticReview`.
3. Register the hook through `AgentCapabilityModule.evaluationHooks`.
4. Keep hook failures isolated from user-facing flow.

Evaluation hooks are for internal measurement and quality signals. They must not mutate public response objects.

## Add An EvidenceNormalizer

1. Implement `EvidenceNormalizer` in `src/agent-core/evidence`.
2. Convert source-specific evidence into `EvidenceItem` and `EvidenceBundle`.
3. Preserve source identifiers and confidence metadata where available.
4. Feed evidence into internal retrieval, critic, or product-context flows.

Evidence normalization should make claims traceable without changing ProductBlock fields.

## Add A Tool

1. Add the tool implementation under `src/agent-tools/<domain>`.
2. Define `ToolDefinition` completely: `name`, `description`, `ownerAgent`, `inputSchema`, `outputSchema`, `mutability`, `requiresConfirmation`, `riskLevel`, and `execute`.
3. Return a valid `ToolResult`.
4. Register it through `src/agent-tools/index.ts`.
5. Add it to the owning agent's `allowedTools` only when the agent should use it.
6. Add tests for input validation, output shape, and pending action behavior when confirmation is required.

Do not change `ToolDefinition` or `ToolResult` to support one new tool.

## Add A Domain

1. Create an `AgentDomainModule` in `src/agent-domains/<domain>`.
2. Provide `agents` and `tools` as before.
3. Optionally add `manifests` and `capabilities`.
4. Register the domain through `AgentDomainRegistry`.
5. Keep `AgentNameSchema`, prompts, and allowed tools compatible unless a separate contract migration is approved.

Domain metadata is internal. It should help future discovery without changing runtime behavior by default.

## Add Explicit Product Actions

1. Add or reuse a `ProductActionType` only when the frontend contract is already approved.
2. Implement deterministic mapping in `src/agent-core/flow/ExplicitActionMapper.ts`.
3. Return one of the existing mapping results: `step`, `needs_input`, or `unsupported`.
4. Add coverage in `tests/ExplicitActionMapper.test.ts` and contract coverage for `/copilot/actions`.

Do not route explicit product actions through natural-language chat.

## Verification Checklist

Use the narrowest relevant tests first, then run the full suite:

```bash
npm run typecheck
npx vitest run tests/agentContractFreeze.test.ts tests/agentPromptContract.test.ts
npm test
git diff --check
```

For capability changes, include focused tests for the new provider, sink, hook, normalizer, tool, or domain registry behavior.
