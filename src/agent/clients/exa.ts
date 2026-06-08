import { createHash } from "node:crypto";
import { EXA_API_KEY } from "../config.ts";
import { exaCacheGet, exaCacheSet, type DB } from "../db.ts";

const SEARCH_URL = "https://api.exa.ai/search";
const CONTENTS_URL = "https://api.exa.ai/contents";

export interface SearchResult {
  title: string;
  url: string;
  id: string;
  snippet: string;
}

export interface SourceContent {
  title: string;
  url: string;
  text: string;
}

// Stable cache key: hash(kind + normalized input). Normalizing makes repeat hits land.
function cacheKey(kind: string, input: string): string {
  return createHash("sha256").update(`${kind}:${input.trim().toLowerCase()}`).digest("hex");
}

// Layer-2 cache (SQLite) checked BEFORE every network call; written after. Per context/06.
export async function search(db: DB, query: string, numResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
  const key = cacheKey("search", `${query}|${numResults}`);
  const cached = exaCacheGet(db, key) as SearchResult[] | null;
  if (cached) return cached;

  const reqBody = { query, numResults, contents: { highlights: true } };
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
    body: JSON.stringify(reqBody),
    signal,
  });
  if (!res.ok) throw new Error(`Exa search HTTP ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    results: Array<{ title?: string; url: string; id: string; text?: string; highlights?: string[] }>;
  };
  const results: SearchResult[] = data.results.map((r) => ({
    title: r.title ?? "",
    url: r.url,
    id: r.id,
    snippet: r.highlights?.[0] ?? r.text ?? "",
  }));

  exaCacheSet(db, {
    key,
    kind: "search",
    requestJson: JSON.stringify(reqBody),
    responseJson: JSON.stringify(results),
  });
  return results;
}

export async function contents(db: DB, idOrUrl: string, signal?: AbortSignal): Promise<SourceContent> {
  const key = cacheKey("contents", idOrUrl);
  const cached = exaCacheGet(db, key) as SourceContent | null;
  if (cached) return cached;

  const isUrl = /^https?:\/\//i.test(idOrUrl.trim());
  const reqBody = isUrl ? { urls: [idOrUrl], text: true } : { ids: [idOrUrl], text: true };
  const res = await fetch(CONTENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
    body: JSON.stringify(reqBody),
    signal,
  });
  if (!res.ok) throw new Error(`Exa contents HTTP ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    results: Array<{ title?: string; url?: string; text?: string }>;
  };
  const first = data.results[0];
  const out: SourceContent = {
    title: first?.title ?? "",
    url: first?.url ?? idOrUrl,
    text: first?.text ?? "",
  };

  exaCacheSet(db, {
    key,
    kind: "contents",
    requestJson: JSON.stringify(reqBody),
    responseJson: JSON.stringify(out),
  });
  return out;
}
