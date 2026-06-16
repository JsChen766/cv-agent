import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../src/agent-core/evidence/EvidenceBundle.js";
import type { EvidenceItem } from "../src/agent-core/evidence/EvidenceItem.js";
import { EvidenceNormalizer } from "../src/agent-core/evidence/EvidenceNormalizer.js";
import { NoopRetrievalProvider } from "../src/agent-core/retrieval/NoopRetrievalProvider.js";
import type { RetrievalQuery } from "../src/agent-core/retrieval/RetrievalQuery.js";
import type { RetrievalResult } from "../src/agent-core/retrieval/RetrievalResult.js";

describe("retrieval and evidence internal interfaces", () => {
  it("NoopRetrievalProvider advertises no supported scopes and returns no results", async () => {
    const provider = new NoopRetrievalProvider();
    const query: RetrievalQuery = {
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      query: "React TypeScript performance",
      scopes: ["experience", "jd"],
      limit: 5,
    };

    expect(provider.id).toBe("core.noop.retrieval");
    expect(provider.supports("experience")).toBe(false);
    await expect(provider.retrieve(query)).resolves.toEqual([]);
  });

  it("RetrievalResult can carry EvidenceItem references without changing tool contracts", () => {
    const evidence: EvidenceItem = {
      id: "evidence-1",
      sourceType: "experience",
      sourceId: "pexp-1",
      text: "Reduced page load time by 40%.",
      confidence: 0.8,
      usage: "support",
    };
    const result: RetrievalResult = {
      id: "retrieval-1",
      scope: "experience",
      sourceId: "pexp-1",
      title: "Frontend performance project",
      text: "React TypeScript performance optimization.",
      score: 0.92,
      evidence: [evidence],
    };

    expect(result.evidence?.[0]).toMatchObject({
      id: "evidence-1",
      sourceType: "experience",
      usage: "support",
    });
  });

  it("EvidenceNormalizer preserves bundle fields while copying arrays", () => {
    const normalizer = new EvidenceNormalizer();
    const item: EvidenceItem = {
      id: "evidence-2",
      sourceType: "jd",
      usage: "missing",
    };
    const bundle: EvidenceBundle = {
      items: [item],
      summary: "One missing JD signal.",
      missing: ["metric"],
      risks: ["unsupported claim"],
    };

    const normalized = normalizer.normalize(bundle);

    expect(normalized).toEqual(bundle);
    expect(normalized).not.toBe(bundle);
    expect(normalized.items).not.toBe(bundle.items);
    expect(normalizer.normalize(undefined)).toEqual({ items: [] });
    expect(normalizer.normalize([item])).toEqual({ items: [item] });
  });
});
