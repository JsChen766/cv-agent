import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { FrontDeskOrchestrator } from "../application/frontdesk/index.js";
import { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../application/generators/DeterministicArtifactGenerator.js";
import { ModelClient } from "../core/model/ModelClient.js";
import { ExperienceIngestionService, KeywordExperienceRetriever } from "../knowledge/index.js";
import { MockProvider } from "../providers/MockProvider.js";
import {
  SqliteDatabase,
  SqliteEvidenceRepository,
  SqliteExperienceRepository,
  SqliteGeneratedArtifactRepository,
  SqliteJDRequirementRepository,
  SqliteSkillRepository,
} from "../persistence/sqlite/index.js";
import { DocumentLoaderTool } from "../tools/document/index.js";

export async function runAgentKernelDemo(): Promise<unknown> {
  const database = await SqliteDatabase.create({
    filePath: join(process.cwd(), ".tmp", "agent-kernel-demo.sqlite"),
  });
  const experienceRepo = new SqliteExperienceRepository(database);
  const evidenceRepo = new SqliteEvidenceRepository(database);
  const skillRepo = new SqliteSkillRepository(database);
  const requirementRepo = new SqliteJDRequirementRepository(database);
  const artifactRepo = new SqliteGeneratedArtifactRepository(database);

  const modelClient = new ModelClient({
    provider: new MockProvider(),
    defaultModel: "mock-frontdesk",
    maxRetries: 0,
  });
  const frontDeskAgent = new FrontDeskAgent({ modelClient });
  const documentLoader = new DocumentLoaderTool();
  const ingestionService = new ExperienceIngestionService(experienceRepo, evidenceRepo, skillRepo);
  const retriever = new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo);
  const resumeGenerationService = new ResumeGenerationService({
    requirementExtractor: new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
    artifactGenerator: new DeterministicArtifactGenerator(),
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    retriever,
  });
  const orchestrator = new FrontDeskOrchestrator(
    frontDeskAgent,
    documentLoader,
    ingestionService,
    resumeGenerationService,
  );

  const userId = `agent-kernel-demo-user-${Date.now()}`;
  const resumeMarkdown = [
    "---",
    "title: Demo resume",
    "---",
    "# Senior Frontend Engineer",
    "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
    "Built an accessible component library with WCAG practices and shared API integration patterns.",
    "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
  ].join("\n");

  const ingestResponse = await orchestrator.handle({
    userId,
    message: "Please import this resume document.",
    documents: [{
      userId,
      fileName: "resume.md",
      mimeType: "text/markdown",
      extension: "md",
      sourceRef: "demo:resume.md",
      buffer: new TextEncoder().encode(resumeMarkdown),
      metadata: { demo: true },
    }],
  });

  const jdText = [
    "We need a frontend engineer with expert React and TypeScript experience.",
    "The role owns design system architecture, accessibility, API integration, and performance optimization with measurable impact.",
  ].join(" ");

  const generationResponse = await orchestrator.handle({
    userId,
    message: "Generate resume bullets for this JD.",
    jdText,
    targetRole: "Senior Frontend Engineer",
  });

  const summary = {
    ingest: {
      decision: ingestResponse.decision,
      extractedDocument: ingestResponse.extractedDocument && {
        documentId: ingestResponse.extractedDocument.documentId,
        sourceType: ingestResponse.extractedDocument.sourceType,
        textPreview: ingestResponse.extractedDocument.textPreview,
        textLength: ingestResponse.extractedDocument.textLength,
        metadata: ingestResponse.extractedDocument.metadata,
      },
      experience: ingestResponse.experience,
      evidences: ingestResponse.evidences,
      skills: ingestResponse.skills,
      warnings: ingestResponse.warnings,
    },
    generation: {
      decision: generationResponse.decision,
      artifacts: generationResponse.artifacts,
      evidenceChains: generationResponse.evidenceChains,
      graphViews: generationResponse.graphViews,
      coverageReport: generationResponse.coverageReport,
      coverageGapReport: generationResponse.coverageGapReport,
      critiqueReport: generationResponse.critiqueReport,
      warnings: generationResponse.warnings,
    },
    sqlite: {
      experiences: (await experienceRepo.listByUserId(userId)).length,
      evidences: (await evidenceRepo.listByUserId(userId)).length,
      skills: (await skillRepo.listByUserId(userId)).length,
      artifacts: (await artifactRepo.listByUserId(userId)).length,
    },
  };

  database.close();
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runAgentKernelDemo(), null, 2));
}
