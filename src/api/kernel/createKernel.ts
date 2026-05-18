import {
  type ArtifactDecisionRepository,
  ArtifactDecisionService,
  InMemoryArtifactDecisionRepository,
} from "../../application/decisions/index.js";
import { ResumeGenerationService } from "../../application/ResumeGenerationService.js";
import { DocumentExperienceIngestionService, DocumentIngestionService } from "../../application/documents/index.js";
import { DeterministicJDRequirementExtractor } from "../../application/extractors/DeterministicJDRequirementExtractor.js";
import { GenerationPersistenceService } from "../../application/generation/index.js";
import {
  EvidenceChainQueryService,
  GraphViewQueryService,
} from "../../application/query/index.js";
import {
  ArtifactRevisionService,
} from "../../application/revision/index.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../../knowledge/index.js";
import {
  readAgentModeConfig,
} from "../../providers/factory/index.js";
import {
  CopilotSessionService,
  CopilotWorkspaceService,
} from "../../copilot/services/index.js";
import {
  InMemoryCopilotPersistence,
  PostgresCopilotPersistence,
  type CopilotPersistence,
} from "../../copilot/persistence/index.js";
import type {
  DocumentRepository,
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
  GenerationArtifactBundleRecord,
  GenerationArtifactBundleRepository,
  GraphViewSnapshot,
  GraphViewSnapshotRepository,
  PersistedDocument,
  PersistedGenerationSessionRepository,
} from "../../persistence/repositories.js";
import {
  PostgresDatabase,
  PostgresArtifactDecisionRepository,
  PostgresDocumentRepository,
  PostgresEvidenceChainSnapshotRepository,
  PostgresEvidenceRepository,
  PostgresExperienceRepository,
  PostgresGeneratedArtifactRepository,
  PostgresGenerationArtifactBundleRepository,
  PostgresGenerationSessionRepository,
  PostgresGraphViewSnapshotRepository,
  PostgresJDRequirementRepository,
  PostgresSkillRepository,
  createPostgresGenerationPersistenceService,
} from "../../persistence/postgres/index.js";
import { DocumentLoaderTool, type ExtractedTextDocument } from "../../tools/document/index.js";
import { DefaultCvAgentKernel } from "../../kernel/index.js";
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
import type { ApiKernel, GenerationPersistencePort } from "../types.js";
import { InMemoryPlatformServices, PostgresPlatformServices, type PlatformServices } from "../../platform/index.js";
import {
  createArtifactCritic,
  createArtifactGenerator,
  createArtifactRevisionAgent,
  createExperienceExtractor,
  createFrontDeskModelClient,
  uniqueWarnings,
} from "./agentModeFactories.js";
import { validateDeterministicKernelAgentModes } from "../../agents/runtime/AgentRuntimeGuards.js";

export async function createKernel(): Promise<ApiKernel> {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? createPostgresKernel(databaseUrl) : createInMemoryKernel();
}

async function createPostgresKernel(databaseUrl: string): Promise<ApiKernel> {
  const database = new PostgresDatabase({ connectionString: databaseUrl });
  await database.runMigrations();
  return createPostgresKernelFromDatabase(database);
}

