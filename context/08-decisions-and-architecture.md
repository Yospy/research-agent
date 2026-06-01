# 08 — Decisions & Architecture (build-ready)

> The single source of truth for **what we're building and how**. Every open decision from
> `00–06` is now **locked** here. If you're picking this up cold to build, read `01-concepts.md`
> (the mental model) then this file. Everything below is decided — do not re-litigate; if you
> must change something, edit this file and say why.

---

## 0. One-line definition
A from-scratch **TypeScript deep research agent** on the **OpenAI raw Chat Completions API**
(no Agents SDK). We own the `while`-loop harness. Given one hard question, it plans research
threads, **spawns an isolated sub-agent per thread** (recursion + context isolation), each
sub-agent searches/reads via **Exa**, and the parent **synthesizes a cited answer**. v1 ships as
an **interactive terminal app** (Claude Code / Codex style): one entry script `terminal.ts` opens
our own **chat loop** where you type questions, watch the sub-agent tree render live, and get a
streamed cited answer. (Two nested loops, both hand-written: an outer **chat loop** reading stdin,
and the inner **agent harness loop** in `runAgent` — no REPL framework.)
Everything persists to **SQLite**; traces also written to `logs/`. **No auth.** (A web API +
frontend — `09-frontend-contract.md` — is **deferred**; the agent core is unchanged when we add it.)

---

## 1. Locked tech decisions

| Area | Decision | Notes |
|------|----------|-------|
| Language | **TypeScript (strict)** | |
| Runtime | **Node 23** | |
| Module system | **ESM** | `"type":"module"`, `import`/`export`. Not CommonJS. |
| LLM API | **OpenAI raw Chat Completions** (`POST /v1/chat/completions`) | NOT Agents/Assistants SDK. |
| HTTP layer | **raw `fetch`** | Hand-rolled POST. No `openai` SDK — keep the wire visible. |
| Model | **`gpt-5.1`** | `process.env.OPENAI_MODEL ?? "gpt-5.1"`. This is final — no fallback model. |
| Search | **Exa** | `POST /search` + `POST /contents`, header `x-api-key: $EXA_API_KEY`. |
| Args validation | **Zod** | `schema.parse(JSON.parse(arguments))` at the tool boundary, every call. |
| Storage | **SQLite**, driver **`better-sqlite3`** (synchronous) | One file `research.db` (gitignored). |
| **Interface (v1)** | **Interactive terminal app (our own chat loop)** | One entry: `terminal.ts`. Run it → chat loop opens → type questions → live tree + streamed cited answer. Like Claude Code / Codex. **No REPL framework** — hand-written `while` around `readline`. |
| **Entry script** | **`terminal.ts`** (single command) | `npm run dev` / `tsx terminal.ts` boots the app directly into the chat loop. No separate server to start. |
| **Terminal UI lib** | **lean: `chalk` + `log-update` + `ansi-escapes`** | Hand-managed redraw of the live tree (in the spirit of "from scratch"). **Ink** (React-for-CLI, what Claude Code/Codex use) is the fallback if we want richer components fast. |
| Streaming | **on (terminal)** | OpenAI SSE is easy to consume in a CLI → stream the final answer token-by-token. (Was deferred for web; terminal re-enables it.) |
| Web API framework | **Hono — DEFERRED** | Not in v1. Future adapter over the same core; see `09-frontend-contract.md`. |
| Auth | **none** | Single-user/local. `run_id` is the only handle. |
| Env loading | **dotenv** `config({ quiet: true })` | dotenv v17+ is verbose otherwise. |
| Logging | **file traces in `logs/<run_id>.jsonl`** | Additive to SQLite. Union states named explicitly. |

### Env (in `.env`, NEVER read or log the values)
- `OPENAI_API_KEY` — OpenAI raw API
- `EXA_API_KEY` — Exa search
- `OPENAI_MODEL` — optional override; defaults to `gpt-5.1`

### Out of scope (do not drift)
- Agents/Assistants SDK, native tools runtime, vector DBs, LangChain/LlamaIndex.
- **Web API + frontend** (Hono, polling, DTOs) — **deferred**, not dropped. Contract preserved in
  `09-frontend-contract.md` so a future web adapter can wrap the **same** agent core unchanged.
