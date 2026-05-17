import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../api/types.js";
import type { KernelRequestContext } from "../kernel/context.js";
import type { CreateGenerationResult } from "../kernel/types.js";
import type { GeneratedArtifact } from "../knowledge/types.js";
import type { ArtifactDecisionRecord } from "../application/decisions/index.js";
import { ProductIntentRouter } from "./ProductIntentRouter.js";
import type { ProductIntent } from "./ProductIntentRouter.js";
import { ProductToolRegistry } from "../product/tools/ProductToolRegistry.js";
import type { ProductToolResult } from "../product/tools/ProductToolRegistry.js";
import { CopilotResponseBuilder } from "./CopilotResponseBuilder.js";
import type {
  CopilotSession,
  CopilotTurn,
  CopilotMessage,
  CopilotWorkspace,
  CopilotChatResponse,
  CopilotActionRequest,
  CopilotChatRequest,
  ProductVariant,
} from "./types.js";

export type CopilotOrchestratorDeps = {
  kernel: ApiKernel;
};

export class CopilotOrchestrator {
  private readonly sessions = new Map<string, CopilotSession>();
  private readonly turns = new Map<string, CopilotTurn>();
  private readonly sessionMessages = new Map<string, CopilotMessage[]>();
  private readonly workspaces = new Map<string, CopilotWorkspace>();
  private readonly artifactSnapshots = new Map<string, GeneratedArtifact>();
  private readonly builder = new CopilotResponseBuilder();
  private readonly intentRouter = new ProductIntentRouter();
  private readonly productTools: ProductToolRegistry;
  private readonly kernel: ApiKernel;

  public constructor(deps: CopilotOrchestratorDeps) {
    this.kernel = deps.kernel;
    this.productTools = new ProductToolRegistry(deps.kernel.productServices);
  }

  // ── Session ──

