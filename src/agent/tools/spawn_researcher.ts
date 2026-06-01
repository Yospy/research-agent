import { z } from "zod";
import { createAgent } from "../db.ts";
import { createTrace } from "../events.ts";
import { mergeCitations } from "../citations.ts";
import { runAgent } from "../runAgent.ts";
import { CHILD_TOOLS } from "./registry.ts";
import type { AgentCtx, Tool } from "../types.ts";

const schema = z.object({ sub_question: z.string() });

// The orchestration tool. Its run() recurses into the SAME runAgent one level deeper, with a fresh
// isolated context and a narrowed toolset (CHILD_TOOLS, no spawn → bounded). Returns a compressed
// {summary, citations} — the parent never sees the child's page dumps (context isolation).
export const spawnResearcher: Tool<z.infer<typeof schema>, { summary: string; citations: string[] }> = {
  name: "spawn_researcher",
  description:
    "Delegate a focused sub-question to an isolated researcher sub-agent. It searches and reads on " +
    "its own and returns a compressed {summary, citations}. Use it for independent threads of the question.",
  schema,
  run: async (args, ctx) => {
    // Bounded recursion: explicit depth cap (CHILD_TOOLS already lacks spawn — belt-and-suspenders).
    if (ctx.depth + 1 > ctx.maxDepth) {
      return { summary: "(sub-agent not spawned: max research depth reached)", citations: [] };
    }

    const childId = createAgent(ctx.db, {
      runId: ctx.runId,
      parentAgentId: ctx.agentId,
      depth: ctx.depth + 1,
      subQuestion: args.sub_question,
    });
    createTrace(ctx.runId).log({
      agent: ctx.agentId,
      event: "spawn",
      child: childId,
      sub_question: args.sub_question,
      depth: ctx.depth + 1,
    });
    ctx.onEvent?.({
      kind: "spawned",
      agentId: ctx.agentId,
      child: childId,
      sub_question: args.sub_question,
      depth: ctx.depth + 1,
    });

    // Fresh, isolated child context: own agentId, own citation map, fresh budget, depth+1.
    // onEvent threads through so child events reach the same UI renderer.
    const childCtx: AgentCtx = {
      db: ctx.db,
      runId: ctx.runId,
      agentId: childId,
      parentAgentId: ctx.agentId,
      depth: ctx.depth + 1,
      maxDepth: ctx.maxDepth,
      toolBudget: ctx.toolBudget,
      citations: new Map(),
      onEvent: ctx.onEvent,
    };

    const result = await runAgent(args.sub_question, CHILD_TOOLS, childCtx);
    if (!result.ok) {
      return { summary: `(sub-agent failed: ${result.error})`, citations: [] };
    }

    mergeCitations(ctx, childCtx.citations); // bubble child's {title,url} up into the parent
    return { summary: result.answer, citations: result.citations };
  },
};
