# 00 — Overview

## One-line pitch
A from-scratch TypeScript **deep research agent**: given one hard, open-ended question, it
**plans research threads, spawns a sub-agent per thread** (each with its own isolated context),
each sub-agent searches/reads independently, and the parent **synthesizes** their compressed
findings into a **cited answer**. We own the loop; no framework.

## Example problem statement
> "Should a D2C coffee brand expand to quick-commerce (Blinkit/Zepto/Instamart) in India in
> 2026? Give a reasoned recommendation with sources."

The agent decomposes this into sub-questions (margins, logistics, competitor moves, consumer
demand), dispatches a sub-agent per sub-question, and writes a cited recommendation.

## Why this project (chosen over a data-analyst agent)
- Mirrors **frontier products** (Perplexity, Claude/OpenAI "deep research").
- Stresses the **hardest, most valuable part** of agent architecture: **sub-agents + context
  isolation + recursion**, and **prompt/KV caching** (large stable prefixes).
- The parent↔child contract (narrow sub-goal down, compressed summary up) is a real design.

## Hard constraints (decided)
1. **OpenAI raw HTTP API** (`POST /v1/chat/completions`) — NOT the Agents/Assistants SDK.
2. **We build our own `while`-loop harness.** No LangChain/LlamaIndex/frameworks.
3. **Exa** for search (account exists; key in `.env` as `EXA_API_KEY`).
4. **SQLite** for ALL local storage (transcript, agent tree, tool calls, Exa cache).
5. **Caching is a first-class, measured concern** (see `06-caching.md`).

## Learning goals (why we're building it)
- **Feel the harness**: the `while` loop, `finish_reason` branching, parse-don't-trust.
- **Master sub-agents**: recursion, context isolation, constraint propagation (narrowed toolset).
- **Understand prompt/KV caching**: stable-prefix design, measure `cached_tokens` per call.
- **Design our own discriminated unions** (`LoopAction`, `AgentResult`) at the boundaries.

## Interface (v1)
- **Interactive terminal app** (Claude Code / Codex style). One entry script `terminal.ts`: run it,
  our own chat loop opens, you type questions, the sub-agent tree renders live, and the cited answer
  streams in. No server to start. (A web API + frontend is **deferred** — see `09-frontend-contract.md`.)

## Tech / env  (locked — see `08-decisions-and-architecture.md`)
- Node 23, TypeScript strict, **ESM**.
- Raw `fetch` POST to OpenAI (no `openai` SDK) — keep the wire visible.
- `.env` (never read/log): `OPENAI_API_KEY`, `EXA_API_KEY`.
- Model: `process.env.OPENAI_MODEL ?? "gpt-5.1"` (final — no fallback model).
- `dotenv.config({ quiet: true })` (dotenv v17+ is verbose otherwise).

## Out of scope (don't drift)
- Agents/Assistants SDK, native "tools runtime", vector DBs, LangChain.
- Web API + frontend — **deferred**, contract preserved in `09-frontend-contract.md`.
- Multi-user / auth / deployment.
- Durable workflow engine (Temporal etc.) — local process + SQLite transcript is enough for v1.
