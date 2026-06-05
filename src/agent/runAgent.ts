import { zodToJsonSchema } from "zod-to-json-schema";
import { streamLLM, type ChatTool } from "./clients/llm.ts";
import { callTool } from "./callTool.ts";
import { decide } from "./decide.ts";
import { finishAgent, insertMessage } from "./db.ts";
import { createTrace } from "./events.ts";
import type { AgentCtx, AgentResult, Msg, Tool } from "./types.ts";

// Short, generic, STABLE prefix (never reordered → prompt-cache friendly).
const SYSTEM_PROMPT =
  "You are a research assistant. Use the provided tools to gather information when needed, " +
  "then answer the user's question concisely. When you have sources, cite them as [n].";

function toChatTool(t: Tool<any, any>): ChatTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema) as object,
    },
  };
}

// The inner agent harness loop. Caller has already created the run + agent rows; we own messages[].
export async function runAgent(
  question: string,
  tools: Tool<any, any>[],
  ctx: AgentCtx,
): Promise<AgentResult> {
  const trace = createTrace(ctx.runId);
  trace.log({ agent: ctx.agentId, depth: ctx.depth, event: "agent_start", question });
  ctx.onEvent?.({ kind: "agent_start", agentId: ctx.agentId, depth: ctx.depth, sub_question: question });

  // Finalize this agent's row + emit the result event on every exit path.
  const finish = (result: AgentResult): AgentResult => {
    finishAgent(ctx.db, ctx.agentId, result.ok ? "done" : "error", result.ok ? result.answer : null);
    ctx.onEvent?.({ kind: "result", agentId: ctx.agentId, result });
    return result;
  };

  const toolDefs = tools.map(toChatTool);
  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  let seq = 0;
  for (const m of messages) {
    insertMessage(ctx.db, { agentId: ctx.agentId, seq: seq++, role: m.role, contentJson: JSON.stringify(m) });
  }

  // Stream the answer token-by-token, but only for the ROOT agent — children's text is internal.
  const onText =
    ctx.depth === 0
      ? (text: string) => ctx.onEvent?.({ kind: "thinking", agentId: ctx.agentId, text })
      : undefined;

  let calls = 0;
  while (true) {
    // Root deadline (wall-clock cap): fail closed before spending another LLM turn.
    if (ctx.deadline && Date.now() > ctx.deadline) {
      trace.log({ agent: ctx.agentId, event: "agent_result", ok: false, error: "deadline" });
      return finish({ ok: false, error: "deadline" });
    }
    const res = await streamLLM(messages, toolDefs.length ? toolDefs : undefined, onText);
    const choice = res.choices[0]!;
    const cached = res.usage.prompt_tokens_details?.cached_tokens ?? 0;

    insertMessage(ctx.db, {
      agentId: ctx.agentId,
      seq: seq++,
      role: "assistant",
      contentJson: JSON.stringify(choice.message),
      finishReason: choice.finish_reason,
      promptTokens: res.usage.prompt_tokens,
      cachedTokens: cached,
      completionTokens: res.usage.completion_tokens,
    });
    trace.log({ agent: ctx.agentId, event: "llm_response", finish_reason: choice.finish_reason, cached_tokens: cached });

    const action = decide(res);
    trace.log({
      agent: ctx.agentId,
      event: "decide",
      loop_action: action.kind,
      ...(action.kind === "run_tools" ? { calls: action.calls.map((c) => c.function.name) } : {}),
    });

    switch (action.kind) {
      case "run_tools": {
        if (action.calls.length === 0) {
          // degenerate: tool_calls finish_reason with no calls → would loop forever. Fail closed.
          trace.log({ agent: ctx.agentId, event: "agent_result", ok: false, error: "no tool calls" });
          return finish({ ok: false, error: "model requested tools but provided none" });
        }
        messages.push(choice.message); // assistant turn CONTAINS tool_calls
        for (const call of action.calls) {
          if (++calls > ctx.toolBudget) {
            trace.log({ agent: ctx.agentId, event: "agent_result", ok: false, error: "tool budget exceeded" });
            return finish({ ok: false, error: "tool budget exceeded" });
          }
          const toolResult = await callTool(call, tools, ctx, trace);
          const toolMsg: Msg = { role: "tool", content: JSON.stringify(toolResult), tool_call_id: call.id };
          messages.push(toolMsg);
          insertMessage(ctx.db, { agentId: ctx.agentId, seq: seq++, role: "tool", contentJson: JSON.stringify(toolMsg) });
        }
        continue;
      }
      case "done": {
        const citations = [...ctx.citations.keys()];
        trace.log({ agent: ctx.agentId, event: "agent_result", ok: true, citations });
        return finish({ ok: true, answer: action.answer, citations });
      }
      case "error": {
        trace.log({ agent: ctx.agentId, event: "agent_result", ok: false, error: action.reason });
        return finish({ ok: false, error: action.reason });
      }
    }
  }
}
