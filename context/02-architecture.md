# 02 — Architecture

## Full flow
```
┌─────────── TERMINAL CHAT LOOP  `terminal.ts` (single entry; ours) ────────────┐
│  prompt> user question → runAgent(question, ROOT_TOOLS, ctx{depth:0})          │
│  UI renderer subscribes to the AgentEvent stream → live tree + streamed answer │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                     ▼
┌─────────────────────── runAgent(question, tools, ctx) ─────────────────────────┐
│  messages = [system, user]            ← persisted to SQLite `messages`          │
│                                                                                 │
│  while (true):                                                                  │
│     res    = POST /chat/completions (messages, tools)   ← OpenAI raw API        │
│     log tokens incl cached_tokens     ← prompt-cache instrumentation            │
│     action = decide(res)              ← SEAM: finish_reason → OUR LoopAction     │
│                                                                                 │
│     run_tools → for each call:                                                  │
│        parse args (Zod)               ← parse-don't-trust seam                  │
│        dispatch by name:                                                        │
│           web_search   → Exa /search   (check exa_cache first)                  │
│           read_source  → Exa /contents (check exa_cache first)                  │
│           spawn_researcher → runAgent(sub_q, CHILD_TOOLS, depth+1)  ← RECURSION  │
│        append role:"tool" result → continue                                     │
│     done   → return AgentResult.ok {answer, citations}                          │
│     error  → return AgentResult.err                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## The 3 layers
- **Harness** (`runAgent` + `decide` + `db`) — domain-blind `while` loop. Owns `messages[]` state,
  persists to SQLite, branches on `LoopAction`. Knows nothing about "research."
- **Tools** (`web_search`, `read_source`, `spawn_researcher`) — the ONLY thing that makes this a
  research agent. Swap these → different agent, same harness.
- **LLM** (OpenAI raw API) — non-deterministic intent. We measure its cache, own its dispatch.

## Unions (see 05)
```
LoopAction  (ours)   run_tools | done | error    ← loop branches on this
AgentResult (ours)   ok | error                  ← bubbles up the recursion
finish_reason (server) → mapped into LoopAction at decide()
```

## Caches (see 06)
```
1. OpenAI prompt cache  → automatic, measured via usage...cached_tokens
2. Exa cache (SQLite)   → keyed on query/url, free + deterministic replay
```

## SQLite (see 04)
```
runs · agents(the recursion tree) · messages(state+tokens) · tool_calls · exa_cache
```

## Proposed file layout
```
src/agent/
  types.ts        Tool<A,R>, Msg, LoopAction, AgentResult, AgentCtx
  decide.ts       finish_reason → LoopAction   (the control seam)
  callTool.ts     generic: parse args → run → result
  runAgent.ts     the while-loop spine (plan-free, model-driven)
  tools/
    web_search.ts        Exa /search   + exa_cache
    read_source.ts       Exa /contents + exa_cache
    spawn_researcher.ts  → runAgent(...) recursion, narrowed tools
    registry.ts          ROOT_TOOLS / CHILD_TOOLS
  llm.ts          POST /chat/completions, return raw res
  db.ts           SQLite open + the 5 tables + helpers
  events.ts       AgentEvent type + emitter (harness → sinks)
src/ui/
  render.ts       subscribe(AgentEvent) → live tree (chalk + log-update)
  stream.ts       streamed answer chunks + Sources list
  history.ts      /history + /open from SQLite
terminal.ts       ← ENTRY: outer chat loop → read question → runAgent → render  (run this)
research.db       local store (gitignored)
src/api/          (DEFERRED) future Hono adapter — see 09-frontend-contract.md
```

## Tool registries (constraint propagation)
```
ROOT_TOOLS  = [web_search, read_source, spawn_researcher]
CHILD_TOOLS = [web_search, read_source]   ← NO spawn → bounded recursion (depth-by-toolset)
```

## Guardrails
- Hard depth cap (e.g. `depth <= 2`) AND/OR toolset narrowing (children lack `spawn_researcher`).
- Per-agent max tool calls (e.g. <= 12), fail-closed.
- Exa cache to avoid re-paying during dev.
- Never read/log `.env` keys.
- `callTool` parses untyped `arguments` JSON at the boundary every time.
