import { describe, expect, it } from "vitest";
import { FrontDeskAgent } from "../src/agents/FrontDeskAgent.js";
import { FrontDeskOrchestrator } from "../src/application/frontdesk/index.js";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
  type ExperienceExtractor,
} from "../src/knowledge/index.js";
import { MockProvider } from "../src/providers/MockProvider.js";
import { DocumentLoaderTool } from "../src/tools/document/index.js";

function createOrchestrator(extractor?: ExperienceExtractor): FrontDeskOrchestrator {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();
  const frontDeskAgent = new FrontDeskAgent({
    modelClient: new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock",
      maxRetries: 0,
    }),
  });
  const ingestionService = new ExperienceIngestionService(
    experienceRepo,
    evidenceRepo,
    skillRepo,
    extractor,
  );
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

  return new FrontDeskOrchestrator(
    frontDeskAgent,
    new DocumentLoaderTool(),
    ingestionService,
    resumeGenerationService,
  );
}

describe("FrontDeskOrchestrator", () => {
  it("ingests an attached markdown document into experience, evidence, and skills", async () => {
    const orchestrator = createOrchestrator();

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Import this resume.",
      documents: [{
        userId: "user-1",
        fileName: "resume.md",
        mimeType: "text/markdown",
        sourceRef: "upload:resume.md",
        buffer: new TextEncoder().encode([
          "# Resume",
          "As a Senior Frontend Engineer at Acme Corp, I led a React design system project for 12 teams.",
          "Reduced bundle size by 40%.",
        ].join("\n")),
      }],
    });

    expect(response.decision.intent).toBe("ingest_resume_document");
    expect(response.extractedDocument?.sourceType).toBe("markdown");
    expect(response.experience?.organization).toBe("Acme Corp");
    expect(response.evidences?.length).toBeGreaterThan(0);
    expect(response.skills?.map((skill) => skill.name)).toContain("React");
    expect(response.warnings).toEqual([]);
  });

  it("returns all experiences from a single ingested document", async () => {
    const extractor: ExperienceExtractor = {
      async extract() {
        return {
          experiences: [
            {
              type: "project",
              organization: "Acme Corp",
              role: "Frontend Engineer",
              summary: "Built a React dashboard.",
              evidenceExcerpts: ["Built a React dashboard."],
              skillNames: [{ name: "React", category: "technical" }],
            },
            {
              type: "project",
              organization: "Beta Inc",
              role: "Data Engineer",
              summary: "Automated PostgreSQL reports.",
              evidenceExcerpts: ["Automated PostgreSQL reports."],
              skillNames: [{ name: "PostgreSQL", category: "technical" }],
            },
          ],
          warnings: [],
        };
      },
    };
    const orchestrator = createOrchestrator(extractor);

    const response = await orchestrator.handle({
      userId: "user-1",
      message: "Import this resume.",
      documents: [{
        userId: "user-1",
        fileName: "resume.md",
        mimeType: "text/markdown",
        sourceRef: "upload:resume.md",
        buffer: new TextEncoder().encode("Resume text."),
      }],
    });

    expect(response.extractedDocuments).toHaveLength(1);
    expect(response.experiences).toHaveLength(2);
    expect(response.experience).toBe(response.experiences?.[0]);
    expect(response.documentIngestionResults?.[0]?.experiences).toHaveLength(2);
  });
});
