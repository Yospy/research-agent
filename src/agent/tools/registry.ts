import { webSearch } from "./web_search.ts";
import { readSource } from "./read_source.ts";
import { spawnResearcher } from "./spawn_researcher.ts";
import type { Tool } from "../types.ts";

// Constraint propagation = the recursion bound.
// CHILD_TOOLS lacks spawn_researcher → sub-agents can't recurse forever (depth-by-toolset).
export const CHILD_TOOLS: Tool<any, any>[] = [webSearch, readSource];
export const ROOT_TOOLS: Tool<any, any>[] = [webSearch, readSource, spawnResearcher];
