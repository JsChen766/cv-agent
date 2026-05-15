import type { FrontDeskOrchestrator } from "../application/frontdesk/index.js";
import type { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import type { GenerationPersistenceService } from "../application/generation/index.js";
import type {
  EvidenceChainQueryService,
  GraphViewQueryService,
} from "../application/query/index.js";

export type ApiMode = "postgres" | "in_memory";

export type ApiKernel = {
  mode: ApiMode;
  warnings: string[];
  frontDeskOrchestrator: FrontDeskOrchestrator;
  resumeGenerationService: ResumeGenerationService;
  generationPersistenceService?: GenerationPersistenceService;
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
