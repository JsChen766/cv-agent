import { describe, expect, it } from "vitest";
import { projectAgentRoomEvents } from "../src/agent-core/events/AgentRoomEventProjector.js";
import type { ToolResult } from "../src/agent-core/tools/ToolResult.js";
import {
  JDResumeAnalysisService,
  ResumeChangeSetService,
  ResumeOptimizationWorkflowService,
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
    expect(stageStatus(completed, "change_set_ready")).toBe("completed");
    expect(completed.events.map((event) => event.stage)).toEqual([
      "intake",
      "jd_analysis",
      "jd_analysis",
      "evidence_pack",
      "rewrite_plan",
      "draft_generation",
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

    const evidenceShortage = service.markFailure({ run, error: new Error("insufficient evidence shortage") });
    expect(evidenceShortage.status).toBe("needs_input");
    expect(evidenceShortage.nextAction?.type).toBe("add_experience_evidence");

    const layoutFailure = service.markFailure({ run, error: new Error("layout overflow") });
    expect(layoutFailure.status).toBe("failed");
    expect(layoutFailure.failureReason).toBe("layout_failure");
    expect(stageStatus(layoutFailure, "layout_check")).toBe("failed");
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
  return { service, changeSet };
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

function flattenDraftText(document: ProductGeneratedVariant["resumeDocument"]): string {
  if (!document) return "";
  return document.sections
    .flatMap((section) => section.items)
    .flatMap((item) => item.bullets.map((bullet) => bullet.text))
    .join("\n");
}
