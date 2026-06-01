import type { ChatResponse } from "./clients/llm.ts";
import type { LoopAction } from "./types.ts";

// The seam: map the server's finish_reason → OUR LoopAction union. Pure (no I/O).
export function decide(res: ChatResponse): LoopAction {
  const choice = res.choices[0];
  if (!choice) return { kind: "error", reason: "no choices in response" };

  switch (choice.finish_reason) {
    case "tool_calls":
      return { kind: "run_tools", calls: choice.message.tool_calls ?? [] };
    case "stop":
      return { kind: "done", answer: choice.message.content ?? "" };
    default:
      return { kind: "error", reason: choice.finish_reason };
  }
}
