import { describe, expect, it } from "vitest";
import { projectAgentRoomEvents } from "../src/agent-core/events/AgentRoomEventProjector.js";
import type { ToolResult } from "../src/agent-core/tools/ToolResult.js";
import {
  JDResumeAnalysisService,
  LayoutPreviewReportProjector,
  ResumeChangeSetService,
  ResumeDraftProjector,
  ResumeEditorialCriticService,
  ResumeOptimizationWorkflowService,
  ResumeWorkflowRecoveryService,
  ResumePatchProjectionService,
  ResumePreviewSnapshotService,
} from "../src/product/resumeOptimization/index.js";
import type { ProductExperienceSummary, ProductGeneratedVariant, ProductGeneration, ProductJDRecord } from "../src/product/types.js";

describe("ResumeOptimizationWorkflowService", () => {
  it("creates ordered stage state and completes draft-generation stages", () => {
    const service = new ResumeOptimizationWorkflowService();
    const run = service.startRun({
      userId: "user-1",
      sessionId: "session-1",
      jdText: "Frontend role requiring React and TypeScript.",
      targetRole: "Frontend Engineer",
    });

    const completed = service.completeDraftGeneration({
      run,
      jd: {
        id: "pjd-1",
        userId: "user-1",
        title: "Frontend Engineer",
        company: "Acme",
        targetRole: "Frontend Engineer",
        rawText: "Frontend role requiring React and TypeScript.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      generation: {
        id: "pgen-1",
        userId: "user-1",
        sessionId: "session-1",
        jdId: "pjd-1",
        targetRole: "Frontend Engineer",
        inputSnapshot: {},
        outputSnapshot: {},
        selectedVariantIds: [],
        createdAt: new Date().toISOString(),
      },
      variants: [{
        id: "pvar-1",
        userId: "user-1",
        content: "Generated resume",
        createdAt: new Date().toISOString(),
      }],
      sourceExperienceIds: ["pexp-1"],
      targetRole: "Frontend Engineer",
      editorialCriticReview: {
        schemaVersion: 1,
        reviewId: "recr-1",
        generationId: "pgen-1",
        createdAt: new Date().toISOString(),
        status: "patch_suggested",
        summary: {
          totalItems: 1,
          autoFixableCount: 1,
          needsInputCount: 0,
          highestSeverity: "medium",
          label: "1 critic patch suggestion ready",
        },
        items: [],
        patchSuggestions: [{
          suggestionId: "rcps-1",
          reviewItemId: "rcri-1",
          generationId: "pgen-1",
          severity: "medium",
          autoApply: true,
          patch: {
            type: "replace_bullet",
            target: { itemId: "item-1", bulletId: "bullet-1" },
            before: "Built a React dashboard.",
            after: "Built a React dashboard with measurable performance impact.",
          },
          rationale: "Improve weak STAR closure.",
        }],
      },
    });

    expect(completed.runId).toBe(run.runId);
    expect(completed.generationId).toBe("pgen-1");
    expect(completed.jdId).toBe("pjd-1");
    expect(completed.currentStage).toBe("change_set_ready");
    expect(completed.stages.map((stage) => stage.stage)).toEqual([
      "intake",
      "jd_analysis",
      "evidence_pack",
      "rewrite_plan",
      "draft_generation",
      "layout_check",
      "critic_review",
      "change_set_ready",
      "accepted",
      "exported",
      "failed",
      "needs_input",
    ]);
    expect(stageStatus(completed, "intake")).toBe("completed");
    expect(stageStatus(completed, "draft_generation")).toBe("completed");
    expect(stageStatus(completed, "layout_check")).toBe("pending");
    expect(stageStatus(completed, "critic_review")).toBe("completed");
    expect(stageStatus(completed, "change_set_ready")).toBe("completed");
    expect(completed.events.map((event) => event.stage)).toEqual([
      "intake",
      "jd_analysis",
      "jd_analysis",
      "evidence_pack",
      "rewrite_plan",
      "draft_generation",
      "critic_review",
      "change_set_ready",
    ]);
  });

  it("maps missing JD, missing role/company, timeout, evidence shortage, and layout failure to clear next actions", () => {
    const service = new ResumeOptimizationWorkflowService();
    const missingJd = service.startRun({ userId: "user-1" });
    expect(missingJd.status).toBe("needs_input");
    expect(missingJd.nextAction?.type).toBe("provide_jd");
    expect(stageStatus(missingJd, "intake")).toBe("needs_input");

    const run = service.startRun({ userId: "user-1", jdText: "React role." });
    const incompleteContext = service.completeDraftGeneration({
      run,
      jd: {
        id: "pjd-2",
        userId: "user-1",
        title: "Untitled JD",
        rawText: "React role.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      generation: {
        id: "pgen-2",
        userId: "user-1",
        jdId: "pjd-2",
        inputSnapshot: {},
        outputSnapshot: {},
        selectedVariantIds: [],
        createdAt: new Date().toISOString(),
      },
      variants: [],
      sourceExperienceIds: [],
    });
    const jdStage = incompleteContext.stages.find((stage) => stage.stage === "jd_analysis");
    const evidenceStage = incompleteContext.stages.find((stage) => stage.stage === "evidence_pack");
    expect(jdStage?.nextAction?.type).toBe("complete_jd_context");
    expect(evidenceStage?.nextAction?.type).toBe("add_experience_evidence");

    const timeout = service.markFailure({ run, error: new Error("LLM request timeout") });
    expect(timeout.status).toBe("failed");
    expect(timeout.failureReason).toBe("llm_timeout");
    expect(timeout.nextAction?.type).toBe("retry_stage");
    expect(timeout.recoveryPlan).toMatchObject({
      reason: "llm_timeout",
      stage: "draft_generation",
      retryable: true,
      preserveCompletedStages: true,
    });

    const evidenceShortage = service.markFailure({ run, error: new Error("insufficient evidence shortage") });
    expect(evidenceShortage.status).toBe("needs_input");
    expect(evidenceShortage.nextAction?.type).toBe("add_experience_evidence");
    expect(evidenceShortage.recoveryPlan?.partialDraftPolicy).toBe("not_available");

    const layoutFailure = service.markFailure({ run, error: new Error("layout overflow") });
    expect(layoutFailure.status).toBe("failed");
    expect(layoutFailure.failureReason).toBe("layout_overflow");
    expect(stageStatus(layoutFailure, "layout_check")).toBe("failed");
    expect(layoutFailure.nextAction?.payload).toMatchObject({
      failedStage: "layout_check",
      retryOnlyFailedStage: true,
      remediation: "compact_layout",
    });
  });

  it("classifies Phase 6 recovery cases without leaking raw provider payloads", () => {
    const service = new ResumeWorkflowRecoveryService();

    const invalidJson = service.classify({
      message: "LLM_GENERATION_FAILED: phase=json_parse; provider=secret-key-like-provider-output; rawContentPreview={bad json with prompt}",
    });
    expect(invalidJson).toMatchObject({
      reason: "llm_invalid_json",
      stage: "draft_generation",
      status: "failed",
      retryable: true,
      partialDraftPolicy: "not_available",
    });
    expect(invalidJson.userMessage).not.toContain("rawContentPreview");
    expect(invalidJson.userMessage).not.toContain("secret-key-like-provider-output");

    const underfill = service.classify({
      message: "layout underfill",
      partialArtifactTypes: ["resumeDocumentDraft", "resumeChangeSet"],
    });
    expect(underfill).toMatchObject({
      reason: "layout_underfill",
      stage: "layout_check",
      partialDraftPolicy: "keep_visible",
    });
    expect(underfill.nextAction.payload).toMatchObject({
      remediation: "expand_grounded_content",
    });

    const critic = service.classify({ message: "critic fail during quality critic review" });
    expect(critic).toMatchObject({
      reason: "critic_failure",
      stage: "critic_review",
      nextAction: { type: "retry_critic_review" },
    });

    const exportFailure = service.classify({ message: "Playwright Chromium renderer failed during export" });
    expect(exportFailure).toMatchObject({
      reason: "export_failure",
      stage: "exported",
      nextAction: { type: "retry_export" },
    });
  });
});

