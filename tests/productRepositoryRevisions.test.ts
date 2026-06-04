import { describe, expect, it } from "vitest";
import { InMemoryProductExperienceRepository } from "../src/product/repositories/index.js";
import type { ProductExperienceRevision } from "../src/product/types.js";

function makeRevision(overrides: Partial<ProductExperienceRevision> = {}): ProductExperienceRevision {
  return {
    id: overrides.id ?? "rev-1",
    userId: overrides.userId ?? "user-1",
    experienceId: overrides.experienceId ?? "exp-1",
    content: overrides.content ?? "Test content",
    source: overrides.source ?? "manual",
    structured: overrides.structured,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe("InMemoryProductExperienceRepository — listRevisionsByExperienceIds", () => {
  it("returns empty array for empty input", async () => {
    const repo = new InMemoryProductExperienceRepository();
    const result = await repo.listRevisionsByExperienceIds("user-1", []);
    expect(result).toEqual([]);
  });

  it("returns revisions for matching experience ids", async () => {
    const repo = new InMemoryProductExperienceRepository();
    await repo.createRevision(makeRevision({ id: "rev-a", experienceId: "exp-a", content: "Content A" }));
    await repo.createRevision(makeRevision({ id: "rev-b", experienceId: "exp-b", content: "Content B" }));

    const result = await repo.listRevisionsByExperienceIds("user-1", ["exp-a", "exp-b"]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["rev-a", "rev-b"]);
  });

  it("returns empty when none of the ids match", async () => {
    const repo = new InMemoryProductExperienceRepository();
    await repo.createRevision(makeRevision({ id: "rev-a", experienceId: "exp-a" }));

    const result = await repo.listRevisionsByExperienceIds("user-1", ["exp-nonexistent"]);
    expect(result).toEqual([]);
  });

  it("deduplicates repeated experience ids without duplicating results", async () => {
    const repo = new InMemoryProductExperienceRepository();
    await repo.createRevision(makeRevision({ id: "rev-a", experienceId: "exp-a" }));

    const result = await repo.listRevisionsByExperienceIds("user-1", ["exp-a", "exp-a"]);
    expect(result).toHaveLength(1);
  });

  it("returns multiple revisions for a single experience id", async () => {
    const repo = new InMemoryProductExperienceRepository();
    await repo.createRevision(makeRevision({ id: "rev-1", experienceId: "exp-a", content: "v1" }));
    await repo.createRevision(makeRevision({ id: "rev-2", experienceId: "exp-a", content: "v2" }));

    const result = await repo.listRevisionsByExperienceIds("user-1", ["exp-a"]);
    expect(result).toHaveLength(2);
  });

  it("scopes by userId and does not leak across users", async () => {
    const repo = new InMemoryProductExperienceRepository();
    await repo.createRevision(makeRevision({ id: "rev-a", experienceId: "exp-a", userId: "user-1" }));

    const result = await repo.listRevisionsByExperienceIds("user-2", ["exp-a"]);
    expect(result).toEqual([]);
  });
});
