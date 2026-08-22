// Shared CDP-over-WebSocket driver for Tier 2 DOM-driven flow tests (test/dom-flows.test.js).
// Formalizes the raw-WebSocket-+-fetch approach used manually, ad hoc, throughout this session's
// live verification of App Builder fixes — no puppeteer/playwright, no new dependency, just
// Node's built-in global fetch + WebSocket (Node 18+).
//
// Prerequisites this module does NOT set up itself (accepted limitation, see test/dom-flows.test.js):
//   - The app's own dev server running on http://localhost:3000 (`node server.js`)
//   - A real Chrome instance already launched with --remote-debugging-port reachable at CDP_HTTP
'use strict';

const CDP_HTTP = process.env.CDP_HTTP || 'http://localhost:9227';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.CDP_TEST_EMAIL || 'testbot@forgeai.test';
const TEST_PASSWORD = process.env.CDP_TEST_PASSWORD || 'TestBot123!';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let msgId = 1;
function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id === id) {
        ws.removeEventListener('message', onMsg);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evalJSON(ws, expression) {
  // awaitPromise:true is a no-op for a plain (non-promise) result, and required whenever the
  // expression is itself an async IIFE (e.g. one that awaits fetch()) — without it, Runtime.
  // evaluate returns the pending Promise object itself rather than its resolved value.
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EVAL ERROR: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

// Checks both prerequisites are actually reachable, with a short timeout — used by
// dom-flows.test.js's before() hook to skip cleanly (with a clear reason) instead of every test
// hanging/erroring individually when the dev server or Chrome isn't running.
async function checkAvailability() {
  try {
    const health = await fetch(APP_URL + '/api/health', { signal: AbortSignal.timeout(2000) });
    if (!health.ok) throw new Error('dev server responded but not healthy (status ' + health.status + ')');
  } catch (err) {
    return { available: false, reason: `dev server not reachable at ${APP_URL} (start it with "node server.js") — ${err.message}` };
  }
  try {
    const ver = await fetch(CDP_HTTP + '/json/version', { signal: AbortSignal.timeout(2000) });
    if (!ver.ok) throw new Error('CDP endpoint responded but not ok (status ' + ver.status + ')');
  } catch (err) {
    return { available: false, reason: `Chrome CDP endpoint not reachable at ${CDP_HTTP} (launch Chrome with --remote-debugging-port) — ${err.message}` };
  }
  return { available: true, reason: '' };
}

// Real session cookie via the app's own login endpoint — same seeded test account used
// throughout this session's manual verification.
async function login() {
  const res = await fetch(APP_URL + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error('login failed: ' + res.status);
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

// A fresh tab, authenticated (cookie set before navigation) and navigated to the app, with
// Network/Runtime/Page domains enabled. Bare — does not enter Pro mode or touch chat state.
async function newTab(cookieVal) {
  const newTabRes = await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' });
  const tab = await newTabRes.json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send(ws, 'Network.enable', {});
  await send(ws, 'Runtime.enable', {});
  await send(ws, 'Page.enable', {});
  await send(ws, 'Network.setCookie', { name: 'connect.sid', value: cookieVal, domain: 'localhost', path: '/', httpOnly: true });
  await send(ws, 'Page.navigate', { url: APP_URL });
  await sleep(4000);
  return { ws, tab };
}

// Full setup: new tab + enter Pro mode + fresh chat + a cheap warmup send (routes to Groq's fast
// free-tier model, not Gemini — negligible cost) so the chat session is properly registered
// before test code manipulates _abState/chatHistory directly, then clears the warmup message back
// out. Mirrors the setupTab() pattern used in every manual CDP verification this session.
async function setupProModeTab(cookieVal) {
  const { ws, tab } = await newTab(cookieVal);
  await send(ws, 'Runtime.evaluate', {
    expression: `(function(){ var btn = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Enter Pro Mode')); if(btn) btn.click(); return 'ok'; })()`,
  });
  await sleep(1200);
  await evalJSON(ws, `if (typeof chNewChat === 'function') chNewChat();`);
  await sleep(800);
  await evalJSON(ws, `(function(){var inp=document.getElementById('chat-in');inp.value='hello';if(typeof rsz==='function')rsz(inp);send();return'warmup';})()`);
  await sleep(3000);
  await evalJSON(ws, `(function(){ chatHistory.length=0; saveChat(); chSync(); document.getElementById('chat-msgs').innerHTML=''; return 'cleared'; })()`);
  await sleep(300);
  return { ws, tab };
}

// Polls until send()'s own in-flight guard (_sendPending) clears, for flows that go through a
// real (but fast/free Groq-tier) classification call — e.g. the guided-flow off-topic-reply
// matcher (/api/ab-match-option, GROQ_8B) — instead of a fixed sleep that races the response.
async function waitForSendSettled(ws, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const pending = await evalJSON(ws, `typeof _sendPending !== 'undefined' ? _sendPending : false`);
    if (!pending) return true;
    await sleep(250);
  }
  return false;
}

module.exports = { CDP_HTTP, APP_URL, sleep, send, evalJSON, checkAvailability, login, newTab, setupProModeTab, waitForSendSettled };
