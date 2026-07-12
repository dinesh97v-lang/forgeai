/**
 * test-quality.js — Automated quality test for the Learn Any Field feature.
 * Run with: node test-quality.js  (server must be running on port 3000)
 * Requires Node 18+ (uses built-in fetch).
 */

'use strict';

const fs = require('fs');

const BASE_URL = 'http://localhost:3000';
const API_URL  = `${BASE_URL}/api/chat`;
const DELAY_MS = 2000;

let sessionCookie = '';

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'testbot@forgeai.test', password: 'TestBot123!' }),
  });
  if (!res.ok) {
    console.error('\x1b[31mTest account login failed — check credentials\x1b[0m');
    process.exit(1);
  }
  // Capture the Set-Cookie header so every API call carries the session
  const raw = res.headers.get('set-cookie') || '';
  sessionCookie = raw.split(';')[0]; // e.g. "connect.sid=s%3A..."
  if (!sessionCookie) {
    console.error('\x1b[31mLogin succeeded but no session cookie received\x1b[0m');
    process.exit(1);
  }
}

const TOPICS = [
  // Trades
  'Electrician & Electronics',
  'Plumbing',
  'Tailoring',
  'Welding',
  'Carpentry',
  // Office
  'Banking & Finance',
  'HR & Human Resources',
  'Accounting',
  'Digital Marketing',
  // Hybrid
  'Hotel Management & Cooking',
  'Beauty & Salon',
  'Photography',
  'Automobile Industry',
  'Healthcare & Nursing',
  // Knowledge
  'AI & Machine Learning',
  'Coding & Software Development',
  'Graphic Design',
  // Unusual
  'Drone Technology',
  'Organic Farming',
  'Insurance Sales',
];

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callApi(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function bulletLineCount(text) {
  const lines = (text || '').split('\n');
  return lines.filter(l => /^\s*([-*•]|\d+[.)]) /.test(l)).length;
}

// Extract JSON from a string — first { to last }
function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Employer-equipment pricing check.
 * Flag if within 2 sentences of an employer-provided-tool term, there is
 * a pricing/investment pattern suggesting the learner should buy it.
 */
function checkEmployerPricing(text) {
  const EMPLOYER_TERMS = /software|system|industrial|kitchen equipment|POS|core banking|machinery|enterprise|ERP|CRM/i;
  const PRICING_PATTERNS = /invest\s*[₹Rs]|invest\s*Rs|will cost.*per year|purchase a licence|buy a licence|₹\s*\d[\d,]+\s*per (year|month)|costs?\s*[₹Rs]\s*\d[\d,]+\s*(per|a)\s*(year|month)|you.?ll need to (buy|purchase)/i;

  const sentences = text.replace(/([.!?])\s+/g, '$1\n').split('\n').filter(Boolean);

  for (let i = 0; i < sentences.length; i++) {
    if (EMPLOYER_TERMS.test(sentences[i])) {
      // Check this sentence and up to 2 sentences after it
      const window = sentences.slice(i, i + 3).join(' ');
      if (PRICING_PATTERNS.test(window)) return true;
    }
  }
  return false;
}

function checkTanglishLeak(text) {
  return /\b(Vanakkam|vanakkam|pannunga|irukku|theriyum|nalla\b|seri|aagum|purinju|appa|akka|bro,)/i.test(text);
}

function checkQuestionsBlock(text) {
  const m = text.match(/\[QUESTIONS\]\s*([\s\S]*?)\s*\[\/QUESTIONS\]/i);
  if (!m) return { present: false, count: 0 };
  const qs = m[1].split('|').map(q => q.trim()).filter(q => q.length > 0);
  return { present: true, count: qs.length };
}

// ── checks ────────────────────────────────────────────────────────────────────

