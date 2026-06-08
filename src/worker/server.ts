import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runResearcher, type RunResearcherContext } from "./runResearcher.ts";
import type { AgentEvent } from "../agent/types.ts";
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

// Handles POST /run as an NDJSON stream: zero or more {"type":"event"} progress lines (pings),
// then one {"type":"result"} line. Headers are flushed up front so the orchestrator's idle timer
// starts immediately; if the orchestrator cancels (idle/absolute timeout), the connection closes
// and we abort the in-flight work so it stops burning tokens.
async function handleRun(db: DB, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: RunBody;
  try {
    body = (await readJson(req)) as RunBody;
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
    return;
  }

  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.flushHeaders(); // headers out NOW → orchestrator's idle clock starts at t=0

  let finished = false;
  const write = (obj: unknown): void => {
    if (finished || res.writableEnded || res.destroyed) return;
    try {
      res.write(JSON.stringify(obj) + "\n");
    } catch {
      // connection went away mid-write — the abort below will stop the work
    }
  };

  // Orchestrator disconnect (cancel) before we finish → abort the researcher.
  const ac = new AbortController();
  res.on("close", () => {
    if (!finished) ac.abort();
  });

  // Forward progress as pings. Structural events pass through; throttle token-level `thinking`
  // to ~1/sec so a long answer stream keeps the task "alive" without flooding the wire.
  let lastThinking = 0;
  const onEvent = (e: AgentEvent): void => {
    if (e.kind === "thinking") {
      const now = Date.now();
      if (now - lastThinking < 1000) return;
      lastThinking = now;
    }
    write({ type: "event", event: e });
  };

  try {
    const result = await runResearcher(db, body.kind, body.task, body.context, onEvent, ac.signal);
    write({ type: "result", result });
  } catch (e) {
    write({ type: "result", result: { ok: false, error: String(e), retryable: true, citations: [] } });
  } finally {
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

// Starts the in-process worker. It lives in the SAME Node process as the REPL/root agent, so it
// shares the one SQLite connection (single writer) and the event loop serves /run requests while
// the root awaits the orchestrator. The Go orchestrator calls back here, one POST /run per task.
export function startWorkerServer(db: DB, port: number): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/run") {
      void handleRun(db, req, res);
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
