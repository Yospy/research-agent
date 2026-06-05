import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runResearcher, type RunResearcherContext } from "./runResearcher.ts";
import type { DB } from "../agent/db.ts";

interface RunBody {
  kind: string;
  task: string;
  context: RunResearcherContext;
}

// Reads and JSON-parses a request body.
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Starts the in-process worker. It lives in the SAME Node process as the REPL/root agent, so
// it shares the one SQLite connection (single writer) and the event loop serves /run requests
// while the root awaits the orchestrator. The Go orchestrator calls back here, one POST /run
// per sub-question.
export function startWorkerServer(db: DB, port: number): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/run") {
      try {
        const body = (await readJson(req)) as RunBody;
        const result = await runResearcher(db, body.kind, body.task, body.context);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        // Worker-level crash → surface as a retryable transport failure to the orchestrator.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e), retryable: true, citations: [] }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Fail loud and clean if the port is taken (e.g. a leaked instance) instead of crashing
  // the REPL later with an unhandled 'error'.
  server.on("error", (e: NodeJS.ErrnoException) => {
    const hint = e.code === "EADDRINUSE" ? ` — port ${port} already in use (set WORKER_PORT)` : "";
    console.error(`worker failed to start${hint}: ${e.message}`);
    process.exit(1);
  });

  server.listen(port);
  return server;
}