describe("ResumeWorkflowEventProjector", () => {
  it("projects workflow status into an AgentRoom activity timeline card", () => {
    const service = new ResumeOptimizationWorkflowService();
    const workflowStatus = service.startQueuedGenerationRun({
      userId: "user-1",
      sessionId: "session-1",
      jdText: "React role.",
      jobId: "job-1",
    });
    const result: ToolResult = {
      status: "success",
      message: "Generation started.",
      data: {
        workflowStatus,
      },
      actionResult: {
        actionType: "generate_resume_from_jd",
        status: "success",
      },
    };

    const events = projectAgentRoomEvents({
      toolResults: [result],
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const workflowEvent = events.find((event) => event.specialInfo?.kind === "agent_activity_timeline");
    expect(workflowEvent).toBeTruthy();
    expect(workflowEvent?.agentName).toBe("architect");
    expect(workflowEvent?.specialInfo?.data).toMatchObject({
      runId: workflowStatus.runId,
      currentStage: "jd_analysis",
      status: "running",
    });
  });
});

describe("JDResumeAnalysisService", () => {
  it("produces a stable, addressable report for strong JD matches", async () => {
    const service = new JDResumeAnalysisService();
    const report = await service.analyze({
      jd: jd("Frontend Engineer", "Frontend Engineer requiring React, TypeScript, performance optimization, dashboard delivery, and A/B testing."),
      targetRole: "Frontend Engineer",
      sourceExperiences: [
        experience("pexp-1", "React performance platform", "Built a React TypeScript analytics dashboard, reduced bundle size by 40%, and shipped A/B testing instrumentation."),
        experience("pexp-2", "Frontend internship", "Optimized dashboard rendering performance with React profiling and delivered user-facing experiment analysis."),
        experience("pexp-skill", "Skills", "React, TypeScript, performance optimization, dashboarding, A/B testing", "skill"),
        experience("pexp-edu", "Education", "BSc Computer Science coursework in web systems and data analysis.", "education"),
      ],
    });

    expectReportShape(report);
    expect(report.rubricVersion).toBe("resume-optimization-rubric-v1");
    expect(report.dimensions).toHaveLength(10);
    expect(report.requirements.length).toBeGreaterThan(0);
    expect(report.requirements.every((item) => item.target?.requirementId === item.requirementId)).toBe(true);
    expect(report.phase3Inputs.evidenceBackedSourceExperienceIds.length).toBeGreaterThan(0);
    expect(report.summary.overallScore).toBeGreaterThan(50);
  });

  it("keeps the same report shape for partial and weak JD matches while surfacing missing evidence", async () => {
    const service = new JDResumeAnalysisService();
    const partial = await service.analyze({
      jd: jd("Data Analyst", "Data analyst requiring SQL, Python, dashboarding, stakeholder reporting, experimentation, and financial modeling."),
      sourceExperiences: [
        experience("pexp-sql", "Reporting analyst", "Built SQL dashboards and weekly stakeholder reporting packs with measurable turnaround improvements."),
        experience("pexp-edu", "Education", "Statistics coursework and Excel modeling.", "education"),
      ],
    });
    const weak = await service.analyze({
      jd: jd("ML Engineer", "Machine learning engineer requiring PyTorch, feature stores, Kubernetes, model monitoring, and online inference."),
      sourceExperiences: [
        experience("pexp-content", "Content operations", "Coordinated newsletters and community events for a student club.", "project"),
      ],
    });

    expectReportShape(partial);
    expectReportShape(weak);
    expect(partial.dimensions.map((item) => item.dimension)).toEqual(weak.dimensions.map((item) => item.dimension));
    expect(partial.summary.overallScore).toBeGreaterThan(weak.summary.overallScore);
    expect(weak.findings.some((item) => item.recommendedAction === "ask_user")).toBe(true);
    expect(weak.phase3Inputs.missingRequirementIds.length).toBeGreaterThanOrEqual(partial.phase3Inputs.missingRequirementIds.length);
    expect(weak.phase3Inputs.rewriteFocusDimensions.length).toBeGreaterThan(0);
  });
});

describe("ResumeChangeSetService", () => {
  it("creates a reviewable local change set and suppresses duplicate changes by business content", async () => {
    const analysisService = new JDResumeAnalysisService();
    const changeSetService = new ResumeChangeSetService();
    const source = experience(
      "pexp-1",
      "React performance platform",
      "Built a React dashboard.\nReduced bundle size by 40%.",
    );
    const analysisReport = await analysisService.analyze({
      jd: jd("Frontend Engineer", "Frontend role requiring React, TypeScript, performance optimization, and dashboard delivery."),
      sourceExperiences: [source],
    });
    const variant = structuredVariant(source.id, [
      "Built a React and TypeScript analytics dashboard for performance monitoring.",
      "Built a React and TypeScript analytics dashboard for performance monitoring.",
      "Reduced bundle size by 40% through profiling and route-level code splitting.",
    ]);
    const [changeSet] = changeSetService.createChangeSets({
      generation: generation("pgen-1", variant.id),
      variants: [variant],
      recommendedVariantId: variant.id,
      analysisReport,
      sourceExperiences: [source],
    });

    expect(changeSet).toBeTruthy();
    expect(changeSet.summary.label).toBe("2 changes waiting for review");
    expect(changeSet.changes).toHaveLength(2);
    expect(changeSet.changes[0]).toMatchObject({
      changeId: expect.any(String),
      type: expect.stringMatching(/replace_bullet|layout_compact/),
      target: {
        sectionId: "section-experience",
        itemId: "item-pexp-1",
        sourceExperienceId: "pexp-1",
      },
      before: expect.any(String),
      after: expect.any(String),
      reason: expect.stringContaining("Improve"),
      evidenceIds: expect.arrayContaining(["source-card-pexp-1"]),
      sourceExperienceId: "pexp-1",
      riskLevel: expect.any(String),
      rubricDimensions: expect.arrayContaining(["jd_alignment"]),
      status: "pending",
      acceptAction: {
        type: "accept_resume_change",
        payload: { changeSetId: changeSet.changeSetId, changeId: expect.any(String) },
      },
      rejectAction: {
        type: "reject_resume_change",
        payload: { changeSetId: changeSet.changeSetId, changeId: expect.any(String) },
      },
    });
  });

  it("accepts and rejects individual changes without mutating unrelated changes", async () => {
    const { changeSet, service } = await sampleChangeSet();
    const [first, second] = changeSet.changes;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const acceptedOne = service.acceptChange(changeSet, first!.changeId);
    expect(acceptedOne.summary.acceptedCount).toBe(1);
    expect(acceptedOne.summary.pendingCount).toBe(changeSet.changes.length - 1);
    expect(acceptedOne.changes.find((change) => change.changeId === first!.changeId)?.status).toBe("accepted");
    expect(acceptedOne.changes.find((change) => change.changeId === second!.changeId)?.status).toBe("pending");
    expect(flattenDraftText(acceptedOne.currentDraft)).toContain(first!.after);
    expect(flattenDraftText(acceptedOne.currentDraft)).not.toContain(second!.after);

    const rejectedOne = service.rejectChange(acceptedOne, second!.changeId);
    expect(rejectedOne.summary.rejectedCount).toBe(1);
    expect(rejectedOne.changes.find((change) => change.changeId === first!.changeId)?.status).toBe("accepted");
    expect(rejectedOne.changes.find((change) => change.changeId === second!.changeId)?.status).toBe("rejected");
    expect(flattenDraftText(rejectedOne.currentDraft)).toContain(first!.after);
    expect(flattenDraftText(rejectedOne.currentDraft)).not.toContain(second!.after);
  });

  it("accept all and reject all are deterministic and recover the original draft", async () => {
    const { changeSet, service } = await sampleChangeSet();
    const acceptedAll = service.acceptAll(changeSet);
    expect(acceptedAll.status).toBe("accepted");
    expect(acceptedAll.summary.acceptedCount).toBe(changeSet.changes.length);
    for (const change of changeSet.changes) {
      expect(flattenDraftText(acceptedAll.currentDraft)).toContain(change.after);
    }

    const rejectedAll = service.rejectAll(changeSet);
    expect(rejectedAll.status).toBe("rejected");
    expect(rejectedAll.summary.rejectedCount).toBe(changeSet.changes.length);
    expect(flattenDraftText(rejectedAll.currentDraft)).toBe(flattenDraftText(changeSet.originalDraft));
  });
});

describe("ResumePreviewSnapshotService", () => {
  it("projects original, problem-marker, patched, and accepted draft snapshots from change-set lineage", async () => {
    const { changeSet, service, analysisReport } = await sampleChangeSet();
    const accepted = service.acceptChange(changeSet, changeSet.changes[0]!.changeId);
    const projector = new ResumeDraftProjector();
    const patchProjection = new ResumePatchProjectionService(projector);
    const previewService = new ResumePreviewSnapshotService(projector, patchProjection);
    const critic = new ResumeEditorialCriticService().review({
      generationId: changeSet.generationId,
      analysisReport,
      changeSet,
    });

    const snapshots = previewService.createSnapshots({
      changeSet,
      analysisReport,
      editorialCriticReview: critic,
      acceptedChangeSet: accepted,
      generationId: changeSet.generationId,
    });

    expect(snapshots.map((snapshot) => snapshot.stage)).toEqual([
      "original_parsed_resume",
      "problem_markers",
      "rewrite_plan",
      "patched_draft",
      "critic_repaired_draft",
      "final_accepted_draft",
    ]);
    expect(snapshots[0]?.resumeDocumentDraft).toEqual(changeSet.originalDraft);
    expect(snapshots[1]?.problemMarkers.length).toBeGreaterThan(0);
    expect(snapshots[2]?.rewritePlan.length).toBe(changeSet.changes.length);
    expect(flattenDraftText(snapshots[3]?.resumeDocumentDraft)).toContain(changeSet.changes[0]!.after);
    expect(flattenDraftText(snapshots[4]?.resumeDocumentDraft)).toContain(changeSet.changes[0]!.after);
    expect(flattenDraftText(snapshots[5]?.resumeDocumentDraft)).toContain(changeSet.changes[0]!.after);
    expect(flattenDraftText(snapshots[5]?.resumeDocumentDraft)).not.toContain(changeSet.changes[1]!.after);
    expect(previewService.pickRenderableDraft(snapshots)).toEqual(accepted.currentDraft);
  });

  it("projects layout preview diagnostics with the same layout report fields used by export quality reports", () => {
    const layoutReport = sampleLayoutReport({
      contentHeightPx: 1200,
      usableHeightPx: 1000,
      remainingHeightPx: 0,
      overflowPx: 200,
      fitsPage: false,
      invalidBullets: [{
        bulletId: "bullet-1",
        itemId: "item-pexp-1",
        sectionType: "experience",
        lineCount: 3,
        lineWidthsPx: [720, 700, 120],
        minRequiredLineWidthPx: 500,
        passesWidthRule: false,
        text: "Too long bullet",
      }],
    });
    const projector = new LayoutPreviewReportProjector();
    const preview = projector.project({
      resumeDocumentDraft: structuredVariant("pexp-1", ["Too long bullet"]).resumeDocument!,
      layoutReport,
      requiredSectionTypes: ["summary", "experience", "education", "skill"],
    });

    expect(preview.exportLayoutReport).toBe(layoutReport);
    expect(preview.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "overflow", severity: "high", overflowPx: 200 }),
      expect.objectContaining({ type: "excessive_bullet_lines", severity: "medium", bulletId: "bullet-1" }),
      expect.objectContaining({ type: "missing_section", severity: "medium", sectionType: "summary" }),
    ]));
    expect(preview.summary).toMatchObject({
      fitsPage: false,
      hasOverflow: true,
      hasUnderfill: false,
      invalidBulletCount: 1,
      missingSectionCount: 3,
    });
  });
});

