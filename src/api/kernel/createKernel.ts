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
import type { ApiKernel } from "../types.js";
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
  const importService = new ImportService(input.productImportRepository, experienceService);
  const generationProductService = new GenerationProductService(
    input.productGenerationRepository,
    jdService,
    resumeService,
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
  const fileService = new FileService(input.fileRepository, input.fileStorage);
  let exportService!: ResumeExportService;
  const jobRunner = new JobRunner({
    platformServices: input.platformServices,
    fileService,
    productServices,
    getExportService: () => exportService,
  });
  exportService = new ResumeExportService(
    input.exportRepository,
    resumeService,
    fileService,
    input.platformServices,
  );
  const model = createModelClient();
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
    frontDeskModelClient: model.client,
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

function createModelClient(): { client?: ModelClient; warnings: string[] } {
  const provider = process.env.AGENT_MODEL_PROVIDER ?? "deepseek";
  const model = process.env.AGENT_MODEL ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

  if (provider === "openai" || provider === "compatible") {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.AGENT_MODEL_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL ?? process.env.AGENT_MODEL_BASE_URL ?? "https://api.openai.com/v1";
    if (!apiKey) return { warnings: ["OPENAI_API_KEY or AGENT_MODEL_API_KEY is not set. Agent model calls are disabled."] };
    return {
      client: new ModelClient({
        provider: new OpenAICompatibleProvider({ name: provider, apiKey, baseURL }),
        defaultModel: process.env.OPENAI_MODEL ?? model,
      }),
      warnings: [],
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.AGENT_MODEL_API_KEY;
  if (!apiKey) return { warnings: ["DEEPSEEK_API_KEY or AGENT_MODEL_API_KEY is not set. Agent model calls are disabled."] };
  return {
    client: new ModelClient({
      provider: new DeepSeekProvider({ apiKey, baseURL: process.env.DEEPSEEK_BASE_URL }),
      defaultModel: model,
    }),
    warnings: [],
  };
}
