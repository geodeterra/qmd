#!/usr/bin/env bun
/**
 * QMD HTTP Server — plain HTTP API returning the same JSON as `qmd --json`.
 *
 * GET /search?q=…&limit=N&min_score=N   BM25 keyword search
 * GET /vsearch?q=…&limit=N&min_score=N  vector (semantic) search
 * GET /query?q=…&limit=N&min_score=N    hybrid search (BM25 + vector + reranker)
 * GET /status                            health / collection info
 *
 * Usage: bun run src/http.ts [--port N]
 */

import {
  enableProductionMode,
  createStore,
  extractSnippet,
  hybridQuery,
  vectorSearchQuery,
} from "./store.js";
import {
  disposeDefaultLlamaCpp } from "./llm.js";
import {
  parseArgs } from "util";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: "string" } },
  strict: false,
  allowPositionals: true,
});

const PORT = Number(values.port) || 7890;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

enableProductionMode();
const store = createStore();
const startTime = Date.now();

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedParams {
  q: string;
  limit: number;
  minScore: number;
  collection: string | undefined;
  fast: boolean;
}

function parseParams(req: Request): ParsedParams {
  const url = new URL(req.url);
  return {
    q: url.searchParams.get("q") || "",
    limit: parseInt(url.searchParams.get("limit") || "20", 10) || 20,
    minScore: parseFloat(url.searchParams.get("min_score") || "0") || 0,
    collection: url.searchParams.get("collection") || undefined,
    fast: url.searchParams.get("fast") === "1" || url.searchParams.get("fast") === "true",
  };
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`${ts} ${msg}`);
}

function toJsonOutput(
  results: Array<{
    docid: string;
    score: number;
    displayPath: string;
    title: string;
    body?: string;
    bestChunk?: string;
    context?: string | null;
    chunkPos?: number;
  }>,
  query: string,
) {
  return results.map((r) => {
    const text = r.bestChunk || r.body || "";
    const { snippet } = extractSnippet(text, query, 300, r.chunkPos);
    const context =
      r.context ?? store.getContextForFile(`qmd://${r.displayPath}`);
    return {
      docid: `#${r.docid}`,
      score: Math.round(r.score * 100) / 100,
      file: `qmd://${r.displayPath}`,
      title: r.title,
      ...(context ? { context } : {}),
      snippet,
    };
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleStatus(): Response {
  const reqStart = Date.now();
  const status = store.getStatus();
  log(`GET /status (${Date.now() - reqStart}ms)`);
  return Response.json(
    { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000), ...status },
    { headers: JSON_HEADERS },
  );
}

async function handleSearch(req: Request): Promise<Response> {
  const reqStart = Date.now();
  const { q, limit, minScore } = parseParams(req);
  if (!q) {
    return Response.json({ error: "missing q parameter" }, { status: 400, headers: JSON_HEADERS });
  }
  try {
    const results = store.searchFTS(q, limit).filter((r) => r.score >= minScore);
    const output = toJsonOutput(results, q);
    log(`GET /search q="${q.slice(0, 60)}" → ${output.length} (${Date.now() - reqStart}ms)`);
    return Response.json(output, { headers: JSON_HEADERS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`GET /search ERROR: ${msg}`);
    return Response.json({ error: msg }, { status: 500, headers: JSON_HEADERS });
  }
}

async function handleVsearch(req: Request): Promise<Response> {
  const reqStart = Date.now();
  const { q, limit, minScore, collection } = parseParams(req);
  if (!q) {
    return Response.json({ error: "missing q parameter" }, { status: 400, headers: JSON_HEADERS });
  }
  try {
    const results = await vectorSearchQuery(store, q, {
      collection,
      limit,
      minScore: minScore || 0.3,
    });
    const output = toJsonOutput(results, q);
    log(`GET /vsearch q="${q.slice(0, 60)}" → ${output.length} (${Date.now() - reqStart}ms)`);
    return Response.json(output, { headers: JSON_HEADERS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`GET /vsearch ERROR: ${msg}`);
    return Response.json({ error: msg }, { status: 500, headers: JSON_HEADERS });
  }
}

async function handleQuery(req: Request): Promise<Response> {
  const reqStart = Date.now();
  const { q, limit, minScore, collection, fast } = parseParams(req);
  if (!q) {
    return Response.json({ error: "missing q parameter" }, { status: 400, headers: JSON_HEADERS });
  }
  try {
    const results = await hybridQuery(store, q, { collection, limit, minScore, skipExpansion: fast, ...(fast && { candidateLimit: 5 }) });
    const output = toJsonOutput(results, q);
    log(`GET /query q="${q.slice(0, 60)}" → ${output.length} (${Date.now() - reqStart}ms)`);
    return Response.json(output, { headers: JSON_HEADERS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`GET /query ERROR: ${msg}`);
    return Response.json({ error: msg }, { status: 500, headers: JSON_HEADERS });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  routes: {
    "/status": handleStatus,
    "/search": handleSearch,
    "/vsearch": handleVsearch,
    "/query": handleQuery,
  },
  fetch() {
    return Response.json({ error: "not found" }, { status: 404, headers: JSON_HEADERS });
  },
});

log(`listening on http://0.0.0.0:${server.port}`);

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop();
  store.close();
  await disposeDefaultLlamaCpp();
}

process.on("SIGTERM", async () => {
  log("shutting down (SIGTERM)");
  await shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("shutting down (SIGINT)");
  await shutdown();
  process.exit(0);
});
