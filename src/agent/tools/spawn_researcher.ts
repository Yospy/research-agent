import { z } from "zod";
import { mergeCitations } from "../citations.ts";
import { ORCHESTRATOR_URL, ORCHESTRATOR_POLICY } from "../config.ts";
import type { Citation, Tool } from "../types.ts";

const schema = z.object({ sub_questions: z.string().min(1).array().min(1) });

// One per input sub-question, in input order (mirrors the Go PerTaskResult).
interface PerTaskResult {
  ok: boolean;
  agentId?: string;
  summary?: string;
  citations?: Citation[];
  error?: { message: string; retryable: boolean };
}

type SpawnResult = { results: PerTaskResult[] };

// The orchestration tool. No longer recurses in-process: it RPCs the Go orchestrator with a
// BATCH of sub-questions. The orchestrator fans out (bounded concurrency, per-task timeout,
// one silent retry on transport failure) to our in-process worker and returns one
// {summary, citations} | {error} per question, in order. The harness JSON.stringifies the
// return, so any per-task error becomes natural self-feedback for the model to retry with new args.
export const spawnResearcher: Tool<z.infer<typeof schema>, SpawnResult> = {
  name: "spawn_researcher",
  description:
    "Delegate one or more focused sub-questions to isolated researcher sub-agents that run " +
    "concurrently. Each searches and reads on its own and returns a compressed {summary, " +
    "citations}. Pass independent threads of the question as separate sub_questions.",
  schema,
  run: async (args, ctx) => {
    const failAll = (message: string, retryable: boolean): SpawnResult => ({
      results: args.sub_questions.map(() => ({ ok: false, error: { message, retryable } })),
    });

    // Bounded recursion: children run at depth+1 with CHILD_TOOLS (no spawn). Guard the cap here.
    if (ctx.depth + 1 > ctx.maxDepth) {
      return failAll("max research depth reached", false);
    }

    // Make the root wall-clock deadline binding during the fan-out (the loop only re-checks it
    // between turns). Aborting the fetch cancels the orchestrator via its request context.
    const signal = ctx.deadline ? AbortSignal.timeout(Math.max(0, ctx.deadline - Date.now())) : undefined;

    let data: SpawnResult;
    try {
      const resp = await fetch(`${ORCHESTRATOR_URL}/orchestrate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          kind: "researcher",
          tasks: args.sub_questions,
          policy: ORCHESTRATOR_POLICY,
          context: {
            runId: ctx.runId,
            parentAgentId: ctx.agentId,
            depth: ctx.depth,
            maxDepth: ctx.maxDepth,
            toolBudget: ctx.toolBudget,
          },
        }),
      });
      if (!resp.ok) {
        // callTool has no try/catch around run() — never throw; return structured feedback.
        return failAll(`orchestrator ${resp.status}: ${await resp.text()}`, true);
      }
      data = (await resp.json()) as SpawnResult;
    } catch (e) {
      return failAll(`orchestrator unreachable: ${String(e)}`, true);
    }

    // Reflect each child into the UI tree (final status — Phase 1 isn't live) and bubble its
    // citations up into the parent's authoritative map so the renderer can link [n].
    data.results.forEach((r, i) => {
      const sub = args.sub_questions[i] ?? "";
      if (r.agentId) {
        ctx.onEvent?.({ kind: "spawned", agentId: ctx.agentId, child: r.agentId, sub_question: sub, depth: ctx.depth + 1 });
        ctx.onEvent?.({ kind: "agent_start", agentId: r.agentId, depth: ctx.depth + 1, sub_question: sub });
        const result = r.ok
          ? { ok: true as const, answer: r.summary ?? "", citations: (r.citations ?? []).map((c) => c.url) }
          : { ok: false as const, error: r.error?.message ?? "unknown error" };
        ctx.onEvent?.({ kind: "result", agentId: r.agentId, result });
      }
      if (r.citations?.length) {
        const map = new Map<string, Citation>();
        for (const c of r.citations) map.set(c.url, c);
        mergeCitations(ctx, map);
      }
    });

    return data;
  },
};
