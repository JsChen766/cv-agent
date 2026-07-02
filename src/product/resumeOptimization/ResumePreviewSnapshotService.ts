import { createHash } from "node:crypto";
import type { ResumeDocument } from "../types.js";
import { ResumeDraftProjector, cloneResumeDocument } from "./ResumeDraftProjector.js";
import { ResumePatchProjectionService } from "./ResumePatchProjectionService.js";
import type {
  JDResumeAnalysisReport,
  ResumeChangeSet,
  ResumeDraftProblemMarker,
  ResumePreviewSnapshot,
  ResumeRewritePlanItem,
} from "./types.js";

export class ResumePreviewSnapshotService {
  public constructor(
    private readonly draftProjector: ResumeDraftProjector = new ResumeDraftProjector(),
    private readonly patchProjectionService: ResumePatchProjectionService = new ResumePatchProjectionService(),
  ) {}

  public createSnapshots(input: {
    changeSet: ResumeChangeSet;
    analysisReport?: JDResumeAnalysisReport;
    acceptedChangeSet?: ResumeChangeSet;
    generationId?: string;
  }): ResumePreviewSnapshot[] {
    const generationId = input.generationId ?? input.changeSet.generationId;
    const markers = input.analysisReport ? problemMarkersFromReport(input.analysisReport) : [];
    const rewritePlan = rewritePlanFromChangeSet(input.changeSet);
    const snapshots: ResumePreviewSnapshot[] = [
      this.snapshot({
        generationId,
        changeSetId: input.changeSet.changeSetId,
        stage: "original_parsed_resume",
        resumeDocumentDraft: this.draftProjector.projectOriginal(input.changeSet),
      }),
      this.snapshot({
        generationId,
        changeSetId: input.changeSet.changeSetId,
        stage: "problem_markers",
        resumeDocumentDraft: this.draftProjector.projectOriginal(input.changeSet),
        problemMarkers: markers,
      }),
      this.snapshot({
        generationId,
        changeSetId: input.changeSet.changeSetId,
        stage: "rewrite_plan",
        resumeDocumentDraft: this.draftProjector.projectOriginal(input.changeSet),
        problemMarkers: markers,
        rewritePlan,
      }),
      this.snapshot({
        generationId,
        changeSetId: input.changeSet.changeSetId,
        stage: "patched_draft",
        resumeDocumentDraft: this.patchProjectionService.projectPatchedDraft(input.changeSet),
        problemMarkers: markers,
        rewritePlan,
      }),
    ];
    if (input.acceptedChangeSet) {
      snapshots.push(this.snapshot({
        generationId,
        changeSetId: input.acceptedChangeSet.changeSetId,
        stage: "final_accepted_draft",
        resumeDocumentDraft: this.patchProjectionService.projectAcceptedDraft(input.acceptedChangeSet),
        problemMarkers: markers,
        rewritePlan,
      }));
    }
    return snapshots;
  }

  public pickRenderableDraft(snapshots: ResumePreviewSnapshot[]): ResumeDocument | undefined {
    return [...snapshots]
      .reverse()
      .find((snapshot) => snapshot.resumeDocumentDraft.sections.length > 0)
      ?.resumeDocumentDraft;
  }

  private snapshot(input: {
    generationId: string;
    changeSetId?: string;
    stage: ResumePreviewSnapshot["stage"];
    resumeDocumentDraft: ResumeDocument;
    problemMarkers?: ResumeDraftProblemMarker[];
    rewritePlan?: ResumeRewritePlanItem[];
  }): ResumePreviewSnapshot {
    return {
      schemaVersion: 1,
      snapshotId: stableId("rps", [input.generationId, input.changeSetId ?? "", input.stage]),
      generationId: input.generationId,
      changeSetId: input.changeSetId,
      stage: input.stage,
      createdAt: new Date().toISOString(),
      resumeDocumentDraft: cloneResumeDocument(input.resumeDocumentDraft),
      problemMarkers: input.problemMarkers ?? [],
      rewritePlan: input.rewritePlan ?? [],
    };
  }
}

function problemMarkersFromReport(report: JDResumeAnalysisReport): ResumeDraftProblemMarker[] {
  return report.findings.map((finding) => ({
    markerId: finding.id,
    severity: finding.severity,
    message: finding.message,
    target: finding.target,
    rubricDimension: finding.dimension,
    evidenceIds: [...finding.evidenceIds],
  }));
}

function rewritePlanFromChangeSet(changeSet: ResumeChangeSet): ResumeRewritePlanItem[] {
  return changeSet.changes.map((change) => ({
    changeId: change.changeId,
    type: change.type,
    target: change.target,
    reason: change.reason,
    riskLevel: change.riskLevel,
    rubricDimensions: [...change.rubricDimensions],
  }));
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}