  public getOrCreateSession(input: {
    sessionId?: string;
    userId: string;
    resumeText?: string;
    jdText?: string;
    targetRole?: string;
  }): CopilotSession {
    if (input.sessionId && this.sessions.has(input.sessionId)) {
      const s = this.sessions.get(input.sessionId)!;
      if (input.resumeText) s.resumeText = input.resumeText;
      if (input.jdText) s.jdText = input.jdText;
      if (input.targetRole) s.targetRole = input.targetRole;
      s.updatedAt = new Date().toISOString();
      return s;
    }
    const now = new Date().toISOString();
    const session: CopilotSession = {
      id: `cs-${randomUUID()}`,
      userId: input.userId,
      targetRole: input.targetRole ?? null,
      resumeText: input.resumeText ?? null,
      jdText: input.jdText ?? null,
      resumeIngested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  public getSession(id: string): CopilotSession | undefined {
    return this.sessions.get(id);
  }

  // ── Turn ──

  public createTurn(sessionId: string, userMessageId: string): CopilotTurn {
    const turn: CopilotTurn = {
      id: `ct-${randomUUID()}`,
      sessionId,
      userMessageId,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.turns.set(turn.id, turn);
    return turn;
  }

  public completeTurn(turnId: string, assistantMessageId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.status = "completed";
    turn.assistantMessageId = assistantMessageId;
    turn.completedAt = new Date().toISOString();
  }

  // ── Messages ──

  public saveMessage(msg: CopilotMessage): void {
    const msgs = this.sessionMessages.get(msg.sessionId) ?? [];
    msgs.push(msg);
    this.sessionMessages.set(msg.sessionId, msgs);
  }

  public createUserMessage(sessionId: string, content: string): CopilotMessage {
    const msg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId,
      role: "user",
      content,
      kind: "plain_text",
      createdAt: new Date().toISOString(),
    };
    this.saveMessage(msg);
    return msg;
  }

  // ── Workspace ──

  public saveWorkspace(ws: CopilotWorkspace): void {
    this.workspaces.set(ws.id, ws);
  }

  public getWorkspace(sessionId: string): CopilotWorkspace | undefined {
    return this.workspaces.get(`ws-${sessionId}`);
  }

  public updateVariantStatus(
    sessionId: string,
    variantId: string,
    status: ProductVariant["status"],
  ): void {
    const ws = this.getWorkspace(sessionId);
    if (!ws) return;
    for (const v of ws.variants) {
      if (v.id === variantId) {
        v.status = status;
      }
    }
    ws.updatedAt = new Date().toISOString();
  }

  public getVariant(sessionId: string, variantId: string): ProductVariant | undefined {
    const ws = this.getWorkspace(sessionId);
    return ws?.variants.find((v) => v.id === variantId);
  }

  // ── Chat orchestration ──

  public async handleChat(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
  ): Promise<CopilotChatResponse & { ingestionWarnings: string[] }> {
    const ingestionWarnings: string[] = [];
    const session = this.getOrCreateSession({
      sessionId: body.sessionId,
      userId: ctx.user.id,
      resumeText: body.resumeText,
      jdText: body.jdText,
      targetRole: body.targetRole,
    });

    const userMsg = this.createUserMessage(session.id, body.message);
    const turn = this.createTurn(session.id, userMsg.id);

    const hasResume = Boolean(session.resumeText || body.resumeText);
    const hasJD = Boolean(session.jdText || body.jdText);

    // Missing info → clarifying question
    if (!hasResume && !hasJD) {
      const response = this.builder.buildClarifyingQuestion(
        session.id, turn.id,
        "Could you paste your resume or a job description so I can help tailor your experience?",
      );
      this.saveMessage(response.assistantMessage);
      this.completeTurn(turn.id, response.assistantMessage.id);
      return { ...response, ingestionWarnings };
    }

    if (!hasJD) {
      const response = this.builder.buildClarifyingQuestion(
        session.id, turn.id,
        "I see you've shared your background. Could you also paste the job description you're targeting?",
      );
      this.saveMessage(response.assistantMessage);
      this.completeTurn(turn.id, response.assistantMessage.id);
      return { ...response, ingestionWarnings };
    }

    // Import resume only if not already ingested this session
    if (hasResume && !session.resumeIngested) {
      try {
        const ingestResult = await this.kernel.cvAgentKernel.documents.ingest(ctx, {
          message: "Import resume.",
          documents: [{
            userId: ctx.user.id,
            fileName: "copilot-resume.txt",
            mimeType: "text/plain",
            sourceRef: `copilot:${session.id}`,
            buffer: new TextEncoder().encode(session.resumeText!),
          }],
        });
        session.resumeIngested = true;
        session.resumeDocumentIds = ingestResult.extractedDocuments.map(d => d.documentId);
        session.resumeArtifactIds = ingestResult.evidences?.map(e => e.id) ?? [];
        session.updatedAt = new Date().toISOString();
      } catch (err) {
        ingestionWarnings.push(`Resume ingestion failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    const productIntent = this.intentRouter.route(body);
    if (this.shouldHandleProductIntent(productIntent.intent)) {
      const productResponse = await this.handleProductIntent(ctx, session, turn.id, body, productIntent.intent, ingestionWarnings);
      if (productResponse) {
        this.saveMessage(productResponse.assistantMessage);
        this.saveWorkspace(productResponse.workspace);
        this.completeTurn(turn.id, productResponse.assistantMessage.id);
        return { ...productResponse, ingestionWarnings };
      }
    }

    const generationResult = await this.generateVariantsForCopilot(ctx, session, body);

    // Store source artifacts in workspace variants' raw before building response
    const generatedArtifacts = generationResult.artifacts;
    const critiqueItems = generationResult.critiqueReport.items;
    const evidenceChains = generationResult.evidenceChains;

    const response = this.builder.buildChatResponse({
      sessionId: session.id,
      turnId: turn.id,
      userMessage: body.message,
      generatedArtifacts,
      critiqueItems,
      evidenceChains,
      targetRole: session.targetRole ?? body.targetRole ?? null,
      clientState: body.clientState ?? {},
    });

    this.storeArtifactSnapshots(session.id, generatedArtifacts);
    this.applyNoVariantsWarning(response, generatedArtifacts.length);

    // Add ingestion timeline items
    if (session.resumeIngested) {
      response.timeline.push({
        id: `tl-${turn.id}-resume`,
        type: "resume_ingested",
        title: "Resume processed",
        description: "Experiences, evidence, and skills extracted.",
        status: "completed",
        createdAt: new Date().toISOString(),
      });
    }
    for (const w of ingestionWarnings) {
      response.timeline.push({
        id: `tl-${turn.id}-warn-${response.timeline.length}`,
        type: "warning",
        title: "Warning",
        description: w,
        status: "completed",
        createdAt: new Date().toISOString(),
      });
    }

    this.saveMessage(response.assistantMessage);
    this.saveWorkspace(response.workspace);
    this.completeTurn(turn.id, response.assistantMessage.id);

    return { ...response, ingestionWarnings };
  }

  // ── Action orchestration ──

  public async handleAction(
    ctx: KernelRequestContext,
    body: CopilotActionRequest,
  ): Promise<CopilotChatResponse> {
    const session = this.getSession(body.sessionId);
    if (!session) {
      return this.errorResponse(body.sessionId, body.turnId ?? `ct-${randomUUID()}`, "Session not found.");
    }

    const now = new Date().toISOString();
    const turnId = body.turnId ?? `ct-${randomUUID()}`;
    const { action } = body;

    // Resolve artifactId from workspace variant
    const variant = action.variantId ? this.getVariant(session.id, action.variantId) : undefined;
    const artifactId = variant?.artifactId ?? action.variantId ?? null;

    switch (action.type) {
      case "accept":
      case "reject":
      case "prefer":
        return this.handleDecision(ctx, session, turnId, action.type, action.variantId ?? "", artifactId, now);

      case "revise_more_conservative":
      case "revise_more_quantified":
        return this.handleRevision(ctx, session, turnId, action, variant, now);

      case "show_evidence":
        return this.handleShowEvidence(session, turnId, action.variantId ?? "", variant, now);

      case "explain_choice":
        return this.handleExplainChoice(session, turnId, action.variantId ?? "", variant, now);

      case "confirm_metric":
        return this.handleConfirmMetric(ctx, session, turnId, action.variantId ?? "", artifactId, action.payload, now);

      default:
        return this.errorResponse(session.id, turnId, `Unsupported action: ${(action as { type: string }).type}`);
    }
  }

  // ── Stream orchestration ──

  public async handleStream(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
    sse: (event: string, data: unknown) => void,
  ): Promise<void> {
    const session = this.getOrCreateSession({
      sessionId: body.sessionId,
      userId: ctx.user.id,
      resumeText: body.resumeText,
      jdText: body.jdText,
      targetRole: body.targetRole,
    });

    const userMsg = this.createUserMessage(session.id, body.message);
    const turn = this.createTurn(session.id, userMsg.id);

    sse("copilot.turn.started", {
      type: "copilot.turn.started",
      sessionId: session.id,
      turnId: turn.id,
    });

    const hasJD = Boolean(session.jdText || body.jdText);
    if (!hasJD) {
      sse("copilot.failed", {
        type: "copilot.failed",
        sessionId: session.id,
        turnId: turn.id,
        message: "Please provide a job description or target role.",
      });
      return;
    }

    // Ingest resume if needed
    if (Boolean(session.resumeText) && !session.resumeIngested) {
      try {
        await this.kernel.cvAgentKernel.documents.ingest(ctx, {
          message: "Import resume.",
          documents: [{
            userId: ctx.user.id,
            fileName: "copilot-resume.txt",
            mimeType: "text/plain",
            sourceRef: `copilot:${session.id}`,
            buffer: new TextEncoder().encode(session.resumeText!),
          }],
        });
        session.resumeIngested = true;
      } catch {
        // Continue despite ingestion failure
      }
    }

    sse("copilot.workspace.updated", {
      type: "copilot.workspace.updated",
      sessionId: session.id,
      status: "generating",
      variantCount: 0,
    });

    try {
      const generationResult = await this.generateVariantsForCopilot(ctx, session, body);

      const generatedArtifacts = generationResult.artifacts;
      const response = this.builder.buildChatResponse({
        sessionId: session.id,
        turnId: turn.id,
        userMessage: body.message,
        generatedArtifacts,
        critiqueItems: generationResult.critiqueReport.items,
        evidenceChains: generationResult.evidenceChains,
        targetRole: session.targetRole ?? body.targetRole ?? null,
        clientState: body.clientState ?? {},
      });
      this.storeArtifactSnapshots(session.id, generatedArtifacts);
      this.applyNoVariantsWarning(response, generatedArtifacts.length);

      this.saveMessage(response.assistantMessage);
      this.saveWorkspace(response.workspace);
      this.completeTurn(turn.id, response.assistantMessage.id);

      // Emit product-level events
      sse("copilot.message.created", {
        type: "copilot.message.created",
        message: response.assistantMessage,
      });

      for (const item of response.timeline) {
        sse("copilot.timeline.updated", { type: "copilot.timeline.updated", item });
      }

      if (response.nextActions.length > 0) {
        sse("copilot.action.required", {
          type: "copilot.action.required",
          actions: response.nextActions,
        });
      }

      sse("copilot.workspace.updated", {
        type: "copilot.workspace.updated",
        sessionId: session.id,
        status: response.workspace.status,
        variantCount: response.workspace.variants.length,
      });

      sse("copilot.completed", {
        type: "copilot.completed",
        sessionId: session.id,
        turnId: turn.id,
        workspaceStatus: response.workspace.status,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Generation failed.";
      sse("copilot.failed", {
        type: "copilot.failed",
        sessionId: session.id,
        turnId: turn.id,
        message: msg,
      });
    }
  }

  // ── Private action handlers ──

  private async handleDecision(
    ctx: KernelRequestContext,
    session: CopilotSession,
    turnId: string,
    decisionType: string,
    variantId: string,
    artifactId: string | null,
    now: string,
  ): Promise<CopilotChatResponse> {
    const ws = this.getWorkspace(session.id) ?? {
      id: `ws-${session.id}`,
      sessionId: session.id,
      variants: [],
      status: "ready",
      updatedAt: now,
    };

    const newStatus: ProductVariant["status"] =
      decisionType === "accept" ? "accepted" :
      decisionType === "reject" ? "rejected" : "ready";

    this.updateVariantStatus(session.id, variantId, newStatus);

    if (decisionType === "prefer") {
      ws.activeVariantId = variantId;
    }

    // Record decision via kernel if artifactId is available
    let decision: ArtifactDecisionRecord | null = null;
    if (artifactId) {
      try {
        const kernelDecision = decisionType === "accept" ? "accept" :
          decisionType === "reject" ? "reject" : "prefer_variant";
        decision = await this.kernel.cvAgentKernel.generations.recordArtifactDecision(ctx, {
          artifactId,
          decision: kernelDecision,
          reason: `User ${decisionType}ed this variant.`,
          sessionId: session.id,
        });
      } catch {
        // Non-fatal
      }
    }

    const labels: Record<string, string> = {
      accept: "accepted", reject: "rejected", prefer: "preferred",
    };
    let content = `You've ${labels[decisionType] ?? decisionType} this version.`;
    let resumeIds: string[] = [];
    if (decisionType === "accept" && ws.productGenerationId && variantId) {
      try {
        const saved = await this.productTools.saveVariantToResume(ctx.user.id, {
          generationId: ws.productGenerationId,
          variantId,
          resumeId: ws.resumeId ?? undefined,
        });
        content = saved.assistantMessage;
        resumeIds = saved.raw?.resumeIds ?? [];
        if (saved.workspacePatch?.activeResume) ws.activeResume = saved.workspacePatch.activeResume;
        if (saved.workspacePatch?.activePanel) ws.activePanel = saved.workspacePatch.activePanel;
        if (saved.workspacePatch?.resumeId) ws.resumeId = saved.workspacePatch.resumeId;
      } catch {
        // Decision recording should remain successful even if product resume save fails.
      }
    }

    const msg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: session.id,
      turnId,
      role: "assistant",
      content,
      kind: "decision_summary",
      createdAt: now,
    };
    this.saveMessage(msg);
    this.saveWorkspace(ws);

    return {
      sessionId: session.id,
      turnId,
      assistantMessage: msg,
      timeline: [{
        id: `tl-${turnId}-1`,
        type: "decision_recorded",
        title: `Variant ${labels[decisionType] ?? decisionType}`,
        status: "completed",
        createdAt: now,
        relatedVariantId: variantId,
      }],
      workspace: ws,
      nextActions: [],
      raw: {
        artifactIds: artifactId ? [artifactId] : [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: decision ? [decision.id, ...resumeIds] : resumeIds,
      },
    };
  }

  private async handleRevision(
    ctx: KernelRequestContext,
    session: CopilotSession,
    turnId: string,
    action: CopilotActionRequest["action"],
    variant: ProductVariant | undefined,
    now: string,
  ): Promise<CopilotChatResponse> {
    if (!variant || !variant.artifactId) {
      return this.errorResponse(session.id, turnId, "Variant not found or has no underlying artifact.");
    }

    const artifactSnapshot = this.artifactSnapshots.get(this.artifactSnapshotKey(session.id, variant.artifactId));
    if (!artifactSnapshot) {
      return this.errorResponse(session.id, turnId, "Source artifact snapshot not available for revision.");
    }

    const instruction = action.type === "revise_more_conservative"
      ? "make_more_conservative" as const
      : "make_more_quantified" as const;
    const tone = action.type === "revise_more_conservative" ? "conservative" as const : "impactful" as const;

    const revisionResult = await this.kernel.cvAgentKernel.generations.reviseArtifact(ctx, {
      artifact: artifactSnapshot,
      instruction,
      tone,
    });

    const revisedArtifact = revisionResult.revisedArtifact;
    const revisedVariant = this.builder.buildVariant({ artifact: revisedArtifact, targetRole: session.targetRole });
    revisedVariant.role = "experimental";
    revisedVariant.badges.unshift({ label: "Revised", tone: "neutral" });
    this.storeArtifactSnapshots(session.id, [revisedArtifact]);

    const ws = this.getWorkspace(session.id);
    if (ws) {
      ws.variants.push(revisedVariant);
      ws.status = "awaiting_user_decision";
      ws.updatedAt = now;
      this.saveWorkspace(ws);
    }

    const msg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: session.id,
      turnId,
      role: "assistant",
      content: `Here's a ${action.type === "revise_more_conservative" ? "more conservative" : "more quantified"} version.`,
      kind: "variant_suggestion",
      createdAt: now,
    };
    this.saveMessage(msg);

    return {
      sessionId: session.id,
      turnId,
      assistantMessage: msg,
      timeline: [{
        id: `tl-${turnId}-1`,
        type: "revision_completed",
        title: "Revision completed",
        status: "completed",
        createdAt: now,
        relatedVariantId: revisedVariant.id,
      }],
      workspace: ws ?? {
        id: `ws-${session.id}`,
        sessionId: session.id,
        variants: [revisedVariant],
        status: "awaiting_user_decision",
        updatedAt: now,
      },
      nextActions: [],
      raw: {
        artifactIds: [revisedVariant.artifactId ?? revisedVariant.id],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
      },
    };
  }

  private handleShowEvidence(
    session: CopilotSession,
    turnId: string,
    variantId: string,
    variant: ProductVariant | undefined,
    now: string,
  ): CopilotChatResponse {
    const ws = this.getWorkspace(session.id);
    const workspace = ws ?? {
      id: `ws-${session.id}`,
      sessionId: session.id,
      variants: variant ? [variant] : [],
      status: "ready",
      updatedAt: now,
    };

    const evidenceItems = variant?.evidenceSummary?.items ?? [];
    return this.builder.buildShowEvidence({
      sessionId: session.id, turnId, variantId, evidenceItems, workspace,
    });
  }

  private handleExplainChoice(
    session: CopilotSession,
    turnId: string,
    variantId: string,
    variant: ProductVariant | undefined,
    now: string,
  ): CopilotChatResponse {
    const ws = this.getWorkspace(session.id);
    const workspace = ws ?? {
      id: `ws-${session.id}`,
      sessionId: session.id,
      variants: variant ? [variant] : [],
      status: "ready",
      updatedAt: now,
    };

    const reason = variant?.reason ?? "This variant was generated based on available evidence and job requirements.";
    return this.builder.buildExplainChoice({
      sessionId: session.id, turnId, variantId, reason, workspace,
    });
  }

  private async handleConfirmMetric(
    ctx: KernelRequestContext,
    session: CopilotSession,
    turnId: string,
    variantId: string,
    artifactId: string | null,
    payload: Record<string, unknown> | undefined,
    now: string,
  ): Promise<CopilotChatResponse> {
    let decision: ArtifactDecisionRecord | null = null;
    if (artifactId) {
      try {
        decision = await this.kernel.cvAgentKernel.generations.recordArtifactDecision(ctx, {
          artifactId,
          decision: "confirm_metric",
          reason: "User confirmed a metric.",
          sessionId: session.id,
          confirmation: {
            metric: typeof payload?.metric === "string" ? payload.metric : undefined,
            value: typeof payload?.value === "string" ? payload.value : undefined,
            explanation: typeof payload?.explanation === "string" ? payload.explanation : undefined,
          },
        });
      } catch { /* non-fatal */ }
    }

    const msg: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: session.id,
      turnId,
      role: "assistant",
      content: "Metric confirmed. This will help improve future revisions.",
      kind: "decision_summary",
      createdAt: now,
    };
    this.saveMessage(msg);

    const ws = this.getWorkspace(session.id);
    return {
      sessionId: session.id,
      turnId,
      assistantMessage: msg,
      timeline: [{
        id: `tl-${turnId}-1`,
        type: "decision_recorded",
        title: "Metric confirmed",
        status: "completed",
        createdAt: now,
        relatedVariantId: variantId,
      }],
      workspace: ws ?? {
        id: `ws-${session.id}`,
        sessionId: session.id,
        variants: [],
        status: "ready",
        updatedAt: now,
      },
      nextActions: [],
      raw: {
        artifactIds: artifactId ? [artifactId] : [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: decision ? [decision.id] : [],
      },
    };
  }

  private errorResponse(sessionId: string, turnId: string, message: string): CopilotChatResponse {
    const now = new Date().toISOString();
    return {
      sessionId,
      turnId,
      assistantMessage: {
        id: `msg-${turnId}-assistant`,
        sessionId,
        turnId,
        role: "assistant",
        content: message,
        kind: "plain_text",
        createdAt: now,
      },
      timeline: [{
        id: `tl-${turnId}-1`,
        type: "warning",
        title: "Error",
        description: message,
        status: "failed",
        createdAt: now,
      }],
      workspace: {
        id: `ws-${sessionId}`,
        sessionId,
        variants: [],
        status: "empty",
        updatedAt: now,
      },
      nextActions: [],
      raw: { artifactIds: [], evidenceChainIds: [], critiqueItemIds: [], decisionIds: [] },
    };
  }

  private async generateVariantsForCopilot(
    ctx: KernelRequestContext,
    session: CopilotSession,
    body: CopilotChatRequest,
  ): Promise<CreateGenerationResult> {
    const jdText = session.jdText ?? body.jdText;
    if (!jdText) {
      throw new Error("Job description is required to generate Copilot variants.");
    }
    return this.kernel.cvAgentKernel.generations.create(ctx, {
      jdText,
      targetRole: session.targetRole ?? body.targetRole ?? "Target Role",
    });
  }

  private shouldHandleProductIntent(intent: ProductIntent): boolean {
    return intent !== "unknown" && intent !== "save_variant_to_resume";
  }

  private async handleProductIntent(
    ctx: KernelRequestContext,
    session: CopilotSession,
    turnId: string,
    body: CopilotChatRequest,
    intent: ProductIntent,
    ingestionWarnings: string[],
  ): Promise<CopilotChatResponse | null> {
    switch (intent) {
      case "list_experiences":
        return this.buildToolResponse(session.id, turnId, await this.productTools.listExperiences(ctx.user.id));
      case "list_resumes":
        return this.buildToolResponse(session.id, turnId, await this.productTools.listResumes(ctx.user.id));
      case "list_jds":
        return this.buildToolResponse(session.id, turnId, await this.productTools.listJDs(ctx.user.id));
      case "add_experience":
        return this.buildToolResponse(session.id, turnId, await this.productTools.createExperience(ctx.user.id, parseProductExperienceFromMessage(body.message)));
      case "import_resume":
        return this.buildToolResponse(session.id, turnId, await this.productTools.importResumeText(ctx.user.id, body.resumeText ?? body.message));
      case "save_jd":
        return this.buildToolResponse(session.id, turnId, await this.productTools.saveJD(ctx.user.id, {
          rawText: body.jdText,
          targetRole: session.targetRole ?? body.targetRole ?? undefined,
        }));
      case "generate_resume_for_jd": {
        const generation = await this.kernel.productServices.generationProductService.generateResumeFromJD(ctx, {
          userId: ctx.user.id,
          sessionId: session.id,
          jdText: session.jdText ?? body.jdText,
          targetRole: session.targetRole ?? body.targetRole ?? "Target Role",
        });
        const response = this.builder.buildChatResponse({
          sessionId: session.id,
          turnId,
          userMessage: body.message,
          generatedArtifacts: generation.variants,
          critiqueItems: generation.generationResult.critiqueReport.items,
          evidenceChains: generation.generationResult.evidenceChains,
          targetRole: session.targetRole ?? body.targetRole ?? null,
          clientState: body.clientState ?? {},
        });
        response.workspace.activePanel = "variants";
        response.workspace.productGenerationId = generation.generation.id;
        response.workspace.jdId = generation.jd.id;
        response.raw.decisionIds = [generation.generation.id];
        this.storeArtifactSnapshots(session.id, generation.variants);
        this.applyNoVariantsWarning(response, generation.variants.length);
        this.addIngestionTimeline(response, turnId, session, ingestionWarnings);
        return response;
      }
      default:
        return null;
    }
  }

  private buildToolResponse(sessionId: string, turnId: string, result: ProductToolResult): CopilotChatResponse {
    const now = new Date().toISOString();
    const workspace: CopilotWorkspace = {
      id: `ws-${sessionId}`,
      sessionId,
      variants: result.workspacePatch?.variants ?? this.getWorkspace(sessionId)?.variants ?? [],
      status: "ready",
      updatedAt: now,
      activePanel: result.workspacePatch?.activePanel,
      experiences: result.workspacePatch?.experiences,
      jds: result.workspacePatch?.jds,
      resumes: result.workspacePatch?.resumes,
      activeResume: result.workspacePatch?.activeResume,
      importCandidates: result.workspacePatch?.importCandidates,
      productGenerationId: result.workspacePatch?.productGenerationId ?? this.getWorkspace(sessionId)?.productGenerationId,
      jdId: result.workspacePatch?.jdId ?? this.getWorkspace(sessionId)?.jdId,
      resumeId: result.workspacePatch?.resumeId ?? this.getWorkspace(sessionId)?.resumeId,
    };
    return {
      sessionId,
      turnId,
      assistantMessage: {
        id: `msg-${randomUUID()}`,
        sessionId,
        turnId,
        role: "assistant",
        content: result.assistantMessage,
        kind: result.status === "needs_input" ? "clarifying_question" : "decision_summary",
        createdAt: now,
      },
      timeline: result.timelineItems ?? [{
        id: `tl-${turnId}-product`,
        type: result.status === "failed" ? "warning" : "message_received",
        title: result.toolName,
        description: result.assistantMessage,
        status: result.status === "failed" ? "failed" : "completed",
        createdAt: now,
      }],
      workspace,
      nextActions: result.nextActions ?? [],
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [
          ...(result.raw?.experienceIds ?? []),
          ...(result.raw?.jdIds ?? []),
          ...(result.raw?.resumeIds ?? []),
          ...(result.raw?.generationIds ?? []),
        ],
      },
    };
  }

  private addIngestionTimeline(
    response: CopilotChatResponse,
    turnId: string,
    session: CopilotSession,
    ingestionWarnings: string[],
  ): void {
    if (session.resumeIngested) {
      response.timeline.push({
        id: `tl-${turnId}-resume`,
        type: "resume_ingested",
        title: "Resume processed",
        description: "Experiences, evidence, and skills extracted.",
        status: "completed",
        createdAt: new Date().toISOString(),
      });
    }
    for (const w of ingestionWarnings) {
      response.timeline.push({
        id: `tl-${turnId}-warn-${response.timeline.length}`,
        type: "warning",
        title: "Warning",
        description: w,
        status: "completed",
        createdAt: new Date().toISOString(),
      });
    }
  }

  private applyNoVariantsWarning(response: CopilotChatResponse, artifactCount: number): void {
    if (artifactCount > 0) return;
    const now = new Date().toISOString();
    const description = "Generation returned no variants. Check artifact generator mode/provider response.";
    response.assistantMessage.content = description;
    response.timeline.push({
      id: `tl-${response.turnId}-no-variants`,
      type: "warning",
      title: "No variants generated",
      description,
      status: "completed",
      createdAt: now,
    });
  }

  private storeArtifactSnapshots(sessionId: string, artifacts: GeneratedArtifact[]): void {
    for (const artifact of artifacts) {
      this.artifactSnapshots.set(this.artifactSnapshotKey(sessionId, artifact.id), artifact);
    }
  }

  private artifactSnapshotKey(sessionId: string, artifactId: string): string {
    return `${sessionId}:${artifactId}`;
  }
}

function parseExperienceFromMessage(message: string): {
  title?: string;
  category?: string;
  content?: string;
} {
  const content = message
    .replace(/^(请)?(帮我)?(保存这段经历|加入经历库|添加经历到经历库|添加经历)[:：\s]*/u, "")
    .trim();
  const safeContent = content.length > 0 ? content : message.trim();
  return {
    title: safeContent.split(/\r?\n/)[0]?.slice(0, 80),
    category: safeContent.toLowerCase().includes("project") || safeContent.includes("项目") ? "project" : "work",
    content: safeContent,
  };
}

function parseProductExperienceFromMessage(message: string): {
  title?: string;
  category?: string;
  content?: string;
} {
  const content = message
    .replace(/^(请)?(帮我)?(保存这段经历|加入经历库|添加经历到经历库|添加经历)[:：\s]*/u, "")
    .trim();
  const safeContent = content.length > 0 ? content : message.trim();
  return {
    title: safeContent.split(/\r?\n/)[0]?.slice(0, 80),
    category: safeContent.toLowerCase().includes("project") || safeContent.includes("项目") ? "project" : "work",
    content: safeContent,
  };
}
