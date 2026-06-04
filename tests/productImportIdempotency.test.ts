import { describe, expect, it } from "vitest";
import {
  ExperienceService,
  ImportService,
  ProductStateConflictError,
} from "../src/product/services/index.js";
import {
  InMemoryProductExperienceRepository,
  InMemoryProductImportRepository,
} from "../src/product/repositories/index.js";

describe("product import candidate acceptance", () => {
  it("does not create a duplicate experience when an accepted candidate is accepted again", async () => {
    const experienceRepository = new InMemoryProductExperienceRepository();
    const importRepository = new InMemoryProductImportRepository();
    const experienceService = new ExperienceService(experienceRepository);
    const importService = new ImportService(importRepository, experienceService);
    const now = new Date().toISOString();
    await importRepository.createImportJob({
      id: "pimp-test",
      userId: "user-1",
      sourceType: "text",
      status: "candidates_ready",
      rawText: "Built analytics dashboard.",
      createdAt: now,
      updatedAt: now,
    });
    const candidate = await importRepository.createImportCandidate({
      id: "pimpcand-test",
      jobId: "pimp-test",
      userId: "user-1",
      title: "Analytics dashboard",
      category: "project",
      content: "Built analytics dashboard.",
      structured: { rawText: "Built analytics dashboard." },
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const accepted = await importService.acceptCandidate("user-1", candidate.id);
    expect(accepted.candidate.status).toBe("accepted");
    await expect(importService.acceptCandidate("user-1", candidate.id)).resolves.toEqual(accepted);
    expect(await experienceService.listExperiences("user-1")).toHaveLength(1);
  });

  it("rejects candidates that are no longer pending", async () => {
    const experienceRepository = new InMemoryProductExperienceRepository();
    const importRepository = new InMemoryProductImportRepository();
    const experienceService = new ExperienceService(experienceRepository);
    const importService = new ImportService(importRepository, experienceService);
    const now = new Date().toISOString();
    await importRepository.createImportCandidate({
      id: "pimpcand-rejected",
      jobId: "pimp-test",
      userId: "user-1",
      title: "Rejected",
      category: "work",
      content: "Rejected content.",
      status: "rejected",
      createdAt: now,
      updatedAt: now,
    });

    await expect(importService.acceptCandidate("user-1", "pimpcand-rejected")).rejects.toBeInstanceOf(ProductStateConflictError);
    expect(await experienceService.listExperiences("user-1")).toHaveLength(0);
  });
});
