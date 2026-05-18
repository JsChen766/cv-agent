import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createAuthResolver } from "../src/api/auth/index.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";

const ORIGINAL_ENV = { ...process.env };

describe("P11 product backend completion", () => {
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
      FILE_UPLOAD_ENABLED: "true",
      FILE_STORAGE_PROVIDER: "memory",
      USER_API_KEY_ENCRYPTION_SECRET: "test-secret",
    };
    delete process.env.DATABASE_URL;
    delete process.env.INTERNAL_KERNEL_ROUTES_ENABLED;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
    process.env = { ...ORIGINAL_ENV };
  });

  it("supports dev-login cookie sessions and /auth/me", async () => {
    await server.close();
    process.env.AUTH_MODE = "cookie_session";
    server = await createServer(kernel);

    const login = await server.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: "cookie@example.com", displayName: "Cookie User" },
    });
    const cookie = login.headers["set-cookie"];
    const me = await server.inject({ method: "GET", url: "/auth/me", headers: { cookie } });

    expect(login.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
    expect((me.json() as ApiSuccess<any>).data.user.email).toBe("cookie@example.com");
  });

  it("rejects dev_header auth resolver in production unless explicitly enabled", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "dev_header";
    delete process.env.ALLOW_DEV_HEADER_AUTH;
    expect(() => createAuthResolver(kernel.authService)).toThrow("AUTH_MODE=dev_header is disabled in production");
  });

  it("stores user API keys encrypted and returns only masked keys", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/auth/api-keys",
      headers: { "x-user-id": "key-user", "idempotency-key": "api-key-1" },
      payload: { provider: "deepseek", label: "DeepSeek", apiKey: "sk-secret-1234", model: "deepseek-chat" },
    });
    const listed = await server.inject({ method: "GET", url: "/auth/api-keys", headers: { "x-user-id": "key-user" } });
    const disabled = await server.inject({ method: "DELETE", url: `/auth/api-keys/${(created.json() as ApiSuccess<any>).data.id}`, headers: { "x-user-id": "key-user", "idempotency-key": "api-key-disable-1" } });

    expect(created.statusCode).toBe(200);
    expect(created.body).toContain("sk-****1234");
    expect(created.body).not.toContain("sk-secret-1234");
    expect((listed.json() as ApiSuccess<any[]>).data).toHaveLength(1);
    expect((disabled.json() as ApiSuccess<any>).data.status).toBe("disabled");
  });

  it("gates internal kernel routes without affecting public routes", async () => {
    await server.close();
    process.env.INTERNAL_KERNEL_ROUTES_ENABLED = "false";
    server = await createServer(kernel);

    const internal = await server.inject({ method: "POST", url: "/generations", headers: { "x-user-id": "boundary-user" }, payload: { jdText: "React", targetRole: "Frontend" } });
    const publicRoute = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "boundary-user" } });

    expect(internal.statusCode).toBe(404);
    expect(publicRoute.statusCode).toBe(200);
  });

  it("uploads and parses text files through background jobs with user isolation", async () => {
    const upload = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "file-user", "idempotency-key": "file-upload-1" },
      payload: { fileName: "resume.txt", mimeType: "text/plain", base64: Buffer.from("Built agent backends.").toString("base64") },
    });
    const file = (upload.json() as ApiSuccess<any>).data;
    const hidden = await server.inject({ method: "GET", url: `/files/${file.id}`, headers: { "x-user-id": "other-user" } });
    const parse = await server.inject({ method: "POST", url: `/files/${file.id}/parse`, headers: { "x-user-id": "file-user", "idempotency-key": "parse-file-1" } });
    const job = (parse.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(job.id, "file-user");
    const parsed = await server.inject({ method: "GET", url: `/files/${file.id}/parsed-document`, headers: { "x-user-id": "file-user" } });

    expect(upload.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);
    expect(parsed.statusCode).toBe(200);
    expect((parsed.json() as ApiSuccess<any>).data.text).toContain("Built agent backends.");
  });

  it("claims jobs once, tracks progress, retries failures, and cancels pending jobs", async () => {
    const job = await kernel.platformServices.backgroundJobs.enqueue({
      userId: "job-user",
      type: "parse_document",
      input: { fileId: "missing-file" },
      progress: 0,
      priority: 1,
      maxAttempts: 2,
    });
    const claimed = await kernel.platformServices.backgroundJobs.claimNextJob("worker-a", ["parse_document"]);
    const blocked = await kernel.platformServices.backgroundJobs.claimNextJob("worker-b", ["parse_document"]);
    await kernel.platformServices.backgroundJobs.markProgress("job-user", job.id, 40, "Parsing");
    await kernel.jobRunner.runJob(job.id, "job-user");
    const retried = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
    const cancelJob = await kernel.platformServices.backgroundJobs.enqueue({ userId: "job-user", type: "long_generation", input: {}, progress: 0, priority: 0, maxAttempts: 1 });
    const cancelled = await kernel.platformServices.backgroundJobs.cancelJob("job-user", cancelJob.id);

    expect(claimed?.id).toBe(job.id);
    expect(blocked).toBeNull();
    expect(retried?.status).toBe("pending");
    expect(retried?.errorMessage).toContain("File not found");
    expect(cancelled?.status).toBe("cancelled");
  });

  it("creates resume HTML export jobs and downloads completed exports", async () => {
    const resumeResponse = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "export-user" },
      payload: { title: "Export Resume", targetRole: "Agent Engineer" },
    });
    const resume = (resumeResponse.json() as ApiSuccess<any>).data;
    await server.inject({
      method: "POST",
      url: `/product/resumes/${resume.id}/items`,
      headers: { "x-user-id": "export-user", "idempotency-key": "export-item-1" },
      payload: { title: "Backend", contentSnapshot: "Built durable agent systems.", sectionType: "experience" },
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "export-user", "idempotency-key": "export-1" },
      payload: { format: "html" },
    });
    const exportRecord = (created.json() as ApiSuccess<any>).data.exportRecord;
    const job = (created.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(job.id, "export-user");
    const detail = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}`, headers: { "x-user-id": "export-user" } });
    const download = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}/download`, headers: { "x-user-id": "export-user" } });
    const hidden = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}`, headers: { "x-user-id": "other-user" } });

    expect(created.statusCode).toBe(200);
    expect((detail.json() as ApiSuccess<any>).data.status).toBe("completed");
    expect(download.body).toContain("Built durable agent systems.");
    expect(hidden.statusCode).toBe(404);
  });

  it("imports uploaded files into product import candidates", async () => {
    const upload = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "import-file-user", "idempotency-key": "import-file-upload-1" },
      payload: { fileName: "resume.txt", mimeType: "text/plain", base64: Buffer.from("Backend Platform\nBuilt APIs and workers.").toString("base64") },
    });
    const file = (upload.json() as ApiSuccess<any>).data;
    const created = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "import-file-user", "idempotency-key": "import-file-1" },
      payload: { fileId: file.id },
    });
    const job = (created.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(job.id, "import-file-user");
    const completed = await kernel.platformServices.backgroundJobs.getJob("import-file-user", job.id);

    expect(created.statusCode).toBe(200);
    expect(completed?.status).toBe("completed");
    expect(completed?.output?.candidateCount).toBeGreaterThan(0);
  });

  it("resolves user via bearer_static auth and ignores body.userId", async () => {
    // Create the user first so /auth/me can resolve it
    await kernel.authService.createUser({
      email: "static@example.com",
      authProvider: "static",
    });
    // The user id generated by createUser is random; use the known static id approach instead
    // by accessing the created user and using their actual id
    const createdUser = await kernel.authService.createUser({
      email: "static2@example.com",
      displayName: "Static User",
      authProvider: "static",
    });

    await server.close();
    process.env.AUTH_MODE = "bearer_static";
    process.env.AUTH_STATIC_BEARER_TOKEN = "static-token-123";
    process.env.AUTH_STATIC_USER_ID = createdUser.id;
    server = await createServer(kernel);

    const me = await server.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer static-token-123" },
    });

    expect(me.statusCode).toBe(200);
    expect((me.json() as ApiSuccess<any>).data.user.id).toBe(createdUser.id);

    // body.userId should be ignored — experience should be scoped to the resolved user
    const created = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: {
        authorization: "Bearer static-token-123",
        "idempotency-key": "bearer-static-1",
      },
      payload: { title: "Owned by static-user", content: "Content.", userId: "hijacker" },
    });

    const listed = await server.inject({
      method: "GET",
      url: "/product/experiences",
      headers: { authorization: "Bearer static-token-123" },
    });
    const experiences = (listed.json() as ApiSuccess<any[]>).data;
    expect(experiences.length).toBeGreaterThan(0);
    expect(experiences[0].userId).toBe(createdUser.id);
  });

  it("rejects AUTH_MODE=disabled in production unless ALLOW_INSECURE_AUTH=true", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "disabled";
    delete process.env.ALLOW_INSECURE_AUTH;
    expect(() => createAuthResolver(kernel.authService)).toThrow("AUTH_MODE=disabled is only allowed in tests");

    process.env.ALLOW_INSECURE_AUTH = "true";
    expect(() => createAuthResolver(kernel.authService)).not.toThrow();
  });

  it("rejects oversized files and unsupported MIME types", async () => {
    // Test file validation at service level (HTTP body size limit would reject large base64 payloads first)
    const { validateFile, assertFileUploadEnabled } = await import("../src/files/FileValidation.js");

    // Oversized file
    expect(() => validateFile({
      originalName: "big.txt",
      mimeType: "text/plain",
      sizeBytes: 11 * 1024 * 1024, // 11 MB
    })).toThrow("size limit");

    // Unsupported MIME type
    expect(() => validateFile({
      originalName: "image.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    })).toThrow("Unsupported file type");

    // Extension mismatch
    expect(() => validateFile({
      originalName: "doc.pdf",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 1024,
    })).toThrow("docx");

    // Empty file
    expect(() => validateFile({
      originalName: "empty.txt",
      mimeType: "text/plain",
      sizeBytes: 0,
    })).toThrow("empty");

    // Valid file should pass
    expect(() => validateFile({
      originalName: "valid.txt",
      mimeType: "text/plain",
      sizeBytes: 1024,
    })).not.toThrow();
  });

  it("prevents path traversal via user-supplied filenames", async () => {
    const upload = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "file-user", "idempotency-key": "pathtraversal-1" },
      payload: { fileName: "../../etc/passwd", mimeType: "text/plain", base64: Buffer.from("safe").toString("base64") },
    });
    expect(upload.statusCode).toBe(200);
    const file = (upload.json() as ApiSuccess<any>).data;
    // storage_key must not contain the user-supplied path
    expect(file.storageKey).not.toContain("..");
    expect(file.storageKey).not.toContain("etc");
    expect(file.storageKey).not.toContain("passwd");
  });

  it("does not expose sensitive content in API responses", async () => {
    const userId = "sensitive-user";

    // Verify API response envelope never leaks sensitive data
    const me = await server.inject({ method: "GET", url: "/auth/me", headers: { "x-user-id": userId } });
    // /auth/me returns 404 if user doesn't exist in DB (dev_header resolves id but getUserById fails)
    // The response body still must not leak sensitive patterns
    const meBody = me.body;

    const sensitivePatterns = ["reasoning_content", "chain_of_thought", "chain-of-thought", "provider_raw", "system_prompt", "tool_internal_args"];
    for (const pattern of sensitivePatterns) {
      expect(meBody).not.toContain(pattern);
    }

    // Create an API key and verify listing never returns raw key
    await server.inject({
      method: "POST",
      url: "/auth/api-keys",
      headers: { "x-user-id": userId, "idempotency-key": "sensitive-apikey-1" },
      payload: { provider: "deepseek", label: "test", apiKey: "sk-very-secret-value-abc", model: "deepseek-chat" },
    });
    const listed = await server.inject({ method: "GET", url: "/auth/api-keys", headers: { "x-user-id": userId } });
    const listedBody = listed.body;

    expect(listedBody).not.toContain("sk-very-secret-value-abc");
    expect(listedBody).toContain("sk-****");
    expect(listedBody).not.toContain("encryptedApiKey");
  });

  it("returns safe error for PDF export with PDF_RENDERER=none", async () => {
    // Verify the default PDF_RENDERER is "none" (from env)
    expect(process.env.PDF_RENDERER ?? "none").toBe("none");

    const resumeResponse = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "export-user" },
      payload: { title: "PDF Resume", targetRole: "Engineer" },
    });
    const resume = (resumeResponse.json() as ApiSuccess<any>).data;

    // PDF export should return an error because the renderer is not configured
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "export-user", "idempotency-key": "pdf-export-none-1" },
      payload: { format: "pdf" },
    });

    // The route returns 5xx because createExport throws for PDF when PDF_RENDERER=none
    // The error is mapped to INTERNAL_ERROR (safe error, no stack trace or internal detail)
    expect(created.statusCode).toBeGreaterThanOrEqual(400);
    expect(created.body).toContain("INTERNAL_ERROR");
  });
});
