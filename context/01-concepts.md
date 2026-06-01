# 01 — Concepts: the harness mental model

> This is the hard-won understanding the whole project rests on. If you forget everything else,
> keep this.

## Three actors (not two)
People say "the LLM" but there are really THREE distinct layers:

```
1. THE MODEL            — neural net weights on GPUs. Generates RAW TOKENS.
                          Knows NOTHING about JSON, `type`, or `finish_reason`. Just math.
2. THE API / INFERENCE  — the provider's SERVER software around the model
   SERVER                 (Anthropic's / OpenAI's machines behind api.*.com).
                          PARSES the raw tokens → tagged JSON. Sets finish_reason, ids, types.
3. THE HARNESS          — OUR code. Owns the message array, the loop, tool execution.
                          Creates tool_result. Decides loop-or-stop by reading the tag.
```

- The **model decides WHAT** (content/intent) — the non-deterministic part.
- The **API server decides packaging** (tags/ids/finish_reason) — deterministic formatting.
- The **harness decides control flow** by reacting to the server's tag — deterministic loop.

## What "the LLM returns" really is
The model emits tokens like: `"let me search..." <tool_call>web_search{"query":"..."}</tool_call>`.
The **API server** wraps that into clean JSON:
```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [{ "id": "call_abc", "type": "function",
                   "function": { "name": "web_search", "arguments": "{\"query\":\"...\"}" } }],
  "finish_reason": "tool_calls"
}
```
- Content (text, tool name, args string) = from the **model**.
- Envelope (`role`, `type`, `id`, `finish_reason`) = added by the **API server**.
- `arguments` is a **JSON STRING** → you must `JSON.parse` it (parse-don't-trust seam).

## The loop (the entire engine)
```
while (true):
   res = POST /chat/completions (messages, tools)   ← re-send the WHOLE growing messages[]
   if finish_reason == "tool_calls":                ← model wants a tool
       run the tool(s) deterministically
       append tool result(s) to messages
       continue                                     ← LOOP: re-POST (LLM is stateless)
   else (finish_reason == "stop"):                  ← no tool call
       return message.content                       ← EXIT: answer to user
```
Key truths:
- **The conversation (`messages[]`) IS the state.** Memory = what's still in the array.
- **The LLM is stateless** — each iteration is a fresh HTTP POST with the full history.
- **The model decides when it's done** (by NOT calling a tool); the **harness detects the
  absence** and stops. The harness never counts steps or judges "complete" itself.
- **Loop length is NOT pre-decided** — it emerges from how many tools the model requests.

## Two kinds of "return" (never confuse)
- **tool_result → back to the LLM** (mid-loop, every iteration, so it can react).
- **final text → to the USER** (loop over; the LLM is NOT re-invoked).

## A tool is just...
> **"a name the model calls + something the harness does in response."**

Usually that "something" is small (search, read a file). For a **sub-agent** (`spawn_researcher`),
that "something" is **running a WHOLE other agent loop**. The model can't tell the difference —
to it, `spawn_researcher` is just another tool that returns a string. The harness keeps the secret.

## Sub-agents = same loop, new notebook
A sub-agent is `runAgent()` **calling itself**: fresh `messages[]` (own context = own cache),
a **narrowed toolset**, `depth+1`. It does noisy work in ITS context, returns only a **compressed
summary** to the parent. Parent's context stays lean. Point = **context isolation**, not recursion
for its own sake. (Narrowed toolset also bounds recursion: children can't spawn grandchildren.)

## This is universal
Every tool-using agent — coding, mail, calendar, finance, research — uses the **identical
harness**. Only the **tools** change. The harness is domain-blind plumbing; the tools are the
agent's personality.

## finish_reason is the server's, not ours
The loop-control signal (`finish_reason`: `"tool_calls" | "stop" | "length" | "content_filter"`)
is **decided by the API server**. We don't invent our own loop states — we **map** theirs into
our own typed union (`LoopAction`) at one seam (`decide()`), then branch on ours. See
`05-unions-and-control-flow.md`.
