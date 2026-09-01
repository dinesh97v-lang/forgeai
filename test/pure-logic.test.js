// Regression tests for App Builder's pure/extractable logic — run with: node --test test/
// Covers public/lib/ab-match-option.js, public/lib/ab-null-streak.js, and
// public/lib/ab-continue-build-guards.js. No server, no browser, no network — fast and
// deterministic. See the "Tier 1" test plan discussed this session for scope/rationale.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _abMatchOption } = require('../public/lib/ab-match-option.js');
const { _abComputeNullStreak, _AB_ESCAPE_THRESHOLD } = require('../public/lib/ab-null-streak.js');
const {
  _AB_BLOCK_TAGS,
  _abDetectTagMismatch,
  _abDetectSplitOpeningTag,
  _abDetectExprMismatch,
} = require('../public/lib/ab-continue-build-guards.js');
const { _ccReplaceMatchingFence, _ccComputeAppliedFix } = require('../public/lib/cc-versions.js');

// ── _abMatchOption ──────────────────────────────────────────────────────────

test('_abMatchOption: exact case-insensitive match', () => {
  assert.equal(_abMatchOption('react', ['React', 'Vue', 'Angular']), 'React');
  assert.equal(_abMatchOption('REACT', ['React', 'Vue', 'Angular']), 'React');
  assert.equal(_abMatchOption('  React  ', ['React', 'Vue', 'Angular']), 'React');
});

test('_abMatchOption: emoji-stripped exact match', () => {
  assert.equal(_abMatchOption('start over', ['🔄 Start over', 'Options-la pick pannen']), '🔄 Start over');
  assert.equal(_abMatchOption('🔄 start over', ['🔄 Start over']), '🔄 Start over');
});

test('_abMatchOption: word-level loose match (Thanglish free text)', () => {
  assert.equal(_abMatchOption('react venum', ['Simple HTML/CSS/JS', 'React']), 'React');
  assert.equal(_abMatchOption('enaku desktop mattum podhum', ['Phone only', 'Desktop only', 'Both']), 'Desktop only');
});

test('_abMatchOption: Tamil-script word matching (requires \\p{M} in the split)', () => {
  // Tamil vowel signs/virama are Unicode Mn/Mc, not \p{L} — without \p{M} in the input-word
  // split, a Tamil word gets shattered into meaningless fragments and this match would fail.
  const options = ['ஃபோன் மட்டும்', 'டெஸ்க்டாப் மட்டும்', 'இரண்டும்'];
  assert.equal(_abMatchOption('எனக்கு டெஸ்க்டாப் மட்டும் வேணும்', options), 'டெஸ்க்டாப் மட்டும்');
});

test('_abMatchOption: no match returns null', () => {
  assert.equal(_abMatchOption('pizza', ['React', 'Vue', 'Angular']), null);
  assert.equal(_abMatchOption('', ['React', 'Vue']), null);
  assert.equal(_abMatchOption('   ', ['React', 'Vue']), null);
});

test('_abMatchOption: short/generic words are not loosely matched (word.length>2 filter)', () => {
  // Options like "Both" split into words of length <=2 get filtered out of loose matching —
  // only exact/emoji-stripped matching should catch these, not the word-level pass.
  assert.equal(_abMatchOption('I want both please', ['Phone only', 'Desktop only', 'Both']), null);
  assert.equal(_abMatchOption('both', ['Phone only', 'Desktop only', 'Both']), 'Both');
});

// ── _abComputeNullStreak ─────────────────────────────────────────────────────

test('_abComputeNullStreak: first miss on a step starts count at 1, no escalation', () => {
  const r = _abComputeNullStreak(null, 0);
  assert.deepEqual(r.nullStreak, { step: 0, count: 1 });
  assert.equal(r.escalate, false);
});

test('_abComputeNullStreak: second consecutive miss on the SAME step escalates', () => {
  const first = _abComputeNullStreak(null, 0);
  const second = _abComputeNullStreak(first.nullStreak, 0);
  assert.deepEqual(second.nullStreak, { step: 0, count: 2 });
  assert.equal(second.escalate, true);
  assert.equal(second.nullStreak.count >= _AB_ESCAPE_THRESHOLD, true);
});

