import { z } from "zod";
import { contents, type SourceContent } from "../clients/exa.ts";
import { addCitation } from "../citations.ts";
import type { Tool } from "../types.ts";

const schema = z.object({ id_or_url: z.string() });

// "now actually read that page" — births a citation (the source we actually fetched).
export const readSource: Tool<z.infer<typeof schema>, SourceContent> = {
  name: "read_source",
  description: "Read the full cleaned text of a source by its id or url. Returns {title,url,text}.",
  schema,
  run: async (args, ctx) => {
    const content = await contents(ctx.db, args.id_or_url);
    addCitation(ctx, { title: content.title, url: content.url });
    return content;
  },
};
