import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthResolver } from "../auth/index.js";
import { createKernelRequestContext } from "../context.js";
import { ApiError } from "../errors.js";
import { success } from "../response.js";
import type { ApiKernel } from "../types.js";
import { CopilotResponseBuilder } from "../../copilot/CopilotResponseBuilder.js";
import type {
  CopilotActionRequest,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotMessage,
  CopilotSession,
  CopilotTurn,
  CopilotWorkspace,
  ProductAction,
} from "../../copilot/types.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { EvidenceChain } from "../../knowledge/types.js";
import type { ArtifactCritiqueItem } from "../../application/critique/types.js";
import type { ArtifactDecisionRecord } from "../../application/decisions/index.js";
import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventSink,
} from "../../kernel/events/index.js";

// ── In-memory session store (TODO: persist to Postgres) ──

const sessions = new Map<string, CopilotSession>();
const turns = new Map<string, CopilotTurn>();
const messages = new Map<string, CopilotMessage[]>();
const workspaces = new Map<string, CopilotWorkspace>();

function getOrCreateSession(input: {
  sessionId?: string;
  userId: string;
  resumeText?: string;
  jdText?: string;
  targetRole?: string;
}): CopilotSession {
  if (input.sessionId && sessions.has(input.sessionId)) {
    const existing = sessions.get(input.sessionId)!;
    // Update mutable fields
    if (input.resumeText) existing.resumeText = input.resumeText;
    if (input.jdText) existing.jdText = input.jdText;
    if (input.targetRole) existing.targetRole = input.targetRole;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const now = new Date().toISOString();
  const session: CopilotSession = {
    id: `cs-${randomUUID()}`,
    userId: input.userId,
    targetRole: input.targetRole ?? null,
    resumeText: input.resumeText ?? null,
    jdText: input.jdText ?? null,
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

function createTurn(sessionId: string, userMessageId: string, intent?: string): CopilotTurn {
  const turn: CopilotTurn = {
    id: `ct-${randomUUID()}`,
    sessionId,
    userMessageId,
    status: "running",
    intent: intent ?? null,
    createdAt: new Date().toISOString(),
  };
  turns.set(turn.id, turn);
  return turn;
}

function completeTurn(turnId: string, assistantMessageId: string): void {
  const turn = turns.get(turnId);
  if (!turn) return;
  turn.status = "completed";
  turn.assistantMessageId = assistantMessageId;
  turn.completedAt = new Date().toISOString();
}

function failTurn(turnId: string, error: string): void {
  const turn = turns.get(turnId);
  if (!turn) return;
  turn.status = "failed";
  turn.error = error;
  turn.completedAt = new Date().toISOString();
}

function saveMessage(msg: CopilotMessage): void {
  const sessionMessages = messages.get(msg.sessionId) ?? [];
  sessionMessages.push(msg);
  messages.set(msg.sessionId, sessionMessages);
}

function saveWorkspace(ws: CopilotWorkspace): void {
  workspaces.set(ws.id, ws);
}

function getWorkspace(sessionId: string): CopilotWorkspace | undefined {
  return workspaces.get(`ws-${sessionId}`);
}

function updateWorkspaceDecisionState(
  sessionId: string,
  variantId: string,
  state: "accepted" | "rejected" | "preferred",
): void {
  const ws = getWorkspace(sessionId);
  if (!ws) return;
  for (const v of ws.variants) {
    if (v.id === variantId) {
      v.decisionState = state;
    }
    if (state === "preferred" && v.id === variantId) {
      ws.activeVariantId = variantId;
    }
  }
  ws.updatedAt = new Date().toISOString();
}

// ── Builder ──

const builder = new CopilotResponseBuilder();

// ── Route registration ──

export async function registerCopilotRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  authResolver: AuthResolver<FastifyRequest>,
): Promise<void> {
  // POST /copilot/chat
  app.post("/copilot/chat", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const body = parseCopilotChatBody(request.body);

    const session = getOrCreateSession({
      sessionId: body.sessionId,
      userId: ctx.user.id,
      resumeText: body.resumeText,
      jdText: body.jdText,
      targetRole: body.targetRole,
    });

    // Save user message
    const now = new Date().toISOString();
    const userMsg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: session.id,
      role: "user",
      content: body.message,
      kind: "plain_text",
      createdAt: now,
    };
    saveMessage(userMsg);

    // Create turn
    const turn = createTurn(session.id, userMsg.id);

    // Simple intent detection: if user provided resume + JD context, go to generation
    const hasResume = Boolean(session.resumeText || body.resumeText);
    const hasJD = Boolean(session.jdText || body.jdText);
    const hasTargetRole = Boolean(session.targetRole || body.targetRole);

    if (!hasResume && !hasJD) {
      // Not enough context — ask clarifying question
      const response = builder.buildClarifyingQuestion(
        session.id,
        turn.id,
        "Could you paste your resume or a job description so I can help tailor your experience? I can also work with just a job description if you have one.",
      );
      saveMessage(response.assistantMessage);
      completeTurn(turn.id, response.assistantMessage.id);
      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
      });
    }

    if (!hasJD) {
      const response = builder.buildClarifyingQuestion(
        session.id,
        turn.id,
        "I see you've shared your background. Could you also paste the job description you're targeting? This helps me tailor the content to what the role needs.",
      );
      saveMessage(response.assistantMessage);
      completeTurn(turn.id, response.assistantMessage.id);
      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
      });
    }

    // Import resume if provided
    let resumeIngested = false;
    if (hasResume) {
      try {
        await kernel.cvAgentKernel.documents.ingest(ctx, {
          message: "Import this resume document.",
          documents: [
            {
              userId: ctx.user.id,
              fileName: "copilot-resume.txt",
              mimeType: "text/plain",
              sourceRef: `copilot:${session.id}`,
              buffer: new TextEncoder().encode(session.resumeText!),
            },
          ],
        });
        resumeIngested = true;
      } catch {
        // Resume ingestion failed — continue without it
      }
    }

    // Run generation through FrontDeskOrchestrator
    try {
      const frontDeskResponse = await kernel.frontDeskOrchestrator.handle({
        userId: ctx.user.id,
        message: body.message,
        jdText: session.jdText ?? body.jdText,
        targetRole: session.targetRole ?? body.targetRole ?? "Target Role",
      });

      const response = builder.buildChatResponse({
        sessionId: session.id,
        turnId: turn.id,
        userMessage: body.message,
        generatedArtifacts: frontDeskResponse.artifacts ?? [],
        critiqueItems: frontDeskResponse.critiqueReport?.items ?? [],
        evidenceChains: frontDeskResponse.evidenceChains ?? [],
        targetRole: session.targetRole ?? body.targetRole ?? null,
        clientState: body.clientState ?? {},
      });

      saveMessage(response.assistantMessage);
      saveWorkspace(response.workspace);
      completeTurn(turn.id, response.assistantMessage.id);

      return success(response, {
        requestId: ctx.request.requestId,
        traceId: ctx.request.traceId,
        mode: kernel.mode,
      });
    } catch (error) {
      failTurn(turn.id, error instanceof Error ? error.message : "Generation failed");
      throw error; // Let the error handler format the response
    }
  });

  // POST /copilot/actions
  app.post("/copilot/actions", async (request) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const body = parseCopilotActionBody(request.body);

    const session = sessions.get(body.sessionId);
    if (!session) {
      throw new ApiError("SESSION_NOT_FOUND", "Session not found.", 404);
    }

    const now = new Date().toISOString();
    const turnId = body.turnId ?? `ct-${randomUUID()}`;
    const { action } = body;

    switch (action.type) {
      case "accept": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for accept.", 400);
        }
        // Record decision via kernel
        let decision: ArtifactDecisionRecord | null = null;
        try {
          decision = await kernel.cvAgentKernel.generations.recordArtifactDecision(ctx, {
            artifactId: action.variantId,
            decision: "accept",
            reason: "User accepted this variant.",
            sessionId: session.id,
          });
        } catch {
          // Non-fatal: decision recording failed, but we can still update workspace
        }
        updateWorkspaceDecisionState(session.id, action.variantId, "accepted");

        const content = "You've accepted this variant. It will be used in your final resume content.";
        const assistantMsg: CopilotMessage = {
          id: `msg-${randomUUID()}`,
          sessionId: session.id,
          turnId,
          role: "assistant",
          content,
          kind: "decision_summary",
          createdAt: now,
        };
        saveMessage(assistantMsg);

        const ws = getWorkspace(session.id) ?? {
          id: `ws-${session.id}`,
          sessionId: session.id,
          variants: [],
          status: "accepted" as const,
          updatedAt: now,
        };
        ws.status = "accepted";
        ws.updatedAt = now;
        saveWorkspace(ws);

        const response: CopilotChatResponse = {
          sessionId: session.id,
          turnId,
          assistantMessage: assistantMsg,
          timeline: [
            {
              id: `tl-${turnId}-1`,
              type: "user_decision",
              title: "Variant accepted",
              status: "completed",
              createdAt: now,
              relatedVariantId: action.variantId,
            },
          ],
          workspace: ws,
          nextActions: [],
          raw: {
            artifactIds: [action.variantId],
            evidenceChainIds: [],
            critiqueItemIds: [],
            decisionIds: decision ? [decision.id] : [],
          },
        };

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      case "reject": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for reject.", 400);
        }
        updateWorkspaceDecisionState(session.id, action.variantId, "rejected");

        const content = "You've rejected this variant. You can review other options or request a revision.";
        const assistantMsg: CopilotMessage = {
          id: `msg-${randomUUID()}`,
          sessionId: session.id,
          turnId,
          role: "assistant",
          content,
          kind: "decision_summary",
          createdAt: now,
        };
        saveMessage(assistantMsg);

        const ws = getWorkspace(session.id) ?? {
          id: `ws-${session.id}`,
          sessionId: session.id,
          variants: [],
          status: "awaiting_user_decision" as const,
          updatedAt: now,
        };
        saveWorkspace(ws);

        const nextActions: ProductAction[] = ws.variants
          .filter((v) => v.id !== action.variantId && v.decisionState === "undecided")
          .slice(0, 3)
          .map((v) => ({
            id: `prefer-${v.id}`,
            type: "prefer" as const,
            label: `Prefer "${v.title}"`,
            variantId: v.id,
          }));

        const response: CopilotChatResponse = {
          sessionId: session.id,
          turnId,
          assistantMessage: assistantMsg,
          timeline: [
            {
              id: `tl-${turnId}-1`,
              type: "user_decision",
              title: "Variant rejected",
              status: "completed",
              createdAt: now,
              relatedVariantId: action.variantId,
            },
          ],
          workspace: ws,
          nextActions,
          raw: {
            artifactIds: [action.variantId],
            evidenceChainIds: [],
            critiqueItemIds: [],
            decisionIds: [],
          },
        };

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      case "prefer": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for prefer.", 400);
        }
        updateWorkspaceDecisionState(session.id, action.variantId, "preferred");

        const content = `You've marked this variant as preferred. It's now the active version for your resume.`;
        const assistantMsg: CopilotMessage = {
          id: `msg-${randomUUID()}`,
          sessionId: session.id,
          turnId,
          role: "assistant",
          content,
          kind: "decision_summary",
          createdAt: now,
        };
        saveMessage(assistantMsg);

        const ws = getWorkspace(session.id) ?? {
          id: `ws-${session.id}`,
          sessionId: session.id,
          variants: [],
          status: "ready" as const,
          updatedAt: now,
        };
        saveWorkspace(ws);

        const response: CopilotChatResponse = {
          sessionId: session.id,
          turnId,
          assistantMessage: assistantMsg,
          timeline: [
            {
              id: `tl-${turnId}-1`,
              type: "user_decision",
              title: "Variant preferred",
              status: "completed",
              createdAt: now,
              relatedVariantId: action.variantId,
            },
          ],
          workspace: ws,
          nextActions: [],
          raw: {
            artifactIds: [action.variantId],
            evidenceChainIds: [],
            critiqueItemIds: [],
            decisionIds: [],
          },
        };

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      case "revise_more_conservative":
      case "revise_more_quantified": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for revision.", 400);
        }
        const ws = getWorkspace(session.id);
        const variant = ws?.variants.find((v) => v.id === action.variantId);
        if (!variant || !variant.artifactId) {
          throw new ApiError("INVALID_ACTION", "Variant not found or has no underlying artifact.", 400);
        }

        // Find the original artifact from last result
        const artifact = findArtifactFromLastResult(variant.artifactId);
        if (!artifact) {
          throw new ApiError("INVALID_ACTION", "Underlying artifact not found for revision.", 400);
        }

        const instruction = action.type === "revise_more_conservative"
          ? "make_more_conservative" as const
          : "make_more_quantified" as const;
        const tone = action.type === "revise_more_conservative" ? "conservative" as const : "impactful" as const;

        try {
          const revisionResult = await kernel.cvAgentKernel.generations.reviseArtifact(ctx, {
            artifact,
            instruction,
            tone,
          });

          const revisedVariant = builder.buildVariant({
            artifact: revisionResult.revisedArtifact,
            targetRole: session.targetRole,
          });
          revisedVariant.badges.unshift({ label: "Revised", tone: "neutral" });

          // Add to workspace
          if (ws) {
            ws.variants.push(revisedVariant);
            ws.status = "awaiting_user_decision";
            ws.updatedAt = now;
            saveWorkspace(ws);
          }

          const assistantMsg: CopilotMessage = {
            id: `msg-${randomUUID()}`,
            sessionId: session.id,
            turnId,
            role: "assistant",
            content: `Here's a ${action.type === "revise_more_conservative" ? "more conservative" : "more quantified"} version: "${revisedVariant.title}"`,
            kind: "variant_suggestion",
            createdAt: now,
          };
          saveMessage(assistantMsg);

          const response: CopilotChatResponse = {
            sessionId: session.id,
            turnId,
            assistantMessage: assistantMsg,
            timeline: [
              {
                id: `tl-${turnId}-1`,
                type: "revision_completed",
                title: `Revision completed (${action.type === "revise_more_conservative" ? "conservative" : "quantified"})`,
                status: "completed",
                createdAt: now,
                relatedVariantId: revisedVariant.id,
              },
            ],
            workspace: ws ?? {
              id: `ws-${session.id}`,
              sessionId: session.id,
              variants: [revisedVariant],
              status: "awaiting_user_decision",
              updatedAt: now,
            },
            nextActions: [
              {
                id: `accept-${revisedVariant.id}`,
                type: "accept",
                label: "Accept",
                variantId: revisedVariant.id,
              },
              {
                id: `reject-${revisedVariant.id}`,
                type: "reject",
                label: "Reject",
                variantId: revisedVariant.id,
              },
            ],
            raw: {
              artifactIds: [revisedVariant.artifactId ?? revisedVariant.id],
              evidenceChainIds: [],
              critiqueItemIds: [],
              decisionIds: [],
            },
          };

          return success(response, {
            requestId: ctx.request.requestId,
            traceId: ctx.request.traceId,
            mode: kernel.mode,
          });
        } catch (error) {
          throw new ApiError(
            "REVISION_FAILED",
            error instanceof Error ? error.message : "Revision failed.",
            500,
          );
        }
      }

      case "show_evidence": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for show_evidence.", 400);
        }
        const ws = getWorkspace(session.id);
        const variant = ws?.variants.find((v) => v.id === action.variantId);
        const evidenceItems = variant?.evidenceSummary?.items ?? [];

        const response = builder.buildShowEvidence({
          sessionId: session.id,
          turnId,
          variantId: action.variantId,
          evidenceItems,
        });
        saveMessage(response.assistantMessage);

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      case "explain_choice": {
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for explain_choice.", 400);
        }
        const ws = getWorkspace(session.id);
        const variant = ws?.variants.find((v) => v.id === action.variantId);

        const reason = buildExplanationReason(variant);

        const response = builder.buildExplainChoice({
          sessionId: session.id,
          turnId,
          variantTitle: variant?.title ?? "this variant",
          variantId: action.variantId,
          reason,
        });
        saveMessage(response.assistantMessage);

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      case "confirm_metric": {
        // Record as a decision with confirmation payload
        if (!action.variantId) {
          throw new ApiError("INVALID_ACTION", "variantId is required for confirm_metric.", 400);
        }
        const payload = action.payload ?? {};

        let decision: ArtifactDecisionRecord | null = null;
        try {
          decision = await kernel.cvAgentKernel.generations.recordArtifactDecision(ctx, {
            artifactId: action.variantId,
            decision: "confirm_metric",
            reason: "User confirmed a metric.",
            sessionId: session.id,
            confirmation: {
              metric: typeof payload.metric === "string" ? payload.metric : undefined,
              value: typeof payload.value === "string" ? payload.value : undefined,
              explanation: typeof payload.explanation === "string" ? payload.explanation : undefined,
            },
          });
        } catch {
          // Non-fatal
        }

        const content = "Metric confirmed. This will be used to improve future revisions.";
        const assistantMsg: CopilotMessage = {
          id: `msg-${randomUUID()}`,
          sessionId: session.id,
          turnId,
          role: "assistant",
          content,
          kind: "decision_summary",
          createdAt: now,
        };
        saveMessage(assistantMsg);

        const response: CopilotChatResponse = {
          sessionId: session.id,
          turnId,
          assistantMessage: assistantMsg,
          timeline: [
            {
              id: `tl-${turnId}-1`,
              type: "user_decision",
              title: "Metric confirmed",
              status: "completed",
              createdAt: now,
              relatedVariantId: action.variantId,
            },
          ],
          workspace: getWorkspace(session.id) ?? {
            id: `ws-${session.id}`,
            sessionId: session.id,
            variants: [],
            status: "ready",
            updatedAt: now,
          },
          nextActions: [],
          raw: {
            artifactIds: [action.variantId],
            evidenceChainIds: [],
            critiqueItemIds: [],
            decisionIds: decision ? [decision.id] : [],
          },
        };

        return success(response, {
          requestId: ctx.request.requestId,
          traceId: ctx.request.traceId,
          mode: kernel.mode,
        });
      }

      default:
        throw new ApiError(
          "INVALID_ACTION",
          `Unsupported action type: ${(action as { type: string }).type}`,
          400,
        );
    }
  });

  // POST /copilot/chat/stream
  app.post("/copilot/chat/stream", async (request, reply) => {
    const resolvedAuth = await authResolver.resolve(request);
    const ctx = createKernelRequestContext(request, resolvedAuth);
    const body = parseCopilotChatBody(request.body);

    const session = getOrCreateSession({
      sessionId: body.sessionId,
      userId: ctx.user.id,
      resumeText: body.resumeText,
      jdText: body.jdText,
      targetRole: body.targetRole,
    });

    const now = new Date().toISOString();
    const userMsg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: session.id,
      role: "user",
      content: body.message,
      kind: "plain_text",
      createdAt: now,
    };
    saveMessage(userMsg);

    const turn = createTurn(session.id, userMsg.id);

    // SSE setup
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": readHeader(request.headers["origin"]) ?? "*",
    });

    const sse = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const hasResume = Boolean(session.resumeText || body.resumeText);
    const hasJD = Boolean(session.jdText || body.jdText);

    if (!hasJD) {
      sse("timeline", {
        type: "timeline",
        item: {
          id: `tl-${turn.id}-1`,
          type: "error",
          title: "More information needed",
          description: "Please provide a job description or target role.",
          status: "failed",
          createdAt: now,
        },
      } as import("../../copilot/types.js").CopilotStreamEvent);
      sse("done", { type: "done", sessionId: session.id, turnId: turn.id });
      reply.raw.end();
      return;
    }

    // Emit timeline events as we progress
    sse("timeline", {
      type: "timeline",
      item: {
        id: `tl-${turn.id}-1`,
        type: "user_submitted",
        title: "Message received",
        status: "completed",
        createdAt: now,
      },
    });

    // Import resume if provided (non-streaming part)
    if (hasResume) {
      sse("timeline", {
        type: "timeline",
        item: {
          id: `tl-${turn.id}-2`,
          type: "resume_analyzed",
          title: "Analyzing resume",
          status: "running",
          createdAt: now,
        },
      });
      try {
        await kernel.cvAgentKernel.documents.ingest(ctx, {
          message: "Import resume.",
          documents: [
            {
              userId: ctx.user.id,
              fileName: "copilot-resume.txt",
              mimeType: "text/plain",
              sourceRef: `copilot:${session.id}`,
              buffer: new TextEncoder().encode(session.resumeText!),
            },
          ],
        });
        sse("timeline", {
          type: "timeline",
          item: {
            id: `tl-${turn.id}-2`,
            type: "resume_analyzed",
            title: "Resume analyzed",
            description: "Experiences, evidence, and skills extracted.",
            status: "completed",
            createdAt: new Date().toISOString(),
          },
        });
      } catch {
        sse("timeline", {
          type: "timeline",
          item: {
            id: `tl-${turn.id}-2`,
            type: "error",
            title: "Resume analysis failed",
            status: "failed",
            createdAt: new Date().toISOString(),
          },
        });
      }
    }

    // Run generation
    sse("workspace_patch", {
      type: "workspace_patch",
      patch: { status: "generating" },
    });

    try {
      const frontDeskResponse = await kernel.frontDeskOrchestrator.handle({
        userId: ctx.user.id,
        message: body.message,
        jdText: session.jdText ?? body.jdText,
        targetRole: session.targetRole ?? body.targetRole ?? "Target Role",
      });

      const response = builder.buildChatResponse({
        sessionId: session.id,
        turnId: turn.id,
        userMessage: body.message,
        generatedArtifacts: frontDeskResponse.artifacts ?? [],
        critiqueItems: frontDeskResponse.critiqueReport?.items ?? [],
        evidenceChains: frontDeskResponse.evidenceChains ?? [],
        targetRole: session.targetRole ?? body.targetRole ?? null,
        clientState: body.clientState ?? {},
      });

      saveMessage(response.assistantMessage);
      saveWorkspace(response.workspace);
      completeTurn(turn.id, response.assistantMessage.id);

      // Emit product-level events
      for (const item of response.timeline) {
        sse("timeline", { type: "timeline", item });
      }

      for (const variant of response.workspace.variants) {
        sse("variant_created", { type: "variant_created", variant });
      }

      if (response.nextActions.length > 0) {
        sse("next_actions", { type: "next_actions", actions: response.nextActions });
      }

      sse("workspace_patch", {
        type: "workspace_patch",
        patch: { status: response.workspace.status },
      });

      sse("done", { type: "done", sessionId: session.id, turnId: turn.id });
    } catch (error) {
      sse("error", {
        type: "error",
        message: error instanceof Error ? error.message : "Generation failed.",
      });
      failTurn(turn.id, error instanceof Error ? error.message : "Generation failed");
    } finally {
      reply.raw.end();
    }
  });
}

