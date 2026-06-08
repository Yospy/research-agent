import type { ZodType } from "zod";
import type Database from "better-sqlite3";

export type Role = "system" | "user" | "assistant" | "tool";

// OpenAI tool_call shape (the server stamps `id`; we echo it back on the tool result).
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// A single chat message. `messages[]` IS the agent's state.
export interface Msg {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[]; // present on assistant turns that call tools
  tool_call_id?: string; // present on role:"tool" results (matches a ToolCall.id)
}

// A tool = a name the model calls + something the harness does. Generic over args/result.
export interface Tool<A, R> {
  name: string;
  description: string;
  schema: ZodType<A>; // runtime validator for the untyped args JSON
  run: (args: A, ctx: AgentCtx) => Promise<R>;
}

// Loop control — finish_reason mapped to OUR vocabulary at decide().
export type LoopAction =
  | { kind: "run_tools"; calls: ToolCall[] }
  | { kind: "done"; answer: string }
  | { kind: "error"; reason: string };

// What a finished agent returns to its parent (the load-bearing union).
export type AgentResult =
  | { ok: true; answer: string; citations: string[] }
  | { ok: false; error: string; partial?: string };

export interface Citation {
  title: string;
  url: string;
}

// Threaded down the recursion; carries the db handle, bounds, and the citation map.
export interface AgentCtx {
  db: Database.Database;
  runId: string;
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  maxDepth: number;
  toolBudget: number;
  citations: Map<string, Citation>; // keyed by url, deduped, harness-owned
  onEvent?: (e: AgentEvent) => void; // optional live sink (UI subscribes); threads to children
  deadline?: number; // optional epoch-ms wall-clock cap; the loop fails closed past it
  signal?: AbortSignal; // optional cancellation; aborts in-flight LLM/Exa fetches when cut
}

// Trace events the harness emits at each seam → sinks (db, logs/, ui later).
export type AgentEvent =
  | { kind: "agent_start"; agentId: string; depth: number; sub_question: string }
  | { kind: "thinking"; agentId: string; text: string }
  | { kind: "tool_call"; agentId: string; name: string; args: unknown; ms?: number }
  | { kind: "spawned"; agentId: string; child: string; sub_question: string; depth: number }
  | { kind: "result"; agentId: string; result: AgentResult };
