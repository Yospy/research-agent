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

  function render(): void {
    if (!rootId || streaming) return;
    const lines: string[] = [];
    const walk = (id: string, indent: string) => {
      const n = nodes.get(id);
      if (!n) return;
      const badge =
        n.status === "running" ? chalk.yellow("[running]") : n.status === "done" ? chalk.green("[done]") : chalk.red("[error]");
      lines.push(`${indent}${chalk.cyan("◆")} ${n.label} ${badge}`);
      for (const t of n.tools) {
        const icon = ICON[t.name] ?? "•";
        const ms = t.ms !== undefined ? chalk.dim(` ${t.ms}ms`) : "";
        lines.push(`${indent}  ${icon} ${chalk.dim(t.name)} ${truncate(t.arg, 50)}${ms}`);
      }
      for (const childId of n.children) walk(childId, indent + "  ");
    };
    walk(rootId, "");
    logUpdate(lines.join("\n"));
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
