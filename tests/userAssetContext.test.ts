import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetMentionResolver } from "../src/copilot/context/AssetMentionResolver.js";
import { isCanonicalExperienceId, isCanonicalJDId, isCanonicalResumeId, sanitizeOrRejectExperienceId, guardExperienceId } from "../src/copilot/context/IdGuards.js";
import type { UserAssetContext } from "../src/copilot/context/UserAssetContext.js";

function makeContext(experiences: UserAssetContext["experiences"] = []): UserAssetContext {
  return {
    experiences,
    jds: [],
    resumes: [],
    generations: [],
    drafts: [],
    active: {},
    counts: { experiences: experiences.length, jds: 0, resumes: 0, generations: 0, drafts: 0 },
    retrievalPolicy: { mode: "manifest_only", maxItemsPerType: 20, maxSummaryChars: 160 },
  };
}

const weexExp = { id: "pexp-550e8400-e29b-41d4-a716-446655440000", type: "experience" as const, title: "WEEX国际交易所有限公司 数据分析实习生", organization: "WEEX", role: "数据分析实习生", tags: ["SQL", "Power BI"], summary: "在WEEX做数据分析实习" };
const gtaExp = { id: "pexp-660e8400-e29b-41d4-a716-446655440001", type: "experience" as const, title: "GTA 项目经历", organization: "GTA", role: "开发", tags: ["React"] };
const anotherWeexExp = { id: "pexp-770e8400-e29b-41d4-a716-446655440002", type: "experience" as const, title: "WEEX 另一个项目", organization: "WEEX", role: "项目经理", tags: ["管理"] };

const weexJD = { id: "pjd-550e8400-e29b-41d4-a716-446655440000", type: "jd" as const, title: "机器人方向实习生", company: "国金证券", targetRole: "机器人方向实习生", summary: "机器人方向实习生 JD" };

describe("AssetMentionResolver", () => {
  const resolver = new AssetMentionResolver();

  it("unique match by organization keyword", () => {
    const result = resolver.matchExperience("weex", makeContext([weexExp, gtaExp]));
    expect(result.status).toBe("unique");
    expect(result.match?.id).toBe("pexp-550e8400-e29b-41d4-a716-446655440000");
  });

  it("unique match by title includes", () => {
    const result = resolver.matchExperience("WEEX国际交易", makeContext([weexExp, gtaExp]));
    expect(result.status).toBe("unique");
    expect(result.match?.id).toBe("pexp-550e8400-e29b-41d4-a716-446655440000");
  });

  it("unique match by role", () => {
    const result = resolver.matchExperience("数据分析实习生", makeContext([weexExp, gtaExp]));
    expect(result.status).toBe("unique");
    expect(result.match?.id).toBe("pexp-550e8400-e29b-41d4-a716-446655440000");
  });

  it("unique match by tag", () => {
    const result = resolver.matchExperience("SQL", makeContext([weexExp, gtaExp]));
    expect(result.status).toBe("unique");
  });

  it("multiple candidates when ambiguous", () => {
    const result = resolver.matchExperience("weex", makeContext([weexExp, anotherWeexExp, gtaExp]));
    expect(result.status).toBe("multiple");
    expect(result.candidates?.length).toBeGreaterThanOrEqual(2);
  });

  it("no match", () => {
    const result = resolver.matchExperience("tencent", makeContext([weexExp, gtaExp]));
    expect(result.status).toBe("none");
  });

  it("empty context returns none", () => {
    const result = resolver.matchExperience("anything", makeContext([]));
    expect(result.status).toBe("none");
  });

  it("JD matching by company", () => {
    const ctx = makeContext([]);
    ctx.jds = [weexJD];
    const result = resolver.matchJD("国金证券", ctx);
    expect(result.status).toBe("unique");
    expect(result.match?.id).toBe("pjd-550e8400-e29b-41d4-a716-446655440000");
  });

  it("JD matching by targetRole", () => {
    const ctx = makeContext([]);
    ctx.jds = [weexJD];
    const result = resolver.matchJD("机器人方向", ctx);
    expect(result.status).toBe("unique");
  });
});

describe("IdGuards", () => {
  it("validates canonical experience IDs", () => {
    expect(isCanonicalExperienceId("pexp-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects natural language keywords", () => {
    expect(isCanonicalExperienceId("weex")).toBe(false);
    expect(isCanonicalExperienceId("那条经历")).toBe(false);
    expect(isCanonicalExperienceId("")).toBe(false);
    expect(isCanonicalExperienceId(undefined)).toBe(false);
  });

  it("rejects IDs with wrong prefix", () => {
    expect(isCanonicalExperienceId("pjd-550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("sanitizeOrRejectExperienceId returns undefined for non-canonical", () => {
    expect(sanitizeOrRejectExperienceId("weex")).toBeUndefined();
    expect(sanitizeOrRejectExperienceId("pexp-550e8400-e29b-41d4-a716-446655440000")).toBe("pexp-550e8400-e29b-41d4-a716-446655440000");
  });

  it("guardExperienceId returns reason for non-canonical", () => {
    const result = guardExperienceId("weex");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBeTruthy();
    }
  });

  it("validates JD IDs", () => {
    expect(isCanonicalJDId("pjd-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isCanonicalJDId("wex")).toBe(false);
  });

  it("validates resume IDs", () => {
    expect(isCanonicalResumeId("pres-550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isCanonicalResumeId("weex")).toBe(false);
  });
});

describe("experience-receiver prompt", () => {
  const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/agent-core/prompts/prompts/experience-receiver.md");
  const prompt = readFileSync(promptPath, "utf-8");

  it("references UserAssetContext", () => {
    expect(prompt).toContain("UserAssetContext");
  });

  it("tells agent to check active.experienceId first", () => {
    expect(prompt).toContain("active.experienceId");
  });

  it("forbids natural language as experienceId", () => {
    expect(prompt).toContain('experienceId: "weex"');
  });

  it("routes to search_experiences when manifest ambiguous", () => {
    expect(prompt).toContain("search_experiences");
  });

  it("routes to ask_clarification when no match", () => {
    expect(prompt).toContain("ask_clarification");
  });
});

describe("frontdesk prompt", () => {
  const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/agent-core/prompts/prompts/frontdesk.md");
  const prompt = readFileSync(promptPath, "utf-8");

  it("references UserAssetContext", () => {
    expect(prompt).toContain("UserAssetContext");
  });

  it("has example with weex matching to real experienceId", () => {
    expect(prompt).toContain("优化一下我 weex 那条经历");
    expect(prompt).toContain('"experienceId": "pexp-xxx"');
  });

  it("forbids natural language as id", () => {
    expect(prompt).toContain('experienceId: "weex"');
  });

  it("prefers userAssetContext.active for current asset", () => {
    expect(prompt).toContain("userAssetContext.active");
  });
});
