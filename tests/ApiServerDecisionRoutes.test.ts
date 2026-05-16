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

  it("records and lists artifact decisions", async () => {
    const postResponse = await server.inject({
      method: "POST",
      url: "/generations/artifacts/decisions",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        userId: "attacker",
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

    expect(postResponse.statusCode).toBe(200);
    const posted = postResponse.json() as ApiSuccess<ArtifactDecisionRecord>;
    expect(posted.data.userId).toBe("user-1");
    expect(posted.data.decision).toBe("confirm_metric");

    const artifactResponse = await server.inject({
      method: "GET",
      url: "/generations/artifacts/artifact-1/decisions",
      headers: {
        "x-user-id": "user-1",
      },
    });
    const artifactBody = artifactResponse.json() as ApiSuccess<ArtifactDecisionRecord[]>;
    expect(artifactResponse.statusCode).toBe(200);
    expect(artifactBody.data).toHaveLength(1);
    expect(artifactBody.data[0]?.id).toBe(posted.data.id);

    const sessionResponse = await server.inject({
      method: "GET",
      url: "/generations/session-1/artifact-decisions",
      headers: {
        "x-user-id": "user-1",
      },
    });
    const sessionBody = sessionResponse.json() as ApiSuccess<ArtifactDecisionRecord[]>;
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionBody.data).toHaveLength(1);
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
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
