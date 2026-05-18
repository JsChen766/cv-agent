import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { ArtifactDecisionRecord } from "../src/application/decisions/index.js";

describe("API server artifact decision routes", () => {
  let originalDatabaseUrl: string | undefined;
  let originalAuthMode: string | undefined;
  let originalAgentProvider: string | undefined;
  let originalFrontDeskAgentMode: string | undefined;
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalAuthMode = process.env.AUTH_MODE;
    originalAgentProvider = process.env.AGENT_PROVIDER;
    originalFrontDeskAgentMode = process.env.FRONTDESK_AGENT_MODE;
    delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
    restoreEnv("AUTH_MODE", originalAuthMode);
    restoreEnv("AGENT_PROVIDER", originalAgentProvider);
    restoreEnv("FRONTDESK_AGENT_MODE", originalFrontDeskAgentMode);
  });

  it("records accept decisions with authenticated user scope", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/decisions",
      headers: {
        "x-user-id": "test-user",
      },
      payload: {
        userId: "attacker",
        artifactId: "artifact-1",
        sessionId: "session-1",
        decision: "accept",
        reason: "Best variant.",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<ArtifactDecisionRecord>;
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      userId: "test-user",
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "accept",
      reason: "Best variant.",
    });
  });

  it("records confirm_metric details", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/decisions",
      headers: {
        "x-user-id": "test-user",
      },
      payload: {
        artifactId: "artifact-1",
        sessionId: "session-1",
        decision: "confirm_metric",
        confirmation: {
          metric: "report preparation time",
          value: "from 2 hours to 20 minutes",
          explanation: "Confirmed by internal workflow logs.",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<ArtifactDecisionRecord>;
    expect(body.data.confirmation).toEqual({
      metric: "report preparation time",
      value: "from 2 hours to 20 minutes",
      explanation: "Confirmed by internal workflow logs.",
    });
  });

  it("lists artifact decisions by artifact and user", async () => {
    const first = await postDecision("test-user", {
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "accept",
      reason: "Best variant.",
    }, server);
    const second = await postDecision("test-user", {
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "reject",
      reason: "Changed my mind.",
    }, server);
    await postDecision("other-user", {
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "accept",
    }, server);

    const artifactResponse = await server.inject({
      method: "GET",
      url: "/generations/artifacts/artifact-1/decisions",
      headers: {
        "x-user-id": "test-user",
      },
    });
    const artifactBody = artifactResponse.json() as ApiSuccess<ArtifactDecisionRecord[]>;
    expect(artifactResponse.statusCode).toBe(200);
    expect(artifactBody.data).toHaveLength(2);
    expect(artifactBody.data.map((record) => record.id)).toEqual([first.id, second.id]);
    expect(artifactBody.data.every((record) => record.userId === "test-user")).toBe(true);
  });

  it("lists artifact decisions by session", async () => {
    const posted = await postDecision("test-user", {
      artifactId: "artifact-1",
      sessionId: "session-1",
      decision: "prefer_variant",
      selectedVariantId: "artifact-variant-1",
    }, server);

    const sessionResponse = await server.inject({
      method: "GET",
      url: "/generations/session-1/artifact-decisions",
      headers: {
        "x-user-id": "test-user",
      },
    });
    const sessionBody = sessionResponse.json() as ApiSuccess<ArtifactDecisionRecord[]>;
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionBody.data).toHaveLength(1);
    expect(sessionBody.data[0]?.id).toBe(posted.id);
  });

  it("rejects decision writes without x-user-id", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/decisions",
      payload: {
        artifactId: "artifact-1",
        decision: "accept",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
      },
    });
  });

  it("rejects invalid decisions", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/decisions",
      headers: {
        "x-user-id": "test-user",
      },
      payload: {
        artifactId: "artifact-1",
        decision: "unknown",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_BODY",
      },
    });
  });
});

async function postDecision(
  userId: string,
  payload: Record<string, unknown>,
  server: Awaited<ReturnType<typeof createServer>>,
): Promise<ArtifactDecisionRecord> {
  const response = await server.inject({
    method: "POST",
    url: "/generations/artifacts/decisions",
    headers: {
      "x-user-id": userId,
    },
    payload,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as ApiSuccess<ArtifactDecisionRecord>).data;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