test('_abComputeNullStreak: a step change (real match/advance) resets the streak to 1', () => {
  const first = _abComputeNullStreak(null, 0);
  const second = _abComputeNullStreak(first.nullStreak, 0); // count=2, would escalate
  // The user advanced to a new step (a genuine match) — the next miss is a FRESH streak,
  // not a continuation of the old one, even though the old streak had already hit 2.
  const onNewStep = _abComputeNullStreak(second.nullStreak, 1);
  assert.deepEqual(onNewStep.nullStreak, { step: 1, count: 1 });
  assert.equal(onNewStep.escalate, false);
});

test('_abComputeNullStreak: a successful off-topic-reply still counts (core redesign property)', () => {
  // The whole point of this session's escape-hatch redesign: the caller increments via this
  // function BEFORE attempting an off-topic reply, regardless of whether that reply succeeds —
  // this function itself has no notion of "off-topic-reply," it just counts unresolved turns.
  // Two calls on the same step, with no reset in between, must escalate on the second.
  const afterFirstUnresolvedTurn = _abComputeNullStreak(null, 2);
  const afterSecondUnresolvedTurn = _abComputeNullStreak(afterFirstUnresolvedTurn.nullStreak, 2);
  assert.equal(afterSecondUnresolvedTurn.escalate, true);
});

test('_abComputeNullStreak: does not mutate the input object (pure)', () => {
  const original = { step: 0, count: 1 };
  const originalCopy = { ...original };
  _abComputeNullStreak(original, 0);
  assert.deepEqual(original, originalCopy);
});

// ── _abDetectTagMismatch (tag-mismatch guard) ────────────────────────────────

test('_abDetectTagMismatch: fires on a closing tag with no matching open tag', () => {
  const code = '<div><section>content</div></section>'; // section closes after div, mismatched
  const result = _abDetectTagMismatch(code, _AB_BLOCK_TAGS);
  assert.equal(result, 'found </div> with no matching open tag');
});

test('_abDetectTagMismatch: fires on a bare closing tag with an empty stack', () => {
  const code = 'some text </section> more text';
  const result = _abDetectTagMismatch(code, _AB_BLOCK_TAGS);
  assert.equal(result, 'found </section> with no matching open tag');
});

test('_abDetectTagMismatch: does NOT fire on properly nested/balanced tags', () => {
  const code = '<div><section><header>Title</header><p>Body</p></section></div>';
  assert.equal(_abDetectTagMismatch(code, _AB_BLOCK_TAGS), null);
});

test('_abDetectTagMismatch: a tag still open at the end is NOT flagged (deliberately noisy signal avoided)', () => {
  const code = '<div><section>unfinished content here';
  assert.equal(_abDetectTagMismatch(code, _AB_BLOCK_TAGS), null);
});

test('_abDetectTagMismatch: self-closing whitelisted tags are ignored entirely', () => {
  // A self-closed whitelisted tag mid-stream must not affect the stack.
  const code = '<div><form /></div>';
  assert.equal(_abDetectTagMismatch(code, _AB_BLOCK_TAGS), null);
});

// ── _abDetectSplitOpeningTag (split-opening-tag guard) ───────────────────────

test('_abDetectSplitOpeningTag: fires on the exact reported case — bare "<" then tag name+attrs', () => {
  const infoCode = 'return (\n    <';
  const verdictCode = 'div ref={inputRef} />\n  );';
  const result = _abDetectSplitOpeningTag(infoCode, verdictCode, _AB_BLOCK_TAGS);
  assert.ok(result, 'expected a flagged reconstruction');
  assert.match(result, /^div /);
});

test('_abDetectSplitOpeningTag: fires on a mid-tag-name split', () => {
  const infoCode = 'return (\n    <di';
  const verdictCode = 'v ref={inputRef} />\n  );';
  assert.ok(_abDetectSplitOpeningTag(infoCode, verdictCode, _AB_BLOCK_TAGS));
});

test('_abDetectSplitOpeningTag: fires on a split closing tag too', () => {
  const infoCode = '  </di';
  const verdictCode = 'v>\n  );';
  assert.ok(_abDetectSplitOpeningTag(infoCode, verdictCode, _AB_BLOCK_TAGS));
});

