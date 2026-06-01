# 06 — Caching (two distinct layers — don't conflate)

## Terms
- **KV cache** = GPU-level attention cache. The model computes key/value tensors per token;
  normally discarded after each request.
- **Prompt caching** = the PRODUCT feature that PERSISTS that KV cache between API calls, so a
  repeated PREFIX isn't recomputed. It's KV caching exposed to API users.

## Why an agent loop is the perfect place to learn it
Every loop iteration re-POSTs the entire growing `messages[]`. The FRONT (system prompt + tool
defs + earlier turns) is identical every iteration → exactly what prompt caching rewards.
```
iter 1: [system + tools]                     ← computed fresh
iter 2: [system + tools + turn1]             ← prefix CACHED, only turn1 new
iter 3: [system + tools + turn1 + turn2]     ← bigger cached prefix
```
Research agents accumulate HUGE contexts (fetched articles) → big stable prefixes → caching matters
economically, not just academically. That's why this project is a great caching vehicle.

## Layer 1 — OpenAI prompt cache (automatic; we MEASURE it)
- OpenAI caches prefixes **≥ 1024 tokens automatically**. No knobs (unlike Anthropic's explicit
  `cache_control` breakpoints + 5-min TTL).
- We **measure** it. The real response includes:
  ```json
  "usage": { "prompt_tokens": 109,
             "prompt_tokens_details": { "cached_tokens": 0 } }
  ```
- **Log `cached_tokens` into the `messages` table every call.** As the stable prefix grows past
  ~1024 tokens, watch `cached_tokens` climb. That's our window into caching.

### Design for cache-friendliness (do this from day 1)
- **Stable prefix first, volatile last**: system prompt → tool defs → (then) the evolving turns.
  Never reorder or mutate the front of `messages[]`.
- Keep tool definitions byte-stable across calls (same JSON, same order).
- Keep each agent's context LEAN (this is also why sub-agents exist) — bloat kills cache value.

## Layer 2 — Exa result cache (OURS, in SQLite)
- Separate from LLM caching. Stored in `exa_cache` table, keyed on `hash(kind + normalized query/url)`.
- Repeated `web_search`/`read_source` with the same input → served from SQLite: **free, no network,
  deterministic**. Makes dev/replay cheap and reproducible.
- Check cache BEFORE calling Exa in each tool's `run`.

## Sub-agents and caching (important nuance)
- Each sub-agent has its OWN context → its OWN separate prompt cache. They do NOT share.
- WITHIN each agent's loop → caching helps a lot.
- ACROSS sub-agents → no sharing UNLESS they share an identical prefix. So keep a **common,
  stable system prefix + tool defs** for all sub-agents to get at least header-level cache hits.

## What to instrument (first-class, not an afterthought)
- Per call: `prompt_tokens`, `cached_tokens`, `completion_tokens` → `messages` table.
- A simple end-of-run report: total tokens, total cached, cache hit ratio, $ saved estimate.
- Exa cache hit/miss counts.