- Multi-user / auth / deployment.
- **Durable/long-running execution** — deferred to a later **Temporal-style workflow** phase.
  v1 runs **in-process** in the terminal; the renderer subscribes to the live event stream (no
  polling needed — same process). Crash recovery comes with that later phase (a process death
  leaves a stale `status:"running"` row — acceptable for v1).

---

## 2. The mental model (the thing the whole project rests on)

Three actors, not two:
```
1. MODEL        — generates raw tokens = INTENT. Knows nothing about JSON/finish_reason.
2. API SERVER   — wraps tokens into JSON, stamps finish_reason + tool_call ids (the envelope).
3. HARNESS (us) — DRIVES every cycle: owns messages[], POSTs, types the response, runs tools,
                  decides loop-or-stop. The model is passive until WE ask.
```
Key truths:
- **`messages[]` IS the state.** The LLM is stateless — every iteration re-POSTs the full history.
- **The model decides WHEN it's done** by NOT calling a tool; the harness detects the absence and stops.
- **A tool = "a name the model calls + something the harness does."** For `spawn_researcher`,
  that "something" is running a WHOLE other agent loop. The model can't tell the difference.

---

## 3. Architecture (3 layers + flow)

```
┌── TERMINAL APP `terminal.ts` (single entry; OUR chat loop) ┐
│  prompt> <user question>                                  │
│  ◆ root: "<question>"                          [running]  │
│    ├─ 🔍 web_search "..."                         120ms   │
│    └─ ◆ spawn: "Blinkit margins?"              [running]  │
│  …live tree redraws as events fire; answer streams in…    │
└───────────────────────────┬──────────────────────────────┘
        renders AgentEvent stream  ▲   │  user question
        (in-process, no polling)   │   ▼
┌──────── UI RENDERER (src/ui) ────────────────────────────┐
│  subscribe(onEvent) → redraw tree (chalk + log-update);   │
│  stream answer tokens; print Sources from ctx.citations   │
└───────────────────────────┬──────────────────────────────┘
                            ▼  runAgent(q, ROOT_TOOLS, ctx{depth:0})
┌──────── HARNESS (our while-loop) ────────────────────────┐
│ runAgent(question, tools, ctx):                           │
│   messages = [system, user]      ← STABLE PREFIX FIRST    │
│   while(true):                                            │
│     res    = POST /chat/completions(messages, tools)  ───┼─► OpenAI (raw fetch)
│     persist(res) + log tokens/cached_tokens          ───┼─► SQLite + logs/
│     action = decide(res)   finish_reason → LoopAction     │   ← THE SEAM
│     switch(action.kind):                                  │
│       run_tools → callTool each (Zod parse) → append tool │
│                   result → continue                       │
│       done      → return AgentResult.ok {answer,citations}│
│       error     → return AgentResult.err                  │
│                                                           │
│   tools: web_search → Exa /search   (exa_cache first) ───┼─► Exa
│          read_source → Exa /contents (exa_cache first)───┼─► Exa
│          spawn_researcher → runAgent(sub_q, CHILD_TOOLS,  │
│                              depth+1)  ← RECURSION         │
└───────────────────────────────────────────────────────────┘
```

### The 3 layers
- **Harness** (`runAgent` + `decide` + `callTool` + `db` + `logger`) — domain-blind `while` loop.
  Owns `messages[]`, persists to SQLite, writes `logs/`, branches on `LoopAction`. Knows nothing about "research."
- **Tools** (`web_search`, `read_source`, `spawn_researcher`) — the ONLY thing that makes this a
  research agent. Swap these → different agent, same harness.
- **LLM** (OpenAI raw API) — non-deterministic intent. We measure its cache, own its dispatch.

### Three directions of flow (the summary)
```
DOWN the tree:  narrowed sub-question + narrowed toolset      (constraint propagation)
UP   the tree:  AgentResult {summary, citations}              (compressed, context-isolated)
SIDE to store:  every turn + token/cache metrics → SQLite + logs/  (durable mirror + trace)
```

---

## 4. The tools (the personality)

