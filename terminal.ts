import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { openDb, createRun, createAgent, finishRun, listRuns } from "./src/agent/db.ts";
import { runAgent } from "./src/agent/runAgent.ts";
import { ROOT_TOOLS } from "./src/agent/tools/registry.ts";
import { createRenderer } from "./src/ui/render.ts";
import { printHistory, printRun, printSources, printMetrics } from "./src/ui/history.ts";
import type { AgentCtx, Citation } from "./src/agent/types.ts";

const db = openDb("research.db");

const HELP = `commands:
  <question>      run a new research run
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

const rl = createInterface({ input, output, prompt: "prompt> " });
rl.on("SIGINT", () => rl.close());

console.log(chalk.bold("deep-research-agent") + " — ask a question, or /help");
rl.prompt();

for await (const line of rl) {
  const q = line.trim();
  if (q === "") {
    rl.prompt();
    continue;
  }
  if (q === "/exit") break;
  if (q === "/help") console.log(HELP);
  else if (q === "/history") printHistory(db);
  else if (q.startsWith("/open ")) openRun(q.slice("/open ".length).trim());
  else await runQuestion(q);
  rl.prompt();
}

rl.close();
db.close();
process.exit(0);
