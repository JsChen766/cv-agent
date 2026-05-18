import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { PostgresPlatformServices } from "../src/platform/PostgresPlatformServices.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { PostgresQueryResult, PostgresQueryable } from "../src/persistence/postgres/PostgresDatabase.js";

const ORIGINAL_ENV = { ...process.env };

describe("backend hardening v2", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "mock",
      FRONTDESK_AGENT_MODE: "fake",
      EXPERIENCE_EXTRACTOR_MODE: "deterministic",
      ARTIFACT_GENERATOR_MODE: "deterministic",
      CRITIC_AGENT_MODE: "deterministic",
      REVISION_AGENT_MODE: "deterministic",
    };
    delete process.env.DATABASE_URL;
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.DEBUG_ROUTES_ENABLED;
    delete process.env.DEBUG_AGENT_RUNS_ENABLED;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses auth-resolved user for rate limits instead of x-user-id", async () => {
    await server.close();
    await kernel.close();
    process.env.AUTH_MODE = "bearer_static";
    process.env.AUTH_STATIC_BEARER_TOKEN = "secret";
    process.env.AUTH_STATIC_USER_ID = "static-user";
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PER_USER_PER_MINUTE = "1";
    kernel = await createKernel();
    server = await createServer(kernel);

    const first = await server.inject({
      method: "GET",
      url: "/product/experiences",
      headers: { authorization: "Bearer secret", "x-user-id": "spoof-a" },
    });
    const second = await server.inject({
      method: "GET",
      url: "/product/experiences",
      headers: { authorization: "Bearer secret", "x-user-id": "spoof-b" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
  });

  it("does not consume user quota before auth succeeds", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PER_USER_PER_MINUTE = "1";

    const missing = await server.inject({ method: "GET", url: "/product/experiences" });
    const valid = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "auth-rate-user" } });

    expect(missing.statusCode).toBe(401);
    expect(valid.statusCode).toBe(200);
  });

  it("covers mutating product routes with idempotency", async () => {
    const resume = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "idem-product" },
      payload: { title: "Main resume" },
    });
    const resumeId = (resume.json() as ApiSuccess<any>).data.id;
    const itemPayload = { title: "Impact", contentSnapshot: "Reduced latency by 20%.", sectionType: "experience" };
    const firstItem = await server.inject({
      method: "POST",
      url: `/product/resumes/${resumeId}/items`,
      headers: { "x-user-id": "idem-product", "idempotency-key": "resume-item-key" },
      payload: itemPayload,
    });
    const replayItem = await server.inject({
      method: "POST",
      url: `/product/resumes/${resumeId}/items`,
      headers: { "x-user-id": "idem-product", "idempotency-key": "resume-item-key" },
      payload: itemPayload,
    });
    const itemId = (firstItem.json() as ApiSuccess<any>).data.id;
    const firstPatch = await server.inject({
      method: "PATCH",
      url: `/product/resume-items/${itemId}`,
      headers: { "x-user-id": "idem-product", "idempotency-key": "resume-item-patch-key" },
      payload: { title: "Updated impact" },
    });
    const replayPatch = await server.inject({
      method: "PATCH",
      url: `/product/resume-items/${itemId}`,
      headers: { "x-user-id": "idem-product", "idempotency-key": "resume-item-patch-key" },
      payload: { title: "Updated impact" },
    });

    expect(firstItem.statusCode).toBe(200);
    expect(replayItem.json()).toEqual(firstItem.json());
    expect(firstPatch.statusCode).toBe(200);
    expect(replayPatch.json()).toEqual(firstPatch.json());
  });

  it("rejects idempotency keys on copilot SSE stream", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "stream-idem", "idempotency-key": "stream-key" },
      payload: { message: "hello" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_BODY");
  });

  it("gates debug agent run routes behind explicit debug env", async () => {
    const blocked = await server.inject({ method: "GET", url: "/debug/agent-runs", headers: { "x-user-id": "debug-user" } });
    process.env.DEBUG_ROUTES_ENABLED = "true";
    const missingAuth = await server.inject({ method: "GET", url: "/debug/agent-runs" });
    const allowed = await server.inject({ method: "GET", url: "/debug/agent-runs", headers: { "x-user-id": "debug-user" } });

    expect(blocked.statusCode).toBe(403);
    expect(missingAuth.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).not.toContain("DATABASE_URL");
    expect(allowed.body).not.toContain("API_KEY");
  });

  it("uses atomic postgres idempotency upsert semantics", async () => {
    const database = new FakePostgresDatabase();
    const services = new PostgresPlatformServices(database);
    const first = await services.idempotency.begin({
      userId: "pg-user",
      key: "key-1",
      requestMethod: "POST",
      requestPath: "/product/experiences",
      requestHash: "hash-a",
    });
    const pending = await services.idempotency.begin({
      userId: "pg-user",
      key: "key-1",
      requestMethod: "POST",
      requestPath: "/product/experiences",
      requestHash: "hash-a",
    });
    await services.idempotency.complete("pg-user", "key-1", 200, { ok: true });
    const replay = await services.idempotency.begin({
      userId: "pg-user",
      key: "key-1",
      requestMethod: "POST",
      requestPath: "/product/experiences",
      requestHash: "hash-a",
    });
    const conflict = await services.idempotency.begin({
      userId: "pg-user",
      key: "key-1",
      requestMethod: "POST",
      requestPath: "/product/experiences",
      requestHash: "hash-b",
    });
    const otherUser = await services.idempotency.begin({
      userId: "pg-user-2",
      key: "key-1",
      requestMethod: "POST",
      requestPath: "/product/experiences",
      requestHash: "hash-b",
    });

    expect(first.type).toBe("started");
    expect(pending.type).toBe("conflict");
    expect(replay.type).toBe("replay");
    expect(conflict.type).toBe("conflict");
    expect(otherUser.type).toBe("started");
    expect(database.sqlLog.some((sql) => sql.includes("ON CONFLICT (user_id, key)"))).toBe(true);
  });

  it("uses atomic postgres session lock upsert semantics", async () => {
    const database = new FakePostgresDatabase();
    const services = new PostgresPlatformServices(database);
    const first = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-1", ttlMs: 1000 });
    const reentrant = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-1", ttlMs: 1000 });
    const blocked = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-2", ttlMs: 1000 });
    await services.sessionLocks.release({ userId: "lock-user", sessionId: "s1", ownerRequestId: "wrong-owner" });
    const stillBlocked = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-2", ttlMs: 1000 });
    await services.sessionLocks.release({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-1" });
    const reacquired = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-2", ttlMs: 1000 });
    const otherSession = await services.sessionLocks.acquire({ userId: "lock-user", sessionId: "s2", ownerRequestId: "req-3", ttlMs: 1000 });

    expect(first).toBe(true);
    expect(reentrant).toBe(true);
    expect(blocked).toBe(false);
    expect(stillBlocked).toBe(false);
    expect(reacquired).toBe(true);
    expect(otherSession).toBe(true);
    expect(database.sqlLog.some((sql) => sql.includes("ON CONFLICT (session_id)"))).toBe(true);
  });
});

