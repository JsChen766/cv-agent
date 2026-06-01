import { createKernel } from "./kernel/createKernel.js";
import { createServer } from "./createServer.js";
import { BackgroundWorker } from "../jobs/BackgroundWorker.js";
import { readPlatformConfig } from "../platform/config.js";
import "dotenv/config";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const kernel = await createKernel();
for (const warning of kernel.warnings) {
  console.warn(warning);
}
const platformConfig = readPlatformConfig();

const server = await createServer(kernel);

// Job Worker auto-start when JOB_WORKER_ENABLED=true or by development default.
let worker: BackgroundWorker | undefined;
const workerJobTypes: Array<"parse_document" | "import_resume_file" | "long_generation" | "export_resume_html" | "export_resume_pdf"> = [
  "parse_document",
  "import_resume_file",
  "long_generation",
  "export_resume_html",
  "export_resume_pdf",
];
console.log("[worker] config", {
  jobWorkerEnabled: platformConfig.jobWorkerEnabled,
  types: workerJobTypes,
  concurrency: platformConfig.jobWorkerConcurrency,
});
if (platformConfig.jobWorkerEnabled) {
  worker = new BackgroundWorker(kernel);
  worker.start(workerJobTypes).then(() => {
    console.log("[worker] BackgroundWorker started", { types: workerJobTypes });
  }).catch((err) => {
    console.error("[worker] BackgroundWorker failed to start:", err instanceof Error ? err.message : err);
  });
} else {
  console.warn("[worker] BackgroundWorker disabled; export jobs will remain pending unless run manually or via dev render fallback.");
}

const close = async () => {
  if (worker) {
    worker.stop();
    console.log("[worker] BackgroundWorker stopped.");
  }
  await server.close();
  await kernel.close();
};

process.once("SIGINT", () => {
  close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
process.once("SIGTERM", () => {
  close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

await server.listen({ port, host });
console.log(JSON.stringify({
  ok: true,
  mode: kernel.mode,
  url: `http://${host}:${port}`,
  jobWorkerEnabled: Boolean(worker),
}));
