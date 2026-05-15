import { describe, expect, it } from "vitest";
import { runAgentKernelDemo } from "../src/examples/agent-kernel-demo.js";

describe("agent kernel demo", () => {
  it("runs the FrontDesk document ingest and generation flow", async () => {
    const result = await runAgentKernelDemo() as {
      ingest: {
        decision: { intent: string };
        extractedDocument: { textLength: number };
        experience: unknown;
      };
      generation: {
        artifacts: unknown[];
        evidenceChains: unknown[];
        graphViews: unknown[];
      };
      sqlite: {
        experiences: number;
        evidences: number;
        skills: number;
        artifacts: number;
      };
    };

    expect(result.ingest.decision.intent).toBe("ingest_resume_document");
    expect(result.ingest.extractedDocument.textLength).toBeGreaterThan(0);
    expect(result.ingest.experience).toBeTruthy();
    expect(result.generation.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(result.generation.evidenceChains.length).toBe(result.generation.artifacts.length);
    expect(result.generation.graphViews.length).toBe(result.generation.artifacts.length);
    expect(result.sqlite.experiences).toBeGreaterThan(0);
    expect(result.sqlite.evidences).toBeGreaterThan(0);
    expect(result.sqlite.skills).toBeGreaterThan(0);
    expect(result.sqlite.artifacts).toBeGreaterThanOrEqual(3);
  });
});
