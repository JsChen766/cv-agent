import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";

const ORIGINAL_ENV = { ...process.env };

describe("Product backend E2E main flow", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  const userId = "e2e-user";

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
      USER_API_KEY_ENCRYPTION_SECRET: "test-e2e-secret",
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

  const headers = (extra: Record<string, string> = {}) => ({
    "x-user-id": userId,
    ...extra,
  });

  it("completes the full main flow: upload → parse → import → accept → JD → generate → export → download", async () => {
    // Step 1: Upload a text resume file
    const uploadRes = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: headers({ "idempotency-key": "e2e-upload" }),
      payload: {
        fileName: "resume.txt",
        mimeType: "text/plain",
        base64: Buffer.from(
          "Senior Engineer at TechCo\nBuilt scalable APIs with Node.js and TypeScript.\nReduced latency by 40% through query optimization."
        ).toString("base64"),
      },
    });
    expect(uploadRes.statusCode).toBe(200);
    const file = (uploadRes.json() as ApiSuccess<any>).data;
    expect(file.id).toBeTruthy();
    expect(file.userId).toBe(userId);

    // Step 2: Parse the file via background job
    const parseRes = await server.inject({
      method: "POST",
      url: `/files/${file.id}/parse`,
      headers: headers({ "idempotency-key": "e2e-parse" }),
    });
    expect(parseRes.statusCode).toBe(200);
    const parseJob = (parseRes.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(parseJob.id, userId);
    const parsedDocRes = await server.inject({
      method: "GET",
      url: `/files/${file.id}/parsed-document`,
      headers: headers(),
    });
    expect(parsedDocRes.statusCode).toBe(200);
    const parsedDoc = (parsedDocRes.json() as ApiSuccess<any>).data;
    expect(parsedDoc.text).toContain("Node.js");

    // Step 3: Import from file → creates candidates
    const importRes = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: headers({ "idempotency-key": "e2e-import" }),
      payload: { fileId: file.id },
    });
    expect(importRes.statusCode).toBe(200);
    const importJob = (importRes.json() as ApiSuccess<any>).data.job;
    await kernel.jobRunner.runJob(importJob.id, userId);
    // The background job output contains the product import job ID
    const completedImportJob = await kernel.platformServices.backgroundJobs.getJob(userId, importJob.id);
    const productImportId = (completedImportJob?.output as Record<string, unknown>)?.importJobId as string;

    const importDetailRes = await server.inject({
      method: "GET",
      url: `/product/imports/${productImportId}`,
      headers: headers(),
    });
    expect(importDetailRes.statusCode).toBe(200);
    const importDetail = (importDetailRes.json() as ApiSuccess<any>).data;
    const candidates = importDetail.candidates || [];
    expect(candidates.length).toBeGreaterThan(0);

    // Step 4: Accept the first candidate → product experience
    const firstCandidate = candidates[0];
    const acceptRes = await server.inject({
      method: "POST",
      url: `/product/import-candidates/${firstCandidate.id}/accept`,
      headers: headers({ "idempotency-key": "e2e-accept" }),
    });
    expect(acceptRes.statusCode).toBe(200);

    // Verify experience was created
    const experiencesRes = await server.inject({
      method: "GET",
      url: "/product/experiences",
      headers: headers(),
    });
    expect(experiencesRes.statusCode).toBe(200);
    const experiences = (experiencesRes.json() as ApiSuccess<any[]>).data;
    expect(experiences.length).toBeGreaterThan(0);
    expect(experiences[0].userId).toBe(userId);

    // Step 5: Save a JD
    const jdRes = await server.inject({
      method: "POST",
      url: "/product/jds",
      headers: headers({ "idempotency-key": "e2e-jd" }),
      payload: {
        rawText: "Looking for a Senior Backend Engineer with Node.js, TypeScript, and API optimization experience.",
        targetRole: "Senior Backend Engineer",
      },
    });
    expect(jdRes.statusCode).toBe(200);
    const jd = (jdRes.json() as ApiSuccess<any>).data;
    expect(jd.id).toBeTruthy();

    // Step 6: Generate resume from JD
    const genRes = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: headers({ "idempotency-key": "e2e-gen" }),
      payload: { jdId: jd.id },
    });
    expect(genRes.statusCode).toBe(200);
    const genData = (genRes.json() as ApiSuccess<any>).data;
    const generationId = genData.generationId as string;
    const generation = genData.generation as Record<string, unknown>;
    expect(generationId).toBeTruthy();

    // Step 7: Accept a variant into a resume
    const variants = (genData.variants || []) as Array<{ id: string }>;
    expect(variants.length).toBeGreaterThan(0);

    const acceptVariantRes = await server.inject({
      method: "POST",
      url: `/product/generations/${generationId}/accept-variant`,
      headers: headers({ "idempotency-key": "e2e-accept-variant" }),
      payload: { variantId: variants[0].id, resumeId: generation.resumeId },
    });
    expect(acceptVariantRes.statusCode).toBe(200);
    const acceptResult = (acceptVariantRes.json() as ApiSuccess<any>).data;
    const acceptedResumeId = (acceptResult.resume as Record<string, unknown>)?.id as string;
    expect(acceptedResumeId).toBeTruthy();

    // Step 8: Create HTML export job
    const exportRes = await server.inject({
      method: "POST",
      url: `/exports/resumes/${acceptedResumeId}`,
      headers: headers({ "idempotency-key": "e2e-export" }),
      payload: { format: "html" },
    });
    expect(exportRes.statusCode).toBe(200);
    const exportData = (exportRes.json() as ApiSuccess<any>).data;
    const exportRecord = exportData.exportRecord;
    const exportJob = exportData.job;
    expect(exportRecord.id).toBeTruthy();

    // Step 9: Run the export job
    await kernel.jobRunner.runJob(exportJob.id, userId);

    // Verify export is completed
    const exportDetailRes = await server.inject({
      method: "GET",
      url: `/exports/${exportRecord.id}`,
      headers: headers(),
    });
    expect(exportDetailRes.statusCode).toBe(200);
    const exportDetail = (exportDetailRes.json() as ApiSuccess<any>).data;
    expect(exportDetail.status).toBe("completed");

    // Step 10: Download the export
    const downloadRes = await server.inject({
      method: "GET",
      url: `/exports/${exportRecord.id}/download`,
      headers: headers(),
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.body).toContain("<!doctype html");
    expect(downloadRes.body).toContain("<html");

    // Step 11: User isolation — other user cannot access
    const hiddenExport = await server.inject({
      method: "GET",
      url: `/exports/${exportRecord.id}`,
      headers: { "x-user-id": "other-user" },
    });
    expect(hiddenExport.statusCode).toBe(404);

    const hiddenFile = await server.inject({
      method: "GET",
      url: `/files/${file.id}`,
      headers: { "x-user-id": "other-user" },
    });
    expect(hiddenFile.statusCode).toBe(404);

    // Step 12: Verify no sensitive data leaked in response bodies
    const allBodies = [
      uploadRes.body, parseRes.body, importRes.body, importDetailRes.body,
      acceptRes.body, experiencesRes.body, jdRes.body, genRes.body,
      acceptVariantRes.body, exportRes.body,
      exportDetailRes.body, downloadRes.body,
    ];
    const forbidden = ["reasoning_content", "chain_of_thought", "provider_raw", "system_prompt", "tool_internal_args"];
    for (const body of allBodies) {
      for (const pattern of forbidden) {
        expect(body).not.toContain(pattern);
      }
    }
  });
});
