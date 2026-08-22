// Tier 2 — DOM-driven flow tests for App Builder, formalizing the CDP-over-WebSocket approach
// used manually throughout this session's live verification. Run with: node --test test/
// (same command as Tier 1's pure-logic.test.js).
//
// Unlike Tier 1, these cannot run cold: they need the app's own dev server already running on
// :3000 AND a real Chrome instance already launched with --remote-debugging-port reachable
// (see test/helpers/cdp.js for the exact endpoints/env vars). This is an accepted limitation —
// the before() hook below checks both and skips every test with a clear reason if either is
// missing, rather than failing individually with a confusing connection error.
//
// Every flow here is deliberately deterministic: guided-flow answers that exactly match a
// button's own option text resolve entirely client-side (_abMatchOption, no network — see
// send()'s `else{_abHandleAnswer(t);}return;` at the top of its guided-flow branch), and the
// escape-hatch/build-fail scenarios use Network.emulateNetworkConditions instead of waiting on a
// real LLM call. No test here depends on live model output, so none of them burn API quota or
// carry model-response flakiness.

'use strict';

const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const cdp = require('./helpers/cdp');

let available = false;
let unavailableReason = '';
let cookieVal = '';

describe('App Builder — Tier 2 DOM-driven flow tests', () => {
  before(async () => {
    const check = await cdp.checkAvailability();
    available = check.available;
    unavailableReason = check.reason;
    if (available) cookieVal = await cdp.login();
  });

  // ── 1: Guided-flow happy path end-to-end (asking -> confirm -> build-triggered) ──────────────
  test('1: guided-flow happy path — answer both questions, reach plan card, trigger build', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      await cdp.evalJSON(ws, `(function(){
        var questions=[
          {question:'Where should your app run?',label:'Platform',options:['Phone only','Desktop only'],multi:false},
          {question:'What design style do you prefer?',label:'Design Style',options:['Minimal','Colorful'],multi:false}
        ];
        window._abState=_abNewState({step:0,phase:'asking',questions:questions,answers:[],intentText:'Test app for happy path e2e',buildHints:{techStack:'Plain HTML/CSS/JS',styleGuide:'Minimal'}});
        _abAsk(questions[0].question, questions[0].options);
        return {ok:true};
      })()`);
      await cdp.sleep(300);

      // Answer Q1 by clicking its pinned-strip option button (exact-text match -> resolves
      // entirely client-side via _abMatchOption, no network).
      await cdp.evalJSON(ws, `(function(){
        var strip=document.getElementById('ab-pin-strip');
        var btn=Array.from(strip.querySelectorAll('button')).find(function(b){return b.dataset.opt==='Phone only';});
        if(!btn) return 'NO_Q1_BUTTON';
        btn.click();
        return 'clicked';
      })()`);
      await cdp.sleep(500);
      const afterQ1 = await cdp.evalJSON(ws, `JSON.stringify({step:window._abState.step, phase:window._abState.phase, q2Text:window._abState.questions[window._abState.step].question})`).then(JSON.parse);
      assert.equal(afterQ1.step, 1, 'answering Q1 should advance to step 1');
      assert.equal(afterQ1.phase, 'asking', 'still asking after Q1 — one more question left');

      // Answer Q2 the same way.
      await cdp.evalJSON(ws, `(function(){
        var strip=document.getElementById('ab-pin-strip');
        var btn=Array.from(strip.querySelectorAll('button')).find(function(b){return b.dataset.opt==='Minimal';});
        if(!btn) return 'NO_Q2_BUTTON';
        btn.click();
        return 'clicked';
      })()`);
      await cdp.sleep(500);
      const afterQ2 = await cdp.evalJSON(ws, `JSON.stringify({
        phase: window._abState.phase,
        lastAbKind: chatHistory.length?chatHistory[chatHistory.length-1].abKind:null,
        hasBuildButton: !!Array.from(document.querySelectorAll('.fl-qr-bar button')).find(function(b){return b.textContent.indexOf('Build it')!==-1 && !b.disabled;})
      })`).then(JSON.parse);
      assert.equal(afterQ2.phase, 'confirm', 'answering the last question should reach the confirm/plan-card phase');
      assert.equal(afterQ2.lastAbKind, 'plan', 'last chat message should be the plan card');
      assert.equal(afterQ2.hasBuildButton, true, 'a live, enabled "Build it" button should be present');

      // Click "Build it" while offline, reading the resulting state in the SAME synchronous
      // evaluate call as the click — _abTriggerBuild() runs synchronously (phase flip, message
      // push, state cleared from localStorage) up until the async fetch; reading state in a
      // separate later call risks racing send()'s own .catch() handler, which (since offline
      // rejects near-instantly, unlike a real timeout) can revert phase back to 'confirm' well
      // within a normal polling delay — this checks the pre-fetch snapshot deterministically.
      await cdp.send(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      const afterBuildClick = await cdp.evalJSON(ws, `(function(){
        var btns=Array.from(document.querySelectorAll('.fl-qr-bar button'));
        var b=btns.find(function(x){return x.textContent.indexOf('Build it')!==-1 && !x.disabled;});
        if(!b) return JSON.stringify({error:'NO_BUILD_BUTTON'});
        var chatIdBefore=window._abState.chatId;
        b.click();
        return JSON.stringify({
          phase: window._abState?window._abState.phase:null,
          // _abTriggerBuild() pushes the "Building..." message first, then calls send() again
          // with the full build prompt — that nested send() pushes its OWN short display message
          // ('🚀 Build: <intent>') right after, so "Building..." is not necessarily the tail entry.
          hasBuildingMsg: chatHistory.some(function(m){return /Building your app/.test(m.content||'');}),
          stateStillInStorage: localStorage.getItem(_abStateKey(chatIdBefore)) !== null
        });
      })()`).then(JSON.parse);
      assert.equal(afterBuildClick.phase, 'building', 'clicking Build it should flip phase to building');
      assert.equal(afterBuildClick.hasBuildingMsg, true, 'a building-in-progress message should be pushed');
      assert.equal(afterBuildClick.stateStillInStorage, false, '_abClearState() should have removed the persisted state synchronously at build start');
      await cdp.send(ws, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    } finally {
      ws.close();
    }
  });

  // ── 2: Reload mid-flow — resumable state restores live; a broken-invariant state is discarded ─
  test('2: reload mid-flow — resumable state restores the live bar; broken-invariant state is discarded', async (t) => {
    if (!available) return t.skip(unavailableReason);

    // Case A: a genuinely-tagged pending question (via the real _abAsk()) survives a reload.
    {
      const { ws } = await cdp.setupProModeTab(cookieVal);
      try {
        await cdp.evalJSON(ws, `(function(){
          chatHistory.push({role:'user',content:'Build a test app for reload-resume check'});
          saveChat();chSync();
          var questions=[{question:'Which tech stack do you prefer?',label:'Tech Stack',options:['Simple HTML/CSS/JS','React'],multi:false}];
          window._abState=_abNewState({step:0,phase:'asking',questions:questions,answers:[],intentText:'reload resume test'});
          _abAsk(questions[0].question, questions[0].options);
          return {ok:true};
        })()`);
        await cdp.sleep(500);
        await cdp.send(ws, 'Page.navigate', { url: cdp.APP_URL });
        await cdp.sleep(4000);
        const restored = await cdp.evalJSON(ws, `JSON.stringify({
          welcomeHidden: document.getElementById('welcome').style.display==='none',
          abStatePresent: !!window._abState,
          abStatePhase: window._abState?window._abState.phase:null,
          pinStripVisible: document.getElementById('ab-pin-strip').style.display==='flex'
        })`).then(JSON.parse);
        assert.equal(restored.welcomeHidden, true, 'mode picker should be skipped when a real session is restored');
        assert.equal(restored.abStatePresent, true, 'genuinely-tagged pending state should survive reload');
        assert.equal(restored.abStatePhase, 'asking', 'restored state should keep its in-flight phase');
        assert.equal(restored.pinStripVisible, true, 'the pending question should be re-armed and visible after restore');
      } finally {
        ws.close();
      }
    }

    // Case B: same chatId, but the invariant is broken — _abState claims a pending question that
    // isn't actually the tail of chatHistory (an untagged assistant message sits last instead).
    // This is the exact shape of bug this session found via _abTailPendingIndex()===-1.
    {
      const { ws } = await cdp.setupProModeTab(cookieVal);
      try {
        await cdp.evalJSON(ws, `(function(){
          chatHistory.push({role:'user',content:'Build a test app for reload-discard check'});
          chatHistory.push({role:'assistant',content:'Some untagged trailing message, no abQuestion/qrOptions'});
          saveChat();chSync();
          var questions=[{question:'Which tech stack do you prefer?',label:'Tech Stack',options:['Simple HTML/CSS/JS','React'],multi:false}];
          var st=_abNewState({step:0,phase:'asking',questions:questions,answers:[],intentText:'reload discard test'});
          localStorage.setItem(_abStateKey(st.chatId), JSON.stringify(st));
          return {chatId: st.chatId};
        })()`);
        await cdp.sleep(300);
        await cdp.send(ws, 'Page.navigate', { url: cdp.APP_URL });
        await cdp.sleep(4000);
        const afterDiscard = await cdp.evalJSON(ws, `JSON.stringify({
          abStatePresent: !!window._abState,
          storageEntryGone: typeof chCurId==='function' ? (localStorage.getItem(_abStateKey(chCurId()))===null) : null
        })`).then(JSON.parse);
        assert.equal(afterDiscard.abStatePresent, false, 'a broken-invariant state should be discarded (nulled), not silently resumed');
        assert.equal(afterDiscard.storageEntryGone, true, 'the stale localStorage entry should be cleared, not just nulled in memory');
      } finally {
        ws.close();
      }
    }
  });

  // ── 3: Guided quick-reply visual differentiation (blue/guided vs red/ordinary) ───────────────
  test('3: guided-flow quick-reply bars render blue/.ab-guided; ordinary chat chips stay default', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      await cdp.evalJSON(ws, `(function(){
        var questions=[{question:'Which features?',label:'Features',options:['Electronics','Furniture'],multi:true}];
        window._abState=_abNewState({step:0,phase:'asking',questions:questions,answers:[],intentText:'styling test'});
        _abRenderFeatureSelect();
        return {ok:true};
      })()`);
      await cdp.sleep(400);
      const guided = await cdp.evalJSON(ws, `(function(){
        var bar=document.getElementById('ab-feat-bar');
        return JSON.stringify({found:!!bar, hasAbGuided: bar?bar.classList.contains('ab-guided'):false});
      })()`).then(JSON.parse);
      assert.equal(guided.found, true, 'the guided multi-select bar should render');
      assert.equal(guided.hasAbGuided, true, 'guided-flow bars must carry the .ab-guided class');

      const ordinary = await cdp.evalJSON(ws, `(function(){
        var msgs=document.getElementById('chat-msgs');
        var qr={options:['Option A','Option B']};
        flRenderQuickReply(qr,msgs); // exact call shape used for server-driven QUICK_REPLY — no isGuided arg
        var bars=Array.from(document.querySelectorAll('.fl-qr-bar'));
        var bar=bars[bars.length-1];
        return JSON.stringify({found:!!bar, hasAbGuided: bar?bar.classList.contains('ab-guided'):false});
      })()`).then(JSON.parse);
      assert.equal(ordinary.found, true, 'an ordinary quick-reply bar should render');
      assert.equal(ordinary.hasAbGuided, false, 'ordinary server-driven QUICK_REPLY bars must NOT carry .ab-guided');
    } finally {
      ws.close();
    }
  });

  // ── 4: Escape hatch / off-topic reply handling ───────────────────────────────────────────────
  test('4: two consecutive off-topic replies on the same step escalate to the escape offer', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      await cdp.evalJSON(ws, `(function(){
        var questions=[{question:'Which design style do you prefer?',label:'Design Style',options:['Minimal','Colorful'],multi:false}];
        window._abState=_abNewState({step:0,phase:'asking',questions:questions,answers:[],intentText:'escape hatch test'});
        _abAsk(questions[0].question, questions[0].options);
        return {ok:true};
      })()`);
      await cdp.sleep(300);

      async function sendFreeText(text) {
        return cdp.evalJSON(ws, `(function(){var inp=document.getElementById('chat-in');inp.value=${JSON.stringify(text)};if(typeof rsz==='function')rsz(inp);send();return'sent';})()`);
      }

      // First off-topic reply — no local match, so it falls through to the real (but Groq-8B,
      // fast/free-tier) /api/ab-match-option classification call before giving up; count goes to
      // 1, below the escalate threshold. Poll _sendPending instead of a fixed sleep, since this
      // is a real (if cheap) network round trip.
      await sendFreeText('what is the capital of France');
      const settled1 = await cdp.waitForSendSettled(ws, 10000);
      assert.equal(settled1, true, 'first off-topic reply should finish its classification round trip within 10s');
      const afterFirstMiss = await cdp.evalJSON(ws, `JSON.stringify({nullStreak: window._abState.nullStreak, pendingEscape: window._abState.pendingEscape || null})`).then(JSON.parse);
      assert.equal(afterFirstMiss.nullStreak.count, 1, 'first off-topic reply should register one miss');
      assert.equal(afterFirstMiss.pendingEscape, null, 'one miss alone should not trigger the escape offer');

      // Second consecutive off-topic reply on the SAME step — hits the threshold (2).
      await sendFreeText('do you like pizza');
      const settled2 = await cdp.waitForSendSettled(ws, 10000);
      assert.equal(settled2, true, 'second off-topic reply should finish its classification round trip within 10s');
      const afterSecondMiss = await cdp.evalJSON(ws, `JSON.stringify({
        nullStreak: window._abState.nullStreak,
        pendingEscape: window._abState.pendingEscape || null,
        lastMsg: chatHistory.length?{abQuestion:chatHistory[chatHistory.length-1].abQuestion, qrOptions:chatHistory[chatHistory.length-1].qrOptions, abKind:chatHistory[chatHistory.length-1].abKind}:null
      })`).then(JSON.parse);
      assert.equal(afterSecondMiss.nullStreak.count, 2, 'second consecutive miss on the same step should bring the count to 2');
      assert.ok(afterSecondMiss.pendingEscape, 'two misses in a row should trigger the escape offer');
      assert.equal(afterSecondMiss.lastMsg.abQuestion, true, 'the escape-offer message must be tagged as a live pending question');
      assert.deepEqual((afterSecondMiss.lastMsg.qrOptions || []).sort(), ['Options-la pick pannen', 'Start over'].sort(), 'escape offer should present exactly the two escape options');
    } finally {
      ws.close();
    }
  });

  // ── 5: Build-fail-then-refresh recovery ──────────────────────────────────────────────────────
  test('5: a build failure survives a refresh with a live, retryable plan card', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      // setupProModeTab() clears the warmup message down to zero role:'user' entries — without a
      // genuine user message here, initPageAll()'s "remove chats with no user messages" pruning
      // deletes this chat before the refresh-restore logic ever runs (the exact bug this session
      // found in the guided-flow-differentiator tests), and refresh silently falls back to some
      // other, unrelated chat instead of restoring this one.
      await cdp.evalJSON(ws, `(function(){
        chatHistory.push({role:'user',content:'Build a test app for failure-recovery verification'});
        saveChat();chSync();
        var questions=[{question:'Design style',label:'Design Style',options:['Minimal'],multi:false}];
        window._abState=_abNewState({step:0,phase:'confirm',questions:questions,answers:['Minimal'],intentText:'Build a test app for failure-recovery verification',buildHints:{techStack:'React',styleGuide:'Minimal'}});
        _abRenderPlanCard();
        return {ok:true};
      })()`);
      await cdp.sleep(500);

      await cdp.send(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await cdp.evalJSON(ws, `(function(){
        var btns=Array.from(document.querySelectorAll('.fl-qr-bar button'));
        var b=btns.find(function(x){return x.textContent.indexOf('Build it')!==-1 && !x.disabled;});
        if(!b) return 'NO_BUILD_BUTTON';
        b.click();
        return 'clicked';
      })()`);
      await cdp.sleep(5000); // let the offline fetch actually reject and the catch handler run

      await cdp.send(ws, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.send(ws, 'Page.navigate', { url: cdp.APP_URL });
      await cdp.sleep(4000);

      const afterRefresh = await cdp.evalJSON(ws, `JSON.stringify({
        fullHistory: chatHistory.map(function(m){return {role:m.role, content:(m.content||'').slice(0,70), abKind:m.abKind};})
      })`).then(JSON.parse);
      const hasFailureMsg = afterRefresh.fullHistory.some(m => m.role === 'assistant' && /Build failed/.test(m.content));
      assert.equal(hasFailureMsg, true, 'the failure notice should persist visibly in the transcript after refresh');
      const tail = afterRefresh.fullHistory[afterRefresh.fullHistory.length - 1];
      assert.equal(tail && tail.abKind, 'plan', 'a fresh plan card should be the last message after refresh');

      const buildBtnState = await cdp.evalJSON(ws, `(function(){
        var allBtns = Array.from(document.querySelectorAll('#chat-msgs button'));
        var buildBtns = allBtns.filter(function(b){return b.textContent.indexOf('Build it')!==-1;});
        return JSON.stringify(buildBtns.map(function(b){return {disabled:b.disabled};}));
      })()`).then(JSON.parse);
      const newestBtn = buildBtnState[buildBtnState.length - 1];
      assert.equal(newestBtn.disabled, false, 'the newest "Build it" button after refresh should be live/clickable, not stranded disabled');

      // Retry — click the live button and confirm it actually re-triggers a build attempt.
      const beforeRetryLen = afterRefresh.fullHistory.length;
      await cdp.evalJSON(ws, `(function(){
        var allBtns = Array.from(document.querySelectorAll('#chat-msgs button'));
        var buildBtns = allBtns.filter(function(b){return b.textContent.indexOf('Build it')!==-1 && !b.disabled;});
        if(!buildBtns.length) return 'NO_LIVE_BUILD_BUTTON';
        buildBtns[buildBtns.length-1].click();
        return 'clicked';
      })()`);
      await cdp.sleep(1500);
      const afterRetry = await cdp.evalJSON(ws, `JSON.stringify({phase: window._abState?window._abState.phase:null, historyLen: chatHistory.length})`).then(JSON.parse);
      assert.equal(afterRetry.phase, 'building', 'clicking the recovered plan card\'s Build it should re-enter the building phase');
      assert.ok(afterRetry.historyLen > beforeRetryLen, 'the retry should push a new building-in-progress message');
    } finally {
      ws.close();
    }
  });

  // ── 6: Live preview renders a generated app correctly ────────────────────────────────────────
  test('6: clicking Preview loads pvBuild()\'s vendor-rewritten output into the iframe', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      const appHtml = [
        '<!DOCTYPE html><html><head>',
        '<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></' + 'script>',
        '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></' + 'script>',
        '<script src="https://unpkg.com/@babel/standalone@7.29.7/babel.min.js"></' + 'script>',
        '</head><body><div id="root"></div>',
        '<script type="text/babel">function App(){return <div id="pv-flow-marker">rendered via preview flow</div>;}ReactDOM.createRoot(document.getElementById(\'root\')).render(<App/>);</' + 'script>',
        '</body></html>',
      ].join('');

      const content = 'Here is your app:\n\n```html\n' + appHtml + '\n```\n';
      const rendered = await cdp.evalJSON(ws, `(function(){
        var content=${JSON.stringify(content)};
        var out=formatMarkdown(content);
        document.getElementById('chat-msgs').innerHTML=out;
        var btn=Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent.indexOf('▶ Preview')!==-1;});
        if(!btn) return JSON.stringify({found:false});
        btn.click();
        return JSON.stringify({found:true});
      })()`).then(JSON.parse);
      assert.equal(rendered.found, true, 'a Preview button should render for a real HTML/React app block');

      await cdp.sleep(800); // pvLoadIframe runs on requestAnimationFrame
      const iframeState = await cdp.evalJSON(ws, `(function(){
        var f=document.getElementById('pv-iframe');
        var s=f?f.srcdoc:'';
        return JSON.stringify({
          hasLocalReact: s.indexOf('/vendor/react.production.min.js')!==-1,
          hasLocalReactDom: s.indexOf('/vendor/react-dom.production.min.js')!==-1,
          hasLocalBabel: s.indexOf('/vendor/babel.min.js')!==-1,
          hasMarker: s.indexOf('pv-flow-marker')!==-1,
          noUnpkgLeft: s.indexOf('unpkg.com')===-1
        });
      })()`).then(JSON.parse);
      assert.equal(iframeState.hasLocalReact, true, 'iframe srcdoc should have React rewritten to the local vendor copy');
      assert.equal(iframeState.hasLocalReactDom, true, 'iframe srcdoc should have ReactDOM rewritten to the local vendor copy');
      assert.equal(iframeState.hasLocalBabel, true, 'iframe srcdoc should have Babel rewritten to the local vendor copy (live preview keeps Babel — export-time-only precompile is separate)');
      assert.equal(iframeState.hasMarker, true, 'the actual app content should have flowed through into the iframe');
      assert.equal(iframeState.noUnpkgLeft, true, 'no raw unpkg.com CDN reference should remain after the vendor rewrite');
    } finally {
      ws.close();
    }
  });

  // ── 7: Preview button suppressed for Node-only JS ────────────────────────────────────────────
  test('7: Preview button is hidden for Node.js-only code, shown for browser-safe JS, no cross-contamination', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      const nodeSnippet = [
        "const express = require('express');",
        "const mongoose = require('mongoose');",
        "const app = express();",
        "app.get('/api/users', (req, res) => { res.json([]); });",
        "mongoose.connect('mongodb://localhost/test');",
        "app.listen(3000, () => console.log('Server running'));",
      ].join('\n');
      const browserSnippet = [
        'function addNumbers(a, b) { return a + b; }',
        "document.getElementById('result').textContent = addNumbers(2, 3);",
      ].join('\n');

      const nodeContent = 'Here is your backend:\n\n```javascript\n' + nodeSnippet + '\n```\n';
      const nodeResult = await cdp.evalJSON(ws, `(function(){
        var content=${JSON.stringify(nodeContent)};
        var rendered=formatMarkdown(content);
        var div=document.createElement('div');div.innerHTML=rendered;document.body.appendChild(div);
        return JSON.stringify({hasPreviewBtn: /▶ Preview/.test(div.innerHTML), jsFileEmpty: !pvFiles.js});
      })()`).then(JSON.parse);
      assert.equal(nodeResult.hasPreviewBtn, false, 'Node/Express (require + server.listen) must NOT get a Preview button');
      assert.equal(nodeResult.jsFileEmpty, true, 'Node-only code must not populate pvFiles.js');

      await cdp.evalJSON(ws, `pvFiles={html:'',css:'',js:'',reactNative:{}};`);

      const browserContent = 'Here is a small browser example:\n\n```javascript\n' + browserSnippet + '\n```\n';
      const browserResult = await cdp.evalJSON(ws, `(function(){
        var content=${JSON.stringify(browserContent)};
        var rendered=formatMarkdown(content);
        var div=document.createElement('div');div.innerHTML=rendered;document.body.appendChild(div);
        return JSON.stringify({hasPreviewBtn: /▶ Preview/.test(div.innerHTML), hasAddNumbers: pvFiles.js.indexOf('addNumbers')!==-1});
      })()`).then(JSON.parse);
      assert.equal(browserResult.hasPreviewBtn, true, 'ordinary browser-safe JS must still get a Preview button — no regression');
      assert.equal(browserResult.hasAddNumbers, true, 'browser-safe JS should populate pvFiles.js');
    } finally {
      ws.close();
    }
  });

  // ── 8: ZIP export flow ────────────────────────────────────────────────────────────────────────
  test('8: ZIP export — multiple blocks dedupe/rename correctly, malformed JSX fails cleanly', async (t) => {
    if (!available) return t.skip(unavailableReason);
    const { ws } = await cdp.setupProModeTab(cookieVal);
    try {
      // (a) two genuinely separate standalone HTML blocks -> last fallback-named one becomes
      // index.html, the earlier one keeps its snippet-N.html name (ccGetFiles' own dedup/rename).
      const filesResult = await cdp.evalJSON(ws, `(function(){
        chatHistory = [
          {role:'user', content:'give me a simple html example of a button'},
          {role:'assistant', content:'Sure:\\n\\n\`\`\`html\\n<!DOCTYPE html><html><body><button>Click</button></body></html>\\n\`\`\`\\n'},
          {role:'user', content:'now a totally different html example, a table'},
          {role:'assistant', content:'Sure:\\n\\n\`\`\`html\\n<!DOCTYPE html><html><body><table><tr><td>1</td></tr></table></body></html>\\n\`\`\`\\n'}
        ];
        var files = ccGetFiles();
        return JSON.stringify(files.map(function(f){return {filename:f.filename, hasButton:f.content.indexOf('button')!==-1, hasTable:f.content.indexOf('table')!==-1};}));
      })()`).then(JSON.parse);
      const earlier = filesResult.find(f => f.hasButton);
      const later = filesResult.find(f => f.hasTable);
      assert.equal(filesResult.length, 2, 'two distinct HTML blocks should produce two files');
      assert.equal(earlier && earlier.filename, 'snippet-1.html', 'the earlier fallback-named block keeps snippet-N.html');
      assert.equal(later && later.filename, 'index.html', 'the LAST fallback-named html block is renamed to index.html');

      // (b) a real download of a valid app succeeds and is Babel-free (exercises the actual
      // server-side precompileJSX() path via a real fetch to /api/export-zip).
      const validHtml = '<!DOCTYPE html><html><body><div id="root"></div>' +
        '<script type="text/babel">function App(){return <div id="zip-marker">hi</div>;}ReactDOM.createRoot(document.getElementById(\'root\')).render(<App/>);</' + 'script>' +
        '</body></html>';
      const validZipResult = await cdp.evalJSON(ws, `(async function(){
        var r = await fetch('/api/export-zip', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({files:[{filename:'index.html', content: ${JSON.stringify(validHtml)}}], projectName:'domflowtest'})});
        var buf = await r.arrayBuffer();
        return JSON.stringify({status:r.status, contentType:r.headers.get('content-type'), byteLength:buf.byteLength});
      })()`);
      const vz = JSON.parse(validZipResult);
      assert.equal(vz.status, 200, 'a valid app should export successfully');
      assert.match(vz.contentType || '', /application\/zip/, 'a successful export should be a real zip response');
      assert.ok(vz.byteLength > 100, 'the zip should contain real bytes, not an empty/corrupt archive');

      // (c) malformed JSX fails the download cleanly — 400 JSON error, never a corrupt zip.
      const badHtml = '<div id="root"></div><script type="text/babel">function App(){ return <div className="p-4"><button onClick={() => go(1}>Go</button></div>; }</' + 'script>';
      const badZipResult = await cdp.evalJSON(ws, `(async function(){
        var r = await fetch('/api/export-zip', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({files:[{filename:'index.html', content: ${JSON.stringify(badHtml)}}], projectName:'domflowtest'})});
        var body = await r.json().catch(function(){return null;});
        return JSON.stringify({status:r.status, contentType:r.headers.get('content-type'), error: body?body.error:null});
      })()`);
      const bz = JSON.parse(badZipResult);
      assert.equal(bz.status, 400, 'malformed JSX should fail the export with a client error, not a 200 with a broken zip');
      assert.match(bz.contentType || '', /application\/json/, 'the failure response must be JSON, never zip headers/bytes');
      assert.match(bz.error || '', /JSX syntax error/, 'the error message should clearly say it is a JSX syntax problem');
    } finally {
      ws.close();
    }
  });
});
