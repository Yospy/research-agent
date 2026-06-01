import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type DB = Database.Database;

// Open (or create) the SQLite file and ensure the 5 tables exist. Schema per context/08 §9.
export function openDb(path = "research.db"): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      final_answer TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_agent_id TEXT,
      depth INTEGER NOT NULL,
      sub_question TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT,
      finish_reason TEXT,
      prompt_tokens INTEGER,
      cached_tokens INTEGER,
      completion_tokens INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      name TEXT NOT NULL,
      args_json TEXT,
      result_json TEXT,
      ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exa_cache (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// --- runs -------------------------------------------------------------------
export function createRun(db: DB, question: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, question, status, final_answer, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, question, "running", null, Date.now(), null);
  return id;
}

export function finishRun(
  db: DB,
  id: string,
  status: string,
  finalAnswer: string | null,
): void {
  db.prepare(`UPDATE runs SET status = ?, final_answer = ?, finished_at = ? WHERE id = ?`).run(
    status,
    finalAnswer,
    Date.now(),
    id,
  );
}

// --- agents -----------------------------------------------------------------
export interface CreateAgentInput {
  runId: string;
  parentAgentId: string | null;
  depth: number;
  subQuestion: string;
}

export function createAgent(db: DB, a: CreateAgentInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, run_id, parent_agent_id, depth, sub_question, status, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.runId, a.parentAgentId, a.depth, a.subQuestion, "running", null, Date.now());
  return id;
}

export function finishAgent(db: DB, id: string, status: string, summary: string | null): void {
  db.prepare(`UPDATE agents SET status = ?, summary = ? WHERE id = ?`).run(status, summary, id);
}

// --- messages ---------------------------------------------------------------
export interface InsertMessageInput {
  agentId: string;
  seq: number;
  role: string;
  contentJson: string | null;
  finishReason?: string | null;
  promptTokens?: number | null;
  cachedTokens?: number | null;
  completionTokens?: number | null;
}

export function insertMessage(db: DB, m: InsertMessageInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages
       (id, agent_id, seq, role, content_json, finish_reason, prompt_tokens, cached_tokens, completion_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    m.agentId,
    m.seq,
    m.role,
    m.contentJson,
    m.finishReason ?? null,
    m.promptTokens ?? null,
    m.cachedTokens ?? null,
    m.completionTokens ?? null,
    Date.now(),
  );
  return id;
}

// --- tool_calls -------------------------------------------------------------
export interface InsertToolCallInput {
  agentId: string;
  toolCallId: string;
  name: string;
  argsJson: string | null;
  resultJson: string | null;
  ms: number | null;
}

export function insertToolCall(db: DB, t: InsertToolCallInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tool_calls (id, agent_id, tool_call_id, name, args_json, result_json, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, t.agentId, t.toolCallId, t.name, t.argsJson, t.resultJson, t.ms, Date.now());
  return id;
}

// --- exa_cache (layer-2 cache) ----------------------------------------------
export function exaCacheGet(db: DB, key: string): unknown | null {
  const row = db.prepare(`SELECT response_json FROM exa_cache WHERE key = ?`).get(key) as
    | { response_json: string }
    | undefined;
  return row ? JSON.parse(row.response_json) : null;
}

export interface ExaCacheSetInput {
  key: string;
  kind: string;
  requestJson: string;
  responseJson: string;
}

export function exaCacheSet(db: DB, c: ExaCacheSetInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO exa_cache (key, kind, request_json, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(c.key, c.kind, c.requestJson, c.responseJson, Date.now());
}

// --- reads (for /history and /open, later) ----------------------------------
export interface RunSummaryRow {
  id: string;
  question: string;
  status: string;
  created_at: number;
}

export function listRuns(db: DB): RunSummaryRow[] {
  return db
    .prepare(`SELECT id, question, status, created_at FROM runs ORDER BY created_at DESC`)
    .all() as RunSummaryRow[];
}

export interface RunRow {
  id: string;
  question: string;
  status: string;
  final_answer: string | null;
  created_at: number;
  finished_at: number | null;
}

export function getRun(db: DB, id: string): RunRow | undefined {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
}

export interface RunMetrics {
  totalTokens: number;
  promptTokens: number;
  cachedTokens: number;
  toolCalls: number;
}

// Per-run token + tool totals (whole tree), summed from the durable messages/tool_calls rows.
export function getRunMetrics(db: DB, runId: string): RunMetrics {
  const inRun = `agent_id IN (SELECT id FROM agents WHERE run_id = ?)`;
  const m = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c,
              COALESCE(SUM(cached_tokens),0) AS cached FROM messages WHERE ${inRun}`,
    )
    .get(runId) as { p: number; c: number; cached: number };
  const t = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE ${inRun}`).get(runId) as { n: number };
  return { totalTokens: m.p + m.c, promptTokens: m.p, cachedTokens: m.cached, toolCalls: t.n };
}

// Reconstruct a run's Sources from its read_source tool_calls (deduped by url). No schema change.
export function getRunCitations(db: DB, runId: string): { title: string; url: string }[] {
  const rows = db
    .prepare(
      `SELECT result_json FROM tool_calls
       WHERE name = 'read_source' AND agent_id IN (SELECT id FROM agents WHERE run_id = ?)
       ORDER BY created_at`,
    )
    .all(runId) as { result_json: string | null }[];
  const seen = new Map<string, { title: string; url: string }>();
  for (const r of rows) {
    if (!r.result_json) continue;
    try {
      const c = JSON.parse(r.result_json) as { title?: string; url?: string };
      if (c.url && !seen.has(c.url)) seen.set(c.url, { title: c.title ?? "", url: c.url });
    } catch {
      // skip unparseable rows (e.g. error results)
    }
  }
  return [...seen.values()];
}
