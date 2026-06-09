import type { ProductGeneratedVariant } from "../../product/types.js";
import type { ExperienceService } from "../../product/services/index.js";
import type { EvidencePack } from "./types.js";
import { JDRequirementParser } from "./JDRequirementParser.js";
import { ExperienceRetriever } from "./ExperienceRetriever.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import { EvidencePackBuilder } from "./EvidencePackBuilder.js";
import { ClaimSupportVerifier } from "./ClaimSupportVerifier.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import { PersistentClaimRetriever } from "./PersistentClaimRetriever.js";

export class EvidenceRAGService {
  private readonly jdRequirementParser: JDRequirementParser;
  private readonly experienceRetriever: ExperienceRetriever;
  private readonly persistentClaimRetriever?: PersistentClaimRetriever;
  private readonly evidencePackBuilder: EvidencePackBuilder;
  private readonly claimSupportVerifier = new ClaimSupportVerifier();

  public constructor(input: {
    experienceService: ExperienceService;
    llmEvidenceService?: LLMEvidenceService;
    claimGraphRepository?: ClaimGraphRepository;
  }) {
    this.jdRequirementParser = new JDRequirementParser(input.llmEvidenceService);
    this.experienceRetriever = new ExperienceRetriever(input.experienceService);
    this.persistentClaimRetriever = input.claimGraphRepository ? new PersistentClaimRetriever(input.claimGraphRepository) : undefined;
    this.evidencePackBuilder = new EvidencePackBuilder(new ExperienceClaimExtractor(input.llmEvidenceService));
  }

  public async buildEvidencePack(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    limit?: number;
  }): Promise<EvidencePack> {
    const requirements = await this.jdRequirementParser.parse({ jdText: input.jdText, targetRole: input.targetRole });

    const persistentClaims = this.persistentClaimRetriever
      ? await this.persistentClaimRetriever.retrieve({
          userId: input.userId,
          requirements,
          limit: Math.max(input.limit ?? 12, 30),
        })
      : [];

    const persistentPack = persistentClaims.length > 0
      ? this.evidencePackBuilder.buildFromPersistentClaims({ requirements, retrievedClaims: persistentClaims })
      : undefined;

    const needsRawFallback = !persistentPack
      || persistentPack.allowedClaims.length === 0
      || persistentPack.missingRequirements.length > 0;

    if (!needsRawFallback && persistentPack) return persistentPack;

    const retrieved = await this.experienceRetriever.retrieve({
      userId: input.userId,
      requirements,
      limit: input.limit ?? 12,
    });
    const dynamicPack = await this.evidencePackBuilder.build({ requirements, retrieved });

    if (!persistentPack) return dynamicPack;
    return this.evidencePackBuilder.mergePersistentAndDynamic(persistentPack, dynamicPack);
  }

  public verifyGeneratedVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return this.claimSupportVerifier.verifyVariants(variants, evidencePack);
  }
}