function checkPreview(raw) {
  const data = extractJson(raw);
  const results = {
    validJson: !!data,
    hasTitle: !!(data && data.title && data.title.trim()),
    hasOutcomes: !!(data && Array.isArray(data.outcomes) && data.outcomes.length === 4),
    hasTimeline: !!(data && data.timeline && data.timeline.trim()),
  };
  results.overall = results.validJson && results.hasTitle && results.hasOutcomes && results.hasTimeline;
  return results;
}

function checkRoadmap(text) {
  const qBlock = checkQuestionsBlock(text);
  const bullets = bulletLineCount(text);
  const words = wordCount(text);

  const results = {
    pricing: !checkEmployerPricing(text),       // PASS = no bad pricing advice
    language: !checkTanglishLeak(text),          // PASS = no Tanglish leak
    questionsPresent: qBlock.present,
    questionsCount: qBlock.count === 3,          // PASS = exactly 3
    bulletStyle: bullets <= 15,                  // PASS = roadmap responses are naturally list-heavy (≤15)
    lengthSanity: words >= 100 && words <= 700,  // PASS = reasonable length
  };
  results.overall =
    results.pricing &&
    results.language &&
    results.questionsPresent &&
    results.questionsCount &&
    results.bulletStyle &&
    results.lengthSanity;
  return { ...results, _meta: { bullets, words, qCount: qBlock.count } };
}

// ── formatting ────────────────────────────────────────────────────────────────

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const pf = v => (v ? PASS : FAIL);

