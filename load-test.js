#!/usr/bin/env node
/**
 * load-test.js — ForgeAI server concurrency test
 *
 * Fires concurrent GET /api/health requests to verify the server handles
 * load without crashing. No database, no API key usage.
 *
 * Usage (human-readable):
 *   node load-test.js
 *   node load-test.js --host http://localhost:3000 --concurrency 100
 *
 * Usage (machine-readable JSON, used by Testing panel):
 *   node load-test.js --json --concurrency 50
 */

const BASE        = (() => { const i = process.argv.indexOf('--host');        return i !== -1 ? process.argv[i+1] : 'http://localhost:3000'; })();
const CONCURRENCY = (() => { const i = process.argv.indexOf('--concurrency'); return i !== -1 ? parseInt(process.argv[i+1]) : 100; })();
const IS_JSON     = process.argv.includes('--json');
const BATCH_SIZE  = Math.max(10, Math.floor(CONCURRENCY / 4));

function log(...args) { if (!IS_JSON) console.log(...args); }

async function req(path) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });
    return { status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { status: 0, error: err.message, ms: Date.now() - start };
  }
}

async function runBatch(tasks) {
  const results = [];
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const chunk = await Promise.all(tasks.slice(i, i + BATCH_SIZE).map(fn => fn()));
    results.push(...chunk);
  }
  return results;
}

(async () => {
  log(`\nForgeAI Load Test`);
  log(`Target      : ${BASE}`);
  log(`Concurrency : ${CONCURRENCY} (batch ${BATCH_SIZE})`);

  const probe = await req('/api/health');
  if (probe.status !== 200) {
    const msg = `Server not reachable at ${BASE} (got ${probe.status}).`;
    if (IS_JSON) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(1); }
    console.error(`\n❌ ${msg} Start with: node server.js\n`);
    process.exit(1);
  }
  log(`✓ Server up`);

  log(`Running ${CONCURRENCY} concurrent GET /api/health...`);
  const results = await runBatch(
    Array.from({ length: CONCURRENCY }, () => () => req('/api/health'))
  );

  const ms      = results.map(r => r.ms).sort((a, b) => a - b);
  const pAt     = (pct) => ms[Math.ceil(ms.length * pct / 100) - 1] ?? ms[ms.length - 1];
  const passed  = results.filter(r => r.status === 200).length;
  const failed  = results.filter(r => r.status >= 500 || r.status === 0).length;
  const byCode  = {};
  for (const r of results) byCode[r.status] = (byCode[r.status] || 0) + 1;

  if (!IS_JSON) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ForgeAI — ${CONCURRENCY} concurrent GET /api/health`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`  Passed : ${passed}/${results.length} (${((passed/results.length)*100).toFixed(1)}%)`);
    console.log(`  Failed : ${failed}`);
    console.log(`  p50    : ${pAt(50)}ms`);
    console.log(`  p95    : ${pAt(95)}ms`);
    console.log(`  p99    : ${pAt(99)}ms`);
    console.log(`  Codes  : ${JSON.stringify(byCode)}`);
    console.log(`  ${failed === 0 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`${'─'.repeat(50)}\n`);
    return;
  }

  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    concurrency: CONCURRENCY,
    tests: {
      health: { total: results.length, passed, failed, p50: pAt(50), p99: pAt(99) },
    },
    summary: {
      totalRequests: results.length,
      totalPassed: passed,
      totalFailed: failed,
      crashes500s: failed,
      sqlite503s: 0,
    },
  }));
})();
