# 05 — Unions & control flow

There are TWO layers of union. Only ONE is ours to decide.

## Layer 1 — loop control = `finish_reason` (the SERVER's, we react)
The signal that drives the `while` loop is **decided by the OpenAI API server**. We do NOT invent
our own loop-control states.
```
finish_reason  (OpenAI):
   "tool_calls"      → model wants a tool → run it, loop
   "stop"            → no tool, just text → return to user, done
   "length"          → hit max_tokens     → handle (continue/truncate/error)
   "content_filter"  → blocked            → error path
```
(Anthropic equivalent: `stop_reason` with `"tool_use"` / `"end_turn"`.)

### Reconciliation with the original PROJECT.md
The original `project/PROJECT.md` (plan-then-execute) had US design a `Step` union
(`call_tool | spawn_agent | reason | finalize`). We **pivoted to the real harness**
(model-driven, step-by-step). In that design, **`finish_reason` + the model's `tool_calls`
REPLACE the `Step` union** — the model decides each step live; the server tags it. So we no longer
hand-design a control union; the wire provides one.

## The seam: map THEIR string → OUR typed union
Best practice: translate the loose wire string into our own union at ONE place (`decide()`), then
the loop branches on OUR vocabulary. Parse-don't-trust, applied to control flow.

```ts
// OUR union — the loop decision, normalized
type LoopAction =
  | { kind: "run_tools"; calls: ToolCall[] }   // from "tool_calls"
  | { kind: "done"; answer: string }            // from "stop"
  | { kind: "error"; reason: string };          // from "length" | "content_filter" | unknown

function decide(res): LoopAction {
  const choice = res.choices[0];
  const msg = choice.message;
  switch (choice.finish_reason) {
    case "tool_calls": return { kind: "run_tools", calls: msg.tool_calls! };
    case "stop":       return { kind: "done", answer: msg.content ?? "" };
    default:           return { kind: "error", reason: choice.finish_reason };
  }
}
```
Benefits: one seam owns vendor translation (swap to Anthropic → change only `decide()`); the loop
reads in our vocabulary; TS exhaustiveness forces handling every case.

## Layer 2 — agent return = `AgentResult` (OURS, the load-bearing one)
What the server does NOT give us is **what a finished agent returns to its parent**. THIS is the
discriminated union we design and "feel" — `Result<T>` with a real job.
```ts
type AgentResult =
  | { ok: true;  answer: string; citations: string[] }
  | { ok: false; error: string; partial?: string };
```
When `spawn_researcher` finishes it returns one of these; the **parent matches on `.ok`** to decide
"use the summary" vs "re-dispatch / give up". This is the union that makes the recursion type-safe
as results bubble up.

## The loop, branching on OUR union
```ts
async function runAgent(question, tools, ctx): Promise<AgentResult> {
  const messages: Msg[] = [systemMsg, { role: "user", content: question }];
  let calls = 0;
  while (true) {
    const res = await callLLM(messages, tools);     // POST /chat/completions
    persistMessage(res, ctx);                        // + cached_tokens
    const action = decide(res);                      // their string → our union

    switch (action.kind) {
      case "run_tools":
        messages.push(res.choices[0].message);       // the assistant turn
        for (const call of action.calls) {
          if (++calls > ctx.toolBudget) return { ok: false, error: "tool budget exceeded" };
          const result = await callTool(call, tools, ctx);  // parse args → run → result
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;                                    // re-POST
      case "done":
        return { ok: true, answer: action.answer, citations: collectCitations(ctx) };
      case "error":
        return { ok: false, error: action.reason };
    }
  }
}
```

## Optional Layer 3 — trace events (ours, for SQLite/printing)
```ts
type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "spawned"; sub_question: string; depth: number }
  | { kind: "result"; result: AgentResult };
```
Nice-to-have for the trace viewer; not required for the loop.

## Summary
```
WHO DECIDES WHICH UNION:
   loop control  →  finish_reason  →  API SERVER decides; we map → LoopAction, then react
   agent return  →  AgentResult    →  WE design; parent matches .ok (the real "design a union")
   trace events  →  AgentEvent     →  WE design; optional, observability only
```
