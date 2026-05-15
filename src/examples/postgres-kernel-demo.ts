import { fileURLToPath } from "node:url";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { DocumentIngestionService } from "../application/documents/index.js";
import { DeterministicJDRequirementExtractor } from "../application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../application/generators/DeterministicArtifactGenerator.js";
import { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import { ModelClient } from "../core/model/ModelClient.js";
import { ExperienceIngestionService, KeywordExperienceRetriever } from "../knowledge/index.js";
import { MockProvider } from "../providers/MockProvider.js";
import {
  PostgresDatabase,
  PostgresDocumentRepository,
  PostgresEvidenceRepository,
  PostgresExperienceRepository,
  PostgresGeneratedArtifactRepository,
  createPostgresGenerationPersistenceService,
  PostgresJDRequirementRepository,
  PostgresSkillRepository,
} from "../persistence/postgres/index.js";
import { DocumentLoaderTool } from "../tools/document/index.js";

export async function runPostgresKernelDemo(): Promise<unknown> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      skipped: true,
      reason: "Set DATABASE_URL to run the PostgreSQL kernel demo.",
      command: "DATABASE_URL=postgres://user:pass@localhost:5432/cv_agent npm run dev:postgres-kernel",
    };
  }

  const database = new PostgresDatabase({ connectionString: databaseUrl });
  try {
    await database.initializeSchema();

    const documentRepo = new PostgresDocumentRepository(database);
    const experienceRepo = new PostgresExperienceRepository(database);
    const evidenceRepo = new PostgresEvidenceRepository(database);
    const skillRepo = new PostgresSkillRepository(database);
    const requirementRepo = new PostgresJDRequirementRepository(database);
    const artifactRepo = new PostgresGeneratedArtifactRepository(database);
    const generationPersistenceService = createPostgresGenerationPersistenceService(database);

    const documentLoader = new DocumentLoaderTool();
    const documentIngestionService = new DocumentIngestionService(documentLoader, documentRepo);
    const ingestionService = new ExperienceIngestionService(experienceRepo, evidenceRepo, skillRepo);
    const retriever = new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo);
    const resumeGenerationService = new ResumeGenerationService(
      new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
      new DeterministicArtifactGenerator(),
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever,
    );
    const modelClient = new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock-frontdesk",
      maxRetries: 0,
    });
    const frontDeskAgent = new FrontDeskAgent({ modelClient });

    const userId = `postgres-kernel-demo-user-${Date.now()}`;
    const resumeMarkdown = [
      "# Senior Frontend Engineer",
      "At Acme Corp, I led a React and TypeScript design system used by 12 product teams.",
      "Improved accessibility coverage and reduced bundle size by 40% through performance work.",
    ].join("\n");

    const decision = await frontDeskAgent.decide({
      userId,
      message: "Please import this resume document.",
      hasDocument: true,
      documentFileNames: ["resume.md"],
    });

    const extractedDocument = await documentIngestionService.ingest({
      userId,
      fileName: "resume.md",
      mimeType: "text/markdown",
      extension: "md",
      sourceRef: "postgres-demo:resume.md",
      buffer: new TextEncoder().encode(resumeMarkdown),
      metadata: { demo: true },
    });

    const ingestResult = await ingestionService.ingest({
      userId,
      rawText: extractedDocument.text,
      sourceRef: extractedDocument.sourceRef,
      sourceType: "resume",
      sourceDocumentId: extractedDocument.documentId,
    });

    const jdText = [
      "We need a frontend engineer with React, TypeScript, accessibility, design system, API integration, and performance experience.",
      "Candidates should show measurable product impact.",
    ].join(" ");

    const generationResult = await resumeGenerationService.generate({
      userId,
      jdText,
      targetRole: "Senior Frontend Engineer",
    });
    const persistedGeneration = await generationPersistenceService.persist(generationResult, {
      demo: true,
    });

    return {
      decision,
      document: {
        id: extractedDocument.documentId,
        sourceType: extractedDocument.sourceType,
        textPreview: extractedDocument.textPreview,
        textLength: extractedDocument.textLength,
      },
      ingest: {
        experienceId: ingestResult.experience.id,
        sourceDocumentId: ingestResult.experience.sourceDocumentId,
        evidenceCount: ingestResult.evidences.length,
        firstEvidenceSourceDocumentId: ingestResult.evidences[0]?.sourceDocumentId,
        skillCount: ingestResult.skills.length,
      },
      generation: {
        sessionId: persistedGeneration.session.id,
        artifactCount: generationResult.artifacts.length,
        evidenceChainSnapshotCount: persistedGeneration.evidenceChainSnapshots.length,
        graphViewSnapshotCount: persistedGeneration.graphViewSnapshots.length,
        bundleCount: persistedGeneration.bundles.length,
        coverageGapCount: generationResult.coverageGapReport.items.length,
      },
      postgres: {
        documents: (await documentRepo.listByUserId(userId)).length,
        experiences: (await experienceRepo.listByUserId(userId)).length,
        evidences: (await evidenceRepo.listByUserId(userId)).length,
        skills: (await skillRepo.listByUserId(userId)).length,
        artifacts: (await artifactRepo.listByUserId(userId)).length,
        sessions: 1,
        bundles: persistedGeneration.bundles.length,
      },
    };
  } finally {
    await database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runPostgresKernelDemo(), null, 2));
}
