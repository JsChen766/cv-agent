import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMProvider,
} from "../src/agent-core/model/types.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { composeCareerTextTool } from "../src/agent-tools/writing/composeCareerText.tool.js";
import type { EvidencePack } from "../src/rag/evidence/types.js";
import type { InstructionPack } from "../src/rag/guideline/types.js";
import type { PersonalizationPack } from "../src/self-evolution/preference/types.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

class StubLLM implements LLMProvider {
  public readonly name = "stub-phase4";
  public lastUserPrompt = "";
  public lastSystemPrompt = "";
  public callCount = 0;

  public constructor(private readonly responder: (req: LLMChatRequest) => Record<string, unknown>) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.callCount += 1;
    this.lastSystemPrompt = request.messages.find((m) => m.role === "system")?.content ?? "";
    this.lastUserPrompt = request.messages.find((m) => m.role === "user")?.content ?? "";
    return { content: JSON.stringify(this.responder(request)) };
  }
}

async function seedExperience(kernel: Awaited<ReturnType<typeof createP12Kernel>>) {
  const created = await kernel.productServices.experienceService.createExperience("user-1", {
    title: "WEEX data analyst internship",
    organization: "WEEX exchange",
    role: "Data Analyst Intern",
    content: "At WEEX, used SQL and Power BI to build growth dashboards, track user funnel metrics, and support A/B experiment design.",
    tags: ["SQL", "Power BI", "analytics", "A/B"],
    category: "work",
    startDate: "2026-01",
    endDate: "2026-04",
  });
  return created.experience;
}

function fakeEvidencePack(experienceId: string, extraClaims: EvidencePack["allowedClaims"] = []): EvidencePack {
  return {
    version: "evidence-rag-v5",
    jdRequirements: [{
      id: "req-1",
      text: "Use verified analytics evidence",
      category: "skill",
      importance: "high",
      evidenceType: "direct_match",
      retrievalPolicies: ["semantic_experience"],
      keywords: ["SQL", "Power BI"],
      coreTerms: ["analytics"],
      queryVariants: ["analytics evidence"],
      strictness: "balanced",
    }],
    matchedEvidence: [],
    allowedClaims: [
      {
        id: "claim-1",
        claim: "Built growth dashboards with SQL and Power BI.",
        requirementIds: ["req-1"],
        experienceId,
        evidenceText: "SQL and Power BI dashboard work",
        confidence: 0.91,
        riskLevel: "low",
      },
      ...extraClaims,
    ],
    missingRequirements: [],
    retrievalTrace: [],
    qualitySignals: [],
    graphLinks: [],
    usageTrace: [],
  };
}

function fakeInstructionPack(rules: string[]): InstructionPack {
  return {
    version: "guideline-rag-v2",
    targetPositioning: "Use safe writing guidance only.",
    roleFamily: "data",
    applicationType: "job",
    language: "en",
    priorityRequirements: [],
    sectionStrategy: {},
    writingRules: rules,
    negativeConstraints: [],
    hardConstraints: [],
    softPreferences: [],
    examplePatterns: [],
    retrievalTrace: [],
  };
}

function fakePersonalizationPack(): PersonalizationPack {
  return {
    version: "preference-bank-v1",
    context: { language: "en" },
    stablePreferences: [
      {
        preferenceId: "pref-style",
        dimension: "writing_style",
        instruction: "Use concise first-person tone.",
        strength: 1,
        confidence: 0.95,
        scope: { language: "en" },
      },
      {
        preferenceId: "pref-fact",
        dimension: "writing_style",
        instruction: "Claim 99% retention at \"Acme\".",
        strength: 1,
        confidence: 0.95,
        scope: { language: "en" },
      },
    ],
    contextualPreferences: [],
    negativePreferences: [],
    experienceAffinities: [],
    uncertainPreferences: [],
    retrievalTrace: [
      { preferenceId: "pref-style", dimension: "writing_style", score: 1, effectiveStrength: 1, scopeMatch: 1, sourceEventIds: [] },
      { preferenceId: "pref-fact", dimension: "writing_style", score: 1, effectiveStrength: 1, scopeMatch: 1, sourceEventIds: [] },
    ],
    diagnostics: {
      totalStored: 2,
      activeCandidates: 2,
      appliedCount: 2,
      staleCount: 0,
      warnings: [],
    },
  };
}

