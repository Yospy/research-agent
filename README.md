# deep-research-agent

A from-scratch **TypeScript deep-research agent** that runs in your terminal. It's built directly on
the **OpenAI raw HTTP API** (no Agents/Assistants SDK) — we own the `while`-loop harness. Given one
hard question, it plans research threads, **spawns isolated recursive sub-agents** that search and
read the web via **Exa**, and synthesizes a **cited answer** — all streamed live in the terminal.

> The point of the project is to **own the harness by hand**: the LLM provides *intent* (which tool,
> what args, when it's done); our code does the deterministic *execution* (the loop, arg validation,
> tool dispatch, recursion, persistence). Fuzzy intent in, exact execution out.

```
prompt> Compare Exa and Tavily as search APIs for AI agents, a researcher for each.
◆ root "Compare Exa and Tavily…"            [running]
  ├─ ◆ spawn "what is Exa?"                  [done]
  │    ├─ 🔍 web_search "exa.ai search api"     120ms
  │    └─ 📄 read_source exa.ai/about           340ms
  └─ ◆ spawn "what is Tavily?"               [running]
…the cited answer then streams in below, with clickable [n] sources…

📊 12.4k tokens · 9.1k cached (73%) · 6 tool calls
```

## Features
- **Hand-rolled agent loop** — `finish_reason → LoopAction` seam, parse-don't-trust tool args (Zod), `tool_call_id` matching.
- **Recursive sub-agents** — context isolation + constraint propagation; bounded by depth cap + toolset narrowing.
- **Cited answers** — harness-owned citation set (born on `read_source`); `[n]` markers render as clickable terminal links.
- **Live sub-agent tree** — Claude Code / Codex style, redrawn as events fire.
- **Token streaming** + an end-of-run metrics line (tokens · cached · tool calls).
- **Durable** — every run mirrored to SQLite (`research.db`) and a JSONL trace (`logs/<run_id>.jsonl`); `/history` + `/open`.
- **Two caches** — OpenAI prompt cache (measured via `cached_tokens`) + an Exa result cache in SQLite.

## Prerequisites
- **Node 23+**
- An **OpenAI API key** and an **Exa API key** (both make real, billed calls).

## Setup
```bash
npm install
cp .env.example .env      # then fill in OPENAI_API_KEY and EXA_API_KEY
```

## Run
```bash
npm run dev               # opens the interactive chat loop (tsx terminal.ts)
```
Commands inside the app:
```
<question>      run a new research run
/history        list past runs
/open <n|id>    reprint a past run (answer + sources)
/help           show commands
/exit           quit  (Ctrl-C also works)
```
> Run it in a real terminal — the live tree and streaming animate in a TTY, and `[n]` sources are
> clickable in modern terminals (iTerm2, macOS Terminal, VS Code, WezTerm…).

`npm run build` typechecks the project (`tsc --noEmit`).

## How it works
```
terminal.ts (chat loop)
   └─ runAgent(question, ROOT_TOOLS, ctx)        ← the while-loop harness
        ├─ streamLLM ──▶ OpenAI (raw fetch, SSE)
        ├─ decide()    finish_reason → LoopAction
        ├─ callTool()  Zod-parse args → run tool → persist
        │     ├─ web_search / read_source ──▶ Exa (+ SQLite cache)
        │     └─ spawn_researcher ──▶ runAgent(…, CHILD_TOOLS, depth+1)   ← recursion
        └─ events ──▶ live UI + logs/<run_id>.jsonl ;  rows ──▶ SQLite
```

## Project structure
```
terminal.ts              entry — the outer chat loop
src/agent/
  config.ts types.ts     env + the typed contracts
  llm via clients/       clients/llm.ts (OpenAI), clients/exa.ts (Exa + cache)
  runAgent.ts decide.ts  the loop + the finish_reason seam
  callTool.ts events.ts  tool dispatch + JSONL trace
  citations.ts db.ts     citation set + SQLite (5 tables)
  tools/                 web_search, read_source, spawn_researcher, registry
src/ui/                  render (live tree), history, ansi (hyperlinks)
context/                 the full design docs (read 07-sprint-plan.md for the build story)
```

## Design docs
The complete architecture, decisions, and build plan live in [`context/`](context/) — start with
[`context/README.md`](context/README.md).

## Notes
- Each run makes **real, billed** OpenAI + Exa calls.
- `research.db` (history/cache) and `logs/` (traces) are local and gitignored.
- No auth, single-user, local — a web API/frontend is designed but deferred (`context/09-frontend-contract.md`).
