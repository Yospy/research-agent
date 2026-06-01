# Deep Research Agent — Context Index

> A from-scratch TypeScript **deep research agent** built on the **OpenAI raw HTTP API**
> (NOT the Agents/Assistants SDK). We own the `while`-loop harness. The agent plans
> research threads, **spawns isolated sub-agents** per thread via recursion, and
> synthesizes a cited answer. Search via **Exa**. Everything stored locally in **SQLite**.
>
> **v1 is an interactive terminal app** (Claude Code / Codex style): one entry script
> `terminal.ts` opens our own chat loop — type a question, watch the sub-agent tree render live,
> get a streamed cited answer. A web API + frontend is **deferred** (`09-frontend-contract.md`).

This directory is the durable context so the project can be picked up cold.

## Read in this order
1. [`00-overview.md`](00-overview.md) — pitch, problem statement, constraints, why this project.
2. [`01-concepts.md`](01-concepts.md) — the harness mental model (model vs API server vs harness, the loop, unions). The hard-won understanding.
3. [`02-architecture.md`](02-architecture.md) — full architecture diagram, file layout, the 3 layers.
4. [`03-tools.md`](03-tools.md) — the 3 tools + Exa API details + sub-agent spawning.
5. [`04-data-models-and-db.md`](04-data-models-and-db.md) — TS types + SQLite schema (5 tables).
6. [`05-unions-and-control-flow.md`](05-unions-and-control-flow.md) — finish_reason → LoopAction, AgentResult, the decide() seam.
7. [`06-caching.md`](06-caching.md) — the two cache layers (OpenAI prompt cache + Exa SQLite cache).
8. [`07-sprint-plan.md`](07-sprint-plan.md) — **THE BUILD PLAN**: the 8 implementation slices (commit-sized, dependency-ordered), each with files + verify + risks. Start here to code.
9. [`08-decisions-and-architecture.md`](08-decisions-and-architecture.md) — **BUILD-READY**: every locked tech decision + the full architecture in one place. **Terminal-first v1** (`terminal.ts` chat loop). Read this + `01-concepts.md` to build.
10. [`09-frontend-contract.md`](09-frontend-contract.md) — **DEFERRED (future web phase)**: API contract, DTOs, TS types, screens/UX. Self-contained; not part of terminal v1.

## Resume-cold prompt (paste verbatim)
> I'm continuing the **Deep Research Agent** described in
> `/Users/yashwadgave/Desktop/practice/context/`. It's a from-scratch TypeScript agent on the
> **OpenAI raw Chat Completions API** (no Agents SDK) — we own the `while`-loop harness. It uses
> **Exa** for search (key in `.env` as `EXA_API_KEY`), stores everything in **SQLite**, and
> **spawns sub-agents** (recursion + context isolation). **v1 is a terminal app** — single entry
> `terminal.ts` opens our own interactive chat loop (no web server, no REPL framework). Read the context files in order, then
> start the sprint in `07-sprint-plan.md`. The OpenAI key is in `.env` as `OPENAI_API_KEY`
> (do NOT read or log it). Follow the global workflow rules (sprint mode, verify each step).

## Keys / env (in `.env`, never read or log)
- `OPENAI_API_KEY` — OpenAI raw API
- `EXA_API_KEY` — Exa search

## Status
Design complete; build plan ready. Not yet scaffolded. Start at `07-sprint-plan.md` **Slice 0**.
