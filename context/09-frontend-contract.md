# 09 — Frontend Contract & UX Spec

> ⏸️ **STATUS: DEFERRED — kept for the future, NOT part of v1.**
> v1 ships as an **interactive terminal app** (`terminal.ts`), not a web UI — see
> `08-decisions-and-architecture.md`. This contract is preserved **unchanged** because the agent
> core is presentation-agnostic: when we add a web frontend later, a thin Hono adapter exposes the
> **same** SQLite-backed runs over the endpoints below — no change to the harness. Build against
> this when the web phase starts; ignore it while building the terminal v1.

> For the **frontend team**. This is everything you need to build the UI **in parallel** with the
> backend: the API contract, the data shapes (DTOs), what each screen shows, and where each piece
> of data comes from. You do NOT need to read the harness internals — just this file.
>
> Backend context (if curious): `08-decisions-and-architecture.md`. But this file is self-contained.

---

## 1. What this product is (so the UI makes sense)
A **deep research agent**. The user asks one hard, open-ended question (e.g. *"Should a D2C coffee
brand expand to quick-commerce in India in 2026?"*). The agent breaks it into sub-questions,
**spawns sub-agents** that each search the web (via Exa) and read sources, then writes a **cited
answer**. The interesting UX is showing (a) the final cited answer and (b) the **tree of
sub-agents** ("show thinking") with the search/read steps each one took.

Think **Perplexity / "deep research"** style: an answer with `[1][2][3]` citations + a Sources
list, plus an expandable reasoning trace.

---

## 2. Ground rules
- **No authentication.** No login, no users, no tokens. A run is identified solely by its `run_id`.
  History = "all runs." Anyone with the URL/`run_id` sees that run.
- **Runs are asynchronous.** `POST /research` returns immediately with a `run_id` and
  `status:"running"`. The agent keeps working in the background. **The frontend polls** the GET
  endpoints to show progress (no streaming/websockets in v1).
- **The backend is the source of truth.** The UI only renders what the API returns; it never
  computes research state itself.
- Base URL: TBD by backend (e.g. `http://localhost:8787`). All JSON. CORS will be enabled for local dev.

---

## 3. API contract

### 3.1 `POST /research` — start a run
Request:
```json
{ "question": "Should a D2C coffee brand expand to quick-commerce in India in 2026?" }
```
Response `200`:
```json
{ "run_id": "r_8f3a...", "status": "running" }
```
Errors: `400 { "error": "question is required" }`.

> After this, poll `GET /runs/:id` until `status` is `done` or `error`.

### 3.2 `GET /runs` — history list (sidebar)
Response `200`:
```json
[
  { "run_id": "r_8f3a", "question": "Should a D2C coffee brand...", "status": "done",    "created_at": 1717200000000 },
  { "run_id": "r_2b1c", "question": "Pricing strategy for...",      "status": "running", "created_at": 1717100000000 }
]
```
Sorted newest-first. Use for the history sidebar. `status ∈ { running | done | error }`.

### 3.3 `GET /runs/:id` — one run (main view)
Response `200`:
```json
{
  "run_id": "r_8f3a",
  "question": "Should a D2C coffee brand expand to quick-commerce in India in 2026?",
  "status": "done",
  "final_answer": "Yes, with caveats. Margins on Blinkit/Zepto run ~18–22% [1], but ... [2][3].",
  "citations": [
    { "n": 1, "title": "Quick-commerce margins report 2026", "url": "https://exa.../a" },
    { "n": 2, "title": "Blinkit seller economics",            "url": "https://exa.../b" },
    { "n": 3, "title": "D2C logistics in India",              "url": "https://exa.../c" }
  ],
  "metrics": { "total_tokens": 12400, "cached_tokens": 9100, "cache_hit_ratio": 0.73, "tool_calls": 6 },
  "created_at": 1717200000000,
  "finished_at": 1717200042000
}
```
Notes:
- While `status:"running"`, `final_answer` is `null`/empty and `citations` may be partial. Keep polling.
- `citations[].n` is the stable number used as `[n]` markers inside `final_answer`. Render a
  **Sources** list from this array; you may make `[n]` in the answer clickable to scroll to source `n`.
- `metrics` powers the small stats panel. `cache_hit_ratio = cached_tokens / total_tokens`.

### 3.4 `GET /runs/:id/tree` — the reasoning trace ("show thinking")
Returns the **recursion tree**: the root agent and every sub-agent it spawned, each with its
tool steps. Recursive shape:
```json
{
  "root": {
    "agent_id": "a0",
    "sub_question": "Should a D2C coffee brand expand to quick-commerce in India in 2026?",
    "depth": 0,
    "status": "done",
    "summary": null,
    "tool_calls": [
      { "name": "web_search", "args": { "query": "coffee D2C quick-commerce india 2026" },
        "result_preview": "[5 results]", "ms": 120 }
    ],
    "children": [
      {
        "agent_id": "a1",
        "sub_question": "Blinkit/Zepto margins for D2C brands?",
        "depth": 1,
        "status": "done",
        "summary": "Margins ~18–22%; listing + fulfilment fees are the main drag ...",
        "tool_calls": [
          { "name": "web_search",  "args": { "query": "blinkit seller margin" }, "result_preview": "[5 results]", "ms": 90 },
          { "name": "read_source", "args": { "id_or_url": "https://exa.../b" },  "result_preview": "Blinkit seller economics ...", "ms": 340 }
        ],
        "children": []
      }
    ]
  }
}
```
Field meanings:
- `depth` — nesting level (0 = root). Use for indentation.
- `status` — per-node `running | done | error` (show a spinner on `running` nodes).
- `summary` — what a sub-agent reported up to its parent (root's is usually `null`).
- `tool_calls[]` — ordered steps; `name ∈ { web_search | read_source | spawn_researcher }`.
  `result_preview` is a short string for display; `ms` is latency (show as a badge).
- `children[]` — sub-agents spawned by this node (the `spawn_researcher` calls).

> Tree depth is small (max ~2 levels). A node with `tool_calls` containing `spawn_researcher`
> corresponds to entries in `children[]`.

### 3.5 Polling guidance
- Poll `GET /runs/:id` (and `/tree` if the trace is open) every **1–2s** while `status:"running"`.
- Stop polling when `status` becomes `done` or `error`.
- On `status:"error"`, show the partial answer if present and an error state.

---

## 4. Screens & what each shows

### 4.1 Layout
```
┌──────────────┬──────────────────────────────────────────────────────────┐
│  HISTORY     │   RESEARCH RUN                                            │
│ (GET /runs)  │   (GET /runs/:id)                                         │
│              │                                                            │
│ ▸ Coffee D2C │   ❓ "<question>"                                          │
│   done · 2h  │   ───────────────────────────────────────────────────     │
│ ▸ Pricing    │   ✅ ANSWER  (final_answer, with [1][2][3] markers)        │
│   running... │      Sources:  [1] title · [2] title · [3] title          │
│ ▸ Market     │                                                            │
│   done · 1d  │   ▼ Show thinking  (GET /runs/:id/tree)                    │
│              │   ┌────────────────────────────────────────────────────┐  │
│ [+ New]      │   │ ◆ root: "<question>"                     [done]     │  │
│              │   │   ├─ 🔍 search "coffee D2C 2026"           120ms    │  │
│              │   │   ├─ ◆ spawn: "Blinkit margins?"           [done]   │  │
│              │   │   │    ├─ 🔍 search ...                90ms          │  │
│              │   │   │    ├─ 📄 read  exa.../b            340ms         │  │
│              │   │   │    └─ ⮑ summary: "margins ~18–22%..."          │  │
│              │   │   └─ ◆ spawn: "competitor moves?"     [running...]  │  │
│              │   └────────────────────────────────────────────────────┘  │
│              │                                                            │
│              │   📊 12.4k tokens · 9.1k cached (73%) · 6 tool calls       │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### 4.2 History sidebar — `GET /runs`
- List of past runs (newest first): question (truncated), status chip, relative time.
- `[+ New]` opens an input → `POST /research` → route to the new `run_id` view.
- A `running` item shows a spinner; flips to `done` on next poll.

### 4.3 Run view — `GET /runs/:id`
- **Question** header.
- **Answer**: render `final_answer` markdown; turn `[n]` into clickable anchors to Sources.
- **Sources**: numbered list from `citations[]` (`n`, `title`, clickable `url`).
- **Metrics**: small panel from `metrics`.
- **States**: `running` → skeleton/typing indicator + keep polling; `error` → error banner (+ partial if any).

### 4.4 "Show thinking" — `GET /runs/:id/tree`
- Collapsible tree, indented by `depth`.
- Node = an agent: label `sub_question`, status chip, and its `summary` (if present) shown when expanded.
- Under each node, its `tool_calls` as step rows: icon by `name` (🔍 search, 📄 read, ◆ spawn),
  the `args` (query/url), `result_preview`, and `ms` badge.
- `spawn` steps correspond to child nodes — render children nested beneath.
- `running` nodes show a spinner and update on poll.

---

## 5. Data dictionary (quick reference)

| Field | Where | Meaning |
|-------|-------|---------|
| `run_id` | all | the only handle for a run (no auth) |
| `status` | run, agent node | `running` \| `done` \| `error` |
| `question` | run | the user's original question |
| `final_answer` | `/runs/:id` | markdown answer with `[n]` citation markers |
| `citations[]` | `/runs/:id` | `{ n, title, url }` — authoritative source list (n matches `[n]`) |
| `metrics` | `/runs/:id` | `{ total_tokens, cached_tokens, cache_hit_ratio, tool_calls }` |
| `tree.root` | `/runs/:id/tree` | recursive `AgentNode` |
| `agent_id` | node | unique per agent |
| `sub_question` | node | this agent's task (root = the question) |
| `depth` | node | nesting level (0 = root) |
| `summary` | node | what the sub-agent reported up to its parent |
| `tool_calls[]` | node | ordered steps: `{ name, args, result_preview, ms }` |
| `children[]` | node | sub-agents spawned here |

---

## 6. TypeScript types (copy into the frontend)
```ts
type Status = "running" | "done" | "error";

interface RunSummary {            // GET /runs[]
  run_id: string;
  question: string;
  status: Status;
  created_at: number;             // ms epoch
}

interface Citation { n: number; title: string; url: string; }

interface RunDetail {             // GET /runs/:id
  run_id: string;
  question: string;
  status: Status;
  final_answer: string | null;
  citations: Citation[];
  metrics: {
    total_tokens: number;
    cached_tokens: number;
    cache_hit_ratio: number;      // 0..1
    tool_calls: number;
  };
  created_at: number;
  finished_at: number | null;
}

interface ToolStep {
  name: "web_search" | "read_source" | "spawn_researcher";
  args: Record<string, unknown>;  // e.g. { query } or { id_or_url } or { sub_question }
  result_preview: string;
  ms: number;
}

interface AgentNode {             // GET /runs/:id/tree → { root: AgentNode }
  agent_id: string;
  sub_question: string;
  depth: number;
  status: Status;
  summary: string | null;
  tool_calls: ToolStep[];
  children: AgentNode[];
}

interface RunTree { root: AgentNode; }
```

---

## 7. Notes / open items for frontend
- **Streaming is out for v1** — use polling. (A streaming/SSE upgrade may come later; design the
  answer area so it can later accept incremental text without a rewrite.)
- **Empty/partial states**: a `running` run may have empty `final_answer` and a partial tree — render gracefully.
- **Markdown**: `final_answer` is markdown; use a sanitizing renderer. Make `[n]` markers anchor to Sources.
- **Field stability**: shapes above are the contract. If the backend needs to change one, it'll be
  updated here first. Build against these types.
