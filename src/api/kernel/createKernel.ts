import { FrontDeskAgent } from "../../agents/FrontDeskAgent.js";
import { DeterministicArtifactCritic } from "../../application/critique/DeterministicArtifactCritic.js";
import { LLMArtifactCritic } from "../../application/critique/LLMArtifactCritic.js";
import type { ArtifactCritic } from "../../application/critique/types.js";
import { ResumeGenerationService } from "../../application/ResumeGenerationService.js";
import { DocumentIngestionService } from "../../application/documents/index.js";
import { DeterministicJDRequirementExtractor } from "../../application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../../application/generators/DeterministicArtifactGenerator.js";
import { LLMArtifactGenerator } from "../../application/generators/LLMArtifactGenerator.js";
import type { ArtifactGenerator } from "../../application/generators/ArtifactGenerator.js";
import { FrontDeskOrchestrator } from "../../application/frontdesk/index.js";
import { GenerationPersistenceService } from "../../application/generation/index.js";
import {
  EvidenceChainQueryService,
  GraphViewQueryService,
} from "../../application/query/index.js";
import {
  ArtifactRevisionService,
  DeterministicArtifactRevisionAgent,
  LLMArtifactRevisionAgent,
  type ArtifactRevisionAgent,
} from "../../application/revision/index.js";
import { ModelClient } from "../../core/model/ModelClient.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../../knowledge/index.js";
import { MockProvider } from "../../providers/MockProvider.js";
import {
  AgentProviderFactory,
  readAgentModeConfig,
} from "../../providers/factory/index.js";
import { LLMExperienceExtractor } from "../../knowledge/ingestion/LLMExperienceExtractor.js";
import { DeterministicExperienceExtractor } from "../../knowledge/ingestion/extractors/DeterministicExperienceExtractor.js";
import type { ExperienceExtractor } from "../../knowledge/ingestion/extractors/types.js";
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
import type { ApiKernel, GenerationPersistencePort } from "../types.js";

export async function createKernel(): Promise<ApiKernel> {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? createPostgresKernel(databaseUrl) : createInMemoryKernel();
}

async function createPostgresKernel(databaseUrl: string): Promise<ApiKernel> {
  const database = new PostgresDatabase({ connectionString: databaseUrl });
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
    close: async () => {},
  });
}

function buildKernel(input: BuildKernelInput): ApiKernel {
  const agentModes = readAgentModeConfig();
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
  const frontDeskAgent = new FrontDeskAgent({
    modelClient: agentProvider.modelClient,
  });
  const frontDeskOrchestrator = new FrontDeskOrchestrator(
    frontDeskAgent,
    documentLoader,
    ingestionService,
    resumeGenerationService,
    documentIngestionService,
    {
      evidenceChainQueryService,
      graphViewQueryService,
    },
    artifactRevisionService,
  );

  const warnings = uniqueWarnings([
    ...(input.warnings ?? []),
    ...agentProvider.warnings,
    ...experienceExtractor.warnings,
    ...artifactGenerator.warnings,
    ...artifactCritic.warnings,
    ...revisionAgent.warnings,
  ]);
  const cvAgentKernel = new DefaultCvAgentKernel({
    mode: input.mode,
    warnings,
    frontDeskOrchestrator,
    resumeGenerationService,
    generationPersistenceService,
    evidenceChainQueryService,
    graphViewQueryService,
    artifactRevisionService,
    close: input.close,
  });

  return {
    mode: input.mode,
    warnings,
    cvAgentKernel,
    frontDeskOrchestrator,
    resumeGenerationService,
    generationPersistenceService,
    evidenceChainQueryService,
    graphViewQueryService,
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
  generationPersistenceService?: GenerationPersistencePort;
  close(): Promise<void>;
};

function createFrontDeskModelClient(input: {
  mode: "mock" | "llm";
}): {
  modelClient: ModelClient;
  warnings: string[];
} {
  if (input.mode === "mock") {
    return {
      modelClient: new ModelClient({
        provider: new MockProvider(),
        defaultModel: "mock",
        maxRetries: 0,
      }),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    modelClient: agentProvider.modelClient,
    warnings: agentProvider.warnings,
  };
}

function createExperienceExtractor(input: {
  mode: "deterministic" | "llm";
}): {
  extractor: ExperienceExtractor;
  warnings: string[];
} {
  if (input.mode === "deterministic") {
    return {
      extractor: new DeterministicExperienceExtractor(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    extractor: new LLMExperienceExtractor({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

function createArtifactGenerator(input: {
  mode: "deterministic" | "llm";
}): {
  generator: ArtifactGenerator;
  warnings: string[];
} {
  if (input.mode === "deterministic") {
    return {
      generator: new DeterministicArtifactGenerator(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    generator: new LLMArtifactGenerator({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

function createArtifactCritic(input: {
  mode: "deterministic" | "llm";
}): {
  critic: ArtifactCritic;
  warnings: string[];
} {
  if (input.mode === "deterministic") {
    return {
      critic: new DeterministicArtifactCritic(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    critic: new LLMArtifactCritic({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

function createArtifactRevisionAgent(input: {
  mode: "deterministic" | "llm";
}): {
  agent: ArtifactRevisionAgent;
  warnings: string[];
} {
  if (input.mode === "deterministic") {
    return {
      agent: new DeterministicArtifactRevisionAgent(),
      warnings: [],
    };
  }

  const agentProvider = AgentProviderFactory.create(AgentProviderFactory.fromEnv());
  return {
    agent: new LLMArtifactRevisionAgent({
      modelClient: agentProvider.modelClient,
    }),
    warnings: agentProvider.warnings,
  };
}

function uniqueWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

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
