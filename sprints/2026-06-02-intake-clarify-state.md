# Sprint — Intake clarify state (Dynamic #1: upfront, generated questions)

## Scope (build EXACTLY this)
A deterministic **intake state** that runs once, at the root, before the research loop.
The harness ALWAYS enters it; the LLM decides (dynamically) whether the topic is ambiguous and,
if so, generates 1–3 clarifying questions. We ask the user, fold answers into an enriched **brief**,
and hand that to `runAgent`. If the topic is clear → 0 questions → straight to research.

Mental model: same seam as `decide()`. Model emits a signal (`ambiguous`/`questions`) in a vacuum;
the harness owns the control flow (whether/when/once to ask). Model signals, harness switches.

## Out of scope (later)
- Dynamic #2: re-clarifying MID-research (that's a model-triggered `ask_user` **tool**, a separate slice).
- No schema change; the brief becomes the run's `question`, so clarifications persist for free.

## Changes
- **NEW** `src/agent/intake.ts`
  - `intake(topic, { ask }) -> Promise<string>` (the brief).
  - One `callLLM` with a dedicated intake prompt → `{ ambiguous, questions }` (Zod, max 3).
  - **Fail-open**: any LLM/parse error → return the raw topic (never block research).
  - Asks via injected `ask` (UI-agnostic); empty answers dropped; if none answered → raw topic.
- **EDIT** `terminal.ts`
  - Run `intake()` before `createRun`; seed run with the brief.
  - Replace `for await (const line of rl)` with a single shared line-queue (`makeLineReader`) so the
    command loop and the intake answers consume the SAME stdin without double-reading; null = EOF.
  - `makeAsker` renders each question and reads its answer from the same queue.

## Verification
1. `npm run build` (`tsc --noEmit`) passes.
2. `tmp_verify_intake.ts` with a STUB `ask`: vague topic ("AI agents") → questions asked, brief enriched;
   specific topic ("capital of France, cite sources") → 0 questions → brief === topic. (1 cheap LLM call
   each, NO Exa / no full research.) Delete the temp file after.
3. Confirm `runAgent` / `decide` / `callTool` are untouched (git diff).

## Status: DONE