// ── Helpers ──

let lastGenArtifacts: GeneratedArtifact[] = [];
let lastCritiqueItems: ArtifactCritiqueItem[] = [];
let lastEvidenceChains: EvidenceChain[] = [];

// The copilot routes need access to the last generation result for revision/show_evidence.
// We capture it via a simple mutable reference from the generation pipeline.
export function captureLastGeneration(result: {
  artifacts: GeneratedArtifact[];
  critiqueItems?: ArtifactCritiqueItem[];
  evidenceChains?: EvidenceChain[];
}): void {
  lastGenArtifacts = result.artifacts;
  lastCritiqueItems = result.critiqueItems ?? [];
  lastEvidenceChains = result.evidenceChains ?? [];
}

function findArtifactFromLastResult(artifactId: string): GeneratedArtifact | undefined {
  return lastGenArtifacts.find((a) => a.id === artifactId);
}

function buildExplanationReason(variant: import("../../copilot/types.js").ProductVariant | undefined): string {
  if (!variant) return "This variant was generated based on available evidence and job requirements.";

  const parts: string[] = [];
  if (variant.score?.overall !== undefined) {
    parts.push(`overall score of ${(variant.score.overall * 100).toFixed(0)}%`);
  }
  if (variant.critiqueSummary?.strengths.length) {
    parts.push(`strengths include ${variant.critiqueSummary.strengths.slice(0, 2).join(", ")}`);
  }
  if (variant.evidenceSummary?.coverageLabel) {
    parts.push(variant.evidenceSummary.coverageLabel.toLowerCase());
  }
  return parts.length > 0
    ? `This variant has ${parts.join(", ")}.`
    : "This variant was generated based on available evidence and job requirements.";
}

