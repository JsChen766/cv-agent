import type { GuidelineRepository } from "./GuidelineRepository.js";
import { GuidelineInstructionBuilder } from "./GuidelineInstructionBuilder.js";
import { GuidelineRetriever } from "./GuidelineRetriever.js";
import { GuidelineRoleAnalyzer } from "./GuidelineRoleAnalyzer.js";
import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import type { InstructionPack } from "./types.js";

export class GuidelineRAGService {
  private readonly roleAnalyzer: GuidelineRoleAnalyzer;
  private readonly retriever: GuidelineRetriever;
  private readonly instructionBuilder: GuidelineInstructionBuilder;

  public constructor(input: {
    repository: GuidelineRepository;
    llmGuidelineService?: LLMGuidelineService;
  }) {
    this.roleAnalyzer = new GuidelineRoleAnalyzer(input.llmGuidelineService);
    this.retriever = new GuidelineRetriever(input.repository);
    this.instructionBuilder = new GuidelineInstructionBuilder(input.llmGuidelineService);
  }

  public async buildInstructionPack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    limit?: number;
  }): Promise<InstructionPack> {
    const analysis = await this.roleAnalyzer.analyze({ jdText: input.jdText, targetRole: input.targetRole });
    const retrieved = await this.retriever.retrieve({ analysis, limit: input.limit ?? 8 });
    return this.instructionBuilder.build({
      jdText: input.jdText,
      targetRole: input.targetRole,
      analysis,
      retrieved,
    });
  }
}
