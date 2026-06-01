# 03 — Tools

Three tools. Minimal and deliberately diverse in shape (so the generic `Tool<A,R>` earns its keep).

```
LEAF TOOLS (the hands)
┌────────────────────────────────────────────────────────────────────────┐
│ web_search(query, num_results?=5)                                        │
│     → Exa /search → [{ title, url, id, snippet }]                         │
│     "find me sources about X"                                            │
│                                                                          │
│ read_source(id_or_url)                                                    │
│     → Exa /contents → { title, url, text }   (clean full text)           │
│     "now actually read that page"                                        │
└────────────────────────────────────────────────────────────────────────┘

ORCHESTRATION TOOL (the recursion)
┌────────────────────────────────────────────────────────────────────────┐
│ spawn_researcher(sub_question)                                           │
│     → runs a FRESH agent loop, own context, narrowed toolset             │
│       (child gets [web_search, read_source], NOT spawn_researcher)       │
│     → returns { summary, citations[] }   ← compressed, not raw dumps     │
└────────────────────────────────────────────────────────────────────────┘
```

No `finalize` tool needed: the loop ends naturally when the parent emits
`finish_reason: "stop"` with the final written answer.

## What is Exa?
A **search API built for AI agents** (not humans). Two reasons it's the right fit:
- **Neural/semantic search** — query by meaning; returns results an LLM can use directly.
- **Returns clean content** — no HTML scraping/stripping needed.

Endpoints we use:
- **`POST https://api.exa.ai/search`** — query → results (title, url, id, optional inline text/highlights).
- **`POST https://api.exa.ai/contents`** — ids/urls → full cleaned article text.

Auth: header `x-api-key: $EXA_API_KEY` (verify exact header at build time against Exa docs).

### Design decision (open — confirm at build)
Two separate tools (`web_search` then `read_source`) vs one combined `/search`-with-contents call.
**Lean: two separate tools** — cleaner pedagogy (search, THEN read, like a human), and the two
shapes exercise the generic better. Exa's `/search` can return contents inline, but we keep them split.

## Tool interface (the typed seam)
```ts
interface Tool<A, R> {
  name: string;                         // model uses this to choose
  description: string;                  // English — model reads to decide WHEN
  schema: ZodType<A>;                   // RUNTIME validator for untyped args JSON
  run: (args: A, ctx: AgentCtx) => Promise<R>;
}
```
The model supplies `arguments` as a JSON **string**; `callTool` does `schema.parse(JSON.parse(args))`
→ untyped → `A`. Parse-don't-trust at the boundary, every call.

## How spawn_researcher teaches sub-agents
```
parent loop (context A — stays clean)
   │  model calls web_search("coffee D2C quick-commerce india 2026")
   │  model calls spawn_researcher("Blinkit/Zepto margins for D2C brands?")
   │                          │
   │      harness intercepts: this tool's `run` is NOT a leaf — it calls runAgent:
   │                          ▼
   │      runAgent(sub_question,
   │               CHILD_TOOLS,            ← [web_search, read_source]  (no spawn)
   │               ctx{ depth: depth+1, fresh messages:[system, user] })  ← own context
   │        child does N searches + reads (all noise lives in context B)
   │        child finishes (finish_reason "stop") → returns {summary, citations}
   │                          │
   │  parent gets back ONLY the summary as the tool_result  ← context A never saw page dumps
   │
   └─ parent writes final cited answer → finish_reason "stop" → return to user
```
Three lessons baked in:
1. **Recursion** — `spawn_researcher.run` calls the same `runAgent`, one level deeper.
2. **Context isolation** — child's noise stays in its own `messages[]`; parent stays lean
   (also keeps the parent's prompt cache effective — bloat would wreck it).
3. **Constraint propagation** — child toolset lacks `spawn_researcher` → can't recurse forever.

## Real OpenAI tool-call shape (verified live)
Request `tools[]`:
```json
{ "type": "function", "function": {
    "name": "web_search", "description": "...",
    "parameters": { "type": "object",
      "properties": { "query": {"type":"string"}, "num_results": {"type":"integer"} },
      "required": ["query"] } } }
```
Response when the model calls it (`finish_reason: "tool_calls"`):
```json
{ "tool_calls": [ { "id": "call_abc", "type": "function",
    "function": { "name": "web_search", "arguments": "{\"query\":\"...\"}" } } ] }
```
We send the result back as: `{ "role": "tool", "tool_call_id": "call_abc", "content": "<json>" }`
(MUST match the id; MUST answer every tool_call before the next model POST).
