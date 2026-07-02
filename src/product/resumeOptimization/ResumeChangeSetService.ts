import type { ProductExperienceSummary, ProductGeneratedVariant, ProductGeneration } from "../types.js";
import type { JDResumeAnalysisReport, ResumeChangeSet } from "./types.js";
import { ResumeChangeApplyService } from "./ResumeChangeApplyService.js";
import { ResumeChangePlanner } from "./ResumeChangePlanner.js";
import { ResumeChangeRejectService } from "./ResumeChangeRejectService.js";

export class ResumeChangeSetService {
  private readonly planner = new ResumeChangePlanner();
  private readonly applyService = new ResumeChangeApplyService();
  private readonly rejectService = new ResumeChangeRejectService();

  public createChangeSets(input: {
    generation: ProductGeneration;
    variants: ProductGeneratedVariant[];
    recommendedVariantId?: string;
    analysisReport: JDResumeAnalysisReport;
    sourceExperiences: ProductExperienceSummary[];
  }): ResumeChangeSet[] {
    const preferredVariantId = input.recommendedVariantId
      ?? input.variants.find((variant) => variant.recommended)?.id
      ?? input.variants[0]?.id;
    return input.variants
      .filter((variant) => variant.id === preferredVariantId)
      .map((variant) => this.planner.plan({
        generation: input.generation,
        variant,
        analysisReport: input.analysisReport,
        sourceExperiences: input.sourceExperiences,
      }));
  }

  public acceptChange(changeSet: ResumeChangeSet, changeId: string): ResumeChangeSet {
    return this.applyService.acceptChange(changeSet, changeId);
  }

  public acceptAll(changeSet: ResumeChangeSet): ResumeChangeSet {
    return this.applyService.acceptAll(changeSet);
  }

  public rejectChange(changeSet: ResumeChangeSet, changeId: string): ResumeChangeSet {
    return this.rejectService.rejectChange(changeSet, changeId);
  }

  public rejectAll(changeSet: ResumeChangeSet): ResumeChangeSet {
    return this.rejectService.rejectAll(changeSet);
  }
}
