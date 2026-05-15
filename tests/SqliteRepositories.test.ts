import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteDatabase,
  SqliteEvidenceRepository,
  SqliteExperienceRepository,
  SqliteGeneratedArtifactRepository,
  SqliteJDRequirementRepository,
  SqliteSkillRepository,
} from "../src/persistence/sqlite/index.js";
import type { Evidence, Experience, GeneratedArtifact, JDRequirement, Skill } from "../src/knowledge/types.js";

const dbPath = join(process.cwd(), ".tmp", "sqlite-repositories.test.sqlite");
const now = "2024-01-01T00:00:00Z";

afterEach(() => {
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
});

describe("SQLite repositories", () => {
  it("saves and reloads core knowledge records from SQLite", async () => {
    const database = await SqliteDatabase.create({ filePath: dbPath });
    const experiences = new SqliteExperienceRepository(database);
    const evidences = new SqliteEvidenceRepository(database);
    const skills = new SqliteSkillRepository(database);
    const requirements = new SqliteJDRequirementRepository(database);
    const artifacts = new SqliteGeneratedArtifactRepository(database);

    const experience: Experience = {
      id: "exp-1",
      userId: "user-1",
      type: "work",
      organization: "Acme",
      role: "Frontend Engineer",
      summary: "Built React systems.",
      timeRange: { startDate: null, endDate: null },
      star: { situation: "s", task: "t", action: "a", result: "r" },
      evidenceIds: ["ev-1"],
      skillIds: ["skill-1"],
      confidence: 0.8,
      createdAt: now,
      updatedAt: now,
    };
    const evidence: Evidence = {
      id: "ev-1",
      userId: "user-1",
      experienceId: "exp-1",
      sourceType: "resume",
      evidenceType: "project",
      sourceRef: "resume.md",
      excerpt: "Built React systems.",
      confidence: 0.9,
      createdAt: now,
    };
    const skill: Skill = {
      id: "skill-1",
      userId: "user-1",
      name: "React",
      category: "technical",
      evidenceIds: ["ev-1"],
      createdAt: now,
      updatedAt: now,
    };
    const requirement: JDRequirement = {
      id: "req-1",
      userId: "user-1",
      jdId: "jd-1",
      description: "React",
      requiredSkillIds: ["skill-1"],
      weight: 1,
      createdAt: now,
    };
    const artifact: GeneratedArtifact = {
      id: "artifact-1",
      userId: "user-1",
      type: "resume_bullet",
      content: "Built React systems.",
      sourceExperienceIds: ["exp-1"],
      sourceEvidenceIds: ["ev-1"],
      matchedSkillIds: ["skill-1"],
      targetJDId: "jd-1",
      targetRequirementIds: ["req-1"],
      targetRole: "Frontend Engineer",
      scores: { overall: 0.8, requirementMatch: 0.8, evidenceStrength: 0.9 },
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };

    await experiences.save(experience);
    await evidences.save(evidence);
    await skills.save(skill);
    await requirements.save(requirement);
    await artifacts.save(artifact);
    database.close();

    const reopened = await SqliteDatabase.create({ filePath: dbPath });
    const reopenedExperiences = new SqliteExperienceRepository(reopened);
    const reopenedEvidences = new SqliteEvidenceRepository(reopened);
    const reopenedSkills = new SqliteSkillRepository(reopened);
    const reopenedRequirements = new SqliteJDRequirementRepository(reopened);
    const reopenedArtifacts = new SqliteGeneratedArtifactRepository(reopened);

    expect(await reopenedExperiences.getById("exp-1")).toEqual(experience);
    expect(await reopenedEvidences.getByExperienceId("exp-1")).toEqual([evidence]);
    expect(await reopenedSkills.findByName("user-1", "react")).toEqual(skill);
    expect(await reopenedRequirements.listByJDId("user-1", "jd-1")).toEqual([requirement]);
    expect(await reopenedArtifacts.getByExperienceId("exp-1")).toEqual([artifact]);
    reopened.close();
  });
});
