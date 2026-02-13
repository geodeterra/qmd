#!/usr/bin/env bun
/**
 * QMD HTTP Server - Plain HTTP API mirroring CLI --json output
 *
 * Endpoints:
 *   GET /search?q=<query>&limit=N&collection=C&min_score=N
 *   GET /query?q=<query>&limit=N&collection=C&min_score=N
 *   GET /vsearch?q=<query>&limit=N&collection=C&min_score=N
 *   GET /status
 */

import {
  createStore,
  extractSnippet,
  hybridQuery,
  vectorSearchQuery,
} from "./store.js";
import type { Store } from "./store.js";
import { disposeDefaultLlamaCpp } from "./llm.js";

export type HttpServerHandle = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => Promise<void>;
};

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function parseParams(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const limit = parseInt(url.searchParams.get("limit") || "20", 10) || 20;
  const minScore = parseFloat(url.searchParams.get("min_score") || "0") || 0;
  const collection = url.searchParams.get("collection") || undefined;
  return { q, limit, minScore, collection };
}

export async function startHttpServer(port: number, options?: { quiet?: boolean }): Promise<HttpServerHandle> {
  const store = createStore();
  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  function log(msg: string): void {
    if (!quiet) console.error(msg);
  }

  function ts(): string {
    return new Date().toISOString().slice(11, 23);
  }

  function formatResults(results: Array<{ docid: string; score: number; displayPath: string; title: string; body?: string; bestChunk?: string; context?: string; chunkPos?: number }>, query: string) {
    return results.map(r => {
      const text = r.bestChunk || r.body || "";
      const { snippet } = extractSnippet(text, query, 300, r.chunkPos);
      return {
        docid: `#${r.docid}`,
        score: Math.round(r.score * 100) / 100,
        file: `qmd://${r.displayPath}`,
        title: r.title,
        ...(r.context && { context: r.context }),
        ...(store.getContextForFile(`qmd://${r.displayPath}`) && {
          context: store.getContextForFile(`qmd://${r.displayPath}`),
        }),
        snippet,
      };
    });
  }

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    routes: {
      "/status": {
        GET: () => {
          const reqStart = Date.now();
          const status = store.getStatus();
          const res = Response.json({
            status: "ok",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            ...status,
          }, { headers: HEADERS });
          log(`${ts()} GET /status (${Date.now() - reqStart}ms)`);
          return res;
        },
      },

      "/search": {
        async GET(req: Request) {
          const reqStart = Date.now();
          const { q, limit, minScore, collection } = parseParams(req);
          if (!q) return Response.json({ error: "missing q parameter" }, { status: 400, headers: HEADERS });

          const results = store.searchFTS(q, limit, collection as any)
            .filter(r => r.score >= minScore);

          const output = formatResults(results, q);
          log(`${ts()} GET /search q="${q.slice(0, 60)}" → ${output.length} results (${Date.now() - reqStart}ms)`);
          return Response.json(output, { headers: HEADERS });
        },
      },

      "/vsearch": {
        async GET(req: Request) {
          const reqStart = Date.now();
          const { q, limit, minScore, collection } = parseParams(req);
          if (!q) return Response.json({ error: "missing q parameter" }, { status: 400, headers: HEADERS });

          const effectiveMinScore = minScore || 0.3;
          const results = await vectorSearchQuery(store, q, { collection, limit, minScore: effectiveMinScore });

          const output = formatResults(results, q);
          log(`${ts()} GET /vsearch q="${q.slice(0, 60)}" → ${output.length} results (${Date.now() - reqStart}ms)`);
          return Response.json(output, { headers: HEADERS });
        },
      },

      "/query": {
        async GET(req: Request) {
          const reqStart = Date.now();
          const { q, limit, minScore, collection } = parseParams(req);
          if (!q) return Response.json({ error: "missing q parameter" }, { status: 400, headers: HEADERS });

          const results = await hybridQuery(store, q, { collection, limit, minScore });

          const output = formatResults(results, q);
          log(`${ts()} GET /query q="${q.slice(0, 60)}" → ${output.length} results (${Date.now() - reqStart}ms)`);
          return Response.json(output, { headers: HEADERS });
        },
      },
    },

    fetch(req) {
      return Response.json({ error: "not found" }, { status: 404, headers: HEADERS });
    },
  });

  const actualPort = server.port;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop();
    store.close();
    await disposeDefaultLlamaCpp();
  };

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  log(`QMD HTTP server listening on http://0.0.0.0:${actualPort}`);
  log(`Endpoints: /search, /vsearch, /query, /status`);
  return { server, port: actualPort, stop };
}
