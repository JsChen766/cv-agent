import type { GuidelineRepository } from "./GuidelineRepository.js";
import { GuidelineInstructionBuilder } from "./GuidelineInstructionBuilder.js";
import { GuidelineIngestionService, type GuidelineIngestionDocument } from "./GuidelineIngestionService.js";
import { GuidelineQueryPlanner } from "./GuidelineQueryPlanner.js";
import { GuidelineRetriever } from "./GuidelineRetriever.js";
import { GuidelineRoleAnalyzer } from "./GuidelineRoleAnalyzer.js";
import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import type { InstructionPack } from "./types.js";

export class GuidelineRAGService {
  private readonly roleAnalyzer: GuidelineRoleAnalyzer;
  private readonly queryPlanner = new GuidelineQueryPlanner();
  private readonly retriever: GuidelineRetriever;
  private readonly instructionBuilder: GuidelineInstructionBuilder;
  private readonly ingestionService: GuidelineIngestionService;

  public constructor(input: { repository: GuidelineRepository; llmGuidelineService?: LLMGuidelineService }) {
    this.roleAnalyzer = new GuidelineRoleAnalyzer(input.llmGuidelineService);
    this.retriever = new GuidelineRetriever(input.repository);
    this.instructionBuilder = new GuidelineInstructionBuilder(input.llmGuidelineService);
    this.ingestionService = new GuidelineIngestionService(input.repository);
  }

  public ingestGuidelines(documents: GuidelineIngestionDocument[]) {
    return this.ingestionService.ingest(documents);
  }

  public async buildInstructionPack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    limit?: number;
  }): Promise<InstructionPack> {
    const analysis = await this.roleAnalyzer.analyze({ jdText: input.jdText, targetRole: input.targetRole });
    const queryPlan = this.queryPlanner.plan(analysis);
    const retrieved = await this.retriever.retrieve({ analysis, queryPlan, limit: input.limit ?? 14 });
    return this.instructionBuilder.build({
      jdText: input.jdText,
      targetRole: input.targetRole,
      analysis,
      queryPlan,
      retrieved,
    });
  }
}
