import type { AgentCtx, Citation } from "./types.ts";

// Harness-owned citations: dedupe by url, insertion-ordered (the authoritative n→url source).
// Born when read_source returns.
export function addCitation(ctx: AgentCtx, c: Citation): void {
  if (!ctx.citations.has(c.url)) ctx.citations.set(c.url, c);
}

// Bubble a finished child's citations up into the parent's set (deduped). Used by spawn_researcher.
export function mergeCitations(ctx: AgentCtx, from: Map<string, Citation>): void {
  for (const c of from.values()) addCitation(ctx, c);
}
