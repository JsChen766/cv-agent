import { createKernel } from "./kernel/createKernel.js";
import { createServer } from "./createServer.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const kernel = await createKernel();
for (const warning of kernel.warnings) {
  console.warn(warning);
}

const server = await createServer(kernel);

const close = async () => {
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
console.log(JSON.stringify({ ok: true, mode: kernel.mode, url: `http://${host}:${port}` }));
