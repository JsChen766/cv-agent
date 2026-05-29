import type { ModelClient } from "../agent-core/model/ModelClient.js";
import type { ProductServices } from "../product/index.js";
import type { LLMExperienceExtractor } from "../product/LLMExperienceExtractor.js";
import type { LLMGenerationService } from "../product/LLMGenerationService.js";
import type { LLMRewriteService } from "../product/LLMRewriteService.js";
import type { CopilotSessionService, CopilotWorkspaceService } from "../copilot/services/index.js";
import type { PlatformServices } from "../platform/index.js";
import type { AuthService } from "../auth/index.js";
import type { FileService } from "../files/index.js";
import type { ResumeExportService } from "../exports/index.js";
import type { JobRunner } from "../jobs/index.js";

export type ApiMode = "postgres" | "in_memory";

export type ApiKernel = {
  mode: ApiMode;
  warnings: string[];
  productServices: ProductServices;
  copilotServices: {
    sessionService: CopilotSessionService;
    workspaceService: CopilotWorkspaceService;
  };
  platformServices: PlatformServices;
  authService: AuthService;
  fileService: FileService;
  exportService: ResumeExportService;
  jobRunner: JobRunner;
  frontDeskModelClient?: ModelClient;
  llmExperienceExtractor?: LLMExperienceExtractor;
  llmGenerationService?: LLMGenerationService;
  llmRewriteService?: LLMRewriteService;
  close(): Promise<void>;
};