function padEnd(str, len) {
  // strip ANSI before measuring
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - plain.length));
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('Logging in as testbot@forgeai.test ... ');
  await login();
  console.log('\x1b[32mOK\x1b[0m');

  console.log('\n\x1b[1m=== ForgeAI — Learn Any Field Quality Test ===\x1b[0m');
  console.log(`Testing ${TOPICS.length} topics against ${API_URL}\n`);

  const results = [];
  let fullyPassed = 0;

  for (let i = 0; i < TOPICS.length; i++) {
    const topic = TOPICS[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${TOPICS.length}] ${topic} ... `);

    const entry = { topic, previewRaw: null, roadmapRaw: null, previewCheck: null, roadmapCheck: null, error: null };

    try {
      // ── Preview call ──────────────────────────────────────────────────────
      const previewData = await callApi({ prompt: topic, history: [], fieldPreviewMode: topic, simpleMode: false });
      entry.previewRaw = previewData.reply || '';
      await sleep(DELAY_MS);

      // ── Roadmap / first-teach call ────────────────────────────────────────
      const roadmapPrompt = `📚 Learn: ${topic}`;
      const roadmapData = await callApi({ prompt: roadmapPrompt, history: [], fieldMode: topic, simpleMode: false });
      entry.roadmapRaw = roadmapData.reply || '';
      await sleep(DELAY_MS);

      entry.previewCheck = checkPreview(entry.previewRaw);
      entry.roadmapCheck = checkRoadmap(entry.roadmapRaw);

      const allPass = entry.previewCheck.overall && entry.roadmapCheck.overall;
      if (allPass) fullyPassed++;

      console.log(allPass ? '\x1b[32mOK\x1b[0m' : '\x1b[31mISSUES\x1b[0m');
    } catch (err) {
      entry.error = err.message;
      console.log(`\x1b[31mERROR: ${err.message}\x1b[0m`);
    }

    results.push(entry);
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log('\n\x1b[1m─────────────────────────────────────────────────────────────────────────────\x1b[0m');
  console.log(
    padEnd('\x1b[1mTopic\x1b[0m', 38) +
    padEnd('\x1b[1mPreview\x1b[0m', 12) +
    padEnd('\x1b[1mPricing\x1b[0m', 12) +
    padEnd('\x1b[1mLanguage\x1b[0m', 13) +
    padEnd('\x1b[1mQuestions\x1b[0m', 14) +
    padEnd('\x1b[1mStyle\x1b[0m', 10) +
    '\x1b[1mLength\x1b[0m'
  );
  console.log('\x1b[1m─────────────────────────────────────────────────────────────────────────────\x1b[0m');

  for (const r of results) {
    if (r.error) {
      console.log(padEnd(r.topic, 38) + `\x1b[31mERROR: ${r.error}\x1b[0m`);
      continue;
    }
    const pc = r.previewCheck;
    const rc = r.roadmapCheck;
    const previewLabel = pc.overall ? PASS : FAIL;
    const detailSuffix = !pc.overall
      ? ` (json:${pc.validJson ? '✓' : '✗'} title:${pc.hasTitle ? '✓' : '✗'} outcomes:${pc.hasOutcomes ? '✓' : '✗'} timeline:${pc.hasTimeline ? '✓' : '✗'})`
      : '';

    console.log(
      padEnd(r.topic, 38) +
      padEnd(previewLabel + detailSuffix, 12 + detailSuffix.length) +
      padEnd(pf(rc.pricing), 12) +
      padEnd(pf(rc.language), 13) +
      padEnd(pf(rc.questionsPresent && rc.questionsCount), 14) +
      padEnd(pf(rc.bulletStyle), 10) +
      pf(rc.lengthSanity) +
      (rc._meta ? `  \x1b[2m(${rc._meta.words}w, ${rc._meta.bullets}b, q:${rc._meta.qCount})\x1b[0m` : '')
    );
  }

  console.log('\x1b[1m─────────────────────────────────────────────────────────────────────────────\x1b[0m');
  console.log(`\n\x1b[1mResult: ${fullyPassed}/${TOPICS.length} topics fully passed\x1b[0m\n`);

  // ── Failure detail ─────────────────────────────────────────────────────────
  const failed = results.filter(r => r.error || !r.previewCheck?.overall || !r.roadmapCheck?.overall);
  if (failed.length > 0) {
    console.log('\x1b[1mFailure detail:\x1b[0m');
    for (const r of failed) {
      console.log(`\n  \x1b[33m${r.topic}\x1b[0m`);
      if (r.error) { console.log(`    ERROR: ${r.error}`); continue; }
      const pc = r.previewCheck;
      const rc = r.roadmapCheck;
      if (!pc.overall) {
        console.log('    Preview:');
        if (!pc.validJson)    console.log('      ✗ Could not extract valid JSON');
        if (!pc.hasTitle)     console.log('      ✗ Missing title');
        if (!pc.hasOutcomes)  console.log(`      ✗ outcomes array not exactly 4 (got ${pc._outcomes ?? '?'})`);
        if (!pc.hasTimeline)  console.log('      ✗ Missing timeline');
      }
      if (!rc.overall) {
        console.log('    Roadmap:');
        if (!rc.pricing)         console.log('      ✗ Employer-equipment pricing advice detected');
        if (!rc.language)        console.log('      ✗ Tanglish/Tamil words leaked into English response');
        if (!rc.questionsPresent)console.log('      ✗ No [QUESTIONS] block found');
        if (!rc.questionsCount)  console.log(`      ✗ [QUESTIONS] has ${rc._meta.qCount} questions (expected 3)`);
        if (!rc.bulletStyle)     console.log(`      ✗ Too many bullet/numbered lines: ${rc._meta.bullets}`);
        if (!rc.lengthSanity)    console.log(`      ✗ Response length out of range: ${rc._meta.words} words`);
      }
    }
    console.log('');
  }

  // ── Save full responses ────────────────────────────────────────────────────
  const outPath = 'test-results.json';
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      results.map(r => ({
        topic: r.topic,
        error: r.error || null,
        previewCheck: r.previewCheck,
        roadmapCheck: r.roadmapCheck
          ? { ...r.roadmapCheck, _meta: r.roadmapCheck._meta }
          : null,
        previewRaw: r.previewRaw,
        roadmapRaw: r.roadmapRaw,
      })),
      null,
      2
    )
  );
  console.log(`Full responses saved to \x1b[36m${outPath}\x1b[0m\n`);
}

main().catch(err => {
  console.error('\x1b[31mFatal error:\x1b[0m', err.message);
  process.exit(1);
});
