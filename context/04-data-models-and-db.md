# 04 — Data models & SQLite

Everything local in one file: `research.db` (gitignored). Suggested driver: `better-sqlite3`
(synchronous, simple) — confirm at scaffold.

## TS data models (the typed boundary)
```ts
// ── the wire union (OpenAI Chat Completions shape) ──
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };   // arguments = JSON STRING → parse
}

// ── our generic tool seam ──
interface Tool<A, R> {
  name: string;
  description: string;
  schema: ZodType<A>;                               // validate untyped args
  run: (args: A, ctx: AgentCtx) => Promise<R>;
}

// ── our designed unions (see 05) ──
type LoopAction =
  | { kind: "run_tools"; calls: ToolCall[] }
  | { kind: "done"; answer: string }
  | { kind: "error"; reason: string };

type AgentResult =
  | { ok: true; answer: string; citations: string[] }
  | { ok: false; error: string; partial?: string };

// ── per-frame context threaded through the recursion ──
interface AgentCtx {
  db: DB;
  runId: string;
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  maxDepth: number;        // e.g. 2
  toolBudget: number;      // e.g. 12, decremented per tool call, fail-closed
}
```

## SQLite schema (5 tables)
```sql
-- one row per top-level question
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  status      TEXT NOT NULL,          -- running | done | error
  final_answer TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

-- the AGENT TREE = the recursion, persisted (root has parent_agent_id NULL)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  parent_agent_id TEXT REFERENCES agents(id),
  depth           INTEGER NOT NULL,
  sub_question    TEXT NOT NULL,       -- root: = the run question
  status          TEXT NOT NULL,       -- running | done | error
  summary         TEXT,                -- what bubbled up to the parent
  created_at      INTEGER NOT NULL
);

-- the transcript per agent = the STATE, plus caching instrumentation
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  seq              INTEGER NOT NULL,   -- order within the agent
  role             TEXT NOT NULL,      -- system | user | assistant | tool
  content_json     TEXT NOT NULL,      -- full message (incl tool_calls)
  finish_reason    TEXT,               -- only on assistant rows
  prompt_tokens    INTEGER,
  cached_tokens    INTEGER,            -- usage.prompt_tokens_details.cached_tokens
  completion_tokens INTEGER,
  created_at       INTEGER NOT NULL
);

-- every tool invocation + its result + latency
CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  tool_call_id TEXT NOT NULL,          -- links to OpenAI call.id
  name         TEXT NOT NULL,
  args_json    TEXT NOT NULL,
  result_json  TEXT,
  ms           INTEGER,
  created_at   INTEGER NOT NULL
);

-- layer-2 cache: avoid re-paying / re-fetching Exa (deterministic replay)
CREATE TABLE exa_cache (
  key          TEXT PRIMARY KEY,       -- hash(kind + normalized query/url)
  kind         TEXT NOT NULL,          -- search | contents
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
```

## Why each table
- `runs` — top-level lifecycle + final answer.
- `agents` — **the recursion tree made durable**; query it to render the run as a tree.
- `messages` — the conversation IS the state; we persist it for inspection + token/cache metrics.
- `tool_calls` — observability: what was called, with what, what came back, how slow.
- `exa_cache` — cheap dev loop + deterministic re-runs; the OpenAI prompt cache is separate
  (server-side, measured via the `cached_tokens` column on `messages`).

## IDs & time
- IDs: `crypto.randomUUID()` or short nanoid.
- Timestamps: `Date.now()` (INTEGER ms).