describe("ResumeEditorialCriticService", () => {
  it("produces item-level critic findings and safe patch suggestions", async () => {
    const { changeSet, analysisReport } = await sampleChangeSet();
    const review = new ResumeEditorialCriticService().review({
      generationId: changeSet.generationId,
      analysisReport,
      changeSet,
    });

    expect(review).toMatchObject({
      schemaVersion: 1,
      reviewId: expect.any(String),
      generationId: changeSet.generationId,
      changeSetId: changeSet.changeSetId,
      summary: {
        totalItems: expect.any(Number),
        autoFixableCount: expect.any(Number),
        needsInputCount: expect.any(Number),
        label: expect.any(String),
      },
      items: expect.any(Array),
      patchSuggestions: expect.any(Array),
    });
    expect(review.items.length).toBeGreaterThan(0);
    expect(review.items[0]).toMatchObject({
      itemId: expect.any(String),
      category: expect.any(String),
      severity: expect.any(String),
      target: expect.any(Object),
      explanation: expect.any(String),
      evidenceIds: expect.any(Array),
      suggestedFix: expect.any(String),
      autoFixAllowed: expect.any(Boolean),
    });
    expect(review.patchSuggestions.length).toBeGreaterThan(0);
    expect(review.repairedDraft?.sections.length).toBeGreaterThan(0);
  });

  it("asks for evidence on unsupported claims instead of auto-patching", async () => {
    const { changeSet, analysisReport } = await sampleChangeSet();
    const riskyReport = {
      ...analysisReport,
      findings: [{
        id: "finding-unsupported",
        dimension: "fabrication_exaggeration_risk" as const,
        severity: "high" as const,
        message: "Claim says revenue grew 300% but no evidence supports it.",
        target: changeSet.changes[0]?.target,
        requirementIds: [],
        sourceExperienceIds: [],
        evidenceIds: [],
        recommendedAction: "ask_user" as const,
      }],
    };
    const review = new ResumeEditorialCriticService().review({
      generationId: changeSet.generationId,
      analysisReport: riskyReport,
      changeSet,
    });
    const unsupported = review.items.find((item) => item.category === "inflated_metric" || item.category === "unsupported_claim");

    expect(unsupported?.autoFixAllowed).toBe(false);
    expect(unsupported?.nextAction?.type).toBe("provide_critic_evidence");
  });

  it("surfaces weak STAR and layout-risk critic items", async () => {
    const { changeSet, analysisReport } = await sampleChangeSet();
    const layoutReport = sampleLayoutReport({
      overflowPx: 160,
      fitsPage: false,
      invalidBullets: [{
        bulletId: "bullet-1",
        itemId: "item-pexp-1",
        sectionType: "experience",
        lineCount: 3,
        lineWidthsPx: [720, 640, 180],
        minRequiredLineWidthPx: 500,
        passesWidthRule: false,
        text: "Too long bullet",
      }],
    });
    const layoutPreview = new LayoutPreviewReportProjector().project({
      resumeDocumentDraft: changeSet.proposedDraft,
      layoutReport,
      requiredSectionTypes: ["summary", "experience"],
    });
    const starReport = {
      ...analysisReport,
      findings: [{
        id: "finding-star",
        dimension: "star_closure" as const,
        severity: "medium" as const,
        message: "Bullet explains action but misses the final result.",
        target: changeSet.changes[0]?.target,
        requirementIds: [],
        sourceExperienceIds: [],
        evidenceIds: ["source-card-pexp-1"],
        recommendedAction: "rewrite" as const,
      }],
    };
    const review = new ResumeEditorialCriticService().review({
      generationId: changeSet.generationId,
      analysisReport: starReport,
      changeSet,
      layoutPreviewReport: layoutPreview,
    });

    expect(review.items.some((item) => item.category === "missing_star_closure")).toBe(true);
    expect(review.items.some((item) => item.category === "layout_risk")).toBe(true);
  });
});

