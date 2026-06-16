# Phase 2 - Narrator/Presenter Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `NarratorService` that turns Phase 1's structured `ToolResult` payloads into natural Chinese / English assistant text via the existing `ModelClient`, while keeping the legacy `ResponseComposer` rule-based templates as a guaranteed fallback. Toggled by `ENABLE_NARRATOR=true`.

**Architecture:**
- New `src/copilot/response/NarratorService.ts` - pure presenter: `narrate(input) -> string | null`. Never mutates state, never calls tools, never touches `workspacePatch` / `actionResult` / pending actions.
- New `src/agent-core/prompts/prompts/product/narrator-system.md`, registered in `PromptRegistry` as `product.narrator.system`.
- `ResponseComposer.compose` gets an **optional** narrator dependency. The default zero-arg constructor still works so existing tests stay green. On a small set of "happy success" branches (`generated` / `accepted` / `exported` / `jdMatch`) it asks the narrator first; on any failure it falls back deterministically to the legacy rule branch and `nextActions` are still emitted.
- `AgentResultAssembler` (the only production caller) wires the narrator from `kernel.frontDeskModelClient` + a shared `PromptRegistry`. When the model client is missing the narrator is `undefined` and the composer is byte-identical to before.
- Confirmation / `needs_input` / `failed` / JD intake handoff / max_steps / "all internal" fallback / final "Done." paths are **left untouched** - UX during errors stays deterministic.

**Tech Stack:**
- TypeScript + Vitest (existing).
- `ModelClient.chat({ messages, temperature, maxTokens })` - same call style as `src/agent-tools/resume/prepareReviseResumeItem.tool.ts:101-108`.
- `PromptRegistry` for `product.narrator.system`.
- Env switch: `process.env.ENABLE_NARRATOR === "true"` (matches `ENABLE_AGENT_DECISION_DEBUG` style in `src/agent-core/agents/BaseAgent.ts:14`).

---

## File Structure

```text
NEW   src/copilot/response/NarratorService.ts
NEW   src/agent-core/prompts/prompts/product/narrator-system.md
MOD   src/agent-core/prompts/PromptRegistry.ts                 # register product.narrator.system
MOD   src/copilot/response/ResponseComposer.ts                 # optional narrator dep + 4 branch hooks
MOD   src/agent-core/runtime/AgentResultAssembler.ts           # construct ResponseComposer with narrator
NEW   tests/NarratorService.test.ts                            # NarratorService unit tests with stub provider
NEW   tests/ResponseComposer.narrator.test.ts                  # composer wiring + fallback
MOD   tests/copilotKernelRefactor.test.ts                      # tiny ENABLE_NARRATOR e2e through assembler
MOD   docs/cv_agent_next_stage_plan.md                         # append Phase 2 completion section before # 阶段 3
```

Boundaries:
- `NarratorService` knows nothing about `ToolRegistry`, `WorkspaceProjector`, `PendingActionService`, or HTTP. It is a thin LLM wrapper over `ToolResult[]` + locale + small contextual hints.
- `ResponseComposer` keeps its full legacy logic. Narrator only runs on the 4 success branches above; everything else stays rule-based.

---

## Context an Engineer Needs

1. **Phase 1 fields are ready.** `ToolResult` already carries optional `summaryFacts` / `entities` / `evidence` / `warnings` / `nextActionHints` / `resultKind`. See `src/agent-core/tools/ToolResult.ts`. Narrator MUST prefer these over raw `data` blobs.
2. **Composer branches to hook into.** In `src/copilot/response/ResponseComposer.ts:32-176`:
   - `accepted` (line ~54): `actionResult.actionType === "accept_generation_variant"` and `status === "success"`.
   - `exported` (line ~75): `actionResult.actionType === "export_resume"` and `status === "success"`.
   - `generated` (line ~86): `actionResult.actionType === "generate_resume_from_jd"` or `hasVariants(result)` AND not `isGeneratingResume`.
   - `jdMatch` (line ~102): `actionResult.actionType === "match_experiences_against_jd"`.
   The early-exit branches (confirmation, needs_input, failed, max_steps, JD intake, internal-only fallback, blank "Done.") MUST stay rule-based.
