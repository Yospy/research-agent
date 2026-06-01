import { appendFileSync, mkdirSync } from "node:fs";

// Per-run JSONL trace → logs/<runId>.jsonl. Whole agent tree shares one file (one run = one file).
// Additive to SQLite; this is the human/debug trace with union states named at each seam.
export interface Trace {
  log(record: Record<string, unknown>): void;
}

export function createTrace(runId: string): Trace {
  mkdirSync("logs", { recursive: true });
  const path = `logs/${runId}.jsonl`;
  return {
    log(record) {
      appendFileSync(path, JSON.stringify({ t: Date.now(), run: runId, ...record }) + "\n");
    },
  };
}