test('_abDetectSplitOpeningTag: false positive avoidance — bare "<" as a less-than operator', () => {
  assert.equal(_abDetectSplitOpeningTag('if (count ', '< 10) { doSomething(); }', _AB_BLOCK_TAGS), null);
});

test('_abDetectSplitOpeningTag: false positive avoidance — comparison split across a newline', () => {
  assert.equal(_abDetectSplitOpeningTag('if (count <', '\n  someVar) { doSomething(); }', _AB_BLOCK_TAGS), null);
});

test('_abDetectSplitOpeningTag: false positive avoidance — identifier merely starting with a tag name', () => {
  // \b after the whitelisted tag name requires a non-word char next; "Length" continues with a
  // word char, so no boundary — must not be flagged.
  assert.equal(_abDetectSplitOpeningTag('if (x <', 'sectionLength) { }', _AB_BLOCK_TAGS), null);
});

test('_abDetectSplitOpeningTag: no dangling tag at an ordinary code boundary', () => {
  assert.equal(_abDetectSplitOpeningTag('const x = 5;\n', 'const y = 10;\n', _AB_BLOCK_TAGS), null);
});

test('_abDetectSplitOpeningTag: a partial name that does not match any whitelisted tag is not flagged', () => {
  assert.equal(_abDetectSplitOpeningTag('return (\n    <dis', 'card ref={x} />\n  );', _AB_BLOCK_TAGS), null);
});

// ── _abDetectExprMismatch (js-expression-mismatch guard) ─────────────────────

test('_abDetectExprMismatch: fires on a bare closing paren right after ={', () => {
  // e.g. "e => setSearch(e.target.value" was lost at the stitch seam, leaving the bare ")"
  // immediately after "={" instead of a real expression.
  const code = 'onChange={)}';
  const result = _abDetectExprMismatch(code);
  assert.equal(result, 'found bare closing delimiter ")" immediately after ={');
});

test('_abDetectExprMismatch: fires on a bare closing brace right after ={', () => {
  const code = 'onClick={}';
  assert.equal(_abDetectExprMismatch(code), 'found bare closing delimiter "}" immediately after ={');
});

test('_abDetectExprMismatch: does NOT fire on a genuine expression', () => {
  const code = 'onChange={e => setSearch(e.target.value)}';
  assert.equal(_abDetectExprMismatch(code), null);
});

test('_abDetectExprMismatch: does NOT fire when no ={ appears at all', () => {
  assert.equal(_abDetectExprMismatch('const x = 5; console.log(x);'), null);
});

test('_abDetectExprMismatch: whitespace between ={ and content is tolerated', () => {
  const code = 'style={   { color: "red" }}';
  assert.equal(_abDetectExprMismatch(code), null);
});

// ── _ccReplaceMatchingFence ──────────────────────────────────────────────────

test('_ccReplaceMatchingFence: replaces the matching fenced block, preserving the language tag', () => {
  const text = 'Here is your app:\n```html\nold code\n```\nEnjoy!';
  const out = _ccReplaceMatchingFence(text, 'old code', 'new code');
  assert.equal(out, 'Here is your app:\n```html\nnew code\n```\nEnjoy!');
});

test('_ccReplaceMatchingFence: matches by trimmed content, tolerant of surrounding whitespace', () => {
  const text = '```js\n  console.log(1);  \n```';
  const out = _ccReplaceMatchingFence(text, 'console.log(1);', 'console.log(2);');
  assert.equal(out, '```js\nconsole.log(2);\n```');
});

test('_ccReplaceMatchingFence: only replaces the ONE block matching, leaves other blocks in the same message untouched', () => {
  const text = '```js\nfile a\n```\nsome prose\n```js\nfile b\n```';
  const out = _ccReplaceMatchingFence(text, 'file b', 'file b fixed');
  assert.equal(out, '```js\nfile a\n```\nsome prose\n```js\nfile b fixed\n```');
});

test('_ccReplaceMatchingFence: returns null when no fence matches the given old content', () => {
  const text = '```html\nsome other code\n```';
  assert.equal(_ccReplaceMatchingFence(text, 'code that is not here', 'new code'), null);
});

