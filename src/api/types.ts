import type { FrontDeskOrchestrator } from "../application/frontdesk/index.js";
import type { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import type {
  EvidenceChainQueryService,
  GraphViewQueryService,
} from "../application/query/index.js";
import type { GenerateResumeResult } from "../application/ResumeGenerationService.js";
import type { GenerationPersistenceResult } from "../persistence/repositories.js";
import type { CvAgentKernel } from "../kernel/index.js";

export type ApiMode = "postgres" | "in_memory";

export type GenerationPersistencePort = {
  persist(
    result: GenerateResumeResult,
    metadata?: Record<string, unknown>,
  ): Promise<GenerationPersistenceResult>;
};

export type ApiKernel = {
  mode: ApiMode;
  warnings: string[];
  cvAgentKernel: CvAgentKernel;
  /**
   * Legacy/internal fields are kept during the API migration.
   * New routes should call cvAgentKernel instead of these services directly.
   */
  frontDeskOrchestrator: FrontDeskOrchestrator;
  resumeGenerationService: ResumeGenerationService;
  generationPersistenceService?: GenerationPersistencePort;
  evidenceChainQueryService: EvidenceChainQueryService;
  graphViewQueryService: GraphViewQueryService;
  close(): Promise<void>;
};

export type IngestDocumentJsonBody = {
  fileName: string;
  mimeType?: string;
  extension?: string;
  text?: string;
  base64?: string;
  sourceRef?: string;
};

export type GenerateJsonBody = {
  jdText: string;
  targetRole: string;
};
