import chalk from "chalk";
import logUpdate from "log-update";
import type { AgentEvent, Citation } from "../agent/types.ts";
import { hyperlink } from "./ansi.ts";

interface ToolStep {
  name: string;
  arg: string;
  ms?: number;
}
interface Node {
  agentId: string;
  depth: number;
  label: string;
  status: "running" | "done" | "error";
  tools: ToolStep[];
  children: string[];
}

const ICON: Record<string, string> = { web_search: "🔍", read_source: "📄" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // Claude-Code-style thinking dots
function argSummary(name: string, args: unknown): string {
  const a = args as Record<string, unknown>;
  if (name === "web_search") return String(a?.query ?? "");
  if (name === "read_source") return String(a?.id_or_url ?? "");
  return "";
}

// Subscribe to the AgentEvent stream and redraw a live sub-agent tree in place.
// `citations` is the live (mutable) map the harness fills; by the time the answer streams it is
// populated, so we can hyperlink inline [n] markers to the n-th source's url on the fly.
export function createRenderer(citations: Map<string, Citation>) {
  const nodes = new Map<string, Node>();
  let rootId: string | null = null;
  let streaming = false; // once the answer starts streaming, freeze the tree and stream below it
  let pending = ""; // small tail buffer so a [n] split across chunks isn't mangled
  let frame = 0; // spinner frame, advanced on a timer while the run is in flight
  let timer: ReturnType<typeof setInterval> | null = null;

  // Animate the spinner by redrawing on a timer (events alone don't fire while the model is thinking).
  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER.length;
      render();
    }, 80);
    timer.unref?.(); // never keep the process alive just for the spinner
  }
  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function linkMarker(n: number): string {
    const c = [...citations.values()][n - 1];
    const label = chalk.cyan(`[${n}]`);
    return c ? hyperlink(label, c.url) : label; // link only if that source exists
  }

  // Stream text through, turning complete [n] tokens into hyperlinks. Holds back only an
  // incomplete trailing "[…" until the next chunk (so live streaming is preserved).
  function streamText(text: string, final: boolean): void {
    pending += text;
    let out = "";
    let i = 0;
    while (i < pending.length) {
      const open = pending.indexOf("[", i);
      if (open === -1) {
        out += pending.slice(i);
        i = pending.length;
        break;
      }
      out += pending.slice(i, open);
      let j = open + 1;
      while (j < pending.length && pending[j]! >= "0" && pending[j]! <= "9") j++;
      if (j < pending.length && pending[j] === "]" && j > open + 1) {
        out += linkMarker(Number(pending.slice(open + 1, j)));
        i = j + 1;
      } else if (j === pending.length && !final) {
        pending = pending.slice(open); // incomplete "[…" → wait for more
        process.stdout.write(out);
        return;
      } else {
        out += "["; // a "[" that isn't a citation marker
        i = open + 1;
      }
    }
    process.stdout.write(out);
    pending = "";
  }

  // Render the tree: the root as a plain ◆ node; each spawned sub-agent as a magenta box.
  function render(): void {
    if (!rootId || streaming) return;
    const root = nodes.get(rootId);
    if (!root) return;
    const boxW = Math.min(74, Math.max(40, (process.stdout.columns ?? 80) - 4));
    const head =
      root.status === "running"
        ? `${chalk.magenta(SPINNER[frame])} ${chalk.cyan("◆")} ${root.label} ${chalk.dim("researching…")}`
        : `${chalk.cyan("◆")} ${root.label} ${badge(root.status)}`;
    const lines: string[] = [head];
    for (const t of root.tools) lines.push("  " + toolLine(t, boxW));
    for (const childId of root.children) for (const l of renderBox(childId, boxW)) lines.push("  " + l);
    logUpdate(lines.join("\n"));
  }

  // A spawned sub-agent (and its subtree) drawn inside a box `avail` columns wide, so spawns stand out.
  function renderBox(id: string, avail: number): string[] {
    const n = nodes.get(id);
    if (!n) return [];
    const cw = avail - 4; // content width inside the box
    const status = badge(n.status);
    const labelMax = Math.max(8, cw - 10 - vwidth(status));
    const header = `${chalk.magenta.bold("spawn:")} ${truncate(n.label, labelMax)}  ${status}`;
    const inner = n.tools.map((t) => toolLine(t, cw));
    for (const childId of n.children) inner.push(...renderBox(childId, cw)); // nested box fits in content
    return boxify(header, inner, cw);
  }

  function handle(e: AgentEvent): void {
    switch (e.kind) {
      case "agent_start": {
        nodes.set(e.agentId, {
          agentId: e.agentId,
          depth: e.depth,
          label: truncate(e.sub_question, 60),
          status: "running",
          tools: [],
          children: [],
        });
        if (rootId === null) rootId = e.agentId;
        startTimer(); // begin animating the thinking spinner
        break;
      }
      case "spawned": {
        nodes.get(e.agentId)?.children.push(e.child);
        break;
      }
      case "tool_call": {
        if (e.name === "spawn_researcher") break; // the child subtree represents it
        nodes.get(e.agentId)?.tools.push({ name: e.name, arg: argSummary(e.name, e.args), ms: e.ms });
        break;
      }
      case "result": {
        const n = nodes.get(e.agentId);
        if (n) n.status = e.result.ok ? "done" : "error";
        break;
      }
      case "thinking": {
        // First chunk: freeze the live tree, then stream the answer below it.
        if (!streaming) {
          stopTimer(); // answer is arriving — stop the spinner
          render();
          logUpdate.done();
          streaming = true;
          process.stdout.write("\n");
        }
        streamText(e.text, false); // links [n] markers as they stream
        return; // never redraw the tree once streaming
      }
    }
    render();
  }

  function done(): void {
    stopTimer();
    if (streaming) {
      streamText("", true); // flush any held-back tail
      process.stdout.write("\n");
    } else {
      render();
      logUpdate.done(); // persist the final tree (no streamed answer, e.g. on error)
    }
  }

  return { handle, done };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function badge(status: Node["status"]): string {
  return status === "running"
    ? chalk.yellow("[running]")
    : status === "done"
      ? chalk.green("[done]")
      : chalk.red("[error]");
}

function toolLine(t: ToolStep, cw: number): string {
  const icon = ICON[t.name] ?? "•";
  const ms = t.ms !== undefined ? ` ${t.ms}ms` : "";
  const argBudget = Math.max(6, cw - vwidth(`${icon} ${t.name} `) - vwidth(ms));
  return `${icon} ${chalk.dim(t.name)} ${truncate(t.arg, argBudget)}${chalk.dim(ms)}`;
}

// Display width ignoring ANSI color codes (good enough for box alignment; our emojis are width-2).
function vwidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Wrap inner lines in a magenta box of content width `cw` (header sits on the top border).
function boxify(header: string, inner: string[], cw: number): string[] {
  const b = chalk.magenta;
  const hw = vwidth(header);
  const top = b("╭─ ") + header + " " + b("─".repeat(Math.max(0, cw - hw - 1)) + "╮");
  const mid = inner.map((line) => b("│ ") + line + " ".repeat(Math.max(0, cw - vwidth(line))) + b(" │"));
  const bot = b("╰" + "─".repeat(cw + 2) + "╯");
  return [top, ...mid, bot];
}
