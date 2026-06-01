import { OPENAI_API_KEY, MODEL } from "../config.ts";
import type { Msg, ToolCall } from "../types.ts";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

// --- response shapes we consume (raw OpenAI chat/completions) ---------------
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatChoiceMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatChoice {
  index: number;
  finish_reason: string;
  message: ChatChoiceMessage;
}

export interface ChatResponse {
  choices: ChatChoice[];
  usage: ChatUsage;
}

// --- request: tool defs are passed through already in OpenAI shape ----------
export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

// Transport only: POST the messages (+ optional tools) and return the parsed response.
// No retries, no streaming. Never logs the API key.
export async function callLLM(messages: Msg[], tools?: ChatTool[]): Promise<ChatResponse> {
  const body = {
    model: MODEL,
    messages,
    ...(tools && tools.length ? { tools } : {}),
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as ChatResponse;
}

// Streaming variant: SSE deltas reassembled into the SAME ChatResponse shape callLLM returns, so
// the loop is unchanged. `onText` fires per content delta (for live token printing). Tool-calling
// turns stream tool_calls (no content) → onText never fires there.
export async function streamLLM(
  messages: Msg[],
  tools?: ChatTool[],
  onText?: (delta: string) => void,
): Promise<ChatResponse> {
  const body = {
    model: MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools && tools.length ? { tools } : {}),
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error("LLM stream: no response body");

  let content = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "";
  let usage: ChatUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        onText?.(delta.content);
      }
      if (delta?.tool_calls) {
        for (const d of delta.tool_calls) {
          const i: number = d.index;
          if (!toolCalls[i]) toolCalls[i] = { id: d.id ?? "", type: "function", function: { name: "", arguments: "" } };
          if (d.id) toolCalls[i].id = d.id;
          if (d.function?.name) toolCalls[i].function.name = d.function.name;
          if (d.function?.arguments) toolCalls[i].function.arguments += d.function.arguments;
        }
      }
    }
  }

  const finalToolCalls = toolCalls.filter((t) => t);
  const message: ChatChoiceMessage = {
    role: "assistant",
    content: content || null,
    ...(finalToolCalls.length ? { tool_calls: finalToolCalls } : {}),
  };
  return { choices: [{ index: 0, finish_reason: finishReason, message }], usage };
}
