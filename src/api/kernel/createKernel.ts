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
  type ResumeExportRepository,
} from "../../exports/index.js";
import { readPlatformConfig } from "../../platform/config.js";
import { JobRunner } from "../../jobs/index.js";
import { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { ModelClient } from "../../agent-core/model/ModelClient.js";
import { DeepSeekProvider } from "../../providers/DeepSeekProvider.js";
import { OpenAICompatibleProvider } from "../../providers/OpenAICompatibleProvider.js";
import { LLMExperienceExtractor } from "../../product/LLMExperienceExtractor.js";
import { LLMGenerationService } from "../../product/LLMGenerationService.js";
import { LLMRewriteService } from "../../product/LLMRewriteService.js";
import { PendingActionService } from "../../agent-core/confirmation/PendingActionService.js";

export async function createKernel(): Promise<ApiKernel> {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? createPostgresKernel(databaseUrl) : createInMemoryKernel();
}

async function createPostgresKernel(databaseUrl: string): Promise<ApiKernel> {
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
    fileStorage: createFileStorage(),
    close: () => database.close(),
  });
}

function createInMemoryKernel(): ApiKernel {
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
    fileStorage: new InMemoryFileStorage(),
    close: async () => {},
  });
}

function buildKernel(input: BuildKernelInput): ApiKernel {
  const experienceService = new ExperienceService(input.productExperienceRepository);
  const jdService = new JDService(input.productJDRepository);
  const resumeService = new ResumeService(input.productResumeRepository);

  // LLM services
  const model = createModelClient();
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
  const pendingActions = new PendingActionService();
  const fileService = new FileService(input.fileRepository, input.fileStorage);
  let exportService!: ResumeExportService;
  const jobRunner = new JobRunner({
    platformServices: input.platformServices,
    fileService,
    productServices,
    pendingActions,
    getExportService: () => exportService,
  });
  exportService = new ResumeExportService(
    input.exportRepository,
    resumeService,
    fileService,
    input.platformServices,
  );
  const warnings = [...(input.warnings ?? []), ...model.warnings];

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
  close(): Promise<void>;
};

function createFileStorage(): FileStorage {
  const provider = readPlatformConfig().fileStorageProvider;
  return provider === "memory" ? new InMemoryFileStorage() : new LocalFileStorage();
}

function createModelClient(): { client?: ModelClient; warnings: string[]; config: ModelRuntimeConfig } {
  const provider = process.env.AGENT_MODEL_PROVIDER ?? process.env.AGENT_PROVIDER ?? "deepseek";
  const model = process.env.AGENT_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

  if (provider === "openai" || provider === "compatible") {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.AGENT_MODEL_API_KEY ?? process.env.AGENT_API_KEY;
    const baseURL =
      process.env.OPENAI_BASE_URL ??
      process.env.AGENT_MODEL_BASE_URL ??
      process.env.AGENT_BASE_URL ??
      "https://api.openai.com/v1";
    if (!apiKey) {
      return {
        config: { provider, model: process.env.OPENAI_MODEL ?? model, baseURL, apiKeyConfigured: false },
        warnings: ["OPENAI_API_KEY, AGENT_MODEL_API_KEY, or AGENT_API_KEY is not set. Agent model calls are disabled."],
      };
    }
    return {
      client: new ModelClient({
        provider: new OpenAICompatibleProvider({ name: provider, apiKey, baseURL }),
        defaultModel: process.env.OPENAI_MODEL ?? model,
      }),
      config: { provider, model: process.env.OPENAI_MODEL ?? model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(apiKey) },
      warnings: [],
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.AGENT_MODEL_API_KEY ?? process.env.AGENT_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL ?? process.env.AGENT_MODEL_BASE_URL ?? process.env.AGENT_BASE_URL ?? "https://api.deepseek.com";
  if (!apiKey) {
    return {
      config: { provider: "deepseek", model, baseURL, apiKeyConfigured: false },
      warnings: ["DEEPSEEK_API_KEY, AGENT_MODEL_API_KEY, or AGENT_API_KEY is not set. Agent model calls are disabled."],
    };
  }
  return {
    client: new ModelClient({
      provider: new DeepSeekProvider({
        apiKey,
        baseURL,
      }),
      defaultModel: model,
    }),
    config: { provider: "deepseek", model, baseURL, apiKeyConfigured: true, apiKeyMasked: maskApiKey(apiKey) },
    warnings: [],
  };
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function debugModelConfig(config: ModelRuntimeConfig): void {
  if (process.env.NODE_ENV !== "development" && process.env.DEBUG_LLM_CONFIG !== "true") return;
  if (process.env.DEBUG_LLM_CONFIG === "false") return;
  console.debug("[model] config", {
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    apiKeyConfigured: config.apiKeyConfigured,
    apiKeyMasked: config.apiKeyMasked,
  });
}
