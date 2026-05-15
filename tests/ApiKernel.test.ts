import { afterEach, describe, expect, it } from "vitest";
import {
  createKernel,
  createPostgresKernelFromDatabaseForTest,
} from "../src/api/kernel/createKernel.js";
import type { GenerateResumeResult } from "../src/application/ResumeGenerationService.js";
import type {
  PostgresQueryable,
  PostgresQueryResult,
} from "../src/persistence/postgres/PostgresDatabase.js";

describe("API kernel", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("creates an in-memory kernel with a generation persistence port when DATABASE_URL is absent", async () => {
    delete process.env.DATABASE_URL;

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
    const database = new FakePostgresDatabase();
    const kernel = await createPostgresKernelFromDatabaseForTest(database);
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