function stageStatus(
  run: ReturnType<ResumeOptimizationWorkflowService["startRun"]>,
  stage: string,
): string | undefined {
  return run.stages.find((item) => item.stage === stage)?.status;
}

function expectReportShape(report: Awaited<ReturnType<JDResumeAnalysisService["analyze"]>>): void {
  expect(report).toMatchObject({
    schemaVersion: 1,
    reportVersion: "resume-optimization-analysis-v1",
    rubricVersion: "resume-optimization-rubric-v1",
    jdId: expect.any(String),
    generatedAt: expect.any(String),
    summary: {
      overallScore: expect.any(Number),
      readiness: expect.any(String),
      strongDimensions: expect.any(Array),
      weakDimensions: expect.any(Array),
      topFindingIds: expect.any(Array),
    },
    dimensions: expect.any(Array),
    requirements: expect.any(Array),
    atsKeywordCoverage: {
      totalKeywords: expect.any(Number),
      matchedKeywords: expect.any(Number),
      missingKeywords: expect.any(Number),
      coverageRatio: expect.any(Number),
      items: expect.any(Array),
    },
    findings: expect.any(Array),
    phase3Inputs: {
      prioritizedRequirementIds: expect.any(Array),
      evidenceBackedSourceExperienceIds: expect.any(Array),
      missingRequirementIds: expect.any(Array),
      riskyEvidenceIds: expect.any(Array),
      rewriteFocusDimensions: expect.any(Array),
    },
  });
}

