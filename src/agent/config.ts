import dotenv from "dotenv";

dotenv.config({ quiet: true });

// Assert a var is present WITHOUT ever touching/printing its value.
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required env var: ${name} (set it in .env)`);
  }
  return value;
}

export const OPENAI_API_KEY = required("OPENAI_API_KEY");
export const EXA_API_KEY = required("EXA_API_KEY");
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.1";

// --- orchestrator wiring (Go control plane + in-process worker) -------------
// The spawn tool RPCs to the orchestrator; the orchestrator calls back into our in-process
// worker endpoint. Two processes, addresses configured here (no auto-spawn).
export const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://localhost:8787";
export const WORKER_PORT = Number(process.env.WORKER_PORT ?? "8788");

// Hard wall-clock cap on a whole root run, enforced in the harness (alongside toolBudget).
export const ROOT_DEADLINE_MS = Number(process.env.ROOT_DEADLINE_MS ?? "300000");

// Default orchestration policy sent with each fan-out (the deterministic control surface).
export const ORCHESTRATOR_POLICY = {
  maxConcurrency: Number(process.env.ORCH_MAX_CONCURRENCY ?? "3"),
  perTaskTimeoutMs: Number(process.env.ORCH_PER_TASK_TIMEOUT_MS ?? "90000"),
  retryBudget: Number(process.env.ORCH_RETRY_BUDGET ?? "1"),
};
