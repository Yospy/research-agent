import { createAgent, finishAgent, type DB } from "../agent/db.ts";
import { runAgent } from "../agent/runAgent.ts";
import { CHILD_TOOLS } from "../agent/tools/registry.ts";
import type { AgentCtx, AgentEvent, Citation } from "../agent/types.ts";

// The opaque context the orchestrator forwards from the parent tool call. Carries everything
// needed to create the child agent row and bound it.
export interface RunResearcherContext {
  runId: string;
  parentAgentId: string;
  depth: number; // the PARENT's depth; the child runs at depth + 1
  maxDepth: number;
  toolBudget: number;
}

// Mirrors the TS AgentResult so the Go worker_client can decode it as a semantic verdict.
export interface RunResearcherResult {
  ok: boolean;
  agentId: string;
  summary?: string;
  error?: string;
  citations: Citation[]; // full {title,url} so the parent can populate its citation map
  retryable: boolean; // a finished agent's own outcome is never transport-retryable
}

// Runs ONE researcher: the extracted body of the old in-process spawn_researcher. Creates the
// child agent row, runs the same runAgent loop with CHILD_TOOLS (no spawn → bounded), and returns
// a compressed, serializable verdict. `onEvent` streams the child's progress as liveness pings
// (Phase 2); `signal` aborts in-flight work when the orchestrator cancels.
export async function runResearcher(
  db: DB,
  _kind: string,
  task: string,
  pass: RunResearcherContext,
  onEvent?: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<RunResearcherResult> {
  const childId = createAgent(db, {
    runId: pass.runId,
    parentAgentId: pass.parentAgentId,
    depth: pass.depth + 1,
    subQuestion: task,
  });

  const childCtx: AgentCtx = {
    db,
    runId: pass.runId,
    agentId: childId,
    parentAgentId: pass.parentAgentId,
    depth: pass.depth + 1,
    maxDepth: pass.maxDepth,
    toolBudget: pass.toolBudget,
    citations: new Map<string, Citation>(),
    onEvent, // Phase 2: progress events double as pings to the orchestrator
    signal,
  };

  try {
    const result = await runAgent(task, CHILD_TOOLS, childCtx);
    // Return whatever sources the child gathered even if it ultimately failed — they're still
    // valid and the parent can cite them.
    const citations = [...childCtx.citations.values()];
    if (!result.ok) {
      return { ok: false, agentId: childId, error: result.error, citations, retryable: false };
    }
    return { ok: true, agentId: childId, summary: result.answer, citations, retryable: false };
  } catch (e) {
    // Cancellation aborts an in-flight fetch mid-loop → runAgent throws. Finalize the row and
    // report it (the orchestrator has already moved on, so this verdict is best-effort).
    finishAgent(db, childId, "error", null);
    return { ok: false, agentId: childId, error: signal?.aborted ? "cancelled" : String(e), citations: [], retryable: false };
  }
}