test('_ccReplaceMatchingFence: returns null on empty/falsy oldCode rather than matching an empty fence', () => {
  assert.equal(_ccReplaceMatchingFence('```html\n\n```', '', 'new code'), null);
  assert.equal(_ccReplaceMatchingFence('```html\ncode\n```', null, 'new code'), null);
});

// ── _ccComputeAppliedFix ─────────────────────────────────────────────────────

test('_ccComputeAppliedFix: applies a matching fix, pushes the prior content as a new version', () => {
  const content = 'Your app:\n```html\nbuggy\n```';
  const pre = [{ filename: 'index.html', content: 'buggy' }];
  const post = [{ filename: 'index.html', content: 'fixed' }];
  const result = _ccComputeAppliedFix(content, pre, post, [], 4, 1000);
  assert.equal(result.changed, true);
  assert.equal(result.newContent, 'Your app:\n```html\nfixed\n```');
  assert.deepEqual(result.newVersions, [{ content: 'Your app:\n```html\nbuggy\n```', ts: 1000 }]);
});

test('_ccComputeAppliedFix: no-op (changed:false) when the fix result is identical to the input', () => {
  const content = '```html\nsame\n```';
  const pre = [{ filename: 'index.html', content: 'same' }];
  const post = [{ filename: 'index.html', content: 'same' }];
  const result = _ccComputeAppliedFix(content, pre, post, [], 4, 1000);
  assert.equal(result.changed, false);
  assert.equal(result.newContent, content);
});

test('_ccComputeAppliedFix: no-op when the pre-fix content is not found in this message at all (file came from elsewhere)', () => {
  const content = '```html\nunrelated content\n```';
  const pre = [{ filename: 'index.html', content: 'content from a different message' }];
  const post = [{ filename: 'index.html', content: 'fixed elsewhere' }];
  const result = _ccComputeAppliedFix(content, pre, post, [], 4, 1000);
  assert.equal(result.changed, false);
  assert.equal(result.newContent, content);
});

test('_ccComputeAppliedFix: appends to existing version history rather than replacing it', () => {
  const content = '```html\nv3\n```';
  const pre = [{ filename: 'index.html', content: 'v3' }];
  const post = [{ filename: 'index.html', content: 'v4' }];
  const existing = [{ content: 'v1 msg', ts: 100 }, { content: 'v2 msg', ts: 200 }];
  const result = _ccComputeAppliedFix(content, pre, post, existing, 4, 300);
  assert.equal(result.changed, true);
  assert.deepEqual(result.newVersions, [
    { content: 'v1 msg', ts: 100 },
    { content: 'v2 msg', ts: 200 },
    { content: '```html\nv3\n```', ts: 300 },
  ]);
});

test('_ccComputeAppliedFix: caps version history at maxVersions, dropping the oldest first', () => {
  const content = '```html\nv5\n```';
  const pre = [{ filename: 'index.html', content: 'v5' }];
  const post = [{ filename: 'index.html', content: 'v6' }];
  const existing = [
    { content: 'v1', ts: 1 },
    { content: 'v2', ts: 2 },
    { content: 'v3', ts: 3 },
    { content: 'v4', ts: 4 },
  ];
  const result = _ccComputeAppliedFix(content, pre, post, existing, 4, 5);
  assert.equal(result.newVersions.length, 4);
  // oldest (v1) dropped, v2/v3/v4 kept, new snapshot appended last
  assert.deepEqual(result.newVersions.map(v => v.content), ['v2', 'v3', 'v4', '```html\nv5\n```']);
});

test('_ccComputeAppliedFix: only writes back files that actually match in THIS message, ignoring unrelated fixed files', () => {
  const content = '```html\nmy file\n```';
  const pre = [
    { filename: 'index.html', content: 'my file' },
    { filename: 'other.js', content: 'not in this message' },
  ];
  const post = [
    { filename: 'index.html', content: 'my file fixed' },
    { filename: 'other.js', content: 'other file fixed' },
  ];
  const result = _ccComputeAppliedFix(content, pre, post, [], 4, 1000);
  assert.equal(result.changed, true);
  assert.equal(result.newContent, '```html\nmy file fixed\n```');
});
