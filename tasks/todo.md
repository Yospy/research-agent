# Todo: Go Orchestrator for Sub-Agent Spawning (Phase 1)

Plan: `~/.claude/plans/now-please-create-a-shimmying-tiger.md`

## Tasks

### Go orchestrator (`orchestrator/`)
- [ ] `go.mod` (module + golang.org/x/sync)
- [ ] `types.go` — envelope structs
- [ ] `worker_client.go` — POST /run, transport vs semantic distinction
- [ ] `orchestrate.go` — fan-out: semaphore + per-task timeout + 1 retry + ordered collect
- [ ] `main.go` — POST /orchestrate handler + env config
- [ ] `orchestrate_test.go` — fake-worker unit tests (concurrency, ordering, timeout, retry rules)

### Node side (additive)
- [ ] `config.ts` — ORCHESTRATOR_URL, WORKER_PORT, ROOT_DEADLINE_MS, policy defaults
- [ ] `types.ts` — add `deadline?: number` to AgentCtx
- [ ] `runAgent.ts` — loop-top deadline guard
- [ ] `src/worker/runResearcher.ts` — extracted sub-agent body
- [ ] `src/worker/server.ts` — in-process POST /run server
- [ ] `tools/spawn_researcher.ts` — MODIFIED → RPC client (batch, try/catch, emit events, merge citations)
- [ ] `terminal.ts` — start worker server + set ctx.deadline
- [ ] `.env.example` — new var names

### Review & verify (subagent ONLY)
- [ ] Launch code-review subagent over full diff
- [ ] `go test ./...` in orchestrator
- [ ] End-to-end: happy path, orchestrator-down, timeout, root-deadline

## Review

Status: **Phase 1 complete.** All tasks above implemented.

Verification:
- `cd orchestrator && go vet ./... && go test -race ./...` → 6/6 pass (ordering, concurrency cap,
  timeout→retryable, transport-retry-then-success, transport-all-fail, semantic-no-retry).
- `npm run build` (tsc --noEmit) → clean.
- Boot smoke: orchestrator `/healthz` ok; worker-down fan-out → ordered retryable per-task errors;
  in-process worker `/healthz` 200, unknown route 404.

Subagent code review: no Critical; verdict "ship Phase 1 after M1." Fixes applied:
- **M1** worker `server.on("error")` → clean exit on EADDRINUSE instead of crashing the REPL.
- **M2** root deadline now binding during fan-out via `AbortSignal` on the orchestrator fetch.
- **m1** child citations preserved & merged even when the child ultimately fails.
- **m3** `sub_questions` requires ≥1 non-empty entry (empty fan-out rejected via Zod).

Known Phase-1 limitations (by design — addressed in Phase 2):
- **M3** transport-timeout retry is non-idempotent: a retried attempt re-creates the child agent
  row and re-runs the researcher (duplicate rows + token cost), and attempt-1 may keep running
  since `runAgent` takes no AbortSignal yet. Phase 2 (cancellation) fixes this.
- No live sub-agent tree — children render with final status only (Phase 2 adds NDJSON heartbeat).
- m2 (`maxDepth:2` is belt-and-suspenders; toolset is the real bound), m4 (worker 500 body is
  human-facing only), m5 (`maxConcurrency<=0` falls back to default) — accepted as-is.

Not run: live end-to-end happy path (interactive REPL + paid OpenAI/Exa calls) — left for the user.
Run with: `cd orchestrator && go run .` (terminal A) + `npm run dev` (terminal B).

## Follow-up: orchestrator observability (added)
Added concise logging to the Go orchestrator (`main.go` had only startup; now `orchestrate.go`
logs per request + per task) — no behavior change:
- per-request: `/orchestrate kind=… tasks=N policy={conc,timeout,retry}`
- per-task: `→ worker (slot acquired)`, `✓ ok agent=… (Xs)`, `✗ fail retryable=… (Xs)`, `⟳ retry k/N`
- concurrency-efficiency summary: `wall`, `serial≈` (Σ task durations = sequential-equivalent),
  `speedup` (concurrency gain, bounded by cap and slowest task), `cap`, `slowest`.
Verified via fake-worker demo: 5 tasks / cap 3 → wall=4.0s serial≈10.1s speedup=2.50x. go test still 6/6.
Note: the speedup measures CONCURRENCY (parallel vs sequential), not Go-vs-TS — sub-agents still run in TS.