```
LEAF (the hands)
  web_search(query: string, num_results?: int = 5)
      → exa_cache? else POST api.exa.ai/search
      R = [{ title, url, id, snippet }]          "FIND sources"
  read_source(id_or_url: string)
      → exa_cache? else POST api.exa.ai/contents
      R = { title, url, text }                   "READ one source" (births a citation)

ORCHESTRATION (the recursion)
  spawn_researcher(sub_question: string)
      → runAgent(sub_question, CHILD_TOOLS, depth+1)   ← fresh context, narrowed tools
      R = { summary, citations[] }               "DELEGATE a thread" (compressed up)
```

### The generic tool seam
```ts
interface Tool<A, R> {
  name: string;                       // model chooses BY this
  description: string;                // English — model reads to decide WHEN
  schema: ZodType<A>;                 // RUNTIME validator for untyped args JSON
  run: (args: A, ctx: AgentCtx) => Promise<R>;
}
```
`interface + generics` → tool shape & wire messages. `type` discriminated unions → decisions
(`LoopAction`, `AgentResult`). A registry holds `Tool<any, any>[]`; precise generics live inside
each tool's own `run`; the Zod parse keeps the boundary honest.

### Tool registries (constraint propagation = the recursion bound)
```
ROOT_TOOLS  = [ web_search, read_source, spawn_researcher ]
CHILD_TOOLS = [ web_search, read_source ]   ← NO spawn → children can't recurse (depth-by-toolset)
```

### `tool_call_id` (server-issued ticket — we only echo it)
- The API server stamps `id` on each `tool_call`. We answer EVERY call with a
  `{ role:"tool", tool_call_id:<same id>, content:<json> }` BEFORE the next POST.
- With parallel calls, match by `id`, never by position. Persisted in `tool_calls`.

---

## 5. Unions & control flow (two layers; only one is ours)

```
LAYER 1 — loop control (SERVER's; we MAP it):
  finish_reason  →  LoopAction (ours) at decide():
    "tool_calls"        → { kind:"run_tools", calls }   → run tools, loop
    "stop"              → { kind:"done", answer }        → return (root→user, child→parent)
    "length"|"content_filter"|unknown → { kind:"error", reason }

LAYER 2 — agent return (OURS; the load-bearing union):
  type AgentResult =
    | { ok:true;  answer:string; citations:string[] }
    | { ok:false; error:string; partial?:string }
  Parent matches .ok to decide "use summary" vs "give up".
```
One seam (`decide()`) owns vendor translation → swap to Anthropic = change only `decide()`.
**Stop rule:** `finish_reason:"stop"` (text, no tool) ends THAT loop. Root's answer → user;
child's answer → its parent (as the `spawn_researcher` tool_result). Same exit, different recipient.

```
LAYER 3 — AgentEvent (OURS; first-class in terminal v1 — it IS the renderer's feed):
  type AgentEvent =
    | { kind:"agent_start";  agentId; depth; sub_question }
    | { kind:"thinking";     agentId; text }                 // streamed answer chunks
    | { kind:"tool_call";    agentId; name; args; ms? }
    | { kind:"spawned";      agentId; child; sub_question; depth }
    | { kind:"result";       agentId; result: AgentResult }
  The harness emits these at the SAME seams it already logs (decide / callTool / spawn / return).
  `logs/` and SQLite consume them for persistence; the terminal UI subscribes to redraw the live
  tree + stream the answer. Same event, three sinks (file, db, screen).
```

---

## 6. Context handling (the harness's real job)

- **Collect:** per cycle append (a) the assistant turn (which CONTAINS `tool_calls`) and
  (b) one `role:"tool"` message per call. Roles ever used: `system | user | assistant | tool`.
- **Curate:** stable prefix (system → tool defs) FIRST and byte-stable; append only to the tail;
  push all noise into sub-agents that return only a compressed `{summary, citations}`. Parent stays lean.
- **Send:** every iteration is a fresh stateless POST of the WHOLE `messages[]` + (stable) tool defs.
- **Mirror:** every turn written to SQLite `messages` (and `logs/`) as it happens → replayable.

---

## 7. Caching (two layers — do not conflate)