function parseCopilotChatBody(body: unknown): CopilotChatRequest {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new ApiError("INVALID_BODY", "message is required.", 400);
  }
  return {
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    message: body.message,
    resumeText: typeof body.resumeText === "string" ? body.resumeText : undefined,
    jdText: typeof body.jdText === "string" ? body.jdText : undefined,
    targetRole: typeof body.targetRole === "string" ? body.targetRole : undefined,
    clientState: isRecord(body.clientState) ? body.clientState as CopilotChatRequest["clientState"] : undefined,
  };
}

function parseCopilotActionBody(body: unknown): CopilotActionRequest {
  if (!isRecord(body)) {
    throw new ApiError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    throw new ApiError("INVALID_BODY", "sessionId is required.", 400);
  }
  if (!isRecord(body.action) || typeof body.action.type !== "string") {
    throw new ApiError("INVALID_BODY", "action with type is required.", 400);
  }
  return {
    sessionId: body.sessionId,
    turnId: typeof body.turnId === "string" ? body.turnId : undefined,
    action: {
      type: body.action.type as CopilotActionRequest["action"]["type"],
      variantId: typeof body.action.variantId === "string" ? body.action.variantId : undefined,
      payload: isRecord(body.action.payload) ? body.action.payload as Record<string, unknown> : undefined,
    },
    clientState: isRecord(body.clientState) ? body.clientState as Record<string, unknown> : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
