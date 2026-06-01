import { insertToolCall } from "./db.ts";
import type { Trace } from "./events.ts";
import type { AgentCtx, Tool, ToolCall } from "./types.ts";

// Run one tool call: find by name, parse-don't-trust the args (Zod), run, log + persist.
// Returns the result object that becomes the role:"tool" message content.
export async function callTool(
  call: ToolCall,
  tools: Tool<any, any>[],
  ctx: AgentCtx,
  trace: Trace,
): Promise<unknown> {
  const name = call.function.name;
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    const result = { error: `unknown tool: ${name}` };
    insertToolCall(ctx.db, {
      agentId: ctx.agentId,
      toolCallId: call.id,
      name,
      argsJson: call.function.arguments,
      resultJson: JSON.stringify(result),
      ms: 0,
    });
    return result;
  }

  // Parse untyped arguments at the boundary; a bad model call returns an error result
  // (so the model can recover) instead of crashing the run.
  let args: unknown;
  try {
    args = tool.schema.parse(JSON.parse(call.function.arguments));
  } catch (e) {
    const result = { error: `invalid arguments: ${e instanceof Error ? e.message : String(e)}` };
    insertToolCall(ctx.db, {
      agentId: ctx.agentId,
      toolCallId: call.id,
      name,
      argsJson: call.function.arguments,
      resultJson: JSON.stringify(result),
      ms: 0,
    });
    return result;
  }

  const start = Date.now();
  const result = await tool.run(args, ctx);
  const ms = Date.now() - start;

  trace.log({ agent: ctx.agentId, event: "tool_call", name, args, ms });
  ctx.onEvent?.({ kind: "tool_call", agentId: ctx.agentId, name, args, ms });
  insertToolCall(ctx.db, {
    agentId: ctx.agentId,
    toolCallId: call.id,
    name,
    argsJson: JSON.stringify(args),
    resultJson: JSON.stringify(result),
    ms,
  });
  return result;
}