3. **`ModelClient.chat` contract.** See `src/agent-core/model/ModelClient.ts:31-46`. Already retries + applies a 60s timeout - narrator only needs `try/catch`.
4. **Prompt registration.** See `src/agent-core/prompts/PromptRegistry.ts:14-32`. Add `"product.narrator.system": "product/narrator-system.md"` to `PRODUCT_PROMPT_FILES`. `trimOneFinalNewline` is auto-applied to product prompts.
5. **Test kernel.** `tests/p12Helpers.ts:15-25` sets `kernel.frontDeskModelClient` to a deterministic `ModelClient` already; ENABLE_NARRATOR e2e tests can build on that. Existing `tests/copilotKernelRefactor.test.ts:174` constructs `new ResponseComposer()` with no arg - that path MUST keep working unchanged.
6. **Locale.** Already on `input.locale` in composer (`"en"` vs `"zh-CN"`). Pass to narrator verbatim.
7. **Verification commands:**
   - `npm run typecheck`
   - `npm test`
   - Targeted: `npx vitest run tests/NarratorService.test.ts tests/ResponseComposer.narrator.test.ts tests/copilotKernelRefactor.test.ts`

---

## Task 1 - NarratorService skeleton + interface (no model call yet)

**Files:**
- Create: `src/copilot/response/NarratorService.ts`
- Test: `tests/NarratorService.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `tests/NarratorService.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NarratorService } from "../src/copilot/response/NarratorService.js";