class FakePostgresDatabase implements PostgresQueryable {
  public readonly sqlLog: string[] = [];
  private readonly idempotency = new Map<string, any>();
  private readonly locks = new Map<string, any>();

  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.sqlLog.push(normalized);
    if (normalized.startsWith("INSERT INTO api_idempotency_key")) return this.insertIdempotency(params) as PostgresQueryResult<Row>;
    if (normalized.startsWith("SELECT * FROM api_idempotency_key")) return this.selectIdempotency(params) as PostgresQueryResult<Row>;
    if (normalized.startsWith("UPDATE api_idempotency_key SET status='completed'")) return this.completeIdempotency(params) as PostgresQueryResult<Row>;
    if (normalized.startsWith("UPDATE api_idempotency_key SET status='failed'")) return this.failIdempotency(params) as PostgresQueryResult<Row>;
    if (normalized.startsWith("INSERT INTO copilot_session_lock")) return this.insertLock(params) as PostgresQueryResult<Row>;
    if (normalized.startsWith("DELETE FROM copilot_session_lock")) return this.releaseLock(params) as PostgresQueryResult<Row>;
    return { rows: [], rowCount: 0 };
  }

  private insertIdempotency(params: unknown[]): PostgresQueryResult {
    const [id, userId, key, requestMethod, requestPath, requestHash, createdAt, updatedAt, expiresAt, now] = params as string[];
    const mapKey = `${userId}:${key}`;
    const existing = this.idempotency.get(mapKey);
    if (!existing || new Date(existing.expires_at).getTime() <= new Date(now).getTime()) {
      const row = {
        id,
        user_id: userId,
        key,
        request_method: requestMethod,
        request_path: requestPath,
        request_hash: requestHash,
        status: "pending",
        response_status: null,
        response_body_json: null,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
      };
      this.idempotency.set(mapKey, row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  private selectIdempotency(params: unknown[]): PostgresQueryResult {
    const [userId, key] = params as string[];
    const row = this.idempotency.get(`${userId}:${key}`);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  private completeIdempotency(params: unknown[]): PostgresQueryResult {
    const [userId, key, status, body, updatedAt] = params as [string, string, number, unknown, string];
    const row = this.idempotency.get(`${userId}:${key}`);
    if (row) {
      row.status = "completed";
      row.response_status = status;
      row.response_body_json = body;
      row.updated_at = updatedAt;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  private failIdempotency(params: unknown[]): PostgresQueryResult {
    const [userId, key, updatedAt] = params as [string, string, string];
    const row = this.idempotency.get(`${userId}:${key}`);
    if (row) {
      row.status = "failed";
      row.updated_at = updatedAt;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  private insertLock(params: unknown[]): PostgresQueryResult {
    const [sessionId, userId, ownerRequestId, lockedUntil, createdAt, updatedAt, now] = params as string[];
    const existing = this.locks.get(sessionId);
    if (!existing || new Date(existing.locked_until).getTime() <= new Date(now).getTime() || (existing.user_id === userId && existing.owner_request_id === ownerRequestId)) {
      const row = { session_id: sessionId, user_id: userId, owner_request_id: ownerRequestId, locked_until: lockedUntil, created_at: existing?.created_at ?? createdAt, updated_at: updatedAt };
      this.locks.set(sessionId, row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  private releaseLock(params: unknown[]): PostgresQueryResult {
    const [sessionId, userId, ownerRequestId] = params as string[];
    const row = this.locks.get(sessionId);
    if (row?.user_id === userId && row.owner_request_id === ownerRequestId) {
      this.locks.delete(sessionId);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}
