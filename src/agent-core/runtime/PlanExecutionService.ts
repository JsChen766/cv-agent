import { ContextHydrator, toolNeedsInputMessageForFields } from "../../copilot/context/ContextHydrator.js";
import { defaultToolResultVisibility } from "../../copilot/response/ToolResultVisibility.js";
import type { CopilotLocale } from "../../copilot/locale.js";
import { buildNormalizedExperiencePreview } from "../../product/experiencePreview.js";
import { computeJDHash } from "../../product/jdHash.js";
import type { ExperienceDraft } from "../../product/types.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { PendingActionService } from "../confirmation/PendingActionService.js";
import { affectedResourcesFor } from "../security/ToolAffectedResources.js";
import { LearningEventService } from "../reflection/LearningEventService.js";
import { guardToolIds, stripInternalToolArgs } from "../security/ToolIdGuard.js";
import { guardToolScope } from "../security/ToolScopeGuard.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import { AgentError } from "./AgentError.js";
import type { AgentMessageParticipant, AgentMessageType } from "./AgentMessage.js";
import type { AgentStreamEventType } from "./AgentStreamEvent.js";
import type { ToolExecutionRecord } from "./CriticGate.js";
import { confirmationSummary, confirmationTitle, previewFor } from "./PreviewPresenter.js";
import type { ExecutedPlan } from "./RunResult.js";
import type { RunState } from "./RunState.js";
import { ToolExecutionPolicy } from "./ToolExecutionPolicy.js";

