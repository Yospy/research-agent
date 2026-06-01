# 07 — Sprint / Build Plan (the implementation split)

> The ordered, verifiable build sequence for the **terminal-first v1**. Turns
> `08-decisions-and-architecture.md` (the *what/how*) into *in-what-order + how-we-verify-each-step*.
> **Build outward from the leaves.** Each slice below is a commit/PR-sized unit that **compiles and
> is verifiable on its own** — never build on unproven code. Do the slices top-to-bottom.

Related: `08-decisions-and-architecture.md` (locked decisions + file layout), `01-concepts.md`
(mental model), `05-unions-and-control-flow.md` (the loop), `06-caching.md` (what to measure).
`09-frontend-contract.md` is **DEFERRED** (web phase) — ignore it for v1.

---

## Scope (v1)
An interactive terminal app: one entry `terminal.ts` → our own outer chat loop → type a question →
the inner `runAgent` harness loop runs (with recursive sub-agents) → live sub-agent tree renders →
a cited answer streams in. Everything mirrored to SQLite + `logs/<run_id>.jsonl`. **No web API, no
auth, no streaming-to-browser.** (Web API + frontend deferred; durable execution deferred.)

## Assumptions
- `.env` holds `OPENAI_API_KEY` + `EXA_API_KEY` (Exa account exists). **Never read or log the values.**
- Model `gpt-5.1` (`process.env.OPENAI_MODEL ?? "gpt-5.1"`, no fallback). Node 23, ESM, TS strict.
- Two loops, both hand-written: outer **chat loop** (`while` around `readline`) + inner **agent
  harness loop** (`runAgent`'s `while`). No REPL framework, no `openai` SDK (raw `fetch`).

## Build principle (why this order)
Dependencies point inward; we build leaves first so every slice is independently testable without
mocking the next. Network seams isolated → loop proven → recursion added → UI last (engine runs
headless via throwaway scripts before any UI exists).

---

## The 8 slices

### Slice 0 — Scaffold  *(compiles & runs)* — ✅ DONE
**Goal:** an app you can launch that echoes input.
- Files: `package.json` (`"type":"module"`, scripts `dev: tsx terminal.ts`, `build: tsc`),
  `tsconfig.json` (strict, ESM, `moduleResolution: NodeNext`), `.gitignore`
  (`.env`, `research.db`, `logs/`, `node_modules`, `dist`), `terminal.ts` stub.
- `terminal.ts` stub: print a banner, `readline` loop that echoes the line; `/exit` + Ctrl-C quit.
- **Verify:** `npm run dev` → prompt appears, echoes your input, `/exit` quits cleanly. `npm run build` passes.
- **Risks:** ESM + `tsx`/`tsconfig` mismatch → settle `NodeNext` + `"type":"module"` now, not later.

### Slice 1 — Config + types  *(the contracts)* — ✅ DONE
**Goal:** typed foundation everything imports; fail fast on missing env.
- Files: `src/agent/config.ts` (`dotenv.config({quiet:true})`, assert both keys **present** —
  throw a clear error naming the missing key, **never print its value**; export `MODEL`),
  `src/agent/types.ts`.
- `types.ts`: `Tool<A,R>`, `Msg`, `ToolCall`, `LoopAction`, `AgentResult`, `AgentCtx`, `AgentEvent`
  (shapes are in `08` §4/§5/§9 and `05`).
- **Verify:** `npm run build` passes; deleting a key from `.env` → clear thrown error, no value leaked.
- **Risks:** accidental logging of secrets — assert presence with `in`/length checks only.

### Slice 2 — DB  *(durable mirror)* — ✅ DONE
**Goal:** SQLite with the 5 tables + typed helpers.
- Files: `src/agent/db.ts` — open `research.db`, `CREATE TABLE IF NOT EXISTS` the 5 tables
  (`runs, agents, messages, tool_calls, exa_cache` — schema in `08` §9), helpers:
  `createRun`, `finishRun`, `createAgent`, `insertMessage`, `insertToolCall`,
  `exaCacheGet(key)`, `exaCacheSet(...)`, plus read helpers for `/history` + `/open`.
- IDs `crypto.randomUUID()`, time `Date.now()`.
- **Verify:** a throwaway init script creates `research.db`; `.tables` shows all 5; a smoke
  insert + read round-trips on each table.
- **Risks:** schema churn later — get columns right per `08` §9 now (esp. `cached_tokens`, `parent_agent_id`).

### Slice 3 — LLM client  *(seam #1, isolated)* — ✅ DONE
**Goal:** prove the OpenAI wire before the loop wraps it.
- Files: `src/agent/clients/llm.ts` — raw `fetch` POST `/v1/chat/completions` with
  `{model: MODEL, messages, tools}`; return the typed response incl.
  `usage.prompt_tokens_details.cached_tokens`, `choices[0].finish_reason`, `message`.
- **Verify:** throwaway script sends `[{role:"user",content:"ping"}]` → gets a reply; print
  `cached_tokens`. Send a long stable prefix twice → watch `cached_tokens` climb.
- **Risks:** auth header / endpoint typos; tool-call response shape — assert it against `05`.

### Slice 4 — Exa client + cache  *(seam #2, isolated)* — ✅ DONE
**Goal:** search/read with the layer-2 cache working.
- Files: `src/agent/clients/exa.ts` — `search(query, n)` → POST `api.exa.ai/search`;
  `contents(idOrUrl)` → POST `api.exa.ai/contents` (header `x-api-key`). **Check `exa_cache`
  (via `db`) before network; write after.** Key = `hash(kind + normalized input)`.
- **Verify:** call `search` twice with same query → 1st hits network, 2nd served from SQLite (no
  network); assert result shapes `[{title,url,id,snippet}]` / `{title,url,text}`.
- **Risks:** unstable cache keys (normalize query/url, lowercase/trim) so hits actually land.

### Slice 5 — Single-agent loop  *(FIRST real milestone — no recursion yet)*
> Most important slice → built in **two sub-phases**: **5a** = the harness spine (proven without
> Exa, with a dummy tool); **5b** = the real research tools + citations on the proven loop.

#### Slice 5a — Harness spine *(tool-agnostic)* — ✅ DONE
**Goal:** the loop machinery, proven WITHOUT Exa.
- Files: `src/agent/events.ts` (per-run JSONL trace → `logs/<runId>.jsonl`),
  `decide.ts` (pure `finish_reason → LoopAction`),
  `callTool.ts` (Zod `parse` untyped args → `run` → result; match `tool_call_id`; log + persist),
  `runAgent.ts` (the `while` spine: tool-defs via `zod-to-json-schema` → `callLLM` → persist+trace →
  `decide` → branch; `toolBudget` fail-closed; degenerate empty-`tool_calls` guard).
- Wire: every turn → `insertMessage` (+ `cached_tokens`); every tool → `insertToolCall`; every seam
  → JSONL trace (union states named).
- **Verify:** headless script with an **inline dummy tool** (`current_time`) — no-tool path → `ok`;
  run_tools path → `ok` with a persisted `tool_calls` row; JSONL trace shows
  `agent_start → llm_response → decide(run_tools) → tool_call → llm_response → decide(done) → agent_result`.

#### Slice 5b — Research tools + citations — ✅ DONE
**Goal:** make it an actual *research* agent.
- Files: `src/agent/citations.ts` (`ctx.citations` collect/merge/dedupe),
  `tools/web_search.ts` (wraps `exa.search`, trims the fat snippet), `tools/read_source.ts`
  (wraps `exa.contents`, births a citation), `tools/registry.ts` (`CHILD_TOOLS`).
- **Verify:** `runAgent("<real research question>", CHILD_TOOLS, ctx)` → `AgentResult.ok` with a
  `[n]`-cited answer and `citations` populated; full trace end-to-end.
- **Risks:** answer EVERY `tool_call` (matched by `tool_call_id`) before the next POST; keep the
  `messages[]` prefix byte-stable; trim search snippets so context/cache don't bloat.

### Slice 6 — Recursion  *(the one hard idea, on a proven base)* — ✅ DONE
**Goal:** sub-agents with bounded depth and citations bubbling up.
- Files: `tools/spawn_researcher.ts` (→ `runAgent(sub_q, CHILD_TOOLS, depth+1)`, fresh ctx,
  returns `{summary, citations}`); add ROOT_TOOLS to `registry.ts`; depth cap (`depth <= maxDepth`)
  + per-agent `toolBudget`; merge child citations into parent; write `agents.parent_agent_id`.
- **Verify:** a fan-out question spawns children; the tree reconstructs from `agents` + `tool_calls`;
  **no `spawn` at the depth cap** (CHILD_TOOLS lack it); exceeding budget → `AgentResult.err`
  (fail-closed). Trace shows `spawn` + nested `agent_start/agent_result`.
- **Risks:** unbounded recursion (guard via BOTH toolset narrowing AND `depth<=maxDepth`); parent
  context bloat (children must return only the compressed `{summary, citations}`).

### Slice 7 — Terminal UI + entry  *(the only UI work)* — ✅ DONE
**Goal:** the app you actually run.
- Files: `src/ui/render.ts` (subscribe `AgentEvent` → live tree redraw via `chalk` + `log-update`),
  `src/ui/stream.ts` (streamed answer chunks + numbered Sources list), `src/ui/history.ts`
  (`/history`, `/open <id>` from SQLite); finish `terminal.ts` (outer chat loop: `readline` →
  free text = question → `runAgent(q, ROOT_TOOLS, ctx{depth:0})` → render; commands `/history`,
  `/open`, `/help`, `/exit`).
- **Verify:** `npm run dev`, ask a real question → live sub-agent tree updates as events fire →
  cited answer streams → Sources print; `/history` lists past runs; `/open <id>` reprints one.
- **Risks:** `log-update` redraw flicker / interleaving with streamed text — render tree and answer
  in distinct regions; keep one writer.

### Slice 8 — Streaming + polish  *(optional; folds into 7)* — ✅ DONE
- Switch `llm.ts` to SSE streaming; emit `thinking` chunks → `stream.ts` prints token-by-token.
- End-of-run metrics line: `total_tokens · cached_tokens · cache_hit_ratio · tool_calls`
  (the numbers from `06`).

---

## Slice → phase map
```
Phase 0  (setup + data)  = Slices 0–2   ✅ DONE
Phase 1  (network seams) = Slices 3–4   ✅ DONE
Phase 2  (single agent)  = Slice 5   ✅ DONE
   ├─ 2a  harness spine          ✅ DONE
   └─ 2b  research tools + cites  ✅ DONE (first demo-able milestone)
Phase 3  (recursion)     = Slice 6   ✅ DONE
Phase 4  (terminal UI)   = Slices 7–8   ✅ DONE
   ├─ 7  live tree + entry + history  ✅ DONE (terminal.ts wired → the agent)
   └─ 8  streaming + metrics polish   ✅ DONE

ALL SLICES COMPLETE — v1 is functionally done.
```

## Cross-cutting guardrails (hold for every slice)
- **Never read or log `.env` values.**
- `callTool` parses untyped `arguments` JSON with Zod at the boundary every time (parse-don't-trust).
- Keep `messages[]` prefix byte-stable: `system → tool defs → turns`, append only to the tail.
- Answer every `tool_call` (matched by `tool_call_id`) before the next POST.
- Depth cap AND toolset narrowing both enforce bounded recursion; `toolBudget` fail-closed.
- Mirror to SQLite + `logs/<run_id>.jsonl` as work happens; union states named at each seam.

## Definition of done (v1)
`npm run dev` opens the chat loop; a real question produces a live tree + streamed cited answer
with a correct Sources list; sub-agents spawn within the depth cap; `cached_tokens` is measured and
climbs on stable prefixes; `/history` + `/open` work; the full run is replayable from
`logs/<run_id>.jsonl` and SQLite.

## Status
**Phase 0 (Slices 0–2) ✅ DONE & verified** (2026-06-01): scaffold + `terminal.ts` echo loop,
`src/agent/config.ts` + `src/agent/types.ts`, `src/agent/db.ts` (5 tables + helpers). `npm install`,
`npm run build`, the echo loop, and DB/config round-trip checks all pass. (Scaffold fix during review:
`allowImportingTsExtensions` added so `src/` files can import each other by `.ts` path.)

**Phase 1 (Slices 3–4) ✅ DONE & verified** (2026-06-01): `src/agent/clients/llm.ts` (raw `fetch`
to OpenAI; `gpt-5.1` confirmed live — ping returned "pong", prompt cache engaged: call-2 cached
1152/1217 prompt tokens) and `src/agent/clients/exa.ts` (`search`/`contents` + layer-2 SQLite cache;
2nd identical call served from cache in 0ms). `npm run build` passes; throwaway verify scripts +
temp db removed.

**Phase 2a (Slice 5a — harness spine) ✅ DONE & verified** (2026-06-01): `events.ts` (JSONL trace),
`decide.ts` (pure seam), `callTool.ts` (parse-don't-trust + persist), `runAgent.ts` (the `while`
spine; tool-defs via `zod-to-json-schema`). Proven headless with an inline dummy `current_time`
tool: no-tool path → `ok` ("4"); run_tools path → model called the tool, looped back, answered;
trace shows the full ordered union states; 5 messages + 1 tool_call persisted. Review caught & fixed
a degenerate empty-`tool_calls` infinite-loop (fail-closed guard). `npm run build` passes.

**Phase 2b (Slice 5b — research tools + citations) ✅ DONE & verified** (2026-06-01): `citations.ts`
(`addCitation`, dedupe by url), `tools/web_search.ts` (wraps `exa.search`, snippet trimmed to 300),
`tools/read_source.ts` (wraps `exa.contents`, births a citation), `tools/registry.ts` (`CHILD_TOOLS`).
End-to-end run ("What is Exa…?") → model searched, read 3 sources (parallel tool calls handled), and
wrote a cited answer; `result.ok`, 3 deduped citations, both tools used, 9 messages persisted, trace
ordered correctly. `npm run build` passes. Note: `[n]` markers in prose can out-number collected
citations (model numbers some against search snippets) — display `n→url` reconciliation is a Slice 7 job.

**Phase 3 (Slice 6 — recursion) ✅ DONE & verified** (2026-06-01): `tools/spawn_researcher.ts`
(recurses into the same `runAgent` at `depth+1`, fresh isolated ctx, `CHILD_TOOLS`), `citations.ts`
+`mergeCitations` (bubble child citations up), `tools/registry.ts` +`ROOT_TOOLS`. Live run
("Exa vs Tavily, a researcher each") → root **spawned 2 children**, each researched in isolation,
4 citations merged up; `agents` tree persisted (root depth 0 + 2 children depth 1, parent=root);
max depth 1 ≤ 2; one trace file shows nested `spawn → child agent_start → agent_result`. Depth-cap
test (deterministic): at `depth=maxDepth` spawn refused, no row created. `npm run build` passes.
(registry↔spawn import cycle is ESM-safe — call-time use only; loaded clean.)

**Phase 4 / Slice 7 (terminal UI + entry) ✅ DONE & verified** (2026-06-01): `terminal.ts` rewired
to a real chat loop (question → `createRun`/`createAgent` → `runAgent(ROOT_TOOLS, ctx{onEvent})` →
answer + Sources; `/history`, `/open <n|id>`, `/help`, `/exit`). New `src/ui/render.ts` (live
sub-agent tree via `log-update`+`chalk`, fed by a new `ctx.onEvent` AgentEvent sink threaded through
`runAgent`/`callTool`/`spawn`) and `src/ui/history.ts`. Also fixed the review gap: `finishAgent`
finalizes every `agents` row (`status`/`summary`) on each `runAgent` return — verified live
(`status=done`, summary set). `/open` reconstructs Sources from `read_source` tool_calls (no schema
change). `npm run build` passes; `npm run dev` smoke (real question) produced a cited answer + Sources
+ working `/history`/`/open`. Deps added: `chalk`, `log-update`.

**Integration status:** ✅ **CLOSED — `terminal.ts` is now wired to the agent.** `npm run dev` is a
working interactive research app (live tree, cited answers, history). Remaining: Slice 8 (token
streaming + metrics) is optional polish.

**Slice 8 (streaming + metrics) ✅ DONE & verified** (2026-06-01): `streamLLM` in `clients/llm.ts`
(SSE deltas reassembled into the same `ChatResponse` shape — content + tool_calls; `onText` per
content delta). `runAgent` streams via `streamLLM`, emitting `thinking` events **only at the root**
(depth 0); `render.ts` freezes the tree on first chunk and streams the answer below it. `db.getRunMetrics`
+ `printMetrics` add the end-of-run line. Verified with a fan-out run (Exa vs Tavily, a researcher
each): **2 children spawned, 19 tool calls, 11 sources merged, answer streamed**, metrics printed
`66.5k tokens · 2.4k cached (4%) · 19 tool calls`. The 19 tool calls executing correctly proves
streamed tool_calls reassemble correctly. `npm run build` passes.

**✅ v1 COMPLETE.** `npm run dev` is the full interactive research app: recursive sub-agents, live
tree, streamed cited answers, history (`/history`/`/open`), metrics, all persisted to SQLite + `logs/`.
