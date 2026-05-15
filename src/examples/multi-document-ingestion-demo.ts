import { fileURLToPath } from "node:url";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { DeterministicJDRequirementExtractor } from "../application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../application/generators/DeterministicArtifactGenerator.js";
import { FrontDeskOrchestrator } from "../application/frontdesk/index.js";
import { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import { ModelClient } from "../core/model/ModelClient.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../knowledge/index.js";
import { MockProvider } from "../providers/MockProvider.js";
import { DocumentLoaderTool } from "../tools/document/index.js";

export async function runMultiDocumentIngestionDemo(): Promise<unknown> {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();
  const frontDeskAgent = new FrontDeskAgent({
    modelClient: new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock-frontdesk",
      maxRetries: 0,
    }),
  });
  const ingestionService = new ExperienceIngestionService(experienceRepo, evidenceRepo, skillRepo);
  const resumeGenerationService = new ResumeGenerationService(
    new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
    new DeterministicArtifactGenerator(),
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo),
  );
  const orchestrator = new FrontDeskOrchestrator(
    frontDeskAgent,
    new DocumentLoaderTool(),
    ingestionService,
    resumeGenerationService,
  );

  const userId = `multi-document-demo-user-${Date.now()}`;
  const response = await orchestrator.handle({
    userId,
    message: "Import these resume documents.",
    documents: [
      {
        userId,
        fileName: "resume.md",
        mimeType: "text/markdown",
        extension: "md",
        sourceRef: "demo:resume.md",
        buffer: new TextEncoder().encode([
          "# Resume",
          "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system for 12 teams.",
          "Reduced bundle size by 40% through performance optimization.",
        ].join("\n")),
      },
      {
        userId,
        fileName: "project-note.txt",
        mimeType: "text/plain",
        extension: "txt",
        sourceRef: "demo:project-note.txt",
        buffer: new TextEncoder().encode(
          "Built an accessible component library with WCAG practices and shared API integration patterns.",
        ),
      },
    ],
  });

  return {
    decision: response.decision.intent,
    extractedDocumentCount: response.extractedDocuments?.length ?? 0,
    experienceCount: response.experiences?.length ?? 0,
    evidenceCount: response.evidences?.length ?? 0,
    skillCount: response.skills?.length ?? 0,
    sourceDocumentIds: response.extractedDocuments?.map((document) => document.documentId) ?? [],
    warnings: response.warnings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runMultiDocumentIngestionDemo(), null, 2));
}