type PlanExecutionServiceDeps = {
  tools: ToolRegistry;
  pendingActions: PendingActionService;
  contextHydrator?: ContextHydrator;
  toolExecutionPolicy?: ToolExecutionPolicy;
  learningEventService?: LearningEventService;
  localeFor: (run: RunState) => CopilotLocale;
  toolCompletedMessage: (run: RunState, toolName: string) => string;
  emit: (
    run: RunState,
    type: AgentStreamEventType,
    label: string,
    extra?: {
      agentName?: AgentName | "AgentOrchestrator" | "ToolExecutor";
      toolName?: string;
      status?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => void;
  addObservation: (run: RunState, step: PlanStep, result: ToolResult) => void;
  addPublicAgentMessage: (
    run: RunState,
    message: {
      from: AgentMessageParticipant;
      type: AgentMessageType;
      content: string;
      payload?: unknown;
    },
  ) => void;
  getOrExecutePrepareSaveResult: (
    run: RunState,
    args: Record<string, unknown>,
  ) => Promise<{ draft: Record<string, unknown>; experienceDraft: Record<string, unknown> } | undefined>;
  getPreparedResumeRewriteResult: (
    run: RunState,
    args: Record<string, unknown>,
  ) => { rewrittenText: string; sourceTextPreview?: string; changes?: unknown[] } | undefined;
};

type ToolOrPendingActionResult = {
  result: ToolResult;
  pendingAction?: PendingAction;
};

export class PlanExecutionService {
  private readonly contextHydrator: ContextHydrator;
  private readonly toolExecutionPolicy: ToolExecutionPolicy;
  private readonly learningEventService: LearningEventService;

  public constructor(private readonly deps: PlanExecutionServiceDeps) {
    this.contextHydrator = deps.contextHydrator ?? new ContextHydrator();
    this.toolExecutionPolicy = deps.toolExecutionPolicy ?? new ToolExecutionPolicy();
    this.learningEventService = deps.learningEventService ?? new LearningEventService();
  }

  public async executePlan(run: RunState, plan: PlanStep[]): Promise<ExecutedPlan> {
    const toolResults: ToolResult[] = [];
    const pendingActions: PendingAction[] = [];
    const executions: ToolExecutionRecord[] = [];
    for (const step of plan) {
      if (!step.toolName) continue;
      this.deps.addPublicAgentMessage(run, {
        from: step.agentName,
        type: "request",
        content: labelForToolStarted(step.toolName),
        payload: { eventType: "tool_call", toolName: step.toolName },
      });
      const result = await this.executeToolOrCreatePendingAction(run, step);
      toolResults.push(result.result);
      executions.push({ step, result: result.result });
      await this.learningEventService.recordToolResult(run.context, step, result.result);
      this.deps.addObservation(run, step, result.result);
      this.deps.addPublicAgentMessage(run, {
        from: "orchestrator",
        type: "observation",
        content: result.result.message ?? this.deps.toolCompletedMessage(run, step.toolName ?? "tool"),
        payload: { eventType: "tool_result", toolName: step.toolName, status: result.result.status },
      });
      if (result.pendingAction) pendingActions.push(result.pendingAction);
      if (result.result.status === "needs_input" || result.result.status === "failed") break;
    }
    return { toolResults, pendingActions, executions };
  }

  public async executeToolOrCreatePendingAction(
    run: RunState,
    step: PlanStep,
  ): Promise<ToolOrPendingActionResult> {
    const tool = this.deps.tools.get(step.toolName ?? "");
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Planned tool is not registered.", { statusCode: 404 });

    const hydratedArgs = this.contextHydrator.hydrate(tool.name, (step.arguments ?? {}) as Record<string, unknown>, run.context, run.workspace);
    run.trace.add({
      agentName: step.agentName,
      type: "reason",
      summary: `Hydrated arguments for ${tool.name}.`,
      toolName: tool.name,
      status: "success",
      completedAt: new Date().toISOString(),
      metadata: { argumentKeys: Object.keys(hydratedArgs) },
    });
    if (Array.isArray(hydratedArgs.__resolverConflicts) && hydratedArgs.__resolverConflicts.length > 0) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Resolver detected conflicting IDs for ${tool.name}.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          toolName: tool.name,
          conflicts: hydratedArgs.__resolverConflicts,
        },
      });
    }
    const idGuardResult = guardToolIds(tool.name, hydratedArgs);
    if (idGuardResult) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Guard blocked tool ${tool.name}: non-canonical ID detected.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          stepId: step.id,
          toolName: tool.name,
          rejectedReason: idGuardResult.actionResult?.missingInputs,
          sessionId: run.context.sessionId,
          turnId: run.context.turnId,
        },
      });
      this.deps.emit(run, "agent.tool.failed", `工具调用被拦截：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "non_canonical_id", missingInputs: idGuardResult.actionResult?.missingInputs },
      });
      return { result: idGuardResult };
    }
    const parsed = tool.inputSchema.safeParse(stripInternalToolArgs(hydratedArgs));
    if (!parsed.success) {
      const missingFields = parsed.error.issues
        .map((issue) => issue.path.join("."))
        .filter(Boolean);
      this.deps.emit(run, "agent.tool.failed", `工具调用失败：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "missing_required_input" },
      });
      const message = toolNeedsInputMessageForFields(tool.name, missingFields, this.deps.localeFor(run));
      return {
        result: {
          status: "needs_input",
          message,
          visibility: "error_user_visible",
          actionResult: {
            actionType: tool.name,
            status: "needs_input",
            reason: "missing_required_input",
            missingInputs: missingFields,
            message,
          },
        },
      };
    }
    const args = parsed.data as Record<string, unknown>;
    const scopedArgs = {
      ...args,
      ...(Array.isArray(hydratedArgs.__resolverConflicts) ? { __resolverConflicts: hydratedArgs.__resolverConflicts } : {}),
    };
    const scopeGuardResult = await guardToolScope(tool.name, scopedArgs, run.context, run.workspace);
    if (scopeGuardResult) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Guard blocked tool ${tool.name}: scope validation failed.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          stepId: step.id,
          toolName: tool.name,
          reason: scopeGuardResult.actionResult?.missingInputs,
          sessionId: run.context.sessionId,
          turnId: run.context.turnId,
        },
      });
      this.deps.emit(run, "agent.tool.failed", `工具调用被拦截：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "scope_guard", missingInputs: scopeGuardResult.actionResult?.missingInputs },
      });
      return { result: scopeGuardResult };
    }
    this.deps.emit(run, "agent.tool.started", labelForToolStarted(tool.name), {
      agentName: step.agentName,
      toolName: tool.name,
      status: "running",
    });
    const autoRevisionAuthorized = isAutoRevisionAuthorized(run, tool.name);
    if (this.toolExecutionPolicy.canExecuteWithoutConfirmation(tool, autoRevisionAuthorized)) {
      if (autoRevisionAuthorized) {
        run.trace.add({
          agentName: "AgentOrchestrator",
          type: "reason",
          summary: `Using internal auto-revision authorization for ${tool.name}.`,
          toolName: tool.name,
          status: "success",
          completedAt: new Date().toISOString(),
          metadata: {
            autoRevisionAuthorized: true,
            sourcePendingActionId: run.autoRevisionContext?.sourcePendingActionId,
          },
        });
      }
      try {
        const rawResult = await run.executor.executeDefinition(tool, args, run.context);
        const patched = sanitizeReadToolConfirmationResult(rawResult, tool.name);
        if (patched !== rawResult) {
          run.trace.add({
            agentName: "AgentOrchestrator",
            type: "reason",
            summary: `Downgraded unexpected needs_confirmation from read tool ${tool.name} to success.`,
            status: "success",
            completedAt: new Date().toISOString(),
          });
        }
        const result = ensureToolResultVisibility(patched, tool.name);
        this.deps.emit(run, "agent.tool.completed", "工具调用完成", {
          agentName: step.agentName,
          toolName: tool.name,
          status: result.status,
        });
        this.deps.emit(run, "agent.tool.summary", "工具结果已整理", {
          agentName: step.agentName,
          toolName: tool.name,
          status: result.status,
          payload: {
            summary: result.message || "工具执行完成",
            status: result.status,
          },
        });
        return { result };
      } catch (error) {
        await this.learningEventService.recordToolResult(run.context, step, {
          status: "failed",
          message: error instanceof Error ? error.message : "Tool execution failed.",
        });
        this.deps.emit(run, "agent.tool.failed", `工具调用失败：${tool.name}`, {
          agentName: step.agentName,
          toolName: tool.name,
          status: "failed",
          payload: { message: error instanceof Error ? error.message : "Tool execution failed." },
        });
        throw error;
      }
    }

    let enrichedArgs: Record<string, unknown> = args;
    let enrichedPreview: PendingAction["preview"] = previewFor(tool.name, args);
    if (tool.name === "save_experience_from_text") {
      const existingPending = await this.deps.pendingActions.list(run.context.userId, run.context.sessionId);
      const duplicatePending = existingPending.find(
        (pa) => pa.toolName === "save_experience_from_text" && pa.toolArguments?.text === (typeof args.text === "string" ? args.text : undefined),
      );
      if (duplicatePending) {
        return {
          result: {
            status: "needs_input",
            message: duplicatePending.summary,
            pendingActionId: duplicatePending.id,
            visibility: "action_required",
            actionResult: {
              status: "needs_confirmation",
              actionType: tool.name,
              pendingActionId: duplicatePending.id,
            },
          },
        };
      }

      const prepared = await this.deps.getOrExecutePrepareSaveResult(run, args);
      if (prepared) {
        const textFallback = stringValue(args.text) ?? buildExperienceTextFallback(prepared.draft);
        enrichedArgs = {
          ...args,
          ...(textFallback ? { text: textFallback } : {}),
          candidate: prepared.draft,
          experienceDraft: prepared.experienceDraft,
        };
        enrichedPreview = {
          after: {
            experienceDraft: prepared.experienceDraft,
          },
        };
      } else {
        const draft = draftFromSaveExperienceArgs(args);
        if (draft) {
          const experienceDraft = buildNormalizedExperiencePreview(draft, { missingFields: draft.warnings });
          const textFallback = stringValue(args.text) ?? buildExperienceTextFallback(draft);
          enrichedArgs = {
            ...args,
            ...(textFallback ? { text: textFallback } : {}),
            candidate: draft,
            experienceDraft,
          };
          enrichedPreview = {
            after: {
              experienceDraft,
            },
          };
        }
      }
    }

    if (tool.name === "save_jd_from_text") {
      const jdText = stringValue(args.text) ?? stringValue(args.jdText) ?? stringValue(args.rawText);
      if (jdText) {
        const jdHash = computeJDHash(jdText);
        enrichedArgs = {
          ...args,
          text: jdText,
          jdText,
          rawText: jdText,
          jdHash,
        };
        enrichedPreview = previewFor(tool.name, enrichedArgs);
        const existingPending = await this.deps.pendingActions.list(run.context.userId, run.context.sessionId);
        const duplicatePending = existingPending.find((pa) => {
          if (pa.toolName !== "save_jd_from_text") return false;
          const pendingArgs = pa.toolArguments ?? {};
          const existingHash = stringValue(pendingArgs.jdHash)
            ?? computeJDHash(
              stringValue(pendingArgs.text)
              ?? stringValue(pendingArgs.jdText)
              ?? stringValue(pendingArgs.rawText)
              ?? "",
            );
          return existingHash === jdHash;
        });
        if (duplicatePending) {
          return {
            result: {
              status: "needs_input",
              message: duplicatePending.summary,
              pendingActionId: duplicatePending.id,
              visibility: "action_required",
              actionResult: {
                status: "needs_confirmation",
                actionType: tool.name,
                pendingActionId: duplicatePending.id,
              },
            },
          };
        }
      }
    }

    if (tool.name === "generate_resume_from_jd") {
      const jdId = stringValue(args.jdId);
      const jdText = stringValue(args.jdText);
      const jdHash = stringValue(args.jdHash) ?? (jdText ? computeJDHash(jdText) : undefined);
      enrichedArgs = {
        ...enrichedArgs,
        ...(jdHash ? { jdHash } : {}),
      };

      const history = await this.deps.pendingActions.listAll(run.context.userId, run.context.sessionId);
      const sameGenerateActions = history.filter((item) => {
        if (item.toolName !== "generate_resume_from_jd") return false;
        const itemArgs = item.toolArguments ?? {};
        const itemJdId = stringValue(itemArgs.jdId);
        const itemJdHash =
          stringValue(itemArgs.jdHash)
          ?? (() => {
            const text = stringValue(itemArgs.jdText) ?? stringValue(itemArgs.text) ?? stringValue(itemArgs.rawText);
            return text ? computeJDHash(text) : undefined;
          })();
        if (jdId && itemJdId && jdId === itemJdId) return true;
        if (jdHash && itemJdHash && jdHash === itemJdHash) return true;
        return false;
      });
      const latestSameAction = sameGenerateActions.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      if (latestSameAction) {
        if (latestSameAction.status === "confirmed" && latestSameAction.lastResult?.status === "success") {
          const reused = ensureToolResultVisibility(latestSameAction.lastResult, tool.name);
          return {
            result: {
              ...reused,
              message: reused.message ?? "已确认，正在生成简历版本。生成完成后会展示在这里。",
            },
          };
        }
        if (latestSameAction.status === "pending") {
          return {
            result: {
              status: "needs_input",
              message: latestSameAction.summary || "请确认后继续生成简历。",
              pendingActionId: latestSameAction.id,
              visibility: "action_required",
              actionResult: {
                status: "needs_confirmation",
                actionType: tool.name,
                pendingActionId: latestSameAction.id,
              },
            },
          };
        }
        if (latestSameAction.status === "executed" && latestSameAction.lastResult?.status === "success") {
          const reused = ensureToolResultVisibility(latestSameAction.lastResult, tool.name);
          return {
            result: {
              ...reused,
              message: reused.message ?? "简历已生成，可查看版本或下载文件。",
            },
          };
        }
      }
    }

    if (tool.name === "revise_resume_item" && !stringValue(enrichedArgs.rewrittenText)) {
      const prepared = this.deps.getPreparedResumeRewriteResult(run, enrichedArgs);
      if (prepared) {
        enrichedArgs = {
          ...enrichedArgs,
          rewrittenText: prepared.rewrittenText,
          preparedRewrite: {
            sourceTextPreview: prepared.sourceTextPreview,
            changes: prepared.changes,
          },
        };
        enrichedPreview = {
          before: { sourceTextPreview: prepared.sourceTextPreview },
          after: { rewrittenText: prepared.rewrittenText, changes: prepared.changes },
        };
      }
    }

    const pending = await this.deps.pendingActions.create({
      userId: run.context.userId,
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      tool,
      toolArguments: enrichedArgs,
      title: confirmationTitle(tool.name, this.deps.localeFor(run), step.summary),
      summary: confirmationSummary(tool.name, this.deps.localeFor(run), enrichedArgs),
      affectedResources: affectedResourcesFor(tool.name, enrichedArgs),
      preview: enrichedPreview,
    });
    await this.learningEventService.recordPendingActionCreated(run.context, pending, step);
    run.trace.add({
      agentName: step.agentName,
      type: "confirmation_required",
      summary: `Confirmation required for ${tool.name}.`,
      toolName: tool.name,
      status: "needs_input",
      completedAt: new Date().toISOString(),
      metadata: { pendingActionId: pending.id },
    });
    this.deps.emit(run, "agent.pending_action.created", "已准备确认操作", {
      agentName: step.agentName,
      toolName: tool.name,
      status: "needs_confirmation",
      payload: {
        pendingActionId: pending.id,
        toolName: tool.name,
        summary: pending.summary,
        riskLevel: pending.riskLevel,
      },
    });
    this.deps.emit(run, "agent.tool.completed", "已准备确认操作", {
      agentName: step.agentName,
      toolName: tool.name,
      status: "needs_confirmation",
      payload: { pendingActionId: pending.id },
    });
    return {
      pendingAction: pending,
      result: {
        status: "needs_input",
        message: pending.summary,
        pendingActionId: pending.id,
        visibility: "action_required",
        actionResult: {
          status: "needs_confirmation",
          actionType: tool.name,
          pendingActionId: pending.id,
        },
      },
    };
  }
}

export function ensureToolResultVisibility(result: ToolResult, toolName?: string): ToolResult {
  return {
    ...result,
    visibility: result.visibility ?? defaultToolResultVisibility(toolName, result.status),
  };
}

export function sanitizeReadToolConfirmationResult(result: ToolResult, toolName: string): ToolResult {
  if (result.actionResult?.status !== "needs_confirmation") return result;
  return {
    ...result,
    visibility: result.visibility ?? "user_summary",
    actionResult: {
      ...(result.actionResult as Record<string, unknown>),
      status: "success",
      reason: "read_tool_cannot_request_confirmation",
    },
  };
}

function labelForToolStarted(toolName: string): string {
  if (toolName === "list_experiences" || toolName === "search_experiences" || toolName === "get_experience") {
    return "正在查看经历库…";
  }
  return `正在调用工具：${toolName}`;
}

function isAutoRevisionAuthorized(run: RunState, toolName: string): boolean {
  return run.autoRevisionContext?.autoRevisionAuthorized === true
    && run.autoRevisionContext.toolName === toolName
    && toolName === "generate_resume_from_jd";
}

function draftFromSaveExperienceArgs(args: Record<string, unknown>): ExperienceDraft | undefined {
  const source = isRecord(args.candidate)
    ? args.candidate
    : isRecord(args.experienceDraft)
      ? args.experienceDraft
      : undefined;
  if (!source) return undefined;

  const title = stringValue(source.title);
  const content = stringValue(source.content) ?? stringValue(source.description) ?? stringValue(source.rawText);
  if (!title || !content) return undefined;

  return {
    category: (stringValue(source.category) ?? "other") as ExperienceDraft["category"],
    title,
    organization: stringValue(source.organization),
    role: stringValue(source.role),
    startDate: stringValue(source.startDate),
    endDate: stringValue(source.endDate),
    content,
    tags: Array.isArray(source.tags)
      ? source.tags.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : Array.isArray(source.skills)
        ? source.skills.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    structured: (isRecord(source.structured) ? source.structured : { rawText: content }) as ExperienceDraft["structured"],
    confidence: numberValue(source.confidence) ?? 0.5,
    warnings: Array.isArray(source.warnings)
      ? source.warnings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : Array.isArray(source.missingFields)
        ? source.missingFields.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
  };
}

function buildExperienceTextFallback(draft: Record<string, unknown>): string | undefined {
  const parts = [
    stringValue(draft.title),
    stringValue(draft.organization),
    stringValue(draft.role),
    [stringValue(draft.startDate), stringValue(draft.endDate)].filter(Boolean).join(" - "),
    stringValue(draft.content) ?? stringValue(draft.description) ?? stringValue(draft.rawText),
  ].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
