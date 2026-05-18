import type { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import type {
  EvidenceChainQueryService,
  GraphViewQueryService,
} from "../application/query/index.js";
import type { GenerateResumeResult } from "../application/ResumeGenerationService.js";
import type { GenerationPersistenceResult } from "../persistence/repositories.js";
import type { CvAgentKernel } from "../kernel/index.js";
import type { ProductServices } from "../product/index.js";
import type { ModelClient } from "../core/model/ModelClient.js";
import type { CopilotSessionService, CopilotWorkspaceService } from "../copilot/services/index.js";
import type { PlatformServices } from "../platform/index.js";

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
  /**
   * Stable backend-facing SDK facade. New API routes must call this facade.
   */
  cvAgentKernel: CvAgentKernel;
  /**
   * Legacy/transitional internal service fields.
   * They remain for compatibility with existing tests and demos, but should not
   * be used by new API routes.
   */
  resumeGenerationService: ResumeGenerationService;
  generationPersistenceService?: GenerationPersistencePort;
  evidenceChainQueryService: EvidenceChainQueryService;
  graphViewQueryService: GraphViewQueryService;
  productServices: ProductServices;
  copilotServices: {
    sessionService: CopilotSessionService;
    workspaceService: CopilotWorkspaceService;
  };
  platformServices: PlatformServices;
  frontDeskModelClient?: ModelClient;
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