```
LAYER 1 — OpenAI PROMPT cache (= KV cache persisted across calls)
  • AUTOMATIC. Fires on a stable prefix ≥ 1024 tokens. We do NOT build it.
  • Our job: keep prefix byte-stable (system → tool defs first, never reorder), and MEASURE:
    log usage.prompt_tokens_details.cached_tokens into messages.cached_tokens every call.

LAYER 2 — EXA cache (OURS, in SQLite `exa_cache`)
  • keyed hash(kind + normalized query/url). Checked BEFORE every Exa call.
  • repeat search/read → free, no network, deterministic replay.
```
Sub-agents each have their OWN context → their OWN prompt cache (no sharing) — but a common,
stable system prefix + tool defs gives all agents at least header-level cache hits.

---

## 8. Citations (harness-owned → clean Sources)

- Born when `read_source(url)` returns, and when a child returns `{summary, citations[]}`.
- Collected on `AgentCtx` as a **deduped Map<url,{title,url}>** — NOT the model's memory.
  - each `read_source` run → add `{title,url}`
  - each child return → merge child citations into parent
  - on `done` → `AgentResult.citations = [...ctx.citations.values()]`
- The model writes prose with `[n]` markers; the HARNESS owns the authoritative `n→url` map, so a
  hallucinated URL can't enter Sources — every source is a URL we actually fetched. Deduped,
  order-stable. Persisted on `runs` and printed under the streamed answer in the terminal as a
  numbered **Sources** list (`[n] title — url`). (A future web UI reads the same map.)

---

## 9. Data model & SQLite (5 tables)

```sql
runs (                              -- one row per question = ONE chat in history
  id TEXT PK, question TEXT, status TEXT,        -- running|done|error
  final_answer TEXT, created_at INT, finished_at INT
);
agents (                            -- the RECURSION TREE, durable (root parent_agent_id NULL)
  id TEXT PK, run_id TEXT, parent_agent_id TEXT, depth INT,
  sub_question TEXT, status TEXT, summary TEXT, created_at INT
);
messages (                          -- transcript per agent = STATE + cache metrics
  id TEXT PK, agent_id TEXT, seq INT, role TEXT,
  content_json TEXT, finish_reason TEXT,
  prompt_tokens INT, cached_tokens INT, completion_tokens INT, created_at INT
);
tool_calls (                        -- observability: every invocation + result + latency
  id TEXT PK, agent_id TEXT, tool_call_id TEXT, name TEXT,
  args_json TEXT, result_json TEXT, ms INT, created_at INT
);
exa_cache (                         -- layer-2 cache (internal; NOT shown in UI)
  key TEXT PK, kind TEXT, request_json TEXT, response_json TEXT, created_at INT
);
```
IDs: `crypto.randomUUID()`. Time: `Date.now()` (INTEGER ms). Relationships:
`runs (1) ──< agents (tree) ──< messages (by seq) & tool_calls`.

### Threaded context type
```ts
interface AgentCtx {
  db: DB; runId: string; agentId: string; parentAgentId: string | null;
  depth: number; maxDepth: number;       // e.g. 2
  toolBudget: number;                     // e.g. 12, decremented per call, fail-closed
  citations: Map<string, {title:string; url:string}>;
}
```

---

## 10. Logging / traces (`logs/<run_id>.jsonl`)

- **Additive** to SQLite (SQLite feeds the UI; `logs/` is for humans/debugging). Gitignored.
- **One JSONL file per run** — whole tree (parent + sub-agents) in one place.
- **Union states named explicitly** on every transition. Hooked at the existing seams:
  `decide()` (LoopAction), agent return (AgentResult), `callTool` (tool step), spawn.
```jsonl
{"t":..,"run":"r_ab","agent":"a0","depth":0,"event":"agent_start","question":"..."}
{"t":..,"agent":"a0","event":"llm_response","finish_reason":"tool_calls","cached_tokens":0}
{"t":..,"agent":"a0","event":"decide","loop_action":"run_tools","calls":["web_search","spawn_researcher"]}
{"t":..,"agent":"a0","event":"tool_call","name":"web_search","args":{"query":"..."},"ms":120}
{"t":..,"agent":"a0","event":"spawn","sub_question":"...","depth":1,"child":"a1"}
{"t":..,"agent":"a1","event":"decide","loop_action":"done"}
{"t":..,"agent":"a1","event":"agent_result","ok":true,"citations":["url1","url2"]}
{"t":..,"agent":"a0","event":"decide","loop_action":"done"}
{"t":..,"agent":"a0","event":"agent_result","ok":true,"citations":["url1","url2","url3"]}
```

