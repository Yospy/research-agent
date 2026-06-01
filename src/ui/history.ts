import chalk from "chalk";
import { getRun, getRunCitations, getRunMetrics, listRuns, type DB } from "../agent/db.ts";
import { hyperlink } from "./ansi.ts";

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

// One-line stats readout after a run (surfaces the prompt-cache savings measured in Phase 1).
export function printMetrics(db: DB, runId: string): void {
  const m = getRunMetrics(db, runId);
  const pct = m.promptTokens > 0 ? Math.round((m.cachedTokens / m.promptTokens) * 100) : 0;
  console.log(
    chalk.dim(`\n📊 ${fmt(m.totalTokens)} tokens · ${fmt(m.cachedTokens)} cached (${pct}%) · ${m.toolCalls} tool calls`),
  );
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// `/history` — newest-first list of past runs. Returns the ordered ids (so `/open <index>` can resolve).
export function printHistory(db: DB): string[] {
  const runs = listRuns(db);
  if (runs.length === 0) {
    console.log(chalk.dim("  (no runs yet)"));
    return [];
  }
  runs.forEach((r, i) => {
    const badge = r.status === "done" ? chalk.green(r.status) : r.status === "error" ? chalk.red(r.status) : chalk.yellow(r.status);
    console.log(`  ${chalk.dim(String(i + 1))}. ${truncate(r.question, 60)}  ${badge}  ${chalk.dim(ago(r.created_at))}`);
  });
  return runs.map((r) => r.id);
}

// `/open <id|index>` — reprint a past run's answer + reconstructed Sources.
export function printRun(db: DB, runId: string): void {
  const run = getRun(db, runId);
  if (!run) {
    console.log(chalk.red(`  no run found: ${runId}`));
    return;
  }
  console.log(`\n${chalk.bold("Q:")} ${run.question}\n`);
  console.log(run.final_answer ?? chalk.dim("(no answer)"));
  printSources(db, runId);
}

export function printSources(db: DB, runId: string): void {
  const cites = getRunCitations(db, runId);
  if (cites.length === 0) return;
  console.log(`\n${chalk.bold("Sources:")}`);
  // The whole "[n] title" is a clickable link to the source url.
  cites.forEach((c, i) =>
    console.log(`  ${hyperlink(chalk.cyan(`[${i + 1}]`) + " " + (c.title || c.url), c.url)} ${chalk.dim("— " + c.url)}`),
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