async function runCompose(input: {
  kernel: Awaited<ReturnType<typeof createP12Kernel>>;
  args: Record<string, unknown>;
  responder: (req: LLMChatRequest) => Record<string, unknown>;
  configureContext?: (context: AgentContext) => void;
}) {
  const stub = new StubLLM(input.responder);
  input.kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-phase4" });
  const registry = new ToolRegistry();
  registry.registerMany([composeCareerTextTool()]);
  const context = testContext(input.kernel, registry.list());
  input.configureContext?.(context);
  const executor = new ToolExecutor(registry, new AgentTraceRecorder());
  const result = await executor.execute("compose_career_text", input.args, context);
  return { result, stub };
}

describe("Phase 4 - compose_career_text RAG grounding", () => {
  it("uses EvidenceRAG for experience-grounded writing without a JD", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    let ragInput: { jdText: string } | undefined;
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async (input) => {
      ragInput = input;
      return fakeEvidencePack(exp.id);
    };

    const { result, stub } = await runCompose({
      kernel,
      args: {
        outputType: "self_intro",
        constraints: { language: "en" },
        userInstruction: "Write a self introduction based on my experiences.",
      },
      responder: () => ({
        status: "success",
        title: "Self intro",
        outputType: "self_intro",
        content: "I use SQL and Power BI to turn product funnel data into practical dashboards.",
        usedExperienceIds: [exp.id],
        usedEvidenceIds: [exp.id],
        groundingNotes: ["Used the WEEX dashboard evidence from " + exp.id],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(result.status).toBe("success");
    expect(ragInput?.jdText).toContain("WEEX");
    expect(stub.lastUserPrompt).toContain("Pre-vetted evidence claims");
    expect(stub.lastUserPrompt).toContain("Built growth dashboards");
    const data = result.data as Record<string, unknown>;
    expect(data.usedExperienceIds).toEqual([exp.id]);
    expect(data.groundingNotes).toEqual(expect.arrayContaining(["Used the WEEX dashboard evidence from " + exp.id]));
    expect((data.groundingDiagnostics as Record<string, { trigger?: string }>).evidenceRag.trigger).toBe("experience");
    expect(result.summaryFacts).toContain("Evidence RAG trigger: experience.");
    await kernel.close();
  });

  it("single-experience mode scopes evidence to the resolved experience", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async () =>
      fakeEvidencePack(exp.id, [{
        id: "claim-other",
        claim: "This unrelated claim must not enter the prompt.",
        requirementIds: ["req-1"],
        experienceId: "pexp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        evidenceText: "unrelated",
        confidence: 0.8,
        riskLevel: "low",
      }]);

    const { result, stub } = await runCompose({
      kernel,
      args: {
        outputType: "project_intro",
        experienceQuery: "WEEX",
        userInstruction: "Turn WEEX into an interview project intro.",
      },
      configureContext: (context) => {
        context.userAssetContext = {
          experiences: [{ id: exp.id, type: "experience", title: exp.title, organization: exp.organization, role: exp.role, tags: exp.tags ?? [] }],
          jds: [],
          resumes: [],
          generations: [],
          drafts: [],
          active: {},
          counts: { experiences: 1, jds: 0, resumes: 0, generations: 0, drafts: 0 },
          retrievalPolicy: { mode: "manifest_only", maxItemsPerType: 20, maxSummaryChars: 160 },
        };
      },
      responder: () => ({
        status: "success",
        title: "Project intro",
        outputType: "project_intro",
        content: "At WEEX, I built SQL and Power BI dashboards for funnel analysis.",
        usedExperienceIds: [exp.id],
        usedEvidenceIds: [exp.id],
        groundingNotes: ["Used single resolved experience " + exp.id],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(result.status).toBe("success");
    expect(stub.lastUserPrompt).toContain("Built growth dashboards");
    expect(stub.lastUserPrompt).not.toContain("unrelated claim");
    const data = result.data as Record<string, unknown>;
    expect(data.usedExperienceIds).toEqual([exp.id]);
    expect((data.groundingDiagnostics as Record<string, { trigger?: string }>).evidenceRag.trigger).toBe("experience");
    await kernel.close();
  });

  it("JD-grounded writing can use short JD text plus evidence without match matrix or variants", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    let ragInput: { jdText: string } | undefined;
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async (input) => {
      ragInput = input;
      return fakeEvidencePack(exp.id);
    };

    const { result } = await runCompose({
      kernel,
      args: {
        outputType: "self_intro",
        jdText: "Data analyst",
        userInstruction: "Write a JD-grounded intro.",
      },
      responder: () => ({
        status: "success",
        title: "JD intro",
        outputType: "self_intro",
        content: "I connect SQL dashboard work with data analyst priorities.",
        usedExperienceIds: [exp.id],
        usedEvidenceIds: [exp.id],
        groundingNotes: ["Used JD plus WEEX evidence"],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(ragInput?.jdText).toContain("Data analyst");
    expect(ragInput?.jdText.length ?? 0).toBeGreaterThan(40);
    const data = result.data as Record<string, unknown>;
    expect((data.groundingDiagnostics as Record<string, { trigger?: string }>).evidenceRag.trigger).toBe("jd");
    const json = JSON.stringify(result);
    expect(json).not.toContain("match_experiences_against_jd");
    expect(json).not.toContain("generate_resume_from_jd");
    expect(json).not.toContain("\"matchResults\"");
    expect(json).not.toContain("\"variants\"");
    await kernel.close();
  });

  it("GuidelineRAG affects style only and filters fact-bearing rules", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async () => fakeEvidencePack(exp.id);
    kernel.productServices.guidelineRAGService!.buildInstructionPack = async () =>
      fakeInstructionPack([
        "Use a concise STAR structure.",
        "Claim 30% growth for every dashboard.",
        "Borrow phrasing from \"Acme Trading\".",
      ]);

    const { result, stub } = await runCompose({
      kernel,
      args: {
        outputType: "project_intro",
        constraints: { tone: "concise", audience: "interviewer", format: "script", language: "en" },
        userInstruction: "Write a project intro.",
      },
      responder: () => ({
        status: "success",
        title: "Project intro",
        outputType: "project_intro",
        content: "I explain the dashboard project with a concise structure.",
        usedExperienceIds: [exp.id],
        groundingNotes: ["Used WEEX only"],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(stub.lastUserPrompt).toContain("Writing guidelines");
    expect(stub.lastUserPrompt).toContain("Use a concise STAR structure.");
    expect(stub.lastUserPrompt).not.toContain("30% growth");
    expect(stub.lastUserPrompt).not.toContain("Acme Trading");
    const data = result.data as Record<string, unknown>;
    expect(data.guidelineRagApplied).toBe(true);
    expect((data.riskNotes as string[]).some((note) => note.includes("Guideline RAG returned 2 rule(s)"))).toBe(true);
    await kernel.close();
  });

  it("PreferenceBank affects style only and exposes additive applied preference diagnostics", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async () => fakeEvidencePack(exp.id);
    kernel.productServices.preferenceBankService!.buildPersonalizationPack = async () => fakePersonalizationPack();

    const { result, stub } = await runCompose({
      kernel,
      args: {
        outputType: "self_intro",
        constraints: { language: "en", tone: "concise" },
        userInstruction: "Write a concise self intro.",
      },
      responder: () => ({
        status: "success",
        title: "Self intro",
        outputType: "self_intro",
        content: "I turn analytics evidence into concise product insights.",
        usedExperienceIds: [exp.id],
        groundingNotes: ["Used WEEX only"],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(stub.lastSystemPrompt).toContain("PreferenceBank");
    expect(stub.lastUserPrompt).toContain("Style preferences");
    expect(stub.lastUserPrompt).toContain("Use concise first-person tone.");
    expect(stub.lastUserPrompt).not.toContain("99%");
    expect(stub.lastUserPrompt).not.toContain("Acme");
    const data = result.data as Record<string, unknown>;
    expect(data.personalizationApplied).toBe(1);
    expect(data.appliedPreferenceIds).toEqual(["pref-style"]);
    expect((data.groundingDiagnostics as Record<string, { appliedCount?: number }>).preferenceBank.appliedCount).toBe(1);
    expect((data.riskNotes as string[]).some((note) => note.includes("PreferenceBank was used for tone/style only"))).toBe(true);
    await kernel.close();
  });

  it("RAG failure degrades with stable warning and riskNotes", async () => {
    const kernel = await createP12Kernel();
    const exp = await seedExperience(kernel);
    kernel.productServices.evidenceRAGService!.buildEvidencePack = async () => {
      throw new Error("simulated outage");
    };

    const { result } = await runCompose({
      kernel,
      args: {
        outputType: "self_intro",
        constraints: { language: "en" },
        userInstruction: "Write a self intro from my saved experience.",
      },
      responder: () => ({
        status: "success",
        title: "Self intro",
        outputType: "self_intro",
        content: "I use SQL and Power BI for analytics workflows.",
        usedExperienceIds: [exp.id],
        groundingNotes: ["Used saved experience despite RAG outage"],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      }),
    });

    expect(result.status).toBe("success");
    expect(result.warnings?.some((warning) => warning.startsWith("evidence_rag_unavailable"))).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data.riskNotes as string[]).some((note) => note.includes("Evidence RAG was unavailable"))).toBe(true);
    expect((data.groundingDiagnostics as Record<string, { status?: string }>).evidenceRag.status).toBe("unavailable");
    await kernel.close();
  });
});
