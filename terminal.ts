import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { openDb, createRun, createAgent, finishRun, listRuns } from "./src/agent/db.ts";
import { runAgent } from "./src/agent/runAgent.ts";
import { intake } from "./src/agent/intake.ts";
import { ROOT_TOOLS } from "./src/agent/tools/registry.ts";
import { createRenderer } from "./src/ui/render.ts";
import { printHistory, printRun, printSources, printMetrics } from "./src/ui/history.ts";
import type { AgentCtx, Citation } from "./src/agent/types.ts";

const db = openDb("research.db");

const HELP = `commands:
  <question>      run a new research run
  /new            start a new thread (the next topic gets clarified again)
  /history        list past runs
  /open <n|id>    reprint a past run (n = number from /history)
  /help           show this
  /exit           quit`;

async function runQuestion(question: string): Promise<void> {
  const runId = createRun(db, question);
  const rootId = createAgent(db, { runId, parentAgentId: null, depth: 0, subQuestion: question });
  const citations = new Map<string, Citation>();
  const renderer = createRenderer(citations); // shares the live map → can link [n] while streaming
  const ctx: AgentCtx = {
    db,
    runId,
    agentId: rootId,
    parentAgentId: null,
    depth: 0,
    maxDepth: 2,
    toolBudget: 12,
    citations,
    onEvent: renderer.handle,
  };

  const result = await runAgent(question, ROOT_TOOLS, ctx);
  renderer.done();
  finishRun(db, runId, result.ok ? "done" : "error", result.ok ? result.answer : null);

  // The answer already streamed live (thinking events). Print Sources + metrics after it.
  if (result.ok) {
    printSources(db, runId);
    printMetrics(db, runId);
  } else {
    console.log(chalk.red("\nerror: " + result.error));
  }
  console.log();
}

function openRun(arg: string): void {
  if (/^\d+$/.test(arg)) {
    const ids = listRuns(db).map((r) => r.id); // newest-first, matches /history numbering
    const id = ids[Number(arg) - 1];
    if (!id) return console.log(chalk.red(`  no run #${arg}`));
    printRun(db, id);
  } else {
    printRun(db, arg);
  }
}

// One listener on 'line' → an async queue. next() resolves the next line, or null once stdin closes.
// Both the command loop AND the intake clarification step pull from this single queue, so no line is
// ever double-consumed (the readline footgun when mixing the async iterator with reads).
function makeLineReader(r: Interface) {
  const buffer: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;
  r.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffer.push(line);
  });
  r.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  return {
    next(): Promise<string | null> {
      if (buffer.length) return Promise.resolve(buffer.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

// Renders each clarifying question and reads its answer from the same line queue.
function makeAsker(r: Interface, lines: { next(): Promise<string | null> }) {
  let asked = 0;
  return async (question: string): Promise<string> => {
    if (asked++ === 0) output.write(chalk.dim("\n  a few quick questions to focus the research:\n"));
    output.write(chalk.magenta("  ? ") + question + "\n");
    r.setPrompt(chalk.magenta("  › "));
    r.prompt();
    const ans = await lines.next();
    r.setPrompt("prompt> ");
    return ans ?? "";
  };
}

const rl = createInterface({ input, output, prompt: "prompt> " });
rl.on("SIGINT", () => rl.close());
const lines = makeLineReader(rl);
let clarified = false; // intake runs ONCE per thread — only the first topic gets clarified

console.log(chalk.bold("deep-research-agent") + " — ask a question, or /help");
rl.prompt();

for (;;) {
  const line = await lines.next();
  if (line === null) break; // stdin closed (EOF / Ctrl-D / SIGINT)
  const q = line.trim();
  if (q === "") {
    rl.prompt();
    continue;
  }
  if (q === "/exit") break;
  if (q === "/help") console.log(HELP);
  else if (q === "/new") {
    clarified = false;
    console.log(chalk.dim("  new thread — your next topic will be clarified"));
  } else if (q === "/history") printHistory(db);
  else if (q.startsWith("/open ")) openRun(q.slice("/open ".length).trim());
  else {
    // Intake STATE: clarify only the FIRST topic of a thread; later prompts go straight to research.
    const brief = clarified ? q : await intake(q, { ask: makeAsker(rl, lines) });
    clarified = true;
    await runQuestion(brief);
  }
  rl.prompt();
}

rl.close();
db.close();
process.exit(0);
