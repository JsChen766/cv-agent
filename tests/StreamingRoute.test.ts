import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";

describe("Streaming generation route", () => {
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

  it("returns NDJSON progress events and a final result", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/stream",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        jdText: "React TypeScript role.",
        targetRole: "Frontend Engineer",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.body).toContain("\"event\"");
    expect(response.body).toContain("\"kernel.started\"");
    expect(response.body).toContain("\"final\"");
  });

  it("rejects missing x-user-id before opening the stream", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/stream",
      payload: {
        jdText: "React TypeScript role.",
        targetRole: "Frontend Engineer",
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