export async function createPostgresKernelFromDatabase(
  database: Pick<PostgresDatabase, "initializeSchema" | "query" | "transaction" | "close">,
): Promise<ApiKernel> {
  await database.initializeSchema();

  const documentRepository = new PostgresDocumentRepository(database);
  const experienceRepository = new PostgresExperienceRepository(database);
  const evidenceRepository = new PostgresEvidenceRepository(database);
  const skillRepository = new PostgresSkillRepository(database);
  const requirementRepository = new PostgresJDRequirementRepository(database);
  const artifactRepository = new PostgresGeneratedArtifactRepository(database);
  const sessionRepository = new PostgresGenerationSessionRepository(database);
  const evidenceChainRepository = new PostgresEvidenceChainSnapshotRepository(database);
  const graphViewRepository = new PostgresGraphViewSnapshotRepository(database);
  const bundleRepository = new PostgresGenerationArtifactBundleRepository(database);
  const artifactDecisionRepository = new PostgresArtifactDecisionRepository(database);
  const productExperienceRepository = new PostgresProductExperienceRepository(database);
  const productJDRepository = new PostgresProductJDRepository(database);
  const productResumeRepository = new PostgresProductResumeRepository(database);
  const productImportRepository = new PostgresProductImportRepository(database);
  const productGenerationRepository = new PostgresProductGenerationRepository(database);
  const copilotPersistence = new PostgresCopilotPersistence(database);
  const platformServices = new PostgresPlatformServices(database);
  const generationPersistenceService = createPostgresGenerationPersistenceService(database);

  return buildKernel({
    mode: "postgres",
    documentRepository,
    experienceRepository,
    evidenceRepository,
    skillRepository,
    requirementRepository,
    artifactRepository,
    sessionRepository,
    evidenceChainRepository,
    graphViewRepository,
    bundleRepository,
    artifactDecisionRepository,
    productExperienceRepository,
    productJDRepository,
    productResumeRepository,
    productImportRepository,
    productGenerationRepository,
    copilotPersistence,
    platformServices,
    generationPersistenceService,
    close: () => database.close(),
  });
}

export const createPostgresKernelFromDatabaseForTest = createPostgresKernelFromDatabase;

function createInMemoryKernel(): ApiKernel {
  const documentRepository = new InMemoryDocumentRepository();
  const experienceRepository = new InMemoryExperienceRepository();
  const evidenceRepository = new InMemoryEvidenceRepository();
  const skillRepository = new InMemorySkillRepository();
  const requirementRepository = new InMemoryJDRequirementRepository();
  const artifactRepository = new InMemoryGeneratedArtifactRepository();
  const sessionRepository = new InMemoryPersistedGenerationSessionRepository();
  const evidenceChainRepository = new InMemoryEvidenceChainSnapshotRepository();
  const graphViewRepository = new InMemoryGraphViewSnapshotRepository();
  const bundleRepository = new InMemoryGenerationArtifactBundleRepository();
  const artifactDecisionRepository = new InMemoryArtifactDecisionRepository();
  const productExperienceRepository = new InMemoryProductExperienceRepository();
  const productJDRepository = new InMemoryProductJDRepository();
  const productResumeRepository = new InMemoryProductResumeRepository();
  const productImportRepository = new InMemoryProductImportRepository();
  const productGenerationRepository = new InMemoryProductGenerationRepository();
  const copilotPersistence = new InMemoryCopilotPersistence();
  const platformServices = new InMemoryPlatformServices();

  return buildKernel({
    mode: "in_memory",
    warnings: ["DATABASE_URL is not set. API is running in in-memory mode."],
    documentRepository,
    experienceRepository,
    evidenceRepository,
    skillRepository,
    requirementRepository,
    artifactRepository,
    sessionRepository,
    evidenceChainRepository,
    graphViewRepository,
    bundleRepository,
    artifactDecisionRepository,
    productExperienceRepository,
    productJDRepository,
    productResumeRepository,
    productImportRepository,
    productGenerationRepository,
    copilotPersistence,
    platformServices,
    close: async () => {},
  });
}

