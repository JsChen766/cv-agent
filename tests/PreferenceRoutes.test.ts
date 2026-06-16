import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { PersonalizationPack, UserPreference } from "../src/self-evolution/preference/index.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.FRONTDESK_AGENT_MODE = "mock";
  process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
  process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
  process.env.CRITIC_AGENT_MODE = "deterministic";
  process.env.REVISION_AGENT_MODE = "deterministic";
  process.env.NODE_ENV = "test";
  delete process.env.DATABASE_URL;
}

describe("PreferenceBank product routes", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("records an explicit scoped preference and returns it from the user-scoped list", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/product/preferences/explicit",
      headers: { "x-user-id": "user-1" },
      payload: {
        instruction: "更简洁，减少背景描述。",
        scope: { roleFamily: "ai_ml", language: "zh" },
      },
    });
    expect(create.statusCode).toBe(200);

    const list = await server.inject({
      method: "GET",
      url: "/product/preferences?status=active",
      headers: { "x-user-id": "user-1" },
    });
    expect(list.statusCode).toBe(200);
    const data = (list.json() as ApiSuccess<{ preferences: UserPreference[] }>).data;
    expect(data.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimension: "verbosity",
        value: "concise",
        status: "active",
        scope: expect.objectContaining({ roleFamily: "ai_ml", language: "zh" }),
      }),
    ]));
  });

  it("builds a contextual PersonalizationPack without requiring resume generation", async () => {
    await server.inject({
      method: "POST",
      url: "/product/preferences/explicit",
      headers: { "x-user-id": "user-1" },
      payload: {
        instruction: "Use direct, non-promotional language and keep technical details.",
        scope: { roleFamily: "ai_ml", language: "en" },
      },
    });

    const preview = await server.inject({
      method: "POST",
      url: "/product/preferences/preview",
      headers: { "x-user-id": "user-1" },
      payload: {
        targetRole: "AI Algorithm Engineer Intern",
        jdText: "Develop LLM and RAG algorithms with Python and PyTorch.",
      },
    });
    expect(preview.statusCode).toBe(200);
    const data = (preview.json() as ApiSuccess<{ personalizationPack: PersonalizationPack }>).data;
    expect(data.personalizationPack.version).toBe("preference-bank-v1");
    expect(data.personalizationPack.diagnostics.appliedCount).toBeGreaterThan(0);
    expect([
      ...data.personalizationPack.stablePreferences,
      ...data.personalizationPack.contextualPreferences,
    ].map((item) => item.dimension)).toEqual(expect.arrayContaining(["writing_style"]));
  });
});
