#!/usr/bin/env bun
/**
 * QMD HTTP Server Benchmark
 * 
 * Usage: bun run bench.ts [--url http://localhost:7890] [--rounds 3] [--warmup 1]
 * 
 * Runs a fixed set of queries against each endpoint, multiple rounds,
 * reports min/median/max/p95 per endpoint and per-step breakdown from server logs.
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: "http://localhost:7890" },
    rounds: { type: "string", default: "3" },
    warmup: { type: "string", default: "1" },
  },
});

const BASE = values.url!;
const ROUNDS = parseInt(values.rounds!, 10);
const WARMUP = parseInt(values.warmup!, 10);

const QUERIES = [
  "cloudflare tunnel setup",
  "strava running data",
  "ibash code style preferences",
  "gpu nvidia driver installation",
  "backup rustic schedule",
  "twilio voice call webhook",
  "gmail push notifications pubsub",
  "facebook marketplace listing",
  "geo mobile websocket proxy",
  "qmd profiling cuda results",
  "email cleanup unsubscribe",
  "wiim speaker discovery",
  "openbubbles imessage auth",
  "caldigit ts3 plus price",
  "marathon training plan december",
  "cloudflare access policy",
  "render deploy service",
  "python uv dependency management",
  "systemd user service restart",
  "ssh tunnel port forwarding",
];

const ENDPOINTS = ["search", "vsearch", "query"] as const;

interface Result {
  endpoint: string;
  query: string;
  round: number;
  ms: number;
  resultCount: number;
  error: string | null;
}

async function runQuery(endpoint: string, query: string): Promise<{ ms: number; count: number; error: string | null }> {
  const encoded = encodeURIComponent(query);
  const url = `${BASE}/${endpoint}?q=${encoded}&limit=5`;
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const ms = performance.now() - start;
    if (!res.ok) {
      const body = await res.text();
      return { ms, count: 0, error: `HTTP ${res.status}: ${body.slice(0, 100)}` };
    }
    const data = await res.json() as unknown[];
    return { ms, count: Array.isArray(data) ? data.length : 0, error: null };
  } catch (err: unknown) {
    const ms = performance.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { ms, count: 0, error: msg };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
  };
}

async function main() {
  // Check server is up
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    console.error(`Server: ${BASE} — OK`);
  } catch {
    console.error(`ERROR: Cannot reach ${BASE}/status`);
    process.exit(1);
  }

  const results: Result[] = [];

  // Warmup
  if (WARMUP > 0) {
    console.error(`\nWarmup: ${WARMUP} round(s)...`);
    for (let w = 0; w < WARMUP; w++) {
      for (const endpoint of ENDPOINTS) {
        for (const query of QUERIES) {
          await runQuery(endpoint, query);
        }
      }
    }
    console.error("Warmup complete.\n");
  }

  // Benchmark
  for (let round = 1; round <= ROUNDS; round++) {
    console.error(`Round ${round}/${ROUNDS}...`);
    for (const endpoint of ENDPOINTS) {
      for (const query of QUERIES) {
        const { ms, count, error } = await runQuery(endpoint, query);
        results.push({ endpoint, query, round, ms, resultCount: count, error });
        if (error) {
          console.error(`  ${endpoint} "${query.slice(0, 30)}..." ERROR: ${error}`);
        }
      }
    }
  }

  // Summary by endpoint
  console.log("\n=== SUMMARY BY ENDPOINT ===\n");
  console.log("endpoint    | queries | min     | median  | mean    | p95     | max     | errors");
  console.log("------------|---------|---------|---------|---------|---------|---------|-------");

  for (const endpoint of ENDPOINTS) {
    const endpointResults = results.filter(r => r.endpoint === endpoint);
    const times = endpointResults.filter(r => !r.error).map(r => r.ms);
    const errors = endpointResults.filter(r => r.error).length;
    if (times.length === 0) {
      console.log(`${endpoint.padEnd(12)}| ${endpointResults.length.toString().padEnd(8)}| -       | -       | -       | -       | -       | ${errors}`);
      continue;
    }
    const s = stats(times);
    console.log(
      `${endpoint.padEnd(12)}| ` +
      `${times.length.toString().padEnd(8)}| ` +
      `${s.min.toFixed(0).padStart(5)}ms | ` +
      `${s.median.toFixed(0).padStart(5)}ms | ` +
      `${s.mean.toFixed(0).padStart(5)}ms | ` +
      `${s.p95.toFixed(0).padStart(5)}ms | ` +
      `${s.max.toFixed(0).padStart(5)}ms | ` +
      `${errors}`
    );
  }

  // Per-query breakdown for /query (the slow one)
  console.log("\n=== /query PER-QUERY BREAKDOWN (all rounds) ===\n");
  console.log("query                              | min     | median  | max     | rounds");
  console.log("-----------------------------------|---------|---------|---------|-------");

  for (const query of QUERIES) {
    const qResults = results.filter(r => r.endpoint === "query" && r.query === query && !r.error);
    const times = qResults.map(r => r.ms);
    if (times.length === 0) {
      console.log(`${query.slice(0, 35).padEnd(35)}| -       | -       | -       | 0`);
      continue;
    }
    const s = stats(times);
    console.log(
      `${query.slice(0, 35).padEnd(35)}| ` +
      `${s.min.toFixed(0).padStart(5)}ms | ` +
      `${s.median.toFixed(0).padStart(5)}ms | ` +
      `${s.max.toFixed(0).padStart(5)}ms | ` +
      `${times.length}`
    );
  }

  // Raw data as JSON for further analysis
  console.log("\n=== RAW DATA (JSON) ===\n");
  console.log(JSON.stringify(results.map(r => ({
    endpoint: r.endpoint,
    query: r.query,
    round: r.round,
    ms: Math.round(r.ms),
    results: r.resultCount,
    error: r.error,
  })), null, 2));
}

main();