---

## 11. Guardrails
- Hard depth cap (`depth <= maxDepth`, e.g. 2) AND toolset narrowing (children lack `spawn_researcher`).
- Per-agent `toolBudget` (<= 12), fail-closed → return `AgentResult.err` when exceeded.
- Exa cache to avoid re-paying during dev.
- **Never read or log `.env` key values.**
- `callTool` parses untyped `arguments` JSON at the boundary every time (parse-don't-trust).
- Keep the `messages[]` prefix byte-stable (cache + correctness).

---

## 12. Proposed file layout
```
practice/
  src/
    agent/
      types.ts        Tool<A,R>, Msg, ToolCall, LoopAction, AgentResult, AgentCtx
      decide.ts       finish_reason → LoopAction (the control seam; logs LoopAction)
      callTool.ts     parse args (Zod) → run → result (logs tool step)
      runAgent.ts     the while-loop spine (model-driven, plan-free)
      tools/
        web_search.ts        Exa /search   + exa_cache
        read_source.ts       Exa /contents + exa_cache
        spawn_researcher.ts  → runAgent(...) recursion, narrowed tools
        registry.ts          ROOT_TOOLS / CHILD_TOOLS
      llm.ts          raw fetch POST /chat/completions, return raw res
      db.ts           SQLite open + 5 tables + helpers
      logger.ts       logs/<run_id>.jsonl writer (union states explicit)
      citations.ts    ctx.citations collect/merge/dedupe helpers
      events.ts       AgentEvent type + tiny emitter (harness → sinks)
    ui/
      render.ts       subscribe(AgentEvent) → live tree redraw (chalk + log-update)
      stream.ts       print streamed answer chunks + final Sources list
      history.ts      list/open past runs from SQLite (the `/history` command)
  terminal.ts         ← THE ENTRY. boots the chat loop: read question → runAgent → render. (run this)
  research.db         (gitignored)
  logs/               (gitignored) — <run_id>.jsonl traces
  src/api/            (DEFERRED) future Hono adapter over the same core — see 09-frontend-contract.md
```
**Single command to run the whole thing:** `npm run dev` (= `tsx terminal.ts`) opens the chat app.

---

## 13. Terminal surface (v1) — our interactive chat loop
> **Two loops, both ours, no framework:** the **outer chat loop** (`while` around `readline`) reads
> each typed question; its "eval" step is a full call to the **inner agent harness loop** (`runAgent`'s
> `while`). One question = one `runAgent` run = many harness iterations.
```
$ npm run dev                         # = tsx terminal.ts — opens the chat app directly

prompt> <type your research question>   → runs a NEW research run; live tree + streamed answer
prompt> /history                        → list past runs (from SQLite, newest-first)
prompt> /open <run_id>                  → reprint a past run's answer + Sources
prompt> /help                           → list commands
prompt> /exit  (or Ctrl-C)              → quit
```
Behavior: free text = a question (the common case, like Claude Code). The renderer subscribes to
the `AgentEvent` stream and redraws the sub-agent tree live; the final answer streams token-by-token,
then a numbered **Sources** list prints. Everything is mirrored to SQLite + `logs/` as it happens.

### Web API surface (DEFERRED — see `09-frontend-contract.md`)
A future Hono adapter exposes the same runs over HTTP (`POST /research`, `GET /runs`,
`GET /runs/:id`, `GET /runs/:id/tree`). The agent core does not change when added.

---

## 14. Status
Design **complete and reviewed**. v1 is **terminal-first** (single entry `terminal.ts`, interactive
chat loop, live tree, streamed answer). All decisions locked above. Deferred (by choice): the web API +
frontend (`09-frontend-contract.md`, same core), long-running durable execution (Temporal phase),
auth. Next artifact: a sprint/build plan (`07-sprint-plan.md`) turning this into ordered, verifiable
steps — Phase 4 = the **terminal renderer** (not a web API). Not yet scaffolded.