function jd(title: string, rawText: string): ProductJDRecord {
  return {
    id: `pjd-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    userId: "user-1",
    title,
    targetRole: title,
    rawText,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  };
}

function experience(
  id: string,
  title: string,
  content: string,
  category: ProductExperienceSummary["category"] = "project",
): ProductExperienceSummary {
  return {
    id,
    category,
    title,
    status: "active",
    content,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  };
}

async function sampleChangeSet(): Promise<{
  service: ResumeChangeSetService;
  changeSet: NonNullable<ReturnType<ResumeChangeSetService["createChangeSets"]>[number]>;
  analysisReport: Awaited<ReturnType<JDResumeAnalysisService["analyze"]>>;
}> {
  const service = new ResumeChangeSetService();
  const analysisService = new JDResumeAnalysisService();
  const source = experience(
    "pexp-1",
    "React performance platform",
    "Built a React dashboard.\nReduced bundle size by 40%.\nImproved user-facing monitoring.",
  );
  const analysisReport = await analysisService.analyze({
    jd: jd("Frontend Engineer", "Frontend role requiring React, TypeScript, dashboard delivery, and performance optimization."),
    sourceExperiences: [source],
  });
  const variant = structuredVariant(source.id, [
    "Built a React and TypeScript analytics dashboard for performance monitoring.",
    "Reduced bundle size by 40% through profiling and route-level code splitting.",
    "Improved user-facing monitoring with measurable dashboard reliability gains.",
  ]);
  const [changeSet] = service.createChangeSets({
    generation: generation("pgen-sample", variant.id),
    variants: [variant],
    recommendedVariantId: variant.id,
    analysisReport,
    sourceExperiences: [source],
  });
  if (!changeSet) throw new Error("Expected change set.");
  return { service, changeSet, analysisReport };
}

function generation(id: string, variantId: string): ProductGeneration {
  return {
    id,
    userId: "user-1",
    jdId: "pjd-frontend-engineer",
    targetRole: "Frontend Engineer",
    inputSnapshot: {},
    outputSnapshot: { recommendedVariantId: variantId },
    selectedVariantIds: [],
    createdAt: "2026-07-02T00:00:00.000Z",
  };
}

function structuredVariant(sourceExperienceId: string, bullets: string[]): ProductGeneratedVariant {
  return {
    id: "pvar-structured",
    userId: "user-1",
    content: bullets.map((bullet) => `- ${bullet}`).join("\n"),
    sourceExperienceIds: [sourceExperienceId],
    sourceEvidenceIds: [`source-card-${sourceExperienceId}`],
    createdAt: "2026-07-02T00:00:00.000Z",
    recommended: true,
    resumeDocument: {
      schemaVersion: 1,
      sections: [{
        id: "section-experience",
        type: "experience",
        title: "Experience",
        order: 1,
        items: [{
          id: `item-${sourceExperienceId}`,
          title: "React performance platform",
          bullets: bullets.map((text, index) => ({
            id: `bullet-${index + 1}`,
            text,
            evidenceIds: [`source-card-${sourceExperienceId}`],
          })),
          sourceExperienceId,
          evidenceStrength: "high",
          relevanceScore: 0.9,
        }],
      }],
    },
  };
}

function sampleLayoutReport(overrides: Partial<import("../src/exports/layout/ResumeLayoutOracle.js").ResumeLayoutReport> = {}): import("../src/exports/layout/ResumeLayoutOracle.js").ResumeLayoutReport {
  const bulletLayouts = overrides.bulletLayouts ?? overrides.invalidBullets ?? [];
  return {
    layoutSessionId: "layout-preview-test",
    templateId: "one-page-modern",
    density: "standard",
    targetPages: 1,
    contentWidthPx: 748,
    usableHeightPx: 1000,
    contentHeightPx: 900,
    remainingHeightPx: 100,
    overflowPx: 0,
    fitsPage: true,
    bulletMinLineWidthRatio: 2 / 3,
    maxBulletLines: 2,
    passesBulletWidthRule: (overrides.invalidBullets ?? []).length === 0,
    bulletLayouts,
    invalidBullets: [],
    sectionLayouts: [],
    itemLayouts: [],
    measuredAt: "2026-07-02T00:00:00.000Z",
    measurer: "heuristic",
    ...overrides,
  };
}

function flattenDraftText(document: ProductGeneratedVariant["resumeDocument"]): string {
  if (!document) return "";
  return document.sections
    .flatMap((section) => section.items)
    .flatMap((item) => item.bullets.map((bullet) => bullet.text))
    .join("\n");
}
