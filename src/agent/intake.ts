import { z } from "zod";
import { callLLM } from "./clients/llm.ts";
import type { Msg } from "./types.ts";

// The intake STATE. Runs once, at the root, BEFORE the research loop. The harness always enters it;
// the model only judges (dynamically) whether the topic is ambiguous and, if so, what to ask. The
// model never learns a human gets prompted — it just answers a self-contained judgment, the same way
// finish_reason is a signal we (not it) give meaning to. Model signals, harness switches.

export interface IntakeDeps {
  ask: (question: string) => Promise<string>; // render a question + read the user's answer (UI-owned)
}

const INTAKE_SYSTEM =
  "You are the intake step of a research agent. Given a research topic, judge whether it is specific " +
  "enough to research well, or whether genuine choices must be resolved first (scope, timeframe, " +
  "geography, audience, or the meaning of a key term). Only flag ambiguity that materially changes " +
  "WHAT to research — never ask about preferences you can reasonably assume. Ask at most 3 short, " +
  'concrete questions. Reply with ONLY a JSON object: {"ambiguous": boolean, "questions": string[]}. ' +
  'If the topic is already clear, reply {"ambiguous": false, "questions": []}.';

const IntakeReply = z.object({
  ambiguous: z.boolean(),
  questions: z.array(z.string().min(1)).max(3).default([]),
});

// Ask the model for clarifying questions. Fail-OPEN: any transport/parse error → [] (no questions),
// because intake is an enhancement and must never block the ability to research.
async function generateQuestions(topic: string): Promise<string[]> {
  try {
    const messages: Msg[] = [
      { role: "system", content: INTAKE_SYSTEM },
      { role: "user", content: topic },
    ];
    const res = await callLLM(messages); // no tools — a single structured judgment
    const parsed = IntakeReply.parse(extractJson(res.choices[0]?.message.content ?? ""));
    return parsed.ambiguous ? parsed.questions : [];
  } catch {
    return [];
  }
}

// The model is told to reply with pure JSON; be tolerant of code fences / surrounding prose anyway.
function extractJson(s: string): unknown {
  const cleaned = s.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
}

// Fold the answered clarifications onto the original topic to seed the research run.
function composeBrief(topic: string, answered: { q: string; a: string }[]): string {
  const lines = answered.map(({ q, a }) => `- ${q}\n  ${a}`).join("\n");
  return `${topic}\n\nClarifications from the user:\n${lines}`;
}

// Entry: topic in → research brief out. Clear topic (or any failure) returns the topic unchanged.
export async function intake(topic: string, deps: IntakeDeps): Promise<string> {
  const questions = await generateQuestions(topic);
  if (questions.length === 0) return topic; // clear → straight to research

  const answered: { q: string; a: string }[] = [];
  for (const q of questions) {
    const a = (await deps.ask(q)).trim();
    if (a) answered.push({ q, a }); // skip the ones the user left blank
  }
  return answered.length ? composeBrief(topic, answered) : topic;
}