function buildKernel(input: BuildKernelInput): ApiKernel {
  const agentModes = readAgentModeConfig();
  const runtimeGuardWarnings = validateDeterministicKernelAgentModes(agentModes);
  const documentLoader = new DocumentLoaderTool();
  const documentIngestionService = new DocumentIngestionService(documentLoader, input.documentRepository);
  const experienceExtractor = createExperienceExtractor({
    mode: agentModes.experienceExtractorMode,
  });
  const ingestionService = new ExperienceIngestionService(
    input.experienceRepository,
    input.evidenceRepository,
    input.skillRepository,
    experienceExtractor.extractor,
  );
  const artifactGenerator = createArtifactGenerator({
    mode: agentModes.artifactGeneratorMode,
  });
  const artifactCritic = createArtifactCritic({
    mode: agentModes.criticAgentMode,
  });
  const revisionAgent = createArtifactRevisionAgent({
    mode: agentModes.revisionAgentMode,
  });
  const artifactRevisionService = new ArtifactRevisionService({
    revisionAgent: revisionAgent.agent,
    artifactRepository: input.artifactRepository,
  });
  const artifactDecisionService = new ArtifactDecisionService(
    input.artifactDecisionRepository,
  );
  const resumeGenerationService = new ResumeGenerationService({
    requirementExtractor: new DeterministicJDRequirementExtractor(input.skillRepository, input.requirementRepository),
    artifactGenerator: artifactGenerator.generator,
    experienceRepo: input.experienceRepository,
    evidenceRepo: input.evidenceRepository,
    skillRepo: input.skillRepository,
    requirementRepo: input.requirementRepository,
    artifactRepo: input.artifactRepository,
    retriever: new KeywordExperienceRetriever(input.experienceRepository, input.evidenceRepository, input.skillRepository),
    artifactCritic: artifactCritic.critic,
  });
  const evidenceChainQueryService = new EvidenceChainQueryService(input.evidenceChainRepository);
  const graphViewQueryService = new GraphViewQueryService(input.graphViewRepository);
  const generationPersistenceService = input.generationPersistenceService ??
    new GenerationPersistenceService(
      input.sessionRepository,
      input.evidenceChainRepository,
      input.graphViewRepository,
      input.bundleRepository,
    );
  const agentProvider = createFrontDeskModelClient({
    mode: agentModes.frontDeskAgentMode,
  });
  const documentExperienceIngestionService = new DocumentExperienceIngestionService(
    documentIngestionService,
    ingestionService,
  );

  const warnings = uniqueWarnings([
    ...(input.warnings ?? []),
    ...agentProvider.warnings,
    ...experienceExtractor.warnings,
    ...artifactGenerator.warnings,
    ...artifactCritic.warnings,
    ...revisionAgent.warnings,
    ...runtimeGuardWarnings,
  ]);
  const cvAgentKernel = new DefaultCvAgentKernel({
    mode: input.mode,
    warnings,
    documentExperienceIngestionService,
    resumeGenerationService,
    generationPersistenceService,
    evidenceChainQueryService,
    graphViewQueryService,
    artifactRevisionService,
    artifactDecisionService,
    close: input.close,
  });
  const experienceService = new ExperienceService(input.productExperienceRepository);
  const jdService = new JDService(input.productJDRepository);
  const resumeService = new ResumeService(input.productResumeRepository);
  const importService = new ImportService(input.productImportRepository, experienceService);
  const generationProductService = new GenerationProductService(
    input.productGenerationRepository,
    jdService,
    resumeService,
    cvAgentKernel,
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

  return {
    mode: input.mode,
    warnings,
    cvAgentKernel,
    resumeGenerationService,
    generationPersistenceService,
    evidenceChainQueryService,
    graphViewQueryService,
    productServices,
    copilotServices,
    platformServices: input.platformServices,
    frontDeskModelClient: agentProvider.modelClient,
    close: input.close,
  };
}

type BuildKernelInput = {
  mode: "postgres" | "in_memory";
  warnings?: string[];
  documentRepository: DocumentRepository;
  experienceRepository: InMemoryExperienceRepository | PostgresExperienceRepository;
  evidenceRepository: InMemoryEvidenceRepository | PostgresEvidenceRepository;
  skillRepository: InMemorySkillRepository | PostgresSkillRepository;
  requirementRepository: InMemoryJDRequirementRepository | PostgresJDRequirementRepository;
  artifactRepository: InMemoryGeneratedArtifactRepository | PostgresGeneratedArtifactRepository;
  sessionRepository: PersistedGenerationSessionRepository;
  evidenceChainRepository: EvidenceChainSnapshotRepository;
  graphViewRepository: GraphViewSnapshotRepository;
  bundleRepository: GenerationArtifactBundleRepository;
  artifactDecisionRepository: ArtifactDecisionRepository;
  productExperienceRepository: ProductExperienceRepository;
  productJDRepository: ProductJDRepository;
  productResumeRepository: ProductResumeRepository;
  productImportRepository: ProductImportRepository;
  productGenerationRepository: ProductGenerationRepository;
  copilotPersistence: CopilotPersistence;
  platformServices: PlatformServices;
  generationPersistenceService?: GenerationPersistencePort;
  close(): Promise<void>;
};

class InMemoryDocumentRepository implements DocumentRepository {
  private readonly documents = new Map<string, PersistedDocument>();

  public async save(document: ExtractedTextDocument | PersistedDocument): Promise<void> {
    const persisted: PersistedDocument = {
      ...document,
      parserStatus: "parserStatus" in document ? document.parserStatus : "parsed",
      parserName: "parserName" in document ? document.parserName : document.metadata.parser,
      updatedAt: "updatedAt" in document ? document.updatedAt : document.createdAt,
    };
    this.documents.set(document.documentId, persisted);
  }

  public async getById(userId: string, id: string): Promise<PersistedDocument | null> {
    const document = this.documents.get(id);
    return document?.userId === userId ? document : null;
  }

  public async listByUserId(userId: string): Promise<PersistedDocument[]> {
    return Array.from(this.documents.values()).filter((document) => document.userId === userId);
  }

  public async delete(userId: string, id: string): Promise<void> {
    const document = await this.getById(userId, id);
    if (document) {
      this.documents.delete(id);
    }
  }
}

class InMemoryPersistedGenerationSessionRepository implements PersistedGenerationSessionRepository {
  private readonly sessions = new Map<string, Parameters<PersistedGenerationSessionRepository["save"]>[0]>();

  public async save(session: Parameters<PersistedGenerationSessionRepository["save"]>[0]): Promise<void> {
    this.sessions.set(session.id, session);
  }

  public async getById(
    userId: string,
    id: string,
  ): Promise<Awaited<ReturnType<PersistedGenerationSessionRepository["getById"]>>> {
    const session = this.sessions.get(id);
    return session?.userId === userId ? session : null;
  }

  public async listByUserId(userId: string): Promise<Awaited<ReturnType<PersistedGenerationSessionRepository["listByUserId"]>>> {
    return Array.from(this.sessions.values()).filter((session) => session.userId === userId);
  }

  public async updateStatus(
    userId: string,
    id: string,
    status: Parameters<PersistedGenerationSessionRepository["updateStatus"]>[2],
  ): Promise<void> {
    const session = await this.getById(userId, id);
    if (session) {
      this.sessions.set(id, {
        ...session,
        status,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

class InMemoryEvidenceChainSnapshotRepository implements EvidenceChainSnapshotRepository {
  private readonly snapshots = new Map<string, EvidenceChainSnapshot>();

  public async save(snapshot: EvidenceChainSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, snapshot);
  }

  public async getById(userId: string, id: string): Promise<EvidenceChainSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot?.userId === userId ? snapshot : null;
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<EvidenceChainSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.userId === userId && snapshot.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async listByArtifactId(userId: string, artifactId: string): Promise<EvidenceChainSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.userId === userId && snapshot.artifactId === artifactId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

class InMemoryGraphViewSnapshotRepository implements GraphViewSnapshotRepository {
  private readonly snapshots = new Map<string, GraphViewSnapshot>();

  public async save(snapshot: GraphViewSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, snapshot);
  }

  public async getById(userId: string, id: string): Promise<GraphViewSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot?.userId === userId ? snapshot : null;
  }

  public async listByScope(userId: string, scopeType: string, scopeId: string): Promise<GraphViewSnapshot[]> {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => (
        snapshot.userId === userId &&
        snapshot.scopeType === scopeType &&
        snapshot.scopeId === scopeId
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

class InMemoryGenerationArtifactBundleRepository implements GenerationArtifactBundleRepository {
  private readonly bundles = new Map<string, GenerationArtifactBundleRecord>();

  public async save(bundle: GenerationArtifactBundleRecord): Promise<void> {
    this.bundles.set(bundle.id, bundle);
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<GenerationArtifactBundleRecord[]> {
    return Array.from(this.bundles.values())
      .filter((bundle) => bundle.userId === userId && bundle.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
