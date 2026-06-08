import type { ProductGeneratedVariant } from "../../product/types.js";
import type { ExperienceService } from "../../product/services/index.js";
import type { EvidencePack } from "./types.js";
import { JDRequirementParser } from "./JDRequirementParser.js";
import { ExperienceRetriever } from "./ExperienceRetriever.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import { EvidencePackBuilder } from "./EvidencePackBuilder.js";
import { ClaimSupportVerifier } from "./ClaimSupportVerifier.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";

export class EvidenceRAGService {
  private readonly jdRequirementParser: JDRequirementParser;
  private readonly experienceRetriever: ExperienceRetriever;
  private readonly evidencePackBuilder: EvidencePackBuilder;
  private readonly claimSupportVerifier = new ClaimSupportVerifier();

  public constructor(input: {
    experienceService: ExperienceService;
    llmEvidenceService?: LLMEvidenceService;
  }) {
    this.jdRequirementParser = new JDRequirementParser(input.llmEvidenceService);
    this.experienceRetriever = new ExperienceRetriever(input.experienceService);
    this.evidencePackBuilder = new EvidencePackBuilder(new ExperienceClaimExtractor(input.llmEvidenceService));
  }

  public async buildEvidencePack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    limit?: number;
  }): Promise<EvidencePack> {
    const requirements = await this.jdRequirementParser.parse({ jdText: input.jdText, targetRole: input.targetRole });
    const retrieved = await this.experienceRetriever.retrieve({
      userId: input.userId,
      requirements,
      limit: input.limit ?? 12,
    });
    return this.evidencePackBuilder.build({ requirements, retrieved });
  }

  public verifyGeneratedVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return this.claimSupportVerifier.verifyVariants(variants, evidencePack);
  }
}
