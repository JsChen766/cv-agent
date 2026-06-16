import {
  CopilotSessionService,
  CopilotWorkspaceService,
} from "../../copilot/services/index.js";
import {
  InMemoryCopilotPersistence,
  PostgresCopilotPersistence,
  type CopilotPersistence,
} from "../../copilot/persistence/index.js";
import {
  ExperienceService,
  GenerationProductService,
  ImportService,
  InMemoryProductExperienceRepository,
  InMemoryProductGenerationRepository,
  InMemoryProductImportRepository,
  InMemoryProductJDRepository,
  InMemoryProductResumeRepository,
  JDService,
  PostgresProductExperienceRepository,
  PostgresProductGenerationRepository,
  PostgresProductImportRepository,
  PostgresProductJDRepository,
  PostgresProductResumeRepository,
  ResumeService,
  type ProductExperienceRepository,
  type ProductGenerationRepository,
  type ProductImportRepository,
  type ProductJDRepository,
  type ProductResumeRepository,
} from "../../product/index.js";
import type { ApiKernel, ModelRuntimeConfig } from "../types.js";
import { InMemoryPlatformServices, PostgresPlatformServices, type PlatformServices } from "../../platform/index.js";
import { AuthService, InMemoryAuthRepository, PostgresAuthRepository } from "../../auth/index.js";
import {
  FileService,
  InMemoryFileRepository,
  InMemoryFileStorage,
  LocalFileStorage,
  PostgresFileRepository,
  type FileRepository,
  type FileStorage,
} from "../../files/index.js";
import {
  InMemoryResumeExportRepository,
  PostgresResumeExportRepository,
  ResumeExportService,
  type PdfRendererAdapter,
  type ResumeExportRepository,
  type ResumeLayoutMeasurer,
} from "../../exports/index.js";
import { readPlatformConfig } from "../../platform/config.js";
import { JobRunner } from "../../jobs/index.js";
import { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { ModelClientFactory, debugModelConfig, describeModelConfig } from "../../providers/ModelClientFactory.js";
import { LLMExperienceExtractor } from "../../product/LLMExperienceExtractor.js";
import { LLMGenerationService } from "../../product/LLMGenerationService.js";
import { LLMRewriteService } from "../../product/LLMRewriteService.js";
import { InMemoryPendingActionRepository } from "../../agent-core/confirmation/InMemoryPendingActionRepository.js";
import { PendingActionService } from "../../agent-core/confirmation/PendingActionService.js";
import { PostgresPendingActionRepository } from "../../agent-core/confirmation/PostgresPendingActionRepository.js";
import type { PendingActionRepository } from "../../agent-core/confirmation/PendingActionRepository.js";

export async function createKernel(options: { pdfRenderer?: PdfRendererAdapter; layoutMeasurer?: ResumeLayoutMeasurer } = {}): Promise<ApiKernel> {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? createPostgresKernel(databaseUrl, options) : createInMemoryKernel(options);
}

async function createPostgresKernel(databaseUrl: string, options: { pdfRenderer?: PdfRendererAdapter; layoutMeasurer?: ResumeLayoutMeasurer }): Promise<ApiKernel> {
  const database = new PostgresDatabase({ connectionString: databaseUrl });
  await database.runMigrations();
  await database.initializeSchema();

  return buildKernel({
    mode: "postgres",
    productExperienceRepository: new PostgresProductExperienceRepository(database),
    productJDRepository: new PostgresProductJDRepository(database),
    productResumeRepository: new PostgresProductResumeRepository(database),
    productImportRepository: new PostgresProductImportRepository(database),
    productGenerationRepository: new PostgresProductGenerationRepository(database),
    copilotPersistence: new PostgresCopilotPersistence(database),
    platformServices: new PostgresPlatformServices(database),
    authService: new AuthService(new PostgresAuthRepository(database)),
    fileRepository: new PostgresFileRepository(database),
    exportRepository: new PostgresResumeExportRepository(database),
    pendingActionRepository: new PostgresPendingActionRepository(database),
    fileStorage: createFileStorage(),
    pdfRenderer: options.pdfRenderer,
    layoutMeasurer: options.layoutMeasurer,
    close: () => database.close(),
  });
}

function createInMemoryKernel(options: { pdfRenderer?: PdfRendererAdapter; layoutMeasurer?: ResumeLayoutMeasurer }): ApiKernel {
  return buildKernel({
    mode: "in_memory",
    warnings: ["DATABASE_URL is not set. API is running in in-memory mode."],
    productExperienceRepository: new InMemoryProductExperienceRepository(),
    productJDRepository: new InMemoryProductJDRepository(),
    productResumeRepository: new InMemoryProductResumeRepository(),
    productImportRepository: new InMemoryProductImportRepository(),
    productGenerationRepository: new InMemoryProductGenerationRepository(),
    copilotPersistence: new InMemoryCopilotPersistence(),
    platformServices: new InMemoryPlatformServices(),
    authService: new AuthService(new InMemoryAuthRepository()),
    fileRepository: new InMemoryFileRepository(),
    exportRepository: new InMemoryResumeExportRepository(),
    pendingActionRepository: new InMemoryPendingActionRepository(),
    fileStorage: new InMemoryFileStorage(),
    pdfRenderer: options.pdfRenderer,
    layoutMeasurer: options.layoutMeasurer,
    close: async () => {},
  });
}

function buildKernel(input: BuildKernelInput): ApiKernel {
  const experienceService = new ExperienceService(input.productExperienceRepository);
  const jdService = new JDService(input.productJDRepository);
  const resumeService = new ResumeService(input.productResumeRepository);

  // LLM services
  const modelClientFactory = new ModelClientFactory();
  const model = modelClientFactory.createDefaultModelClient();
  debugModelConfig(model.config);
  const llmExperienceExtractor = model.client ? new LLMExperienceExtractor(model.client) : undefined;
  const llmGenerationService = model.client ? new LLMGenerationService(model.client) : undefined;
  const llmRewriteService = model.client ? new LLMRewriteService(model.client) : undefined;

  const importService = new ImportService(input.productImportRepository, experienceService, llmExperienceExtractor);
  const generationProductService = new GenerationProductService(
    input.productGenerationRepository,
    jdService,
    resumeService,
    experienceService,
    llmGenerationService,
  );
  const productServices = {
    experienceService,
    jdService,
    resumeService,
    importService,
    generationProductService,
  };
  const copilotServices = {
    sessionService: new CopilotSessionService(input.copilotPersistence),
    workspaceService: new CopilotWorkspaceService(input.copilotPersistence, productServices),
  };
  const pendingActions = new PendingActionService(input.pendingActionRepository);
  const fileService = new FileService(input.fileRepository, input.fileStorage);
  let exportService!: ResumeExportService;
  const jobRunner = new JobRunner({
    platformServices: input.platformServices,
    fileService,
    productServices,
    pendingActions,
    copilotServices,
    getExportService: () => exportService,
  });
  exportService = new ResumeExportService(
    input.exportRepository,
    resumeService,
    fileService,
    input.platformServices,
    input.pdfRenderer,
    input.layoutMeasurer,
  );
  const warnings = [...(input.warnings ?? []), ...model.warnings];

  const resolveUserModelClient = async (userId: string) => {
    const userConfig = await input.authService.resolveUserModelConfig(userId);
    if (userConfig.provider && userConfig.apiKey) {
      const result = modelClientFactory.createModelClientForUser(userConfig);
      return {
        client: result.client,
        source: "user" as const,
        configSummary: result.client ? describeModelConfig(result.config) : undefined,
      };
    }
    return { client: model.client, source: "default" as const };
  };

  return {
    mode: input.mode,
    warnings,
    productServices,
    copilotServices,
    platformServices: input.platformServices,
    authService: input.authService,
    fileService,
    exportService,
    jobRunner,
    pendingActions,
    frontDeskModelClient: model.client,
    modelClientFactory,
    resolveUserModelClient,
    llmExperienceExtractor,
    llmGenerationService,
    llmRewriteService,
    modelRuntimeConfig: model.config,
    close: input.close,
  };
}

type BuildKernelInput = {
  mode: "postgres" | "in_memory";
  warnings?: string[];
  productExperienceRepository: ProductExperienceRepository;
  productJDRepository: ProductJDRepository;
  productResumeRepository: ProductResumeRepository;
  productImportRepository: ProductImportRepository;
  productGenerationRepository: ProductGenerationRepository;
  copilotPersistence: CopilotPersistence;
  platformServices: PlatformServices;
  authService: AuthService;
  fileRepository: FileRepository;
  fileStorage: FileStorage;
  exportRepository: ResumeExportRepository;
  pendingActionRepository: PendingActionRepository;
  pdfRenderer?: PdfRendererAdapter;
  layoutMeasurer?: ResumeLayoutMeasurer;
  close(): Promise<void>;
};

function createFileStorage(): FileStorage {
  const provider = readPlatformConfig().fileStorageProvider;
  return provider === "memory" ? new InMemoryFileStorage() : new LocalFileStorage();
}
