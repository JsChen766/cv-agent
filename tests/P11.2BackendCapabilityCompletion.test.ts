import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createAuthResolver } from "../src/api/auth/index.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";

const ORIGINAL_ENV = { ...process.env };

describe("P11.2 Backend Capability Completion", () => {
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
      USER_API_KEY_ENCRYPTION_SECRET: "test-p11-2-secret",
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

  // ─── AUTH TESTS ────────────────────────────────────────────────

  describe("Auth", () => {
    it("cookie_session: login → /auth/me → logout → session rejected", async () => {
      await server.close();
      process.env.AUTH_MODE = "cookie_session";
      server = await createServer(kernel);

      // dev-login creates user + session + sets cookie
      const login = await server.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { email: "p11-2@example.com", displayName: "P11.2 User" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers["set-cookie"];
      expect(cookie).toBeTruthy();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");

      // /auth/me with cookie
      const me = await server.inject({
        method: "GET", url: "/auth/me", headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      const user = (me.json() as ApiSuccess<any>).data.user;
      expect(user.email).toBe("p11-2@example.com");
      // no sensitive fields leaked
      const meBody = me.body;
      expect(meBody).not.toContain("encryptedApiKey");
      expect(meBody).not.toContain("password");

      // logout
      const logout = await server.inject({
        method: "POST", url: "/auth/logout", headers: { cookie },
      });
      expect(logout.statusCode).toBe(200);

      // session should be rejected after logout (auth fails with 401 or user not found with 404)
      const meAfter = await server.inject({
        method: "GET", url: "/auth/me", headers: { cookie },
      });
      expect(meAfter.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("cookie_session: duplicate dev-login reuses existing user", async () => {
      await server.close();
      process.env.AUTH_MODE = "cookie_session";
      server = await createServer(kernel);

      const first = await server.inject({
        method: "POST", url: "/auth/dev-login",
        payload: { email: "reuse@example.com", displayName: "Reuse" },
      });
      const cookie1 = first.headers["set-cookie"];

      // Second login with same email should reuse user
      const second = await server.inject({
        method: "POST", url: "/auth/dev-login",
        payload: { email: "reuse@example.com", displayName: "Reuse Again" },
      });

      const me1 = await server.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookie1 } });
      const me2 = await server.inject({ method: "GET", url: "/auth/me", headers: { cookie: second.headers["set-cookie"] } });

      expect(me1.statusCode).toBe(200);
      expect(me2.statusCode).toBe(200);
      expect((me1.json() as ApiSuccess<any>).data.user.id).toBe((me2.json() as ApiSuccess<any>).data.user.id);
      expect((me2.json() as ApiSuccess<any>).data.user.email).toBe("reuse@example.com");
    });

    it("cookie_session: expired session is rejected", async () => {
      await server.close();
      process.env.AUTH_MODE = "cookie_session";
      server = await createServer(kernel);

      const login = await server.inject({
        method: "POST", url: "/auth/dev-login",
        payload: { email: "temporary@example.com" },
      });
      const cookieHeader = login.headers["set-cookie"];
      const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;

      // Manually revoke the session to simulate expiry/revocation
      const token = cookie?.match(/coolto_session=([^;]+)/)?.[1];
      if (token) {
        await kernel.authService.revokeSession(decodeURIComponent(token));
      }

      // Session should be rejected
      const me = await server.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      expect(me.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("rejects dev_header in production unless explicitly enabled", () => {
      process.env.NODE_ENV = "production";
      process.env.AUTH_MODE = "dev_header";
      delete process.env.ALLOW_DEV_HEADER_AUTH;
      expect(() => createAuthResolver(kernel.authService)).toThrow("AUTH_MODE=dev_header is disabled in production");
    });

    it("rejects disabled auth in production unless ALLOW_INSECURE_AUTH=true", () => {
      process.env.NODE_ENV = "production";
      process.env.AUTH_MODE = "disabled";
      delete process.env.ALLOW_INSECURE_AUTH;
      expect(() => createAuthResolver(kernel.authService)).toThrow("only allowed in tests");
    });

    it("user_api_key: create → list masked → disable → user isolation", async () => {
      // Create API key for user A
      const created = await server.inject({
        method: "POST", url: "/auth/api-keys",
        headers: { "x-user-id": "user-a", "idempotency-key": "key-a-1" },
        payload: { provider: "deepseek", label: "Key A", apiKey: "sk-secret-a-1234", model: "deepseek-chat" },
      });
      expect(created.statusCode).toBe(200);
      expect(created.body).toContain("sk-****");
      expect(created.body).not.toContain("sk-secret-a-1234");

      // List for user A returns masked key
      const listA = await server.inject({ method: "GET", url: "/auth/api-keys", headers: { "x-user-id": "user-a" } });
      expect(listA.statusCode).toBe(200);
      expect((listA.json() as ApiSuccess<any[]>).data).toHaveLength(1);
      expect(listA.body).not.toContain("sk-secret-a-1234");
      expect(listA.body).not.toContain("encryptedApiKey");

      // User B cannot see user A's keys
      const listB = await server.inject({ method: "GET", url: "/auth/api-keys", headers: { "x-user-id": "user-b" } });
      expect((listB.json() as ApiSuccess<any[]>).data).toHaveLength(0);

      // User B cannot disable user A's key
      const keyId = (created.json() as ApiSuccess<any>).data.id;
      const disableCross = await server.inject({
        method: "DELETE", url: `/auth/api-keys/${keyId}`,
        headers: { "x-user-id": "user-b", "idempotency-key": "cross-disable" },
      });
      expect(disableCross.statusCode).toBe(404);

      // User A can disable their own key
      const disable = await server.inject({
        method: "DELETE", url: `/auth/api-keys/${keyId}`,
        headers: { "x-user-id": "user-a", "idempotency-key": "disable-a" },
      });
      expect(disable.statusCode).toBe(200);
      expect((disable.json() as ApiSuccess<any>).data.status).toBe("disabled");
    });

    it("ignores body.userId in authenticated routes", async () => {
      // POST /product/experiences with spoofed body.userId
      const res = await server.inject({
        method: "POST", url: "/product/experiences",
        headers: { "x-user-id": "real-user", "idempotency-key": "body-user-id-test" },
        payload: { title: "Spoofed", content: "Content.", userId: "hijacker" },
      });
      expect(res.statusCode).toBe(200);
      // Verify the experience was created under the auth-resolved user, not the spoofed body.userId
      const listed = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "real-user" } });
      const experiences = (listed.json() as ApiSuccess<any[]>).data;
      expect(experiences.length).toBeGreaterThan(0);
      // User with hijacker id should not see this experience
      const hijackerList = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "hijacker" } });
      expect((hijackerList.json() as ApiSuccess<any[]>).data).toHaveLength(0);
    });
  });

  // ─── JOB / WORKER TESTS ────────────────────────────────────────

  describe("Job / Worker", () => {
    it("two workers cannot claim the same job", async () => {
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "job-user", type: "parse_document", input: { fileId: "test" },
        progress: 0, priority: 1, maxAttempts: 2,
      });
      const claimed1 = await kernel.platformServices.backgroundJobs.claimNextJob("worker-a", ["parse_document"]);
      const claimed2 = await kernel.platformServices.backgroundJobs.claimNextJob("worker-b", ["parse_document"]);
      expect(claimed1?.id).toBe(job.id);
      expect(claimed2).toBeNull();
    });

    it("cancelled job is not executed", async () => {
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "job-user", type: "long_generation", input: {}, progress: 0, maxAttempts: 1,
      });
      await kernel.platformServices.backgroundJobs.cancelJob("job-user", job.id);
      await kernel.jobRunner.runJob(job.id, "job-user");
      const current = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
      expect(current?.status).toBe("cancelled");
    });

    it("completed job cannot be cancelled", async () => {
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "job-user", type: "parse_document", input: { fileId: "test" },
        progress: 0, maxAttempts: 1,
      });
      await kernel.platformServices.backgroundJobs.claimNextJob("worker-a", ["parse_document"]);
      await kernel.platformServices.backgroundJobs.markCompleted("job-user", job.id, { done: true });
      await expect(
        kernel.platformServices.backgroundJobs.cancelJob("job-user", job.id),
      ).rejects.toThrow("Completed or failed");
    });

    it("failed job retries with backoff up to maxAttempts", async () => {
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "job-user", type: "parse_document", input: { fileId: "missing" },
        progress: 0, priority: 1, maxAttempts: 2,
      });
      await kernel.jobRunner.runJob(job.id, "job-user");
      const retried = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
      expect(retried?.status).toBe("pending");
      expect(retried?.nextRetryAt).toBeTruthy();
      expect(retried?.errorMessage).toContain("File not found");

      // Force retry now (clear nextRetryAt) and run again — should fail finally
      const retriedJob = { ...retried!, lockedUntil: undefined, nextRetryAt: undefined };
      await kernel.jobRunner.runJob(retriedJob.id, "job-user");
      const final = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
      expect(final?.status).toBe("failed");
    });

    it("runClaimedJob works with claimed job", async () => {
      const job = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "job-user", type: "parse_document", input: { fileId: "test" },
        progress: 0, maxAttempts: 1,
      });
      const claimed = await kernel.platformServices.backgroundJobs.claimNextJob("worker-x", ["parse_document"]);
      expect(claimed).toBeTruthy();
      await kernel.jobRunner.runClaimedJob(claimed!, "worker-x");
      const current = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
      // parse_document with missing file should fail
      expect(current?.status === "failed" || current?.status === "pending").toBeTruthy();
    });

    it("job output does not contain raw text content", async () => {
      // Upload and parse a file, then check job output
      const upload = await server.inject({
        method: "POST", url: "/files/upload",
        headers: { "x-user-id": "job-user", "idempotency-key": "output-safety" },
        payload: { fileName: "cv.txt", mimeType: "text/plain", base64: Buffer.from("My resume content: built APIs.").toString("base64") },
      });
      const file = (upload.json() as ApiSuccess<any>).data;
      const parseRes = await server.inject({
        method: "POST", url: `/files/${file.id}/parse`,
        headers: { "x-user-id": "job-user", "idempotency-key": "parse-output-safety" },
      });
      const job = (parseRes.json() as ApiSuccess<any>).data.job;
      await kernel.jobRunner.runJob(job.id, "job-user");
      const completed = await kernel.platformServices.backgroundJobs.getJob("job-user", job.id);
      const output = JSON.stringify(completed?.output);
      // Output has IDs but not the full resume text
      expect(output).not.toContain("built APIs");
    });

    it("user A cannot see user B jobs", async () => {
      const jobA = await kernel.platformServices.backgroundJobs.enqueue({
        userId: "user-a", type: "long_generation", input: {}, progress: 0,
      });
      const found = await kernel.platformServices.backgroundJobs.getJob("user-b", jobA.id);
      expect(found).toBeNull();
    });
  });

  // ─── FILE IMPORT TESTS ─────────────────────────────────────────

  describe("File Import", () => {
    it("upload txt → parse → read parsed document", async () => {
      const upload = await server.inject({
        method: "POST", url: "/files/upload",
        headers: { "x-user-id": "file-user", "idempotency-key": "fi-upload-1" },
        payload: { fileName: "resume.txt", mimeType: "text/plain", base64: Buffer.from("Built agent backends with TypeScript.").toString("base64") },
      });
      expect(upload.statusCode).toBe(200);
      const file = (upload.json() as ApiSuccess<any>).data;

      // Parse
      const parse = await server.inject({
        method: "POST", url: `/files/${file.id}/parse`,
        headers: { "x-user-id": "file-user", "idempotency-key": "fi-parse-1" },
      });
      const job = (parse.json() as ApiSuccess<any>).data.job;
      await kernel.jobRunner.runJob(job.id, "file-user");

      const doc = await server.inject({
        method: "GET", url: `/files/${file.id}/parsed-document`,
        headers: { "x-user-id": "file-user" },
      });
      expect(doc.statusCode).toBe(200);
      expect((doc.json() as ApiSuccess<any>).data.text).toContain("TypeScript");
    });

    it("rejects oversized file at validation layer", async () => {
      const { validateFile } = await import("../src/files/FileValidation.js");
      expect(() => validateFile({ originalName: "x.txt", mimeType: "text/plain", sizeBytes: 0 })).toThrow("empty");
      expect(() => validateFile({ originalName: "x.txt", mimeType: "text/plain", sizeBytes: 11 * 1024 * 1024 })).toThrow("size limit");
    });

    it("rejects mime type / extension mismatch", async () => {
      const { validateFile } = await import("../src/files/FileValidation.js");
      expect(() => validateFile({ originalName: "doc.pdf", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 100 })).toThrow("docx");
      expect(() => validateFile({ originalName: "img.png", mimeType: "image/png", sizeBytes: 100 })).toThrow("Unsupported file type");
    });

    it("malicious filename does not affect storage path", async () => {
      const upload = await server.inject({
        method: "POST", url: "/files/upload",
        headers: { "x-user-id": "file-user", "idempotency-key": "path-test" },
        payload: { fileName: "../../etc/malicious.sh", mimeType: "text/plain", base64: Buffer.from("x").toString("base64") },
      });
      expect(upload.statusCode).toBe(200);
      const file = (upload.json() as ApiSuccess<any>).data;
      expect(file.storageKey).not.toContain("..");
      expect(file.storageKey).not.toContain("etc");
      expect(file.storageKey).not.toContain("malicious");
    });

    it("import from uploaded txt creates candidates", async () => {
      const upload = await server.inject({
        method: "POST", url: "/files/upload",
        headers: { "x-user-id": "import-user", "idempotency-key": "import-1" },
        payload: { fileName: "cv.txt", mimeType: "text/plain", base64: Buffer.from("Senior Engineer\nBuilt scalable systems.\nReduced latency 40%.").toString("base64") },
      });
      const file = (upload.json() as ApiSuccess<any>).data;

      const importRes = await server.inject({
        method: "POST", url: "/product/imports/file",
        headers: { "x-user-id": "import-user", "idempotency-key": "import-file-1" },
        payload: { fileId: file.id },
      });
      expect(importRes.statusCode).toBe(200);
      const bgJob = (importRes.json() as ApiSuccess<any>).data.job;
      await kernel.jobRunner.runJob(bgJob.id, "import-user");

      const completed = await kernel.platformServices.backgroundJobs.getJob("import-user", bgJob.id);
      expect(completed?.status).toBe("completed");
      expect((completed?.output as any)?.candidateCount).toBeGreaterThan(0);
    });

    it("user A cannot access/delete/parse user B file", async () => {
      // Upload as user A
      const upload = await server.inject({
        method: "POST", url: "/files/upload",
        headers: { "x-user-id": "user-a", "idempotency-key": "isolation-a" },
        payload: { fileName: "a.txt", mimeType: "text/plain", base64: Buffer.from("A's file").toString("base64") },
      });
      const file = (upload.json() as ApiSuccess<any>).data;

      // User B cannot get it
      const getB = await server.inject({ method: "GET", url: `/files/${file.id}`, headers: { "x-user-id": "user-b" } });
      expect(getB.statusCode).toBe(404);

      // User B cannot delete it
      const delB = await server.inject({
        method: "DELETE", url: `/files/${file.id}`,
        headers: { "x-user-id": "user-b", "idempotency-key": "del-b" },
      });
      expect(delB.statusCode).toBe(404);

      // User B cannot parse it
      const parseB = await server.inject({
        method: "POST", url: `/files/${file.id}/parse`,
        headers: { "x-user-id": "user-b", "idempotency-key": "parse-b" },
      });
      expect(parseB.statusCode).toBe(404);
    });
  });

  // ─── RESUME EXPORT TESTS ───────────────────────────────────────

  describe("Resume Export", () => {
    it("create HTML export job → worker completes → download", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "export-user" },
        payload: { title: "Export Resume", targetRole: "Engineer" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;
      await server.inject({
        method: "POST", url: `/product/resumes/${resume.id}/items`,
        headers: { "x-user-id": "export-user", "idempotency-key": "item-1" },
        payload: { title: "Backend", contentSnapshot: "Built APIs.", sectionType: "experience" },
      });

      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "export-user", "idempotency-key": "exp-1" },
        payload: { format: "html" },
      });
      expect(created.statusCode).toBe(200);
      const { exportRecord, job } = (created.json() as ApiSuccess<any>).data;

      await kernel.jobRunner.runJob(job.id, "export-user");

      const detail = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}`, headers: { "x-user-id": "export-user" } });
      expect((detail.json() as ApiSuccess<any>).data.status).toBe("completed");

      const download = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}/download`, headers: { "x-user-id": "export-user" } });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toContain("text/html");
      expect(download.body).toContain("<html");
      expect(download.body).toContain("Built APIs.");
    });

    it("HTML escaping prevents script injection in export", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "export-user" },
        payload: { title: "Test", targetRole: "Dev" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;
      await server.inject({
        method: "POST", url: `/product/resumes/${resume.id}/items`,
        headers: { "x-user-id": "export-user", "idempotency-key": "xss-test" },
        payload: { title: "<script>alert('xss')</script>", contentSnapshot: "Content with <b>bold</b> & \"quotes\" & 'apos'.", sectionType: "experience" },
      });

      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "export-user", "idempotency-key": "xss-exp" },
        payload: { format: "html" },
      });
      const job = (created.json() as ApiSuccess<any>).data.job;
      await kernel.jobRunner.runJob(job.id, "export-user");
      const exportRecord = (created.json() as ApiSuccess<any>).data.exportRecord;
      const download = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}/download`, headers: { "x-user-id": "export-user" } });
      const html = download.body;
      // Script tags from content should be escaped
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      // HTML entities should be properly escaped
      expect(html).not.toContain('<b>bold</b>');
      expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
      expect(html).toContain("&quot;quotes&quot;");
      expect(html).toContain("&#39;apos&#39;");
    });

    it("user A cannot download user B export", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "user-a" },
        payload: { title: "A's Resume", targetRole: "Dev" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;
      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "user-a", "idempotency-key": "a-exp" },
        payload: { format: "html" },
      });
      const { exportRecord, job } = (created.json() as ApiSuccess<any>).data;
      await kernel.jobRunner.runJob(job.id, "user-a");

      // User B cannot access
      const detailB = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}`, headers: { "x-user-id": "user-b" } });
      expect(detailB.statusCode).toBe(404);

      // User B cannot download
      const dlB = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}/download`, headers: { "x-user-id": "user-b" } });
      expect(dlB.statusCode).toBe(404);
    });

    it("PDF_RENDERER=none returns error for PDF format", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "export-user" },
        payload: { title: "PDF Test", targetRole: "Dev" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;

      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "export-user", "idempotency-key": "pdf-test" },
        payload: { format: "pdf" },
      });
      // PDF with no renderer: returns error response
      expect(created.statusCode).toBeGreaterThanOrEqual(400);
      expect(created.body).toContain("PDF");
    });

    it("download pending export returns 404", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "export-user" },
        payload: { title: "Pending Test", targetRole: "Dev" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;
      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "export-user", "idempotency-key": "pending-exp" },
        payload: { format: "html" },
      });
      const exportRecord = (created.json() as ApiSuccess<any>).data.exportRecord;

      // Download before completion
      const download = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}/download`, headers: { "x-user-id": "export-user" } });
      expect(download.statusCode).toBe(404);
      expect(download.body).toContain("not ready");
    });

    it("missing template falls back to default", async () => {
      const resumeRes = await server.inject({
        method: "POST", url: "/product/resumes",
        headers: { "x-user-id": "export-user" },
        payload: { title: "Template Test", targetRole: "Dev" },
      });
      const resume = (resumeRes.json() as ApiSuccess<any>).data;

      // Request with non-existent template
      const created = await server.inject({
        method: "POST", url: `/exports/resumes/${resume.id}`,
        headers: { "x-user-id": "export-user", "idempotency-key": "tpl-test" },
        payload: { format: "html", templateId: "nonexistent-template-v99" },
      });
      expect(created.statusCode).toBe(200);
      const job = (created.json() as ApiSuccess<any>).data.job;
      await kernel.jobRunner.runJob(job.id, "export-user");
      const exportRecord = (created.json() as ApiSuccess<any>).data.exportRecord;
      const detail = await server.inject({ method: "GET", url: `/exports/${exportRecord.id}`, headers: { "x-user-id": "export-user" } });
      // Should have completed successfully using default template
      expect((detail.json() as ApiSuccess<any>).data.status).toBe("completed");
    });
  });

  // ─── E2E SMOKE TEST ────────────────────────────────────────────

  it("completes abbreviated E2E flow: upload → parse → import → export", async () => {
    // Upload
    const up = await server.inject({
      method: "POST", url: "/files/upload",
      headers: { "x-user-id": "e2e", "idempotency-key": "e2e-up" },
      payload: { fileName: "cv.txt", mimeType: "text/plain", base64: Buffer.from("Built APIs and workers.").toString("base64") },
    });
    const file = (up.json() as ApiSuccess<any>).data;

    // Parse
    const parse = await server.inject({ method: "POST", url: `/files/${file.id}/parse`, headers: { "x-user-id": "e2e", "idempotency-key": "e2e-parse" } });
    const parseJob = (parse.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(parseJob.id, "e2e");

    // Import
    const imp = await server.inject({ method: "POST", url: "/product/imports/file", headers: { "x-user-id": "e2e", "idempotency-key": "e2e-imp" }, payload: { fileId: file.id } });
    const impJob = (imp.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(impJob.id, "e2e");
    const impCompleted = await kernel.platformServices.backgroundJobs.getJob("e2e", impJob.id);
    expect(impCompleted?.status).toBe("completed");
    expect((impCompleted?.output as any)?.candidateCount).toBeGreaterThan(0);

    // Export
    const resumeRes = await server.inject({ method: "POST", url: "/product/resumes", headers: { "x-user-id": "e2e" }, payload: { title: "E2E Resume", targetRole: "Dev" } });
    const resume = (resumeRes.json() as ApiSuccess<any>).data;
    await server.inject({ method: "POST", url: `/product/resumes/${resume.id}/items`, headers: { "x-user-id": "e2e" }, payload: { title: "Item", contentSnapshot: "Built APIs.", sectionType: "experience" } });
    const exp = await server.inject({ method: "POST", url: `/exports/resumes/${resume.id}`, headers: { "x-user-id": "e2e" }, payload: { format: "html" } });
    const expJob = (exp.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(expJob.id, "e2e");
    const expRecord = (exp.json() as ApiSuccess<any>).data.exportRecord;
    const dl = await server.inject({ method: "GET", url: `/exports/${expRecord.id}/download`, headers: { "x-user-id": "e2e" } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("<html");
    expect(dl.body).toContain("Built APIs.");

    // User isolation
    const hidden = await server.inject({ method: "GET", url: `/files/${file.id}`, headers: { "x-user-id": "other" } });
    expect(hidden.statusCode).toBe(404);

    // No sensitive leaks
    for (const pattern of ["reasoning_content", "provider_raw", "system_prompt", "tool_internal_args"]) {
      expect(dl.body).not.toContain(pattern);
    }
  });
});
