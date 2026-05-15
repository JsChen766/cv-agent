import { afterEach, describe, expect, it } from "vitest";
import {
  createKernel,
  createPostgresKernelFromDatabase,
  createPostgresKernelFromDatabaseForTest,
} from "../src/api/kernel/createKernel.js";
import type { GenerateResumeResult } from "../src/application/ResumeGenerationService.js";
import type {
  PostgresQueryable,
  PostgresQueryResult,
} from "../src/persistence/postgres/PostgresDatabase.js";

describe("API kernel", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAgentProvider = process.env.AGENT_PROVIDER;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
  const originalAllowMockFallback = process.env.ALLOW_MOCK_FALLBACK;
  const originalFrontDeskAgentMode = process.env.FRONTDESK_AGENT_MODE;
  const originalExperienceExtractorMode = process.env.EXPERIENCE_EXTRACTOR_MODE;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalAgentProvider === undefined) {
      delete process.env.AGENT_PROVIDER;
    } else {
      process.env.AGENT_PROVIDER = originalAgentProvider;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalDeepSeekApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
    }
    if (originalAllowMockFallback === undefined) {
      delete process.env.ALLOW_MOCK_FALLBACK;
    } else {
      process.env.ALLOW_MOCK_FALLBACK = originalAllowMockFallback;
    }
    if (originalFrontDeskAgentMode === undefined) {
      delete process.env.FRONTDESK_AGENT_MODE;
    } else {
      process.env.FRONTDESK_AGENT_MODE = originalFrontDeskAgentMode;
    }
    if (originalExperienceExtractorMode === undefined) {
      delete process.env.EXPERIENCE_EXTRACTOR_MODE;
    } else {
      process.env.EXPERIENCE_EXTRACTOR_MODE = originalExperienceExtractorMode;
    }
  });

  it("creates an in-memory kernel with a generation persistence port when DATABASE_URL is absent", async () => {
    delete process.env.DATABASE_URL;
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect(kernel.mode).toBe("in_memory");
      expect(kernel.cvAgentKernel.mode).toBe("in_memory");
      expect(typeof kernel.cvAgentKernel.health).toBe("function");
      expect(typeof kernel.generationPersistenceService?.persist).toBe("function");
    } finally {
      await kernel.close();
    }
  });

  it("uses transaction-aware generation persistence in postgres kernel mode", async () => {
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.NODE_ENV = "test";
    const database = new FakePostgresDatabase();
    expect(createPostgresKernelFromDatabaseForTest).toBe(createPostgresKernelFromDatabase);
    const kernel = await createPostgresKernelFromDatabase(database);
    try {
      await kernel.generationPersistenceService?.persist(createMinimalGenerateResumeResult());

      expect(kernel.mode).toBe("postgres");
      expect(kernel.cvAgentKernel.mode).toBe("postgres");
      expect(database.initializeSchemaCalled).toBe(true);
      expect(database.transactionCalled).toBe(true);
      expect(database.client.queries.some((query) => query.sql.includes("INSERT INTO generation_sessions"))).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("merges agent provider warnings into kernel warnings", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "llm";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ALLOW_MOCK_FALLBACK = "true";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect(kernel.warnings).toContain(
        "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
      );
      expect((await kernel.cvAgentKernel.health()).warnings).toContain(
        "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
      );
    } finally {
      await kernel.close();
    }
  });

  it("keeps FrontDesk on mock mode even when AGENT_PROVIDER=deepseek has no key", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ALLOW_MOCK_FALLBACK = "false";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect(kernel.warnings).not.toContain(
        "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
      );
      expect((await kernel.cvAgentKernel.health()).warnings).toEqual([
        "DATABASE_URL is not set. API is running in in-memory mode.",
      ]);
    } finally {
      await kernel.close();
    }
  });

  it("throws when FrontDesk llm mode uses deepseek without key and fallback is disabled", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "llm";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ALLOW_MOCK_FALLBACK = "false";
    process.env.NODE_ENV = "test";

    await expect(createKernel()).rejects.toThrow(
      "DEEPSEEK_API_KEY is required when AGENT_PROVIDER=deepseek.",
    );
  });

  it("allows FrontDesk llm mode with mock provider", async () => {
    delete process.env.DATABASE_URL;
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "llm";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect(kernel.mode).toBe("in_memory");
      expect((await kernel.cvAgentKernel.health()).warnings).toEqual([
        "DATABASE_URL is not set. API is running in in-memory mode.",
      ]);
    } finally {
      await kernel.close();
    }
  });

  it("throws when ExperienceExtractor llm mode uses deepseek without key and fallback is disabled", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "llm";
    process.env.ALLOW_MOCK_FALLBACK = "false";
    process.env.NODE_ENV = "test";

    await expect(createKernel()).rejects.toThrow(
      "DEEPSEEK_API_KEY is required when AGENT_PROVIDER=deepseek.",
    );
  });

  it("allows ExperienceExtractor llm mode to fall back to mock provider with warning", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "llm";
    process.env.ALLOW_MOCK_FALLBACK = "true";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect(kernel.warnings).toContain(
        "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
      );
    } finally {
      await kernel.close();
    }
  });

  it("keeps FrontDesk and ExperienceExtractor modes independently controlled", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "llm";
    process.env.ALLOW_MOCK_FALLBACK = "true";
    process.env.NODE_ENV = "test";

    const kernel = await createKernel();
    try {
      expect((await kernel.cvAgentKernel.health()).warnings).toContain(
        "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
      );
    } finally {
      await kernel.close();
    }
  });
});

class FakePostgresDatabase {
  public initializeSchemaCalled = false;
  public transactionCalled = false;
  public closeCalled = false;
  public readonly client = new FakePostgresClient();

  public async initializeSchema(): Promise<void> {
    this.initializeSchemaCalled = true;
  }

  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    return this.client.query(sql, params);
  }

  public async transaction<T>(callback: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    this.transactionCalled = true;
    return callback(this.client);
  }

  public async close(): Promise<void> {
    this.closeCalled = true;
  }
}

class FakePostgresClient implements PostgresQueryable {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}

function createMinimalGenerateResumeResult(): GenerateResumeResult {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    userId: "user-1",
    jdId: "jd-1",
    jdText: "Need React experience.",
    targetRole: "Frontend Engineer",
    requirements: [],
    retrievedExperiences: [],
    artifacts: [],
    evidenceChains: [],
    graphViews: [],
    coverageReport: {
      id: "coverage-1",
      jdId: "jd-1",
      userId: "user-1",
      totalRequirements: 0,
      coveredRequirementIds: [],
      weaklyCoveredRequirementIds: [],
      evidenceAvailableButNotUsedRequirementIds: [],
      noEvidenceRequirementIds: [],
      notTargetedRequirementIds: [],
      items: [],
      summary: "No requirements.",
      createdAt: now,
    },
    coverageGapReport: {
      id: "coverage-gap-1",
      userId: "user-1",
      jdId: "jd-1",
      items: [],
      supplementalArtifactCount: 0,
      evidenceRequestCount: 0,
      summary: "No gaps.",
      createdAt: now,
    },
    critiqueReport: {
      id: "critique-1",
      userId: "user-1",
      jdId: "jd-1",
      items: [],
      summary: "No artifacts.",
      createdAt: now,
    },
    createdAt: now,
  };
}
