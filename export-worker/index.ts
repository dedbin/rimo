import { createPdfWorker } from "./http";

const port = Number(process.env.PDF_WORKER_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PDF_WORKER_PORT");
const worker = createPdfWorker(process.env.PDF_WORKER_TOKEN ?? "");
worker.listen(port, process.env.PDF_WORKER_HOST ?? "127.0.0.1", () => {
  console.info("PDF worker listening", { port });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  worker.close();
  setTimeout(() => process.exit(0), 5_000).unref();
});
