import { z } from "zod";
import { search, type SearchResult } from "../clients/exa.ts";
import type { Tool } from "../types.ts";

const MAX_SNIPPET = 300; // trim Exa's fat highlights so the tool message + prompt cache stay lean

const schema = z.object({
  query: z.string(),
  num_results: z.number().int().positive().optional(),
});

// "find me sources about X" — does NOT birth a citation (that happens on read_source, per 08 §8).
export const webSearch: Tool<z.infer<typeof schema>, { results: SearchResult[] }> = {
  name: "web_search",
  description:
    "Search the web for sources about a topic. Returns a list of {title,url,id,snippet}. " +
    "Call read_source on a result's url or id to read its full text.",
  schema,
  run: async (args, ctx) => {
    const results = await search(ctx.db, args.query, args.num_results ?? 5, ctx.signal);
    return {
      results: results.map((r) => ({ ...r, snippet: r.snippet.slice(0, MAX_SNIPPET) })),
    };
  },
};