describe("NarratorService", () => {
  it("returns null when modelClient is missing (degrades silently)", async () => {
    const narrator = new NarratorService({ modelClient: undefined, prompt: "system", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "请帮我生成简历",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });

  it("returns null when disabled even if modelClient is provided", async () => {
    const stub = { chat: async () => ({ content: "should not be called" }) } as any;
    const narrator = new NarratorService({ modelClient: stub, prompt: "system", enabled: false });
    const result = await narrator.narrate({ locale: "zh-CN", userMessage: "x", toolResults: [], branch: "generated" });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `npx vitest run tests/NarratorService.test.ts`
Expected: FAIL - `Cannot find module .../NarratorService`.

- [ ] **Step 1.3: Implement the skeleton**

Create `src/copilot/response/NarratorService.ts`:

```ts
import type { PendingAction } from "../../agent-core/confirmation/PendingAction.js";
import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import type { ToolResult } from "../../agent-core/tools/ToolResult.js";
import type { CriticReview } from "../../agent-core/validation/AgentOutputSchemas.js";
import type { CopilotLocale } from "../locale.js";
import type { CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";

export type NarratorBranch = "generated" | "accepted" | "exported" | "jd_match";

export type NarratorInput = {
  locale: CopilotLocale;
  userMessage: string;
  toolResults: ToolResult[];
  branch: NarratorBranch;
  workspace?: CopilotWorkspace | null;
  pendingActions?: PendingAction[];
  criticReview?: CriticReview;
  frontDeskHandoff?: FrontDeskHandoff;
  fallbackText?: string;
};

export type NarratorOptions = {
  modelClient?: ModelClient;
  prompt: string;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
};

export class NarratorService {
  private readonly modelClient: ModelClient | undefined;
  private readonly prompt: string;
  private readonly enabled: boolean;
  private readonly temperature: number;
  private readonly maxTokens: number;

  public constructor(options: NarratorOptions) {
    this.modelClient = options.modelClient;
    this.prompt = options.prompt;
    this.enabled = options.enabled ?? (process.env.ENABLE_NARRATOR === "true");
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 600;
  }

  public async narrate(_input: NarratorInput): Promise<string | null> {
    if (!this.enabled) return null;
    if (!this.modelClient) return null;
    return null;
  }
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `npx vitest run tests/NarratorService.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 1.5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 1.6: Commit**

```bash
git add src/copilot/response/NarratorService.ts tests/NarratorService.test.ts
git commit -m "feat(narrator): add NarratorService skeleton (phase 2 task 1)"
```

---

## Task 2 - Narrator system prompt + real LLM call + payload shaping

**Files:**
- Create: `src/agent-core/prompts/prompts/product/narrator-system.md`
- Modify: `src/agent-core/prompts/PromptRegistry.ts`
- Modify: `src/copilot/response/NarratorService.ts`
- Modify: `tests/NarratorService.test.ts`

- [ ] **Step 2.1: Write the narrator system prompt file**

Create `src/agent-core/prompts/prompts/product/narrator-system.md` with content:

```markdown
You are the Narrator for an AI resume copilot. You produce the final chat reply that the user reads after one or more tools have already executed.

Hard rules:
- You DO NOT execute tools, modify state, fetch data, or invent facts.
- You answer in the conversation locale. If `locale` is `zh-CN`, reply in fluent Mandarin Chinese; if `en`, reply in concise English.
- Use 1-4 short sentences. No bullet lists, no JSON, no code blocks, no headings.
- Ground every claim in the provided `toolResults`. Prefer values from `summaryFacts`, `entities`, `evidence`, `warnings`, and `nextActionHints`. Never invent counts, IDs, percentages, or names.
- If `warnings` is non-empty, surface the most relevant warning briefly.
- If `nextActionHints` is non-empty, naturally suggest the most relevant next step using its `label`. Do not list more than two suggestions.
- If `criticReview.verdict` is `needs_revision` or `fail`, acknowledge the gap honestly and avoid claiming success.
- Never echo internal IDs, JSON keys, or system phrasing like "tool result", "actionResult", "workspacePatch".
- Output only the reply text. No prefix, no quotes around the whole reply, no trailing meta commentary.

Branch hints:
- `generated`: user just received generated resume variants. Encourage choosing one variant to save, or reviewing them. Mention how many were generated when available.
- `accepted`: a variant was just saved as the user's resume. Confirm the save in one sentence and offer export as a natural next step when applicable.
- `exported`: an export job was created. Tell the user the file will become available shortly without promising a specific time.
- `jd_match`: experiences were matched against a JD. Briefly summarize how strong the match is using counts in `summaryFacts` (e.g. high-match counts) and suggest the next step.

If the structured payload is empty, lean on `fallbackText` (already a safe legacy phrasing) and rephrase it slightly more naturally without changing its meaning.
```

- [ ] **Step 2.2: Register the prompt in PromptRegistry**

Modify `src/agent-core/prompts/PromptRegistry.ts`. Inside `PRODUCT_PROMPT_FILES` add the new entry at the end (before the closing brace):

```ts
  "tools.experience.jdMatch.system": "tools/experience/jd-match-system.md",
  "product.narrator.system": "product/narrator-system.md",
} as const;
```

- [ ] **Step 2.3: Add an LLM-call test (success + failure paths)**

Append to `tests/NarratorService.test.ts`:

```ts
function makeStubModelClient(responses: Array<string | Error>) {
  let i = 0;
  return {
    chat: async () => {
      const next = responses[i++] ?? "";
      if (next instanceof Error) throw next;
      return { content: next };
    },
  } as any;
}

describe("NarratorService LLM path", () => {
  it("calls modelClient.chat and returns trimmed assistant text on success", async () => {
    const stub = makeStubModelClient(["  已基于 JD 生成 3 个简历版本，你可以选一个版本保存。  "]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "请帮我生成简历",
      toolResults: [{
        status: "success",
        message: "已基于 JD 生成 3 个简历版本",
        resultKind: "generation_completed",
        summaryFacts: ["Generated 3 variants"],
        nextActionHints: [{ type: "accept_generation_variant", label: "选择并保存一个版本" }],
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
      }],
      branch: "generated",
    });
    expect(result).toBe("已基于 JD 生成 3 个简历版本，你可以选一个版本保存。");
  });

  it("returns null when modelClient throws (caller falls back)", async () => {
    const stub = makeStubModelClient([new Error("provider down")]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "x",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });

  it("returns null when modelClient returns blank content", async () => {
    const stub = makeStubModelClient(["   \n  "]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "x",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2.4: Run the tests to verify they fail**

Run: `npx vitest run tests/NarratorService.test.ts`
Expected: FAIL on the new 3 tests because `narrate` still always returns `null`.

- [ ] **Step 2.5: Implement the LLM call inside `narrate`**

Replace the body of `narrate` in `src/copilot/response/NarratorService.ts` with:

```ts
  public async narrate(input: NarratorInput): Promise<string | null> {
    if (!this.enabled) return null;
    if (!this.modelClient) return null;

    const userPayload = this.buildUserPayload(input);
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: this.prompt },
          { role: "user", content: userPayload },
        ],
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });
      const text = (response.content ?? "").trim();
      if (!text) return null;
      return text;
    } catch {
      return null;
    }
  }

  private buildUserPayload(input: NarratorInput): string {
    const compactResults = input.toolResults.map((result) => ({
      status: result.status,
      resultKind: (result as { resultKind?: string }).resultKind,
      message: result.message,
      summaryFacts: (result as { summaryFacts?: string[] }).summaryFacts,
      entities: (result as { entities?: unknown }).entities,
      evidence: (result as { evidence?: unknown }).evidence,
      warnings: (result as { warnings?: string[] }).warnings,
      nextActionHints: (result as { nextActionHints?: unknown }).nextActionHints,
      actionType: result.actionResult?.actionType,
      actionStatus: result.actionResult?.status,
    }));
    const payload = {
      locale: input.locale,
      branch: input.branch,
      userMessage: input.userMessage,
      fallbackText: input.fallbackText,
      criticReview: input.criticReview ? {
        verdict: input.criticReview.verdict,
        userVisibleSummary: input.criticReview.userVisibleSummary,
      } : undefined,
      frontDeskIntent: input.frontDeskHandoff?.intent,
      toolResults: compactResults,
    };
    return JSON.stringify(payload);
  }
```

- [ ] **Step 2.6: Run the tests to verify they pass**

Run: `npx vitest run tests/NarratorService.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 2.7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2.8: Commit**

```bash
git add src/copilot/response/NarratorService.ts src/agent-core/prompts/PromptRegistry.ts src/agent-core/prompts/prompts/product/narrator-system.md tests/NarratorService.test.ts
git commit -m "feat(narrator): wire LLM call + product.narrator.system prompt (phase 2 task 2)"
```

---

## Task 3 - Wire optional narrator into ResponseComposer (4 branch hooks + fallback)

**Files:**
- Modify: `src/copilot/response/ResponseComposer.ts`
- Create: `tests/ResponseComposer.narrator.test.ts`

- [ ] **Step 3.1: Write the failing tests for composer wiring**

Create `tests/ResponseComposer.narrator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ResponseComposer } from "../src/copilot/response/ResponseComposer.js";
import { NarratorService } from "../src/copilot/response/NarratorService.js";

function fakeContext(): any {
  return { productContext: {} };
}

function buildComposer(narratorReply: string | null): ResponseComposer {
  const stub = { chat: async () => ({ content: narratorReply ?? "" }) } as any;
  const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
  return new ResponseComposer({ narrator });
}

describe("ResponseComposer narrator wiring", () => {
  it("uses narrator output for the `generated` branch when ENABLE_NARRATOR is on", async () => {
    const composer = buildComposer("已基于 JD 生成 2 个版本，请选择一个保存。");
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "生成简历",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
        data: { variants: [{ id: "v-1" }, { id: "v-2" }] },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toBe("已基于 JD 生成 2 个版本，请选择一个保存。");
  });

  it("falls back to legacy text when narrator returns null", async () => {
    const composer = buildComposer(null);
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "生成简历",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
        data: { variants: [{ id: "v-1" }] },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toContain("已基于 JD 生成");
  });

  it("preserves nextActions on the `accepted` branch when narrator overrides text", async () => {
    const composer = buildComposer("已保存这个版本，可随时导出。");
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "保存",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "accept_generation_variant", metadata: { resumeId: "res-1" } },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toBe("已保存这个版本，可随时导出。");
    expect(output.nextActions?.[0]).toMatchObject({ type: "export_resume", payload: { resumeId: "res-1" } });
  });

  it("does not call narrator on confirmation branch (deterministic UX)", async () => {
    let called = 0;
    const stub = { chat: async () => { called += 1; return { content: "should not appear" }; } } as any;
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const composer = new ResponseComposer({ narrator });
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "确认?",
      workspace: null,
      toolResults: [{
        status: "success",
        message: "我将把这个版本保存到你的简历中，请确认。",
        actionResult: { status: "needs_confirmation", actionType: "accept_generation_variant" },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(called).toBe(0);
    expect(output.assistantText).toContain("我将把这个版本保存到你的简历中");
  });

  it("zero-arg constructor still composes without narrator (backward compat)", async () => {
    const composer = new ResponseComposer();
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "x",
      workspace: null,
      toolResults: [],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(typeof output.assistantText).toBe("string");
  });
});
```

- [ ] **Step 3.2: Run the tests to verify they fail**

Run: `npx vitest run tests/ResponseComposer.narrator.test.ts`
Expected: FAIL because `ResponseComposer` is currently zero-arg only and has no `composeAsync`.

- [ ] **Step 3.3: Modify ResponseComposer to accept an optional narrator and add `composeAsync`**

In `src/copilot/response/ResponseComposer.ts`:

1. Add an optional constructor argument and a private field. Keep the existing `compose` method synchronous and untouched (so all existing tests stay green). Add a new async `composeAsync` that runs the narrator on the four success branches and falls back to the existing rule output otherwise.

```ts
import { NarratorService, type NarratorBranch } from "./NarratorService.js";
// ... existing imports remain

export type ResponseComposerOptions = {
  narrator?: NarratorService;
};

export class ResponseComposer {
  private readonly narrator: NarratorService | undefined;

  public constructor(options: ResponseComposerOptions = {}) {
    this.narrator = options.narrator;
  }

  public compose(input: ResponseComposerInput): ResponseComposerOutput {
    // existing body unchanged - keep all current branching as-is
    // (paste the existing implementation here verbatim)
  }

  public async composeAsync(input: ResponseComposerInput): Promise<ResponseComposerOutput> {
    const baseline = this.compose(input);
    if (!this.narrator) return baseline;

    const branch = this.detectNarratorBranch(input);
    if (!branch) return baseline;

    try {
      const text = await this.narrator.narrate({
        locale: input.locale,
        userMessage: input.userMessage,
        toolResults: input.toolResults,
        branch,
        workspace: input.workspace,
        pendingActions: input.pendingActions,
        criticReview: input.criticReview,
        frontDeskHandoff: input.frontDeskHandoff,
        fallbackText: baseline.assistantText,
      });
      if (typeof text === "string" && text.trim().length > 0) {
        return { ...baseline, assistantText: text };
      }
    } catch {
      // fall through to baseline
    }
    return baseline;
  }

  private detectNarratorBranch(input: ResponseComposerInput): NarratorBranch | undefined {
    const hasConfirmation = input.toolResults.some((r) => r.actionResult?.status === "needs_confirmation");
    const hasNeedsInput = input.toolResults.some((r) => r.status === "needs_input");
    const hasFailedVisible = input.toolResults.some((r) => r.status === "failed" && r.visibility === "error_user_visible");
    if (hasConfirmation || hasNeedsInput || hasFailedVisible) return undefined;

    if (input.toolResults.some((r) => r.actionResult?.actionType === "accept_generation_variant" && r.status === "success")) return "accepted";
    if (input.toolResults.some((r) => r.actionResult?.actionType === "export_resume" && r.status === "success")) return "exported";
    if (input.toolResults.some((r) => {
      if (r.actionResult?.actionType === "generate_resume_from_jd") {
        const md = r.actionResult?.metadata as Record<string, unknown> | undefined;
        return !(md && md.generating === true);
      }
      const data = r.data as { variants?: unknown[] } | undefined;
      return Array.isArray(data?.variants);
    })) return "generated";
    if (input.toolResults.some((r) => r.actionResult?.actionType === "match_experiences_against_jd")) return "jd_match";
    return undefined;
  }
}
```

Important: when pasting the body of the existing `compose` method, do NOT change any existing logic - only re-indent it inside the new class shape. The pre-existing zero-arg constructor must keep working: the new constructor signature uses a default value `options: ResponseComposerOptions = {}` so calls like `new ResponseComposer()` are still valid.

- [ ] **Step 3.4: Run the tests to verify they pass**

Run: `npx vitest run tests/ResponseComposer.narrator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3.5: Run the full pre-existing composer tests to confirm no regression**

Run: `npx vitest run tests/copilotKernelRefactor.test.ts`
Expected: PASS (all existing tests, including the `does not leak internal tool logs into assistant text` test using zero-arg `new ResponseComposer()`).

- [ ] **Step 3.6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3.7: Commit**

```bash
git add src/copilot/response/ResponseComposer.ts tests/ResponseComposer.narrator.test.ts
git commit -m "feat(narrator): wire optional narrator into ResponseComposer.composeAsync (phase 2 task 3)"
```

---

## Task 4 - Wire narrator into AgentResultAssembler (orchestrator side)

**Files:**
- Modify: `src/agent-core/runtime/AgentResultAssembler.ts`
- Modify: `src/agent-core/runtime/AgentOrchestrator.ts`

- [ ] **Step 4.1: Make AgentResultAssembler async and inject narrator**

In `src/agent-core/runtime/AgentResultAssembler.ts`:

1. Add a `deps` argument with `narrator?: NarratorService`.
2. Replace `this.responseComposer.compose(...)` with `await this.responseComposer.composeAsync(...)`.
3. Convert the `assemble` method signature to `public async assemble(input): Promise<AgentResultAssembly>`.

```ts
import { NarratorService } from "../../copilot/response/NarratorService.js";

export type AgentResultAssemblerDeps = {
  narrator?: NarratorService;
};

export class AgentResultAssembler {
  private readonly responseComposer: ResponseComposer;

  public constructor(
    private readonly assistantMessageProjector: AssistantMessageProjector = new AssistantMessageProjector(),
    deps: AgentResultAssemblerDeps = {},
  ) {
    this.responseComposer = new ResponseComposer({ narrator: deps.narrator });
  }

  public async assemble(input: AgentResultAssemblyInput): Promise<AgentResultAssembly> {
    const now = new Date().toISOString();
    const composed = await this.responseComposer.composeAsync({
      // unchanged input mapping (locale, userMessage, frontDeskHandoff, workspace, ...)
    });
    // rest of the method unchanged
  }
}
```

- [ ] **Step 4.2: Update AgentOrchestrator to construct the narrator and pass it in**

In `src/agent-core/runtime/AgentOrchestrator.ts` near line 77-119:

```ts
import { NarratorService } from "../../copilot/response/NarratorService.js";

// In the constructor body, just after `const promptRegistry = new PromptRegistry();`:
const narratorPrompt = (() => {
  try { return promptRegistry.get("product.narrator.system"); }
  catch { return undefined; }
})();
const narrator = (deps.kernel.frontDeskModelClient && narratorPrompt)
  ? new NarratorService({ modelClient: deps.kernel.frontDeskModelClient, prompt: narratorPrompt })
  : undefined;
this.resultAssembler = new AgentResultAssembler(undefined, { narrator });
```

Convert `private readonly resultAssembler = new AgentResultAssembler();` to `private readonly resultAssembler: AgentResultAssembler;` and assign it inside the constructor.

- [ ] **Step 4.3: Find and `await` every `resultAssembler.assemble(` call site**

Run: `npx rg -n "resultAssembler\.assemble\(" src`
For each match, change `this.resultAssembler.assemble(` to `await this.resultAssembler.assemble(` and ensure the enclosing function is `async`. All call sites are in `AgentOrchestrator`, which is already `async`.

- [ ] **Step 4.4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. If you see "Type 'Promise<...>' is missing properties of ..." errors, an `await` was missed in step 4.3.

- [ ] **Step 4.5: Commit**

```bash
git add src/agent-core/runtime/AgentResultAssembler.ts src/agent-core/runtime/AgentOrchestrator.ts
git commit -m "feat(narrator): inject NarratorService into AgentResultAssembler (phase 2 task 4)"
```

---

## Task 5 - ENABLE_NARRATOR e2e test + full suite + docs

**Files:**
- Modify: `tests/copilotKernelRefactor.test.ts`
- Modify: `docs/cv_agent_next_stage_plan.md`

- [ ] **Step 5.1: Add an ENABLE_NARRATOR e2e test using a stub provider**

Append to `tests/copilotKernelRefactor.test.ts` a new `describe("ENABLE_NARRATOR e2e through AgentResultAssembler")` block. The test sets `process.env.ENABLE_NARRATOR = "true"`, swaps `kernel.frontDeskModelClient` for a `ModelClient` whose provider returns a fixed Chinese sentence, runs a turn that lands on the `generated` branch (after the existing JD intake + confirm flow), and asserts the assistant message contains the narrator output. After the test it always restores the env var.

```ts
describe("ENABLE_NARRATOR e2e through AgentResultAssembler", () => {
  it("uses narrator output when ENABLE_NARRATOR=true and a frontDeskModelClient is available", async () => {
    const original = process.env.ENABLE_NARRATOR;
    process.env.ENABLE_NARRATOR = "true";
    try {
      const kernel = await createP12Kernel();
      const provider = { name: "narrator-stub", chat: async () => ({ content: "已基于 JD 生成 2 个版本，请选择一个保存。" }) } as any;
      kernel.frontDeskModelClient = new ModelClient({ provider, defaultModel: "narrator-stub" });
      const orchestrator = new AgentOrchestrator({ kernel });
      const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "narr-1", traceId: "narr-1" } });
      const intake = await orchestrator.handleChat(ctx, { message: JD_TEXT });
      const generated = await orchestrator.handleChat(ctx, { sessionId: intake.sessionId, message: "那就生成吧" });
      const pendingId = generated.raw.pendingActions?.[0]?.id;
      expect(pendingId).toBeDefined();
      const confirmed = await orchestrator.confirmPendingAction(ctx, pendingId!);
      expect(confirmed.assistantMessage.content).toContain("已基于 JD 生成 2 个版本");
      await kernel.close();
    } finally {
      if (original === undefined) delete process.env.ENABLE_NARRATOR;
      else process.env.ENABLE_NARRATOR = original;
    }
  });
});
```

The real `AgentOrchestrator.confirmPendingAction(ctx, pendingActionId: string)` signature was verified before plan execution (`src/agent-core/runtime/AgentOrchestrator.ts:356`). The acceptance criterion is unchanged: after the generation tool runs successfully on the `generated` branch, the final `assistantMessage.content` contains the narrator stub text.

- [ ] **Step 5.2: Run the new e2e test**

Run: `npx vitest run tests/copilotKernelRefactor.test.ts`
Expected: PASS (existing tests + new ENABLE_NARRATOR test).

- [ ] **Step 5.3: Run the full test suite**

Run: `npm test`
Expected: PASS. Test files >= 63 (was 62 after Phase 1) and tests >= 600 (was 593). No previously-passing test regressed.

- [ ] **Step 5.4: Append the Phase 2 completion section to `docs/cv_agent_next_stage_plan.md`**

Insert a new `## 阶段 2 完成情况记录（执行回顾）` section immediately before the line `# 阶段 3：引入结构化 ResumeDocument 模型`. Use the same four-part structure used in stages 0 and 1: 实际改动文件清单 / 关键设计说明 / 验收标准达成 / 是否影响对外 API 与契约.

The contract impact table for Phase 2 must record:

- New env var `ENABLE_NARRATOR` (default off) - additive, safe.
- `/copilot/chat`, `/copilot/actions`, `/copilot/pending-actions/:id/confirm`: when `ENABLE_NARRATOR=true` AND `frontDeskModelClient` is configured AND the turn lands on one of `generated / accepted / exported / jd_match`, `assistantMessage.content` is now narrator-generated rather than fixed; all other fields (raw.toolResults, workspace, workspacePatch, raw.actionResults, nextActions, raw.pendingActions, timeline, agentRoomEvents, raw.metadata) are byte-identical to the rule-based path.
- When `ENABLE_NARRATOR` is unset or false, behavior is byte-identical to Phase 1.
- REST routes (`/exports/*`, `/product/*`, `/jobs/:id`), DB schema, and persisted message metadata are untouched.

- [ ] **Step 5.5: Commit**

```bash
git add tests/copilotKernelRefactor.test.ts docs/cv_agent_next_stage_plan.md
git commit -m "test(narrator): add ENABLE_NARRATOR e2e + phase 2 completion notes"
```

---

## Acceptance Criteria

- `npm run typecheck` passes.
- `npm test` passes; >= 63 files / >= 600 tests; no regressions.
- With `ENABLE_NARRATOR` unset: assistant text on `generated / accepted / exported / jd_match` turns is byte-identical to the Phase 1 baseline.
- With `ENABLE_NARRATOR=true` and a working `frontDeskModelClient`: assistant text on those four branches is generated by the narrator. Workspace patches, action results, pending actions, next actions, timeline, and metadata remain byte-identical to the rule-based path.
- If the model provider throws or returns blank, the rule-based fallback text is shown instead - never a blank or partial reply.
- Confirmation, needs_input, failed-error, JD intake, max_steps, and "Done." paths are still rule-based (deterministic).

## Out of Scope

- Do not modify any tool's output (Phase 1 already structured them).
- Do not change `mergeWorkspacePatch`, `WorkspaceProjector`, `PendingActionService`, REST routes, or DB schema.
- Do not let the narrator call tools, modify state, or read DB.
- Do not delete or rewrite the existing rule-based branches in `ResponseComposer.compose`.
- Do not change `DisplayToolResult` / frontend types (deferred to Phase 9).

## Self-Review

1. Spec coverage:
   - "新增 NarratorService" -> Task 1 + Task 2.
   - "新增 narrator prompt" -> Task 2.1 + 2.2.
   - "修改 ResponseComposer 优先尝试 NarratorService, 失败回退" -> Task 3.
   - "增加环境开关 ENABLE_NARRATOR=true/false" -> wired in NarratorService default (Task 1.3) + respected via `enabled` option; e2e in Task 5.1.
   - "Narrator 开启时能基于结构化结果生成非固定话术" -> Task 3 + Task 5.1 e2e.
   - "Narrator 失败时原有 ResponseComposer fallback 仍然可用" -> Task 3.1 second test + Task 2.3 throw/blank tests.
2. Placeholder scan: no TBDs, no "implement later". Every code step has actual code.
3. Type consistency: `NarratorBranch` matches values used in `detectNarratorBranch` (`generated` / `accepted` / `exported` / `jd_match`). `ResponseComposerOptions` uses the same `narrator?: NarratorService` field name across Tasks 1, 3, 4. `AgentResultAssemblerDeps.narrator` is the field name used both in Task 4.1 and Task 4.2.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-06-16-phase-2-narrator-service.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using `executing-plans`, batch with checkpoints.

Which approach?
