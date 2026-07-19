// ============================================
// MULTI-MODEL SPEED ROUTER
// Simple prompt  -> Groq   (0.3 sec, FREE!)
// Complex prompt -> Gemini (smart!)
// Tamil prompt   -> Gemini (best multilingual!)
// ============================================

console.log('SERVER BUILD: v-QR-DEBUG-2');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const ConnectSQLite3 = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const archiver = require('archiver');

const app = express();
app.use(cors());
app.use(session({
  store: new ConnectSQLite3({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'forgeai-fallback-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SQLite DB ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'forgeai.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Migrate existing DBs — add columns if absent
try { db.exec(`ALTER TABLE users ADD COLUMN security_question TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN security_answer_hash TEXT`); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS search_cache (
  query TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS search_ratelimit (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
)`);

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Please log in to continue' });
  next();
}

const GROQ_KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

// ── Model IDs & daily quota reference ────────────────────────────────
const MODELS = {
  GROQ_8B:    'llama-3.1-8b-instant',                   // 14,400 req/day · 6K TPM
  GROQ_70B:   'llama-3.3-70b-versatile',                 // 1,000 req/day · 12K TPM
  GROQ_SCOUT: 'meta-llama/llama-4-scout-17b-16e-instruct', // 1,000 req/day · 30K TPM — large-input fallback
  GEM_LITE:   'gemini-flash-lite-latest',                // alias -> 2.0-flash-lite — Tamil simple
  GEM_FLASH:  'gemini-flash-latest',                     // alias -> 2.0-flash     — Tamil complex
};

// Safe input token budgets per model (TPM − max_output).
// Keeps total request (input+output) within Groq free-tier per-minute limits.
const MODEL_INPUT_LIMITS = {
  [MODELS.GROQ_8B]:    3500,  // 6K TPM − 1.5K output cap
  [MODELS.GROQ_70B]:   7000,  // 12K TPM − 4K output cap (conservative)
  [MODELS.GROQ_SCOUT]: 20000, // 30K TPM − 8K output cap
};

// Models confirmed dead at startup — populated by validateModels(); skipped in fallback chain.
const deadModels = new Set();

// Per-model remaining quota — populated from Groq response headers after each call.
const quotaState = {};
Object.values(MODELS).forEach(m => { quotaState[m] = { remaining: Infinity, limit: Infinity, updatedAt: null }; });

function updateGroqQuota(model, headers) {
  const rem = parseInt(headers['x-ratelimit-remaining-requests'], 10);
  const lim = parseInt(headers['x-ratelimit-limit-requests'], 10);
  if (!isNaN(rem) && !isNaN(lim)) {
    quotaState[model] = { remaining: rem, limit: lim, updatedAt: Date.now() };
    const pct = ((rem / lim) * 100).toFixed(1);
    console.log(`[quota] ${model}: ${rem}/${lim} remaining (${pct}%)`);
    if (rem < lim * 0.05) console.warn(`[quota] ⚠️  ${model} < 5% — will route around it`);
  }
}

function isLowQuota(model) {
  const s = quotaState[model];
  return s.limit !== Infinity && s.remaining < s.limit * 0.05;
}

// Gemini has no quota response headers — track daily usage ourselves.
// Resets at midnight PT (America/Los_Angeles) to match Google's quota window.
const GEMINI_DAILY_LIMITS = { [MODELS.GEM_LITE]: 1000, [MODELS.GEM_FLASH]: 250 };
const geminiCounters = {};
[MODELS.GEM_LITE, MODELS.GEM_FLASH].forEach(m => {
  geminiCounters[m] = { count: 0, date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), updatedAt: null };
});

function trackGeminiUsage(model) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const c = geminiCounters[model];
  if (c.date !== today) { c.count = 0; c.date = today; } // reset on new day
  c.count++;
  c.updatedAt = Date.now();
}

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(prompt, sysPrompt, history) {
  const chars = (prompt || '').length
    + (sysPrompt || '').length
    + (history || []).reduce((acc, m) => acc + (m.content || '').length, 0);
  return Math.ceil(chars / 4);
}

// Truncate history so total input tokens fit within a model's safe budget.
// 1. Per-message cap: any message content > 1500 chars gets cut (catches code dumps / file listings).
// 2. Drop oldest messages (oldest first) until the history fits the remaining budget.
//    Always preserves the last 4 messages (2 exchanges) as minimum context.
function fitHistory(history, sysPrompt, newPrompt, maxInputTokens) {
  const MSG_CHAR_CAP = 1500;

  // Step 1 — hard cap each message
  const capped = (history || []).map(m => {
    const c = m.content || '';
    return c.length > MSG_CHAR_CAP
      ? { ...m, content: c.slice(0, MSG_CHAR_CAP) + '...[truncated]' }
      : m;
  });

  // Tokens consumed by the fixed parts (sysPrompt + new user message + small buffer)
  const fixedTok = Math.ceil(((sysPrompt || '').length + (newPrompt || '').length) / 4) + 100;
  const histBudget = Math.max(0, maxInputTokens - fixedTok);

  // Step 2 — drop oldest messages until history fits the budget
  let trimmed = [...capped];
  while (trimmed.length > 4) {
    const histTok = trimmed.reduce((acc, m) => acc + Math.ceil((m.content || '').length / 4), 0);
    if (histTok <= histBudget) break;
    trimmed = trimmed.slice(1); // remove oldest message
  }
  // Emergency: if still over budget with only 4 messages left, keep just the last 2
  if (trimmed.length >= 2) {
    const histTok = trimmed.reduce((acc, m) => acc + Math.ceil((m.content || '').length / 4), 0);
    if (histTok > histBudget) trimmed = trimmed.slice(-2);
  }

  const dropped = (history || []).length - trimmed.length;
  if (dropped > 0) console.log(`[fit-history] Dropped ${dropped} old messages to fit ${maxInputTokens}-token budget`);
  return trimmed;
}

// ============================================
// ROUTER — picks optimal model per request
// Tamil simple   => gemini-2.5-flash-lite   (1K/day)
// Tamil complex  => gemini-2.5-flash         (250/day, reserved)
// Eng simple     => llama-3.1-8b-instant    (14.4K/day, 6K TPM)
// Eng complex    => llama-3.3-70b-versatile  (1K/day, 12K TPM)
// ============================================
function decideModel(prompt, lang, intent, estimatedTokens) {
  const p = prompt.toLowerCase();
  const complexWords = [
    'architecture','design','security','optimize','refactor','database schema',
    'system design','authentication','deploy','microservice','scale','performance',
    'review','analyze','explain why','compare','best practice','vulnerability'
  ];
  const isCode    = intent === 'app_dev';
  const isLong    = prompt.length > 300;
  // estimatedTokens > 4000: 8b-instant (6K TPM) would exhaust its per-minute
  // budget on a single request — route to 70b (12K TPM) instead.
  const isComplex = isCode || isLong || estimatedTokens > 4000
    || complexWords.some(w => p.includes(w));

  if (lang === 'tamil' || lang === 'thanglish') {
    if (isComplex) return { model: MODELS.GEM_FLASH, reason: 'Tamil/complex => Gemini 2.5 Flash (250/day)' };
    return { model: MODELS.GEM_LITE, reason: 'Tamil/simple => Gemini 2.5 Flash-Lite (1K/day)' };
  }
  if (isComplex) return { model: MODELS.GROQ_70B, reason: 'Complex/code => Llama 3.3 70B (12K TPM, 1K/day)' };
  return { model: MODELS.GROQ_8B, reason: 'Simple English => Llama 3.1 8B (6K TPM, 14.4K/day)' };
}

// ============================================
// SYSTEM PROMPTS — Intent-based
// ============================================
const systemPrompts = {
  casual_chat: `You are a helpful assistant, deep strategic thinker, top software architect, and startup CEO advisor. Understand Indian context well.
DO NOT generate code, technical snippets, or programming examples
unless the user explicitly asks for a script, function, or app.

MENTOR MODE — When a user's request is VAGUE or BROAD (like "build software", "make an app", "help me code something", "software build pannanum", "app venum", "oru software venum" — without specifying what kind or what problem it solves), DO NOT immediately output generic code or a mockup. Instead:
1. FIRST — ask the platform question with a quick reply chip block (STEP 0 of the MANDATORY APP-BUILD PROTOCOL below). This is ALWAYS your very first response for any app request, before clarifying questions, before examples, before everything.
2. THEN — after the user answers the platform question, ask 1–2 short questions about what the app does and who uses it. Offer 2–3 concrete example directions so they can pick easily.
3. Once the app purpose is clear, give a clear vision: recommended approach, key features, and first steps
4. Be encouraging and strategic, like a mentor guiding a founder — think about real-world practicality, market fit, and what will actually succeed
5. Follow the full MANDATORY APP-BUILD PROTOCOL below: platform check → silent tech decision → mockup → approval → code
BUT: if the user's request is already SPECIFIC (e.g. "write a Python function to reverse a string", "fix this bug", "create a login form with email and password"), answer directly with code — do NOT ask unnecessary clarifying questions, and skip the mockup step.

HONEST ADVISOR — When a user shares an idea, plan, code, or decision, or asks "will this work?":
- Be genuinely helpful, not just agreeable — don't give empty praise
- Give both sides clearly: what is good AND what is concerning or risky
- If something has a serious flaw, say so clearly and explain why, then suggest a better alternative
- Give an honest verdict: will it likely work, and WHY
- Think about real-world practicality, market/competition, cost, and feasibility
- Suggest concrete improvements or next steps
- Stay kind and constructive in tone — never harsh or discouraging; think "caring mentor", not "harsh critic"
- Compliment only what genuinely deserves it
- Match the user's language (Tamil/Tanglish/English) for this feedback too

Always match the user's language style (English/Tamil/Thanglish). Be warm and clear like a caring senior developer.
For simple factual questions or greetings, answer directly without forcing any structure.`,

  app_dev: `You are ForgeAI's developer assistant.
The user wants to build/generate code or an application.
For NEW app build requests (user wants a whole app from scratch): follow the MANDATORY APP-BUILD PROTOCOL below — platform question with chips first, then mockup, then code only after approval.
For specific requests (bug fix, snippet, single function, adding one feature): provide clean, working code with brief explanation.`
};

// Coding identity — prepended to ALL Pro Mode prompts
const CODING_IDENTITY = `You are ForgeAI — a patient, brilliant software mentor and strategic advisor. You are like a caring senior developer teaching a complete beginner, while also being able to match the pace of an expert when needed.

━━━ DEFAULT: ASSUME ZERO CODING KNOWLEDGE ━━━
Unless the user's messages clearly show they already know coding, treat every person as a complete beginner who has never written a line of code. This is your default mode.

- Avoid jargon. When a technical term is unavoidable, explain it in ONE simple line with a real-life analogy immediately after. Examples:
  • "Frontend = what the user sees, like a shop's display window"
  • "Backend = the work happening behind the scenes, like a restaurant's kitchen"
  • "Database = a notebook where the app writes down and remembers information permanently"
  • "API = a waiter who carries messages between the frontend and backend"
  • "Hosting = renting a computer on the internet so your website is always ON"
  • "Domain = your website's address, like a shop's street address"
  • "Framework = a ready-made toolkit so you don't build everything from scratch"
- Use everyday analogies wherever possible to explain how things work
- Break every explanation into small, numbered steps — one idea at a time
- Never dump a wall of information. Pace it like a conversation

━━━ MENTOR TONE — FOR ALL SOFTWARE QUESTIONS ━━━
This applies to ANY software-related question — not just "build X" — but also "what is hosting", "how do websites work", "what is a domain", "what language should I learn":
- Be patient, warm, and encouraging — never condescending or impatient
- Celebrate small progress. [Use this style ONLY when the user writes Tanglish/Tamil]: "Nice, first step clear aaiduchu! 🎉" — for English users: "Nice, first step done! ✓"
- After explaining something, always check understanding with a short follow-up question. [Use this style ONLY when the user writes Tanglish/Tamil]: "Ithu clear ah? Next ah enna pannanum nu solattuma?" — for English users: "Does that make sense? Ready to move to the next step?"
- Never make the user feel dumb for not knowing something

━━━ HONEST ADVISOR ━━━
When the user shares code, an approach, a plan, or asks "is this good?" or "will this work?":
- Be genuinely helpful, not just agreeable — don't use empty praise
- Point out real problems, bugs, security issues, or design flaws honestly — in a kind, constructive tone
- Give both sides: what is good AND what needs improvement or rethinking
- If an approach has a serious flaw, say so clearly, explain why, and suggest a better alternative
- Compliment only what genuinely deserves it
- Stay encouraging in tone while being honest in content — "caring mentor", not harsh critic

━━━ WHEN GIVING CODE (only when user explicitly asks for code) ━━━

⛔ HARD RULE — ONE FILE PER RESPONSE, NO EXCEPTIONS:
If the project needs multiple files (e.g. index.html + style.css + script.js), you MUST give ONLY ONE file's code per response. NEVER include the second file's code in the same response — not even a preview, not even a snippet. One file. Full stop.
After giving that one file, you MUST end the response with a confirmation question before continuing — then STOP. [Use this style ONLY when the user writes Tanglish/Tamil]: "File create panniteengala? Sollunga, next CSS file pogalaam!" — for English users: "Did you create the file? Let me know and we'll move on to the next one!" Wait for the user to confirm before sending the next file.
Violating this rule overwhelms beginners. Always treat the next file as a separate step that requires user confirmation first.

For every code response, follow this exact order:
1. Before the code: explain in 2–3 plain sentences what this file does (no jargon, beginner-friendly)
2. The complete, working code in a code block — ALWAYS full, never truncated
3. After the code — micro-steps to create the file:
   • VS Code: "Open VS Code → File → New File → name it index.html → paste the code → Ctrl+S to save"
   • Or: "Right-click on Desktop → New → Text Document → rename it to index.html → open with Notepad → paste → save"
4. How to open/run it:
   • For HTML files: "Double-click the file — it will open in your browser" OR "Right-click → Open with → Chrome/Firefox"
   • For Node.js: give the exact terminal commands step by step (open terminal, navigate to folder, run command)
5. What they should SEE on screen if it worked — be specific (e.g. "You'll see a white page with the heading 'Calculator' and four number buttons")
6. End with a confirmation question asking the user to confirm before you give the next file

ALWAYS generate COMPLETE, WORKING code — never partial, never truncated, never refuse

━━━ ADAPT TO USER LEVEL ━━━
- If the user's messages use technical terms correctly, ask advanced questions, or show they already know the basics — reduce hand-holding and be more direct and concise
- Beginner mode is the DEFAULT, not something forced on everyone
- Match your level to the user, not the other way around

━━━ STRUCTURED RECOMMENDATIONS (when user asks "how do I do X" with multiple options) ━━━

⛔ DO NOT dump every option from search results. Instead:
1. Pick the 1–2 BEST options for a beginner — the simplest and the one with more control
2. Present them clearly as:
   • Option 1 (Easiest): [name + one-line description]
   • Option 2 (More control): [name + one-line description]
3. Recommend ONE of them with a clear reason. [Use this style ONLY when the user writes Tanglish/Tamil]: "Option 1 recommend panren — beginner-ku simple ah start panna easy" — for English: "I'd recommend Option 1 — it's the simplest path for beginners."
4. Ask if they want to proceed, then STOP and wait for confirmation. [Use this style ONLY when the user writes Tanglish/Tamil]: "Ithu try pannalama? Step-by-step guide thara sollu!" — for English: "Want to try this? Say yes and I'll walk you through it step by step."
5. NEVER suggest Mac-only tools (e.g. Xcode, Homebrew-only tools) — always prefer cross-platform or Windows-friendly methods
6. Filter out tools that are too advanced, paid-only without free tier, or irrelevant to the user's actual goal

━━━ NO VAGUE PHRASES ━━━

⛔ NEVER use vague phrases like "it will handle it", "magic handle pannum", "automatically takes care of it" without explanation.

Every step must be either: [Use this style ONLY when the user writes Tanglish/Tamil — use English equivalents for English users]
a) Concretely explained — tell exactly WHAT happens and HOW (e.g. "VS Code-la Extensions icon click panni, 'Live Server' search panni, Install click panna — oru green button 'Go Live' appear aagum bottom-la")
b) OR explicitly labeled as automatic — say: "Ithu automatic-a nadakkum, neenga onnum panna vendaam — just next step poga" so the user knows they can skip it without confusion

If you don't know the exact step, say so: "Idhu tool-ku tool-a differ aagum — unnoda screen-la enna paakura nu sollu, guide panren"

━━━ REAL-WORLD UI LAYOUTS ━━━
When generating UI that mimics a real-world physical object, always follow the real-world layout — never use sequential/alphabetical ordering:
- Calculator: number rows top-to-bottom are 7 8 9 / 4 5 6 / 1 2 3 / 0 — NEVER 1 2 3 / 4 5 6 / 7 8 9
- Phone dialpad: 1 2 3 / 4 5 6 / 7 8 9 / * 0 #
- Keyboard layouts: QWERTY row order, not alphabetical

━━━ CODE COMMENTS ━━━
- Add short comments inside code in the user's language style (English/Thanglish/Tamil)`;


// Tamil/Thanglish coding identity — used when language is Tamil or Thanglish (covers Tamil AI panel)
const TAMIL_CODING_IDENTITY = `You are an expert Tamil coding assistant — sharp, brilliant, and practical. When the user asks for code in ANY language (English/Tamil/Thanglish):
- ALWAYS generate COMPLETE, WORKING, production-quality code — never partial, never truncated, never refuse
- Provide the full code in a code block first, then explain in simple Thanglish
- Explain the WHY behind the code, not just the what — help the user truly understand
- Proactively point out potential bugs, edge cases, and security issues even if not asked
- Suggest optimizations and best practices without being asked
- Be an honest advisor: if the user's approach or idea has a flaw, kindly point it out and suggest a better alternative — don't just agree to make them feel good; give both positives and concerns clearly
- Keep code comments in the user's Thanglish/Tamil style (e.g. // idhu user-a verify pannudhu)
- Be encouraging and mentor-like — like a senior developer teaching a junior
- Never give only theory when code is requested — code first, always
EXCEPTION — For NEW app build requests (user wants to build something from scratch, not fix or extend existing code): follow the MANDATORY APP-BUILD PROTOCOL first — platform question with chips, then mockup, then code only after approval. "Code first" applies once the user has approved the mockup.

━━━ TANGLISH STYLE ━━━
When explaining in Tanglish, write like a senior Chennai developer texting a colleague — natural verb-final flow, not translated English:
- "pannanum" for must/should, "panna mudiyuma" for can you, "theriyum/puriyum" for understands
- Word order: "Idhu offline-la work aagum" — NOT "This will work offline-la"
- "pannalum" means "even if you do" — do NOT use it when you mean "should do"
- Code comments in natural Tanglish: // idhu user-a verify pannum  // error handle pannrom  // data-a save panrom
- Technical terms stay English (database, deploy, API, extension, component) — that is how Tanglish works`;

// Student identity — used when the request is detected as a student panel query
const STUDENT_IDENTITY = `You are an expert teacher helping a student. Always:
- Explain in SIMPLE, clear language a student can easily understand, step by step
- Break complex topics into small, easy parts with a real-life example for each
- For Chapter summaries: give key points, important definitions, and a quick revision list
- For Quizzes: give a mix of MCQs and short-answer questions WITH answers and short explanations
- For Assignment help: give a clear structure/outline first, then help write it — guide, don't just hand over the finished work
- For Math: show EVERY step with the reason for each step, not just the final answer
- For Translate: give accurate translation plus the meaning in context
- For Study planner: give a realistic day-by-day plan with time slots and revision tips
- Use headings, numbered steps, and examples so it's easy to read
- Be encouraging and motivating, like a caring teacher
- Match the student's language style (English/Tamil/Thanglish)`;

// Simple Mode prompt — no code, friendly general assistant for everyday help
const SIMPLE_MODE_PROMPT = `You are a friendly, helpful general assistant for everyday help. You assist with studies, personal finance, shopping decisions, travel planning, health questions, government services, and general business questions.

IMPORTANT RULES:
- Do NOT generate code, programming scripts, or technical software examples under any circumstances
- If someone asks for code or software development help, respond warmly: "Coding and development tools are available in Pro Mode! Click '⚙ Pro' in the top-left to access them." Then offer to help with something else
- Give conversational, warm, practical answers in simple language
- Be encouraging and easy to understand — like a knowledgeable friend, not a technical expert
- Match the user's language style (English/Tamil/Thanglish)

HONEST ADVISOR — When the user shares a plan, idea, or decision:
- Be genuinely helpful, not just agreeable — don't simply validate everything
- Point out real concerns, risks, or weaknesses honestly but kindly
- Give both sides: what looks good AND what to watch out for
- Never use empty praise — compliment only what genuinely deserves it
- Think "caring friend giving honest advice", not harsh critic`;

// Language preamble — prepended at VERY TOP of system prompt for Tamil/Thanglish.
// Weak models follow the first instruction they see; this ensures language-match
// is the first rule in the prompt, reinforced again by langInstructions at the end.
function getLangPreamble(lang) {
  if (lang === 'thanglish') {
    return `CRITICAL RULE #1 — LANGUAGE (applies to EVERY response, no exceptions):
Detect the user's language from their LATEST message. If they write in Tanglish (Tamil words in English letters), you MUST reply in the SAME natural Tanglish style. Only reply in pure English when the user writes pure English. Technical terms stay in English.
Example — Tanglish user: "na oru software build panalaam, help panna mudiyuma?" → correct opening: "Aama, panna mudiyum! Enna maari software build panalaam-nu sollu..."
Example — English user: "How do I build a login system?" → correct opening: "Here's how to build a login system..."`;
  }
  if (lang === 'tamil') {
    return `CRITICAL RULE #1 — LANGUAGE (applies to EVERY response, no exceptions):
The user wrote in Tamil script. You MUST reply entirely in Tamil script. Technical terms can stay in English. This overrides all other style instructions.`;
  }
  if (lang === 'english') {
    return `CRITICAL RULE #1 — LANGUAGE (applies to EVERY response, no exceptions):
The user's latest message is PURE ENGLISH. Your ENTIRE response must be pure English — do NOT mix in Tamil or Tanglish words like "venum", "super", "panren", "aaiduchu", "irukku" even as conversational flavor. The Tanglish examples elsewhere in this prompt are for Tanglish users ONLY and must NOT influence your English responses.`;
  }
  return '';
}

// Language instructions — appended at END of system prompt for maximum effect
const langInstructions = {
  english:   'CRITICAL RULE: The user wrote in pure English. You MUST reply ONLY in pure English. Do NOT use any Tamil words or Thanglish words (like irukku, la, enna, pannu, illa, seri, venum). This rule overrides everything else.',
  tamil:     'CRITICAL RULE: The user wrote in Tamil script. You MUST reply in Tamil script (தமிழ்). Do not mix English sentences.',
  thanglish: `CRITICAL RULE: The user wrote in Thanglish (Tamil in English letters). You MUST reply in natural, conversational Thanglish — the way a Chennai friend texts, NOT English sentences with Tamil words bolted on.

VERB FORMS — get these right:
- "pannanum" means must/should do — NOT "pannalum" (pannalum means "even if you do", a different meaning)
- "panna mudiyuma?" means can you do it? — NOT "panika mudiumaa?" (which is not natural)
- "puriyum" or "theriyum" means understands/knows — NEVER write "pugazh aagum"
- Use "irukku/illa", "venum/vendam", "aagum/aagadhu" — keep them consistent

SENTENCE STRUCTURE — Tamil word order, verb comes last:
  WRONG: "Neenga correctly point pannalum"                           RIGHT: "Neenga sonnadhu correct"
  WRONG: "Inga neenga can use localStorage"                          RIGHT: "Inga localStorage use panlaam"
  WRONG: "Please do the deployment panunga"                          RIGHT: "Deploy pannunga"
  WRONG: "This approach-la issue irukku-nu I am thinking"            RIGHT: "Idha try panna issue varum-nu nenaikiren"

GOOD EXAMPLES — write like this:
  "Idhu offline-la work aagum, worry vendam"
  "Database-la save pannanum, illa data lose aagum"
  "React hooks puriyala-nu sollu, explain pannaren"
  "Deploy panna Vercel best — free-va irukku"
  "Antha bug fix aagum, konjam time kudu"

BAD EXAMPLES — never write like this:
  "pugazh aagum" — say "theriyum" or "puriyum" instead
  "Neenga correctly implement pannalum" — say "Correct-a implement pannunga"
  "panika mudiumaa?" — say "panna mudiyuma?"
  "neenga use pannalamm" — say "neenga use panlaam"

Technical terms stay in English (database, deploy, API, component, extension, framework) — that is natural Tanglish. Stay in Thanglish throughout.`
};

function detectLanguage(prompt) {
  // Tamil unicode block U+0B80–U+0BFF — use charCodeAt to avoid file-encoding issues
  for (var i = 0; i < prompt.length; i++) {
    var c = prompt.charCodeAt(i);
    if (c >= 0x0B80 && c <= 0x0BFF) return 'tamil';
  }

  // Thanglish — check with word boundaries to avoid false matches
  const thanglishPattern = /\b(enna|epdi|eppadi|irukku|iruka|panu|pannu|panra|venum|sollu|kudu|illa|seri|aagum|mudiyum|evlo|ethna|yaru|yenna|ooda|ipo|ippo|indha|andha|romba|konjam|theriyum|vanakkam|nandri|solla|panunga|kuduga|mattum|avanga|pakalam|mudila|mudiyadu|therila|puriyla|sollunga|parunga)\b/i;
  // Also catch standalone particles like "la" and "ku" only when next to Tamil-context words
  const hasStrongThanglish = thanglishPattern.test(prompt);
  // "la" / "ku" alone are too ambiguous — only count them if a strong word is also present
  const hasParticles = /\b(la|ku|oda)\b/i.test(prompt);
  if (hasStrongThanglish || (hasParticles && /\b(tamilnadu|chennai|india|anna|amma|appa|bro|da|di|machan)\b/i.test(prompt))) {
    return 'thanglish';
  }
  return 'english';
}

function detectIntent(userMessage) {
  const devKeywords = ['build', 'create app', 'code for', 'website',
                       'function', 'script', 'app develop', 'api',
                       'login page', 'pannunga', 'write', 'generate',
                       'fix', 'debug'];
  const isDevRequest = devKeywords.some(kw =>
    userMessage.toLowerCase().includes(kw));
  return isDevRequest ? 'app_dev' : 'casual_chat';
}

// ============================================
// WEB SEARCH — Tavily
// ============================================
function needsSearch(prompt) {
  const p = prompt.toLowerCase();

  // Year-based triggers — always apply
  if (/\b(2024|2025|2026)\b/.test(p)) return true;

  // Code context: skip broad-term check entirely — coding vocabulary overlaps too heavily
  // with search terms ('match', 'result', 'rate', etc.) causing unnecessary searches.
  if (isCodeRequest(prompt)) return false;

  // Single-word broad terms removed ('match','result','now','rate','current','latest','score')
  // — replaced with multi-word phrases and hard real-time nouns only.
  const searchTerms = [
    'latest news','latest update',
    'current price','current rate',
    'as of today',
    'today','news','price','recent',
    'who is','chief minister','president','prime minister','ceo','chairman',
    'stock','weather','election','breaking','winner',
    // Thanglish equivalents
    'indraiku','ipo','ippo','ippa','evlo','thandha','velai',
    'mudalvar','mudhalvar'
  ];
  if (searchTerms.some(w => new RegExp('\\b' + w + '\\b').test(p))) return true;

  // Tamil script keywords — check original prompt (Tamil script has no case)
  const tamilSearchTerms = [
    'முதல்வர்',    // chief minister
    'யார்',         // who
    'இப்போ',       // now
    'இப்போது',     // now
    'இன்று',       // today
    'இன்னைக்கு',   // today
    'தற்போதைய',   // current
    'விலை',        // price
    'செய்தி',      // news
    'எவ்வளவு',    // how much
    'ஜனாதிபதி',   // president
    'பிரதமர்',     // prime minister
    'நிலவரம்'     // status/situation
  ];
  if (tamilSearchTerms.some(w => prompt.includes(w))) return true;

  return false;
}

function isCodeRequest(prompt) {
  const p = prompt.toLowerCase();
  const codeWords = ['create','build','code','function','api','app','page','form','fix','script',
    'website','component','endpoint','database','login','register','button','modal','table',
    'query','class','method','deploy','implement'];
  if (codeWords.some(w => p.includes(w))) return true;
  // Tamil script and Thanglish equivalents
  const tamilCodeWords = ['குறியீடு','எழுதுங்கள்','செய்','panu','pannu','venum','pannunga','ezhutu'];
  if (tamilCodeWords.some(w => prompt.includes(w))) return true;
  return false;
}

function isStudentRequest(prompt) {
  const p = prompt.toLowerCase();
  // Student panel fixed query patterns
  if (/summarize.*(chapter|lesson|topic)|chapter.*key.?point/i.test(p)) return true;
  if (/generate.*(practice.?question|quiz|mcq)|practice.*(question|test|paper)/i.test(p)) return true;
  if (/(help|write|draft|complete).*(assignment|essay|homework)|assignment.*research/i.test(p)) return true;
  if (/solve.*(math|maths|problem|equation)|math.*step.?by.?step/i.test(p)) return true;
  if (/translate.*(english|tamil)|english.*to.*tamil|tamil.*to.*english/i.test(p)) return true;
  if (/study.?plan|exam.?schedule|revision.?plan|day.*study.*plan/i.test(p)) return true;
  // Common student subject keywords
  const topics = [
    'photosynthesis','chlorophyll','osmosis','mitosis','meiosis','respiration',
    'evaporation','condensation','ecosystem','biodiversity','cell division',
    'trigonometry','calculus','theorem','algebra','geometry','pythagoras',
    'democracy','constitution','civics','parliament','amendment',
    'chapter summary','key points','revision','syllabus','textbook'
  ];
  return topics.some(t => p.includes(t));
}

async function callTavily(query) {
  const response = await axios.post(
    'https://api.tavily.com/search',
    { api_key: TAVILY_KEY, query, max_results: 5 },
    { timeout: 5000 }
  );
  return response.data.results || [];
}

// Rewrite follow-up questions into standalone English search queries using history context
async function rewriteSearchQuery(userPrompt, history) {
  const ctx = history.slice(-4)
    .map(m => `${m.role === 'assistant' ? 'AI' : 'User'}: ${m.content.slice(0, 200)}`)
    .join('\n');
  const instruction = `Conversation context:\n${ctx}\n\nFollow-up question: "${userPrompt}"\n\nRewrite the follow-up into a standalone English web search query. Reply with ONLY the search query, nothing else.`;
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: MODELS.GROQ_8B,
        messages: [
          { role: 'system', content: 'You rewrite follow-up questions into standalone English web search queries. Output ONLY the search query — no explanation, no quotes.' },
          { role: 'user', content: instruction }
        ],
        max_tokens: 60,
        temperature: 0.1
      },
      {
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000
      }
    );
    return response.data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    console.log('Query rewrite failed, using original:', err.message);
    return userPrompt;
  }
}

// ============================================
// ============================================
// GROQ API — parameterized model
// ============================================
async function callGroqModel(model, prompt, sysPrompt, history = [], maxTokensOverride = null) {
  const MAX_OUT = { [MODELS.GROQ_8B]: 1500, [MODELS.GROQ_70B]: 4096, [MODELS.GROQ_SCOUT]: 8192 };
  const maxTok = maxTokensOverride ?? MAX_OUT[model] ?? 2048;
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        ...history,
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTok
    },
    {
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );
  try { updateGroqQuota(model, response.headers); } catch (e) { console.warn('[quota-track]', e.message); }
  return response.data.choices[0].message.content;
}

// ============================================
// GEMINI API — parameterized model
// ============================================
async function callGeminiModel(model, prompt, sysPrompt, history = [], maxTokensOverride = null) {
  const contents = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: { parts: [{ text: sysPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokensOverride ?? 8192 }
    },
    { timeout: 60000 }
  );
  try { trackGeminiUsage(model); } catch (e) { console.warn('[gemini-track]', e.message); }
  const candidate = response.data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    const reason = candidate?.finishReason || 'unknown';
    throw new Error(`Gemini returned no text — finishReason: ${reason}, response: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
  return candidate.content.parts[0].text;
}

async function callGeminiWithImage(model, prompt, sysPrompt, history, attachment) {
  const contents = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content || '' }]
  }));
  contents.push({
    role: 'user',
    parts: [
      { inlineData: { mimeType: attachment.mimeType, data: attachment.data } },
      { text: prompt || 'Describe this image in detail.' }
    ]
  });
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: { parts: [{ text: sysPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 8192 }
    },
    { timeout: 60000 }
  );
  try { trackGeminiUsage(model); } catch (e) { console.warn('[gemini-track]', e.message); }
  const candidate = response.data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    const reason = candidate?.finishReason || 'unknown';
    throw new Error(`Gemini vision returned no text — finishReason: ${reason}`);
  }
  return candidate.content.parts[0].text;
}

// ============================================
// COMPACT SYSTEM PROMPT — used when quality-critical fieldMode paths
// fall back to a smaller model (8B / Scout). Short prompts are followed
// more reliably by small models than the full 500-word version.
// ============================================
function makeFieldCompactPrompt(fld) {
  return `You are a senior professional with 20+ years of hands-on experience in "${fld}", mentoring a fresher on the job. Speak like an experienced senior — real, practical, workplace-focused.

LANGUAGE RULE (STRICT): Detect the language of the user's most recent message. If English, respond 100% in English — no Tamil or Tanglish words anywhere. If Tamil/Tanglish, respond fully in that style. Never mix languages.

PRICING: Never mention prices or license fees for employer-provided software or systems (Tally, QuickBooks, CRM, POS, ERP, Core Banking, etc.). ₹ costs are allowed ONLY for small personal practice tools a beginner buys themselves (hand tools, basic kit, etc.).

MANDATORY FORMAT: Your response MUST end with these two blocks in order — no exceptions:

1. Doubt questions (always include):
[QUESTIONS]
question one | question two | question three
[/QUESTIONS]
Write exactly 3 short beginner questions (under 12 words each) about the content you just taught.

2. Quick reply (include whenever your response ends with a choice for the user):
<<QUICK_REPLY>>option1|option2|option3<<END_QUICK_REPLY>>
Example: <<QUICK_REPLY>>Complete beginner|Know the basics|Intermediate<<END_QUICK_REPLY>>
Rules: 2–4 short options only, each under 6 words, pipe-separated. NEVER put a full sentence or single question inside — only short clickable phrases. NEVER use any other closing tag — it is always <<END_QUICK_REPLY>>.

No text after either block.

STYLE: Maximum 5 bullet points per response. Prefer short paragraphs. Include one real workplace example per response.`;
}

// ============================================
// FALLBACK CHAIN
// Groq primary=70b:  70b -> 8b -> scout
// Groq primary=8b:   8b  -> 70b -> scout
// Gemini: flash <-> lite, then full Groq chain
// Skips models below 5% quota OR confirmed dead at startup.
// Applies per-model history truncation before each attempt.
// Throws only when entire chain is exhausted.
// ============================================
const _GROQ_CHAIN = [MODELS.GROQ_70B, MODELS.GROQ_8B, MODELS.GROQ_SCOUT];

async function callWithFallback(primaryModel, prompt, sysPrompt, history, lang = 'english', maxTokensOverride = null) {
  const isTamilLang = lang === 'tamil' || lang === 'thanglish';
  const isGemini = m => m.startsWith('gemini');
  // Skip 8B for Tamil/Thanglish — it ignores language-match instructions
  const groqChain = isTamilLang
    ? [MODELS.GROQ_70B, MODELS.GROQ_SCOUT]
    : _GROQ_CHAIN;

  let chain;
  if (isGemini(primaryModel)) {
    const alt = primaryModel === MODELS.GEM_FLASH ? MODELS.GEM_LITE : MODELS.GEM_FLASH;
    chain = [primaryModel, alt, ...groqChain];
  } else {
    // Primary first, then remaining models in priority order.
    const others = groqChain.filter(m => m !== primaryModel);
    chain = [primaryModel, ...others];
  }

  let lastError;
  for (const model of chain) {
    if (deadModels.has(model)) {
      console.log(`[fallback] Skip ${model} — decommissioned (detected at startup)`);
      continue;
    }
    if (isLowQuota(model)) {
      console.log(`[fallback] Skip ${model} — < 5% quota`);
      continue;
    }
    try {
      // Fit history to this model's safe input budget before calling
      const safeHistory = isGemini(model)
        ? history
        : fitHistory(history, sysPrompt, prompt, MODEL_INPUT_LIMITS[model] ?? 4000);

      const reply = isGemini(model)
        ? await callGeminiModel(model, prompt, sysPrompt, safeHistory, maxTokensOverride)
        : await callGroqModel(model, prompt, sysPrompt, safeHistory, maxTokensOverride);
      return { reply, model };
    } catch (err) {
      const status = err.response?.status;
      console.log(`[fallback] ${model} -> HTTP ${status ?? err.code}: ${JSON.stringify(err.response?.data || err.message).slice(0, 120)}`);
      if (status === 401) throw err; // bad API key — stop immediately
      // Preserve a more informative error — don't let a 404 (dead/inaccessible model) clobber a prior 429 (rate limit)
      if (!(lastError?.response?.status === 429 && status === 404)) {
        lastError = err;             // 429 / 413 / 400 / 5xx -> try next in chain
      }
    }
  }
  throw lastError || new Error('All models in fallback chain exhausted');
}

// ============================================
// FIELD-MODE FALLBACK — quality-critical Learn paths only.
// Adds a 3-second 429-retry on the primary before downgrading.
// If downgrade happens, switches to the compact system prompt so
// smaller models (8B / Scout) receive a prompt they can follow.
// ============================================
async function callWithFieldFallback(primaryModel, prompt, fullSysPrompt, compactSysPrompt, history, maxTokens = null) {
  const isGemini = m => m.startsWith('gemini');

  // ── Step 1: try primary with one 429-retry ────────────────────────────────
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const safeHistory = isGemini(primaryModel)
        ? history
        : fitHistory(history, fullSysPrompt, prompt, MODEL_INPUT_LIMITS[primaryModel] ?? 4000);
      const reply = isGemini(primaryModel)
        ? await callGeminiModel(primaryModel, prompt, fullSysPrompt, safeHistory, maxTokens)
        : await callGroqModel(primaryModel, prompt, fullSysPrompt, safeHistory, maxTokens);
      return { reply, model: primaryModel, didFallback: false };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw err; // bad API key — no point retrying
      if (status === 429 && attempt === 1) {
        console.log(`[model-routing] primary ${primaryModel} rate-limited (429) — waiting 3s before retry`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // Non-429 error on attempt 1, or any error on attempt 2 — fall through
      console.log(`[model-routing] primary ${primaryModel} failed (attempt ${attempt}, HTTP ${status ?? err.code}) — switching to compact fallback`);
      break;
    }
  }

  // ── Step 2: primary exhausted — smaller models with compact prompt ────────
  const fallbackModels = isGemini(primaryModel)
    ? [primaryModel === MODELS.GEM_FLASH ? MODELS.GEM_LITE : MODELS.GEM_FLASH, ..._GROQ_CHAIN]
    : _GROQ_CHAIN.filter(m => m !== primaryModel);

  let lastErr;
  for (const model of fallbackModels) {
    if (deadModels.has(model)) { console.log(`[model-routing] skip ${model} — dead`); continue; }
    if (isLowQuota(model))     { console.log(`[model-routing] skip ${model} — low quota`); continue; }
    try {
      const safeHistory = isGemini(model)
        ? history
        : fitHistory(history, compactSysPrompt, prompt, MODEL_INPUT_LIMITS[model] ?? 4000);
      const reply = isGemini(model)
        ? await callGeminiModel(model, prompt, compactSysPrompt, safeHistory, maxTokens)
        : await callGroqModel(model, prompt, compactSysPrompt, safeHistory, maxTokens);
      return { reply, model, didFallback: true };
    } catch (err) {
      const status = err.response?.status;
      console.log(`[model-routing] fallback ${model} -> HTTP ${status ?? err.code}`);
      if (status === 401) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models in field fallback chain exhausted');
}

// RATE LIMITER — 100 messages/day per user (free plan)
// ============================================
const _userDaily = new Map(); // userId -> { count, date }
function rlCheck(userId, plan) {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  let e = _userDaily.get(userId);
  if (!e || e.date !== today) { _userDaily.set(userId, { count: 1, date: today }); return false; }
  const limit = plan === 'free' ? 100 : Infinity;
  if (e.count >= limit) return true;
  e.count++;
  return false;
}
// Prune previous-day entries every hour
setInterval(() => { const t = new Date().toLocaleDateString('en-CA'); for (const [k, v] of _userDaily) if (v.date !== t) _userDaily.delete(k); }, 60 * 60_000).unref();

// FORGOT-PASSWORD RATE LIMITER — 5 verify attempts per email per hour
const _forgotRl = new Map();
function forgotRlCheck(email) {
  const now = Date.now(), win = 60 * 60_000, max = 5;
  let e = _forgotRl.get(email);
  if (!e || now > e.r) { _forgotRl.set(email, { n: 1, r: now + win }); return false; }
  if (e.n >= max) return true;
  e.n++;
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _forgotRl) if (now > v.r) _forgotRl.delete(k); }, 60 * 60_000).unref();

// ============================================
// AUTH ROUTES
// ============================================
const SECURITY_QUESTIONS = [
  'What was the name of your first school?',
  'What is your favourite place?',
  'What was the name of your first pet?',
  'What is your mother\'s home town?'
];
const _emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, securityQuestion, securityAnswer } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name' });
  if (!email || !_emailRe.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!securityQuestion || !SECURITY_QUESTIONS.includes(securityQuestion)) return res.status(400).json({ error: 'Please select a valid security question' });
  if (!securityAnswer || !securityAnswer.trim()) return res.status(400).json({ error: 'Please answer the security question' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const answerHash = await bcrypt.hash(securityAnswer.toLowerCase().trim(), 10);
    try {
      db.prepare('INSERT INTO users (email, password_hash, name, security_question, security_answer_hash) VALUES (?, ?, ?, ?, ?)').run(email.toLowerCase().trim(), hash, name.trim(), securityQuestion, answerHash);
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'This email is already registered — please log in' });
      throw e;
    }
    res.json({ success: true, message: 'Account created' });
  } catch (err) {
    console.error('[auth-signup]', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Please enter your email and password' });
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Incorrect email or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password' });
    req.session.userId = user.id; req.session.userPlan = user.plan;
    req.session.userName = user.name; req.session.userEmail = user.email;
    res.json({ user: { id: user.id, name: user.name, email: user.email, plan: user.plan, hasSecurityQuestion: !!user.security_question } });
  } catch (err) {
    console.error('[auth-login]', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: { id: req.session.userId, name: req.session.userName, email: req.session.userEmail, plan: req.session.userPlan } });
});

// POST /api/auth/forgot/start — returns security question for email (no enumeration)
app.post('/api/auth/forgot/start', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !_emailRe.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const norm = email.toLowerCase().trim();
  const user = db.prepare('SELECT security_question FROM users WHERE email = ?').get(norm);
  if (!user) {
    // Small delay to prevent timing-based email enumeration
    await new Promise(r => setTimeout(r, 80 + Math.random() * 80));
    return res.json({ question: 'Unga favourite oru place?' });
  }
  if (!user.security_question) return res.json({ noQuestion: true });
  res.json({ question: user.security_question });
});

// POST /api/auth/forgot/verify — check answer, reset password
app.post('/api/auth/forgot/verify', async (req, res) => {
  const { email, answer, newPassword } = req.body || {};
  if (!email || !answer || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const norm = email.toLowerCase().trim();
  if (forgotRlCheck(norm)) return res.status(429).json({ error: 'Too many attempts — please try again in an hour' });
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(norm);
    if (!user || !user.security_answer_hash) return res.status(401).json({ error: 'Incorrect answer' });
    const match = await bcrypt.compare(answer.toLowerCase().trim(), user.security_answer_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect answer' });
    const newHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth-forgot-verify]', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

// POST /api/auth/set-security-question — authenticated, for users who skipped/existing accounts
app.post('/api/auth/set-security-question', requireAuth, async (req, res) => {
  const { question, answer } = req.body || {};
  if (!question || !SECURITY_QUESTIONS.includes(question)) return res.status(400).json({ error: 'Please select a valid security question' });
  if (!answer || !answer.trim()) return res.status(400).json({ error: 'Please enter your answer' });
  try {
    const hash = await bcrypt.hash(answer.toLowerCase().trim(), 10);
    db.prepare('UPDATE users SET security_question = ?, security_answer_hash = ? WHERE id = ?').run(question, hash, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth-set-sq]', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

function extractFirstJson(str) {
  const s = (str || '').indexOf('{');
  const e = (str || '').lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) return null;
  try { return JSON.parse(str.slice(s, e + 1)); } catch { return null; }
}

// ============================================
// DIAGNOSTIC TEST ENDPOINT — NO AUTH (remove after QR debug)
// ============================================
app.post('/api/test-qr', async (req, res) => {
  req.body = req.body || {};
  req.body.prompt = req.body.prompt || 'enaku oru app venum';
  req.body.history = [];
  req.body.enterpriseMode = false;
  req.body.simpleMode = !!req.body.simpleMode;
  req.session = req.session || {};
  req.session.userId = 'test'; req.session.userPlan = 'pro';
  // Reuse the chat handler directly via internal call
  try {
    const { prompt, history, enterpriseMode, simpleMode } = req.body;
    const lang = detectLanguage(prompt);
    const intent = detectIntent(prompt);
    const isStudent = false;
    let sysPrompt = '';
    const langInstr = langInstructions;
    if (simpleMode) {
      const _lp = getLangPreamble(lang);
      sysPrompt = (_lp ? _lp + '\n\n' : '') + SIMPLE_MODE_PROMPT + '\n\n' + langInstr[lang];
      sysPrompt += '\n\nQUICK REPLY BLOCKS — MANDATORY: Whenever you ask the user to choose between options (yes/no, topic choice, next-step choice), you MUST output the structured quick_reply block instead of a plain-text question.\n\nFormat (at the very end of your response):\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Your question?","options":["Option 1","Option 2","Option 3"]}<<END_QUICK_REPLY>>\n\nRules: Maximum 4 options. Each option maximum 5 words. ONE quick_reply block per response. Regular answers stay as plain text.';
    } else {
      const identity = (lang === 'tamil' || lang === 'thanglish') ? TAMIL_CODING_IDENTITY : CODING_IDENTITY;
      const _lp = getLangPreamble(lang);
      sysPrompt = (_lp ? _lp + '\n\n' : '') + identity + '\n\n' + systemPrompts[intent] + '\n\n' + langInstr[lang];
      sysPrompt += `\n\n=== MANDATORY APP-BUILD PROTOCOL (NON-NEGOTIABLE) ===\n\nSTEP 0 — PLATFORM CHECK (BLOCKING):\nBefore ANY mockup, ANY code, or ANY tech suggestion, you MUST know the target platform. If the user has not stated it, your NEXT response must ask ONLY this question — in the user's language — with a QUICK_REPLY block and NOTHING else app-related:\n\nEnglish version:\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Where should your app run?","options":["Phone only","Desktop only","Both","Not sure"]}<<END_QUICK_REPLY>>\n\n[Use this style ONLY when the user writes Tanglish/Tamil] Tanglish version: "Unga app enga use aaganum?"\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Unga app enga use aaganum?","options":["Phone-la mattum","Computer-la mattum","Rendulayum","Theriyala"]}<<END_QUICK_REPLY>>\n\n=== END MANDATORY APP-BUILD PROTOCOL ===`;
      sysPrompt += '\n\nQUICK REPLY BLOCKS — MANDATORY: Whenever you ask the user to choose between options, you MUST output the structured quick_reply block.\n\nFormat:\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Your question?","options":["Option 1","Option 2","Option 3"]}<<END_QUICK_REPLY>>';
    }
    const estimatedTokens = Math.ceil((sysPrompt.length + prompt.length) / 4) + 100;
    const decision = decideModel(prompt, lang, intent, estimatedTokens);
    const primaryModel = decision.model;
    console.log(`[test-qr] lang=${lang} intent=${intent} model=${primaryModel} tokens~${estimatedTokens}`);
    const { reply, model: usedModel } = await callWithFallback(primaryModel, prompt, sysPrompt, [], lang);
    const hasQr = (reply||'').includes('<<QUICK_REPLY>>');
    console.log(`[test-qr] model=${usedModel} has_qr=${hasQr}`);
    console.log(`[test-qr] RAW REPLY:\n${reply}`);
    return res.json({ lang, intent, model: usedModel, has_quick_reply: hasQr, raw_reply: reply });
  } catch(err) {
    console.error('[test-qr] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// MAIN CHAT ENDPOINT — With Router!
// ============================================
app.post('/api/chat', requireAuth, async (req, res) => {
  if (rlCheck(req.session.userId, req.session.userPlan)) {
    return res.status(429).json({ error: 'Innikku 100 messages limit mudinjuchu — naaliku continue pannunga!' });
  }

  const { prompt, history, enterpriseMode, simpleMode, attachment, fieldMode, fieldPreviewMode, forceTest, evaluateTest, sourceUrl, learnLang, maxTokensOverride, appBuilderBuild } = req.body;
  if (!attachment && (!prompt || !prompt.trim())) {
    return res.status(400).json({ error: 'Prompt is empty!' });
  }

  const recentHistory = (Array.isArray(history) ? history : []).slice(-10);

  const startTime  = Date.now();
  const intent     = detectIntent(prompt);
  const lang       = detectLanguage(prompt);
  const isStudent  = isStudentRequest(prompt);
  const tDetect    = Date.now() - startTime;
  let sysPrompt;
  let isEnterprise = false;
  if (evaluateTest && fieldMode && fieldMode.trim()) {
    const fld = fieldMode.trim().slice(0, 100);
    sysPrompt = `You are evaluating a beginner's quiz answers for the field "${fld}". Respond ONLY with valid JSON — no markdown fences, no explanations, no extra text. Use exactly this structure:\n{"results":[{"question":"","userAnswer":"","verdict":"correct","correctAnswer":"","note":""},{"question":"","userAnswer":"","verdict":"correct","correctAnswer":"","note":""},{"question":"","userAnswer":"","verdict":"correct","correctAnswer":"","note":""}],"score":"X/10","encouragement":""}\nverdict must be exactly "correct", "wrong", or "partial". correctAnswer: Write a COMPLETE, beginner-friendly correct answer in 1-2 sentences — specific enough that someone who got it wrong now fully understands the right answer. Include the key term AND what it means or why. WEAK example: "to inform and target the content". GOOD example: "Keywords help search engines understand what your content is about, so it appears when people search for those terms." Use empty string when verdict is "correct". note: One sentence explaining the gap between the user's answer and the correct one, in an encouraging tone. If the user's answer was empty or "nil", skip comparing and simply say this is a common question freshers face. Use empty string when not needed. score: e.g. "7/10". encouragement: one warm, encouraging sentence. CRITICAL: output must start with { and end with }. Nothing before or after the JSON.`;
  } else if (fieldPreviewMode && fieldPreviewMode.trim()) {
    const prevLangNote = (lang === 'tamil' || lang === 'thanglish')
      ? "All text values must be in Tanglish (Tamil written in English letters, casual friendly tone). Timeline example: '2 weeks-la basics ready'."
      : "All text values must be in simple, friendly English. Timeline example: '2 weeks to learn the basics'.";
    sysPrompt = `You are generating a learning preview for a beginner-friendly tutoring app. Respond ONLY with valid JSON, no markdown fences, no extra text. Format: { "title": "", "level_note": "", "outcomes": ["", "", "", ""], "timeline": "", "first_lesson_preview": { "question": "", "answer": "" } } ${prevLangNote} Keep outcomes short and practical. Timeline must be realistic and encouraging. first_lesson_preview should be one simple sample Q&A from the very first lesson. CRITICAL: Output must START with { and END with }. No greetings, no explanations, no markdown fences, no text before or after the JSON object. If you are about to write anything except JSON, stop and write only the JSON.`;
  } else if (fieldMode && fieldMode.trim()) {
    const fld = fieldMode.trim().slice(0, 100);
    sysPrompt = `You are a senior professional with 20+ years of hands-on experience in "${fld}", mentoring a fresher who has just joined this line of work. Teach them like a caring senior guiding a junior on the job — not a textbook, not a consumer guide, but real insider knowledge from someone who has lived this work.

LANGUAGE RULE (STRICT): Detect the language of the user's most recent message. If it is English, your ENTIRE response must be 100% English — zero Tamil or Tanglish words, including greetings (no 'Vanakkam'), fillers ('irukku', 'pannunga', 'theriyum'), and closing questions. If the user's message is in Tamil script or Tanglish, respond fully in that same style. Never mix languages within one response.

QUICK REPLY BLOCKS — MANDATORY: Whenever you offer the user a choice (level check, topic selection, next-step choice, yes/no confirmation), you MUST output a quick reply block instead of a plain-text question. Never ask a choice question as plain text.

Format — pipe-separated options, placed at the very end of your response AFTER the [QUESTIONS] block:
<<QUICK_REPLY>>Option one|Option two|Option three<<END_QUICK_REPLY>>

Example:
I'd love to tailor this to where you're at.
<<QUICK_REPLY>>Complete beginner|Know the basics|Intermediate|Self-taught<<END_QUICK_REPLY>>

Rules: 2–4 options only. Each option maximum 5 words. ONE quick_reply block per response. Options must be short clickable phrases — NEVER full sentences, questions, or encouragements inside the block. ALWAYS include this block when your response ends with a choice question.

CONTENT FOCUS — every lesson must be workplace-oriented. Cover the real day-to-day work processes that actually happen on the job, the industry-standard terms, documents, and tools they will hear at work (job cards, SOPs, quality reports — whatever applies). Explain what seniors and employers expect from a beginner in the first weeks, what common mistakes freshers make and how to avoid them, practical insider tips only experienced people know, and the career growth path in India from junior to senior with realistic salary progression.

AVOID: consumer-level explanations, generic textbook definitions, and content aimed at customers or hobbyists. Assume the learner will DO this work professionally, not just know about it.

STYLE: Explain like a senior talking to a junior over tea. Maximum 5 bullet points per response — prefer short paragraphs. Every teaching response must include one specific workplace scenario or insider detail, and end with one concrete free/cheap action the learner can do this week (before the [QUESTIONS] block).

RESPONSE BUDGET: Keep the main lesson concise — maximum 5 short sections. The [QUESTIONS] block and <<QUICK_REPLY>> block at the end are MANDATORY — budget your response so they ALWAYS fit. If your lesson content is running long, cut it short. Never cut the end blocks.

CONTENT QUALITY: Only real, accurate information. Real tool names, real document names, realistic ₹ salary figures. If you don't know something specific, say so instead of inventing.

PRICING RULE: NEVER write phrases like "expect to invest", "will cost you", or any ₹ amount for software, systems, or equipment that employers provide. WRONG: "kitchen management software like Aloha — expect to invest ₹50,000". RIGHT: "you'll use kitchen management software like Aloha — the hotel provides this". ₹ costs are allowed ONLY for small personal tools a beginner buys to practice at home (sewing machine, multimeter, makeup kit, basic hand tools). When mentioning employer-provided software by name (Tally, QuickBooks, CRM systems, POS), NEVER include any price, subscription cost, or license fee — not even in brackets. Name the software and say the employer provides it. Nothing else.

When the user's message starts with "📚 Learn:", give a friendly structured roadmap: (1) What this job actually involves day-to-day — 2-3 sentences from a senior's perspective, (2) Core skills and knowledge a fresher must build — step-by-step in order, (3) Adapt this section to the field type. For hands-on/trade fields (electrician, salon, automobile, tailoring): tools and equipment a BEGINNER needs, with realistic ₹ costs. For office/knowledge fields (banking, HR, coding, marketing): software they'll use daily (note that employers provide enterprise systems — never list enterprise license prices or tell freshers to buy them), useful certifications with realistic exam fees, and documents/systems they'll handle at work. (4) Realistic salary progression and career path in India, (5) end with a question inviting them to pick where to start. After the roadmap, end your response with the [QUESTIONS] block containing exactly 3 questions about this field. Then immediately after [/QUESTIONS], include the <<QUICK_REPLY>> block with 2–4 short options for what to learn first. Both blocks are mandatory — never omit them from a roadmap response.

For all follow-up messages: teach one concept at a time, use real workplace scenarios and examples.

INTERACTIVE LEARNING RULES:

1. DOUBT QUESTIONS — At the end of EVERY teaching response, after your main content, output this exact block as the very last lines:
[QUESTIONS]
question one | question two | question three
[/QUESTIONS]
Write exactly 3 questions a beginner would naturally wonder after reading THAT specific explanation (not generic). Each under 12 words, written as if the learner is asking. Each question must be about the NEWEST content just taught — never repeat or rephrase questions from earlier [QUESTIONS] blocks in this conversation. Do NOT include any other text after [/QUESTIONS].

2. MARKS & APPRECIATION — When the learner answers test questions, evaluate each answer and give marks out of 10 total (show the breakdown, e.g. Q1: 3/3, Q2: 2/4, Q3: 3/3 = 8/10). Then:
   - 8-10: praise enthusiastically and highlight what they got exactly right
   - 5-7: appreciate the effort, gently correct the wrong parts with a short explanation
   - Below 5: be encouraging, never discouraging — say this is normal for beginners, re-explain the weak areas simply, and offer a fresh attempt with different questions
   Never mock or criticize. Always end evaluation with what to learn next.

4. If the learner ignores the test and asks something else, answer their question normally — do not force the test.

LANGUAGE RULE (STRICT): Detect the language of the user's most recent message. If it is English, your ENTIRE response must be 100% English — zero Tamil or Tanglish words, including greetings (no 'Vanakkam'), fillers ('irukku', 'pannunga', 'theriyum'), and closing questions. If the user's message is in Tamil script or Tanglish, respond fully in that same style. Never mix languages within one response.`;
  } else if (simpleMode) {
    const _lp = getLangPreamble(lang);
    sysPrompt = (_lp ? _lp + '\n\n' : '') + SIMPLE_MODE_PROMPT + '\n\n' + langInstructions[lang];
    sysPrompt += '\n\nQUICK REPLY BLOCKS — MANDATORY: Whenever you ask the user to choose between options (yes/no, topic choice, next-step choice), you MUST output the structured quick_reply block instead of a plain-text question.\n\nFormat (at the very end of your response):\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Your question?","options":["Option 1","Option 2","Option 3"]}<<END_QUICK_REPLY>>\n\nRules: Maximum 4 options. Each option maximum 5 words. ONE quick_reply block per response. Regular answers stay as plain text.';
  } else {
    const identity = isStudent ? STUDENT_IDENTITY
      : (lang === 'tamil' || lang === 'thanglish') ? TAMIL_CODING_IDENTITY
      : CODING_IDENTITY;
    const _lp = getLangPreamble(lang);
    sysPrompt = (_lp ? _lp + '\n\n' : '') + identity + '\n\n' + systemPrompts[intent] + '\n\n' + langInstructions[lang];
    if (appBuilderBuild === true) {
      // App Builder's client-side flow already sent a complete build prompt (platform/stack/features/style/DESIGN SYSTEM) — skip the protocol below, it would conflict.
    } else {
    sysPrompt += `\n\n=== MANDATORY APP-BUILD PROTOCOL (NON-NEGOTIABLE) ===

STEP 0 — PLATFORM CHECK (BLOCKING):
Before ANY mockup, ANY code, or ANY tech suggestion, you MUST know the target platform. If the user has not stated it, your NEXT response must ask ONLY this question — in the user's language — with a QUICK_REPLY block and NOTHING else app-related:

English version:
<<QUICK_REPLY>>{"type":"quick_reply","question":"Where should your app run?","options":["📱 Phone only","💻 Desktop only","🌐 Both","🤷 Not sure"]}<<END_QUICK_REPLY>>

[Use this style ONLY when the user writes Tanglish/Tamil] Tanglish version: "Unga app enga use aaganum?"
<<QUICK_REPLY>>{"type":"quick_reply","question":"Unga app enga use aaganum?","options":["📱 Phone-la mattum","💻 Computer-la mattum","🌐 Rendulayum","🤷 Theriyala"]}<<END_QUICK_REPLY>>

FORBIDDEN before platform answer exists: generating a mockup, writing any code, or suggesting a tech stack.
FORBIDDEN always: asking the user to pick a programming language or framework — that is your decision (STEP 1).

STEP 1 — TECH DECISION (AI-ONLY, SILENT):
Once the platform answer is known, decide silently — never ask the user to choose:
- Phone only  →  React Native (Expo)
- Desktop only  →  HTML web app
- Both / Not sure  →  Responsive HTML web app (mobile-first 430px base + desktop media queries). NEVER offer "React Native vs HTML" as a choice — responsive web IS the answer for both.
- User explicitly named a tech ("React la pannu", "Flutter app venum", "Python script")  →  use exactly that and skip Step 0.
Announce the decision in ONE line in the user's language, then move to Step 2:
  English: "Building as a web app — works on phone browser and desktop from one link."
  [Use this style ONLY when the user writes Tanglish/Tamil] Tanglish: "Web app-a build panren — phone browser-layum computer-layum ore link-la work aagum."

STEP 2 — MOCKUP → APPROVAL → BUILD:
PHASE 1 — MOCKUP: Your very next response must be ONE self-contained HTML mockup inside a \`\`\`html code block. It must:
• Be a single file with all CSS inside a <style> tag — no external files or CDN stylesheets
• Show the actual screens described with realistic placeholder data — use THEIR app name, THEIR feature names, THEIR language for all UI labels and button text (English/Tamil/Tanglish as appropriate)
• Be mobile-friendly: max-width 430px centred, proper padding, readable font sizes
• Cover 3–5 sections: a home/landing screen plus the key feature screens requested
• Buttons can call alert() or be visual-only — no real backend logic needed
• Use a proper colour scheme and clear visual hierarchy — not a blank white page

PHASE 2 — APPROVAL: Immediately after the \`\`\`html block, write 1–2 sentences in the user's language saying the app will look roughly like this and asking if they want to proceed. Then output a QUICK_REPLY block with these three options translated into the user's language: "Build it" | "Change design" | "Add features"

PHASE 3 — CODE: Only after the user chooses "Build it" (or equivalent approval), start generating the full working code — one file at a time.

COMPLIANCE EXAMPLES:
CORRECT — User: "AI-powered productivity app venum" → AI asks the platform question with chips. No mockup, no code yet.
WRONG — User: "AI-powered productivity app venum" → AI outputs a mockup immediately. (Violation — platform unknown.)
CORRECT — User: "React la oru dashboard pannu" → AI builds in React. (User named the tech; skip Step 0.)

DOES NOT APPLY TO: bug fixes, small snippets, single functions, adding one feature to existing code, Enterprise Mode, or explicit single-file requests.

=== END MANDATORY APP-BUILD PROTOCOL ===`;
    }
    sysPrompt += '\n\nQUICK REPLY BLOCKS — MANDATORY: Whenever you ask the user to choose between options (topic selection, yes/no confirmation, next-step choice, architecture choice, etc.), you MUST output the structured quick_reply block instead of a plain-text question. Never ask a choice question as plain text.\n\nFormat (place at the very end of your response):\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Your question?","options":["Option 1","Option 2","Option 3"]}<<END_QUICK_REPLY>>\n\nWRONG — plain-text choice question (never do this):\n"Would you like to use Monolithic or Microservices architecture?"\n\nCORRECT — same question as a quick_reply block:\nHere\'s a quick breakdown of both. Before I go deeper, let me know which direction you\'re leaning:\n<<QUICK_REPLY>>{"type":"quick_reply","question":"Which architecture fits your project?","options":["Monolithic","Microservices","Not sure yet"]}<<END_QUICK_REPLY>>\n\nRules: Maximum 4 options. Each option maximum 5 words. ONE quick_reply block per response only. Use ONLY for genuine choice moments — regular answers stay as plain text.';
    isEnterprise = !!(enterpriseMode && isCodeRequest(prompt));
    if (isEnterprise) {
      sysPrompt += '\n\nENTERPRISE MODE ACTIVE — generated code must meet production standards:\n- Input validation on all user inputs\n- Proper error handling with try-catch and meaningful error messages\n- Security best practices: no hardcoded secrets, parameterized queries, XSS-safe output\n- Comments explaining key sections\n- After the code, add a short \'Production Checklist\' section listing what to verify before deploying (security, testing, environment variables)';
    }
  }

  // When a non-English language is explicitly selected, strip the fieldMode auto-detection rule
  // which says "if message is English, respond in English" — it conflicts with the override below
  // because field names like "📚 Learn: Coding & Software" are always English text.
  if (learnLang && learnLang !== 'english' && fieldMode) {
    sysPrompt = sysPrompt.replace(/\n?LANGUAGE RULE \(STRICT\):[\s\S]*?Never mix languages[^\n]*\./g, '');
  }

  // Explicit language override for Learn Any Field paths — placed last to win over detection rules
  if (learnLang && (fieldMode || fieldPreviewMode) && !evaluateTest) {
    const _markerNote = 'IMPORTANT EXCEPTION — STRUCTURAL MARKERS must stay in exact ASCII:\n' +
      'Doubt questions use ONLY this format: [QUESTIONS] question1 | question2 | question3 [/QUESTIONS]\n' +
      'Quick reply buttons use ONLY this format: <<QUICK_REPLY>>option1|option2|option3<<END_QUICK_REPLY>>\n' +
      'These are TWO SEPARATE formats — NEVER mix them. NEVER write [/QUICK_REPLY] inside a <<QUICK_REPLY>> block — that tag does not exist here. The closing tag for <<QUICK_REPLY>> is ALWAYS <<END_QUICK_REPLY>>. Each option inside <<QUICK_REPLY>> must be a short phrase under 6 words written in the selected language — NEVER full sentences or encouragements. Always include the <<QUICK_REPLY>> block when your response ends with a choice question.';
    const _li = learnLang === 'tamil'
      ? 'CRITICAL LANGUAGE OVERRIDE: The user has explicitly chosen Tamil as their response language. You MUST respond entirely in Tamil using Tamil script. This overrides the language detection rule above — even if the user\'s message contains English words, respond only in Tamil script. ' + _markerNote
      : learnLang === 'tanglish'
      ? 'CRITICAL LANGUAGE OVERRIDE: The user has explicitly chosen Tanglish as their response language. You MUST respond in Tanglish — Tamil words written in Roman/English letters in a natural, conversational style. This overrides the language detection rule above. ' + _markerNote
      : learnLang === 'hindi'
      ? 'CRITICAL LANGUAGE OVERRIDE: The user has explicitly chosen Hindi as their response language. You MUST respond entirely in Hindi using Devanagari script. This overrides the language detection rule above — even if the user\'s message contains English words, respond only in Hindi. ' + _markerNote
      : learnLang === 'telugu'
      ? 'CRITICAL LANGUAGE OVERRIDE: The user has explicitly chosen Telugu as their response language. You MUST respond entirely in Telugu using Telugu script. This overrides the language detection rule above — even if the user\'s message contains English words, respond only in Telugu. ' + _markerNote
      : 'CRITICAL LANGUAGE OVERRIDE: The user has explicitly chosen English as their response language. You MUST respond entirely in English. No Tamil or Tanglish words. ' + _markerNote;
    sysPrompt += '\n\n' + _li;
  }

  // Force test: output machine-readable [TEST] block only — client renders interactive quiz
  if (forceTest && !evaluateTest && fieldMode && fieldMode.trim()) {
    sysPrompt += '\n\nMANDATORY: Do not teach new content. Output ONLY a [TEST] block with exactly 3 short questions based on what was taught — one recall question, one workplace scenario question, one yes/no question. Use this exact format and nothing else:\n[TEST]\nquestion one | question two | question three\n[/TEST]\nNo text before or after the [TEST] block.';
  }

  // Web search — enrich prompt with live results if needed
  let finalPrompt = prompt || '';
  let searched    = false;

  // ── Image upload: route directly to Gemini vision, bypass search & routing ──
  if (attachment?.type === 'image') {
    const imgPrompt = (prompt || '').trim() || 'Describe this image in detail.';
    console.log(`[attachment] Image "${attachment.name}" (${attachment.mimeType}) → ${MODELS.GEM_FLASH}`);
    try {
      const reply = await callGeminiWithImage(MODELS.GEM_FLASH, imgPrompt, sysPrompt, recentHistory, attachment);
      const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
      return res.json({ reply, model: MODELS.GEM_FLASH, time: timeTaken + 's', searched: false, enterprise: false });
    } catch (err) {
      console.error('[attachment-image-error]', err.message);
      const msg = err.response?.status === 429
        ? 'Image analysis ku Gemini quota mudinjuchu — konjam neram kalichu try pannunga'
        : 'Image analysis la error achu — please try again.';
      return res.status(500).json({ error: msg });
    }
  }

  // ── Text file upload: prepend content to prompt, then continue normal routing ──
  if (attachment?.type === 'text') {
    const FILE_CHAR_CAP = 8000;
    const raw = attachment.data || '';
    const content = raw.slice(0, FILE_CHAR_CAP);
    const suffix = raw.length > FILE_CHAR_CAP ? '\n...[file truncated to fit context]' : '';
    finalPrompt = `User uploaded file '${attachment.name}':\n${content}${suffix}\n\nUser question: ${prompt || 'Analyze this file.'}`;
    console.log(`[attachment] Text file "${attachment.name}" — ${content.length} chars prepended`);
  }
  // Source-card path: fetch page via Readability and inject into prompt
  let sourcePageFetched = false;
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    let pageText = '';
    try {
      const srcRes = await axios.get(sourceUrl, {
        timeout: 10000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeAI/1.0)' },
        responseType: 'text'
      });
      const srcDom = new JSDOM(srcRes.data, { url: sourceUrl });
      const srcArticle = new Readability(srcDom.window.document).parse();
      pageText = srcArticle ? (srcArticle.textContent || '').trim().slice(0, 6000) : '';
    } catch (srcErr) {
      console.error('[source-card] fetch failed:', srcErr.message);
    }
    sysPrompt = 'The user clicked a search result. Using the following page content, explain the key details clearly and concisely. If the content is missing or empty, say the page could not be read and answer from the search snippet instead.';
    finalPrompt = `Page URL: ${sourceUrl}\n\nPage content:\n${pageText || '(Could not fetch page content)'}\n\nUser request: ${prompt}`;
    sourcePageFetched = true;
    console.log(`[source-card] fetched ${sourceUrl} — ${pageText.length} chars`);
  }

  let tRewrite = 0, tTavily = 0;
  if (needsSearch(prompt) && TAVILY_KEY && !fieldPreviewMode && !sourcePageFetched) {
    try {
      let searchQuery = prompt;
      // Only rewrite short/ambiguous follow-ups — long queries are self-contained.
      // Skipping rewrite eliminates an extra LLM round-trip (~300-800ms) for most searches.
      if (recentHistory.length > 0 && prompt.trim().length < 80) {
        const t1 = Date.now();
        searchQuery = await rewriteSearchQuery(prompt, recentHistory);
        tRewrite = Date.now() - t1;
      }
      if (searchQuery !== prompt) console.log(`Search query rewritten: "${searchQuery}" (original: "${prompt}")`);
      const t2 = Date.now();
      const results = await callTavily(searchQuery);
      tTavily = Date.now() - t2;
      if (results.length > 0) {
        const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
        const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join('\n\n');
        finalPrompt = `Here are current web search results:\n\n${context}\n\nToday's date is ${today}. Use these results to answer accurately.\n\nUser question: ${prompt}`;
        searched = true;
      }
    } catch (err) {
      console.log('Tavily search failed, proceeding without search:', err.message);
    }
  }

  // Pick primary model AFTER finalPrompt is built — token count includes search context
  const estimatedTokens = estimateTokens(finalPrompt, sysPrompt, recentHistory);
  const decision   = decideModel(prompt, lang, intent, estimatedTokens);
  let primaryModel = decision.model;
  // Search context adds tokens — upgrade 8b to 70b for better synthesis
  if (searched && primaryModel === MODELS.GROQ_8B) primaryModel = MODELS.GROQ_70B;
  // Field tutor: always use strongest model — 8b produces fake Tamil words
  if (fieldMode && fieldMode.trim()) {
    const _fl = learnLang || lang;
    primaryModel = (_fl === 'tamil' || _fl === 'tanglish' || _fl === 'thanglish' || _fl === 'hindi' || _fl === 'telugu') ? MODELS.GEM_FLASH : MODELS.GROQ_70B;
  }
  // Preview card: upgrade 8b for reliable JSON generation
  if (fieldPreviewMode && fieldPreviewMode.trim()) {
    const _fl = learnLang || lang;
    primaryModel = (_fl === 'tamil' || _fl === 'tanglish' || _fl === 'thanglish' || _fl === 'hindi' || _fl === 'telugu') ? MODELS.GEM_FLASH : MODELS.GROQ_70B;
  }
  // Source card: page content is large — use 70b for better synthesis
  if (sourcePageFetched) {
    primaryModel = (lang === 'tamil' || lang === 'thanglish') ? MODELS.GEM_FLASH : MODELS.GROQ_70B;
  }

  console.log(`Lang: ${lang} | Intent: ${intent} | Tokens~${estimatedTokens} | Primary: ${primaryModel} | Search: ${searched}`);
  console.log(`[router] ${decision.reason}`);

  try {
    const tModelStart = Date.now();

    // Quality-critical fieldMode paths get retry + compact-prompt fallback.
    // All other paths (preview, normal chat) use the standard chain.
    let reply, usedModel;
    if (fieldMode && fieldMode.trim()) {
      const fld = fieldMode.trim().slice(0, 100);
      let compactPrompt = makeFieldCompactPrompt(fld);
      if (learnLang && learnLang !== 'english') {
        compactPrompt = compactPrompt.replace(/\n?LANGUAGE RULE \(STRICT\):[\s\S]*?Never mix languages[^\n]*\./g, '');
        const _cMarker = 'Keep [QUESTIONS], [/QUESTIONS], <<QUICK_REPLY>>, <<END_QUICK_REPLY>>, and | in ASCII exactly as shown.';
        const _cli = learnLang === 'tamil' ? 'MANDATORY: Respond entirely in Tamil script. ' + _cMarker
          : learnLang === 'tanglish' ? 'MANDATORY: Respond in Tanglish (Tamil written in Roman/English letters). ' + _cMarker
          : learnLang === 'hindi' ? 'MANDATORY: Respond entirely in Hindi using Devanagari script. ' + _cMarker
          : learnLang === 'telugu' ? 'MANDATORY: Respond entirely in Telugu using Telugu script. ' + _cMarker
          : '';
        if (_cli) compactPrompt = _cli + '\n\n' + compactPrompt;
      }
      // For forceTest, the compact prompt used by fallback models must also carry the test instruction
      if (forceTest && !evaluateTest) {
        compactPrompt += '\n\nMANDATORY: Do not teach new content. Output ONLY a [TEST] block with exactly 3 short questions based on what was taught. Format:\n[TEST]\nquestion one | question two | question three\n[/TEST]\nNo text before or after the [TEST] block.';
      }
      const _fieldMaxTok = (learnLang === 'tamil' || learnLang === 'hindi' || learnLang === 'telugu') ? 4000 : 2500;
      const result = await callWithFieldFallback(primaryModel, finalPrompt, sysPrompt, compactPrompt, recentHistory, _fieldMaxTok);
      reply    = result.reply;
      usedModel = result.model;
      console.log(`[model-routing] path=fieldMode model=${usedModel} fallback=${result.didFallback}`);
    } else {
      ({ reply, model: usedModel } = await callWithFallback(primaryModel, finalPrompt, sysPrompt, recentHistory, lang, maxTokensOverride));
      // DIAGNOSTIC — log raw reply snippet to check for <<QUICK_REPLY>> presence
      const _qrPresent = (reply||'').includes('<<QUICK_REPLY>>');
      console.log(`[debug-qr] model=${usedModel} has_qr_block=${_qrPresent} snippet=${JSON.stringify((reply||'').slice(0,300))}`);
      if (fieldPreviewMode && fieldPreviewMode.trim()) {
        console.log(`[model-routing] path=fieldPreview model=${usedModel} fallback=${usedModel !== primaryModel}`);
      }
    }

    const tModel   = Date.now() - tModelStart;
    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[timing] detect=${tDetect}ms rewrite=${tRewrite}ms search=${tTavily}ms model=${tModel}ms total=${Date.now() - startTime}ms`);
    if (usedModel !== primaryModel) console.log(`[fallback] Served by ${usedModel} (primary ${primaryModel} unavailable)`);

    // ── [TEST] parsing for forceTest responses ───────────────────────────────
    let testQuestions = null;
    if (forceTest && !evaluateTest && fieldMode && fieldMode.trim()) {
      console.log('[test-parse] raw tail:', JSON.stringify(reply.slice(-300)));
      // Accept [TEST], [QUESTIONS] (with or without closing tag), or plain "Questions: ..." heading
      const _splitQs = inner => {
        // Strip history-truncation marker before it leaks into user-visible question text
        const clean = inner.replace(/\s*\.\.\.\[truncated\]/gi, '');
        const byPipe = clean.split('|').map(q => q.trim()).filter(Boolean);
        const byLine = clean.split(/\r?\n/).map(q => q.trim()).filter(Boolean);
        return (byPipe.length >= byLine.length ? byPipe : byLine).slice(0, 3);
      };
      const _extractTestQs = text => {
        const tm = text.match(/\[TEST\]([\s\S]*?)\[\/TEST\]/i);
        if (tm) return _splitQs(tm[1].trim());
        // Accept [QUESTIONS] with or without closing tag — 8B often omits [/QUESTIONS]
        const qm = text.match(/\[QUESTIONS\]([\s\S]*?)\[\/QUESTIONS\]/i)
                || text.match(/\[QUESTIONS\]\s*([\s\S]{0,500})/i);
        if (qm) return _splitQs(qm[1].trim().replace(/\[\/QUESTIONS\][\s\S]*/i, ''));
        const hm = text.match(/\b(?:test\s+)?questions?\s*:\s*(.+)/i);
        if (hm) return _splitQs(hm[1].trim());
        return [];
      };
      let parts = _extractTestQs(reply);
      if (parts.length < 1) {
        console.log('[test-parse] no recognisable question format — retrying');
        try {
          const snippet = reply.slice(0, 1200);
          const retryPrompt = `Generate exactly 3 short test questions from this lesson content. Output ONLY the [TEST] block.\n\nContent:\n${snippet}`;
          const retrySys = 'Output ONLY a [TEST] block and nothing else. Format: [TEST]\nq1 | q2 | q3\n[/TEST]';
          const { reply: retryReply } = await callWithFieldFallback(primaryModel, retryPrompt, retrySys, retrySys, [], 200);
          parts = _extractTestQs(retryReply);
        } catch (retryErr) {
          console.log('[test-parse] retry failed:', retryErr.message);
        }
      }
      if (parts.length >= 1) {
        testQuestions = parts;
        reply = '';
        console.log(`[test-parse] extracted ${testQuestions.length} questions`);
      } else {
        // Parsing failed — strip any leaked markup so plain-text fallback is clean
        reply = reply
          .replace(/\s*\[TEST\][\s\S]*?\[\/TEST\]/gi, '')
          .replace(/\s*\[QUESTIONS\][\s\S]*?(?:\[\/QUESTIONS\]|$)/gi, '')
          .trim();
        console.log('[test-parse] failed, raw tail:', JSON.stringify(reply.slice(-300)));
      }
    }

    // ── evaluateTest JSON parsing ────────────────────────────────────────────
    let evaluationResult = null;
    if (evaluateTest && fieldMode && fieldMode.trim()) {
      let evParsed = extractFirstJson(reply);
      const _validEval = p => p && Array.isArray(p.results) && p.results.length >= 1;
      if (!_validEval(evParsed)) {
        console.log('[eval-parse] JSON parse failed — retrying');
        try {
          const retryPrompt = `Your previous response could not be parsed as JSON. Re-output ONLY the evaluation JSON object — no markdown fences, no extra text.\n\nEvaluate these answers:\n${finalPrompt}`;
          const { reply: retryReply } = await callWithFieldFallback(primaryModel, retryPrompt, sysPrompt, sysPrompt, [], 600);
          evParsed = extractFirstJson(retryReply);
          if (_validEval(evParsed)) reply = retryReply;
        } catch (retryErr) {
          console.log('[eval-parse] retry failed:', retryErr.message);
        }
      }
      if (_validEval(evParsed)) {
        evaluationResult = evParsed;
        reply = '';
        console.log('[eval-parse] evaluation result parsed successfully');
      } else {
        console.log('[eval-parse] both attempts failed — plain text fallback');
      }
    }

    // ── [QUESTIONS] post-check for fieldMode responses ────────────────────────
    // Skipped for forceTest and evaluateTest — those have their own blocks above
    const _hasValidQBlock = () => /\[QUESTIONS\][\s\S]*?\[\/QUESTIONS\]/i.test(reply);
    const _hasAnyQBlock   = () => /\[QUESTIONS\]/i.test(reply);

    if (fieldMode && fieldMode.trim() && !forceTest && !evaluateTest && !_hasValidQBlock()) {
      const topic = fieldMode.trim().slice(0, 100);
      console.log('[questions-fallback] triggered for topic:', topic);
      try {
        const lessonSnippet = reply.slice(0, 1200);
        const fbPrompt = `Based on this lesson content:\n\n${lessonSnippet}\n\nGenerate exactly 3 short beginner questions (each under 12 words) about it. Output ONLY this format:\n[QUESTIONS]\nquestion one | question two | question three\n[/QUESTIONS]`;
        const fbSys = 'You output only a [QUESTIONS] block and nothing else. No greetings, no explanations, no extra text.';
        // Use callWithFieldFallback so the primary gets a 429-retry before dropping to 8B/Scout
        const { reply: fbReply } = await callWithFieldFallback(primaryModel, fbPrompt, fbSys, fbSys, [], 200);

        const fbMatch = fbReply.match(/\[QUESTIONS\]([\s\S]*?)\[\/QUESTIONS\]/i);
        if (fbMatch) {
          const inner = fbMatch[1].trim();
          const byPipe = inner.split('|').map(q => q.trim()).filter(Boolean);
          const byLine = inner.split(/\r?\n/).map(q => q.trim()).filter(Boolean);
          const parts  = (byPipe.length >= byLine.length ? byPipe : byLine).slice(0, 3);

          if (parts.length >= 1) {
            const normBlock = `[QUESTIONS]\n${parts.join(' | ')}\n[/QUESTIONS]`;
            if (_hasAnyQBlock()) {
              reply = reply.replace(/\[QUESTIONS\][\s\S]*?(\[\/QUESTIONS\]|$)/i, normBlock);
            } else {
              reply = reply.trimEnd() + '\n\n' + normBlock;
            }
            console.log(`[questions-fallback] topic=${topic} parsed=${parts.length} appended=true`);
          } else {
            console.log(`[questions-fallback] topic=${topic} parsed=0 appended=false`);
          }
        } else {
          console.log(`[questions-fallback] topic=${topic} parsed=0 appended=false (no block in reply)`);
        }
      } catch (fbErr) {
        console.log('[questions-fallback] follow-up call failed:', fbErr.message, '— sending as-is');
      }
    }

    res.json({
      reply,
      model:      usedModel,
      reason:     decision.reason,
      time:       timeTaken + 's',
      searched,
      enterprise: isEnterprise,
      ...(testQuestions    ? { testQuestions }    : {}),
      ...(evaluationResult ? { evaluationResult } : {}),
    });

  } catch (error) {
    console.error('[chat-error] stack:', error.stack || error);
    console.error('[chat-error] response:', JSON.stringify(error.response?.data ?? null));
    let errorMsg = 'Something went wrong. Please try again.';
    if (error.response?.status === 401) {
      errorMsg = 'API key wrong! Check your .env file.';
    } else if (error.response?.status === 429) {
      errorMsg = 'AI service quota mudinjuchu — konjam neram kalichu try pannunga';
    } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      errorMsg = 'Connection issue. Please try again.';
    }
    res.status(500).json({ error: errorMsg });
  }
});


// ============================================
// SEARCH ENDPOINT — Tavily + AI synthesis
// ============================================
app.post('/api/search', requireAuth, async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) return res.status(400).json({ error: 'Query is empty!' });
  if (!TAVILY_KEY) return res.status(503).json({ error: 'Search not configured. Add TAVILY_API_KEY to .env' });

  const q = query.trim();
  const userId = req.session.userId;
  const today = new Date().toISOString().slice(0, 10);

  // Rate limit — 10 searches per user per day
  const rl = db.prepare('SELECT count FROM search_ratelimit WHERE user_id=? AND date=?').get(userId, today);
  const usedToday = rl ? rl.count : 0;
  if (usedToday >= 10) {
    return res.status(429).json({ error: 'Search limit reached (10/day). Try again tomorrow.' });
  }

  // Cache lookup — 24 hours
  const cacheKey = q.toLowerCase();
  const cached = db.prepare('SELECT result FROM search_cache WHERE query=? AND created_at > ?').get(cacheKey, Date.now() - 86400000);
  if (cached) {
    const parsed = JSON.parse(cached.result);
    parsed.remaining = 10 - usedToday;
    return res.json(parsed);
  }

  try {
    // Fetch web results from Tavily
    const tavilyRes = await axios.post(
      'https://api.tavily.com/search',
      { api_key: TAVILY_KEY, query: q, max_results: 6, include_answer: false },
      { timeout: 10000 }
    );
    const sources = (tavilyRes.data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: (r.content || r.snippet || '').slice(0, 400)
    }));

    // AI synthesis
    const lang = detectLanguage(q);
    const context = sources.map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`).join('\n\n');
    const synthSys = 'You are a search assistant. Answer the question in 3-5 sentences using the provided web search results. Be factual, clear, and cite key information. Do not add disclaimers or preambles.';
    const synthPrompt = `Question: ${q}\n\nWeb search results:\n${context}`;
    let aiAnswer = '';

    try {
      if (lang === 'tamil' && GEMINI_KEY) {
        const gemRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.GEM_FLASH}:generateContent?key=${GEMINI_KEY}`,
          {
            system_instruction: { parts: [{ text: synthSys }] },
            contents: [{ role: 'user', parts: [{ text: synthPrompt }] }],
            generationConfig: { maxOutputTokens: 400 }
          },
          { timeout: 15000 }
        );
        aiAnswer = gemRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else if (GROQ_KEY) {
        const groqRes = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: MODELS.GROQ_70B,
            messages: [
              { role: 'system', content: synthSys },
              { role: 'user', content: synthPrompt }
            ],
            max_tokens: 400,
            temperature: 0.3
          },
          { headers: { Authorization: `Bearer ${GROQ_KEY}` }, timeout: 15000 }
        );
        aiAnswer = groqRes.data?.choices?.[0]?.message?.content || '';
      }
    } catch (synthErr) {
      console.error('[search-synth] AI synthesis failed:', synthErr.message);
    }

    const result = { answer: aiAnswer.trim(), results: sources };

    // Cache + rate limit update
    db.prepare('INSERT OR REPLACE INTO search_cache (query, result, created_at) VALUES (?,?,?)').run(cacheKey, JSON.stringify(result), Date.now());
    db.prepare('INSERT INTO search_ratelimit (user_id, date, count) VALUES (?,?,1) ON CONFLICT(user_id, date) DO UPDATE SET count=count+1').run(userId, today);

    result.remaining = 10 - (usedToday + 1);
    res.json(result);
  } catch (err) {
    console.error('[search] Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// ============================================
// READER PREVIEW — fetch + Readability extract
// ============================================
app.get('/api/preview', requireAuth, async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: true, originalUrl: url });
  }
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeAI/1.0; +https://forgeai.app)' },
      responseType: 'text'
    });
    const dom = new JSDOM(response.data, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article) return res.json({ error: true, originalUrl: url });
    res.json({ title: article.title || '', content: (article.textContent || '').trim(), originalUrl: url });
  } catch (err) {
    console.error('[preview]', err.message);
    res.json({ error: true, originalUrl: url });
  }
});

// ============================================
// CODE PIPELINE — check / fix / zip
// ============================================
async function runCodeCheck(files) {
  const content = files.map(f => `=== ${f.filename} ===\n${f.content}`).join('\n\n').slice(0, 8000);
  const resp = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: MODELS.GROQ_70B,
      messages: [
        { role: 'system', content: 'You are a code reviewer. Check the following files for syntax errors, obvious bugs, missing dependencies, and security issues (hardcoded secrets, eval). Respond in this exact JSON format only: { "status": "pass" or "issues", "issues": ["issue 1", "issue 2"] }. If code is fine, status is pass with empty issues array.' },
        { role: 'user', content: content }
      ],
      max_tokens: 800,
      temperature: 0
    },
    { headers: { Authorization: `Bearer ${GROQ_KEY}` }, timeout: 20000 }
  );
  const raw = resp.data?.choices?.[0]?.message?.content || '';
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/i, '').trim();
  const parsed = extractFirstJson(stripped);
  return (parsed && (parsed.status === 'pass' || parsed.status === 'issues'))
    ? parsed
    : { status: 'issues', issues: ['Could not parse check result'] };
}

app.post('/api/code-check', requireAuth, async (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'No files provided' });
  try {
    res.json(await runCodeCheck(files));
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[code-check] 70B rate-limited (429) — skipping check, treating as pass');
      return res.json({ status: 'pass' });
    }
    console.error('[code-check]', err.message);
    res.status(500).json({ error: 'Code check failed' });
  }
});

app.post('/api/code-fix', requireAuth, async (req, res) => {
  const { files, issues } = req.body;
  if (!Array.isArray(files) || files.length === 0) {
    console.log('[code-fix] rejected: no files provided');
    return res.json({ error: true, reason: 'no-files' });
  }
  const totalChars = files.reduce((sum, f) => sum + (f.content || '').length, 0);
  const issueCount = Array.isArray(issues) ? issues.length : 0;
  console.log(`[code-fix] start — files:${files.length} totalChars:${totalChars} issues:${issueCount}`);
  try {
    const content = files.map(f => `=== ${f.filename} ===\n${f.content}`).join('\n\n').slice(0, 8000);
    const issueList = (Array.isArray(issues) ? issues : []).join('\n');
    const fixSys  = 'You are a code fixer. Fix ONLY the listed issues. Do not refactor, rename, or change anything else. Return ONLY valid JSON: { "files": [{ "filename": "...", "content": "...full corrected file content..." }] }';
    const fixUser = `Issues to fix:\n${issueList}\n\nFiles:\n${content}`;

    let raw = null;
    let groqWas429 = false;

    // Try GROQ_70B first
    console.log(`[code-fix] attempting ${MODELS.GROQ_70B} (timeout:30s)...`);
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: MODELS.GROQ_70B, messages: [{ role: 'system', content: fixSys }, { role: 'user', content: fixUser }], max_tokens: 4000, temperature: 0 },
        { headers: { Authorization: `Bearer ${GROQ_KEY}` }, timeout: 30000 }
      );
      raw = resp.data?.choices?.[0]?.message?.content || '';
      const finishReason = resp.data?.choices?.[0]?.finish_reason || 'unknown';
      console.log(`[code-fix] ${MODELS.GROQ_70B} OK — finish_reason:${finishReason} rawLen:${raw.length}`);
    } catch (groqErr) {
      const status = groqErr.response?.status;
      if (status === 429) {
        groqWas429 = true;
        console.log(`[code-fix] ${MODELS.GROQ_70B} rate-limited (429) — trying Gemini Flash fallback`);
        // Fallback: Gemini Flash only — never downgrade to 8B for code fixing
        try {
          raw = await callGeminiModel(MODELS.GEM_FLASH, fixUser, fixSys, [], 4000);
          console.log(`[code-fix] Gemini Flash OK — rawLen:${raw ? raw.length : 0}`);
        } catch (gemErr) {
          console.log('[code-fix] Gemini fallback also failed:', gemErr.message);
          return res.json({ busy: true });
        }
      } else {
        console.error(`[code-fix] ${MODELS.GROQ_70B} failed — HTTP:${status ?? 'ERR'} code:${groqErr.code || '-'} msg:${groqErr.message}`);
        throw groqErr; // non-429 → outer catch
      }
    }

    console.log('[code-fix] parsing JSON response...');
    const cleanRaw = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/i, '').trim();
    const parsed = extractFirstJson(cleanRaw);
    if (!parsed || !Array.isArray(parsed.files)) {
      console.error('[code-fix] parse failed — raw preview:', (raw || '').slice(0, 500));
      return res.json({ error: true, reason: 'parse' });
    }
    console.log(`[code-fix] parse OK — outputFiles:${parsed.files.length} outputChars:${(parsed.files[0]?.content || '').length}`);
    let recheck;
    if (groqWas429) {
      // 70B was already rate-limited during the fix — skip recheck to avoid a guaranteed 429 wasted call
      console.log('[code-fix] skipping recheck — 70B rate-limited during fix');
      recheck = { status: 'check-skipped' };
    } else {
      try {
        recheck = await runCodeCheck(parsed.files);
        console.log(`[code-fix] recheck done — status:${recheck.status}`);
      } catch (recheckErr) {
        // Fix succeeded but post-fix verification call failed (e.g. 429 on second Groq call).
        // Return the corrected files anyway so they aren't silently discarded.
        console.log('[code-fix] recheck failed after successful fix:', recheckErr.message);
        return res.json({ files: parsed.files, recheck: { status: 'check-failed' } });
      }
    }
    res.json({ files: parsed.files, recheck });
  } catch (err) {
    console.error(`[code-fix] outer catch — msg:${err.message} code:${err.code || '-'}`);
    res.json({ error: true, reason: 'model' });
  }
});

app.post('/api/export-zip', requireAuth, async (req, res) => {
  const { files, projectName } = req.body;
  const pName = (projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${pName}.zip"`);
  try {
    if (!Array.isArray(files) || files.length === 0) throw new Error('no files');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { console.error('[export-zip] archiver error:', err.message); });
    archive.pipe(res);
    for (const f of files) {
      const safeFn = (f.filename || 'file.txt').replace(/\.\.[/\\]/g, '').replace(/^[/\\]+/, '') || 'file.txt';
      archive.append(Buffer.from(String(f.content || ''), 'utf8'), { name: safeFn });
    }
    await archive.finalize();
  } catch (err) {
    console.error('[export-zip] fatal:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'zip failed' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'running',
    groqKey:   GROQ_KEY   ? 'loaded ✓' : 'MISSING ✗',
    geminiKey: GEMINI_KEY ? 'loaded ✓' : 'MISSING ✗',
    tavilyKey: TAVILY_KEY ? 'loaded ✓ (search ON)' : 'MISSING (search OFF)'
  });
});

// ============================================
// TESTING PANEL — real health-check endpoint
// ============================================
const { execFile } = require('child_process');
const fs = require('fs');

const LT_RESULT_FILE = path.join(__dirname, 'load-test-result.json');
const LT_SCRIPT      = path.join(__dirname, 'load-test.js');
let ltRunning = false;

// GET /api/health-check — real server stats for the Testing panel
app.get('/api/health-check', (req, res) => {
  const mem = process.memoryUsage();
  let lastLoadTest = null;
  try { lastLoadTest = JSON.parse(fs.readFileSync(LT_RESULT_FILE, 'utf8')); } catch {}
  res.json({
    ok: true,
    build: 'v-DEBUG-1',
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb:       Math.round(mem.rss       / 1024 / 1024),
    },
    keys: { groq: !!GROQ_KEY, gemini: !!GEMINI_KEY, tavily: !!TAVILY_KEY },
    ltRunning,
    lastLoadTest,
  });
});

// POST /api/health-check/load-test — spawns load-test.js as a child process
app.post('/api/health-check/load-test', (req, res) => {
  if (ltRunning) return res.status(409).json({ error: 'Load test already running, please wait.' });
  ltRunning = true;
  execFile(process.execPath, [LT_SCRIPT, '--host', 'http://127.0.0.1:3000', '--concurrency', '50', '--json'],
    { timeout: 60000 },
    (err, stdout) => {
      ltRunning = false;
      if (err && !stdout) return res.status(500).json({ error: `Load test failed: ${err.message}` });
      try {
        const result = JSON.parse(stdout);
        if (result.error) return res.status(500).json(result);
        fs.writeFileSync(LT_RESULT_FILE, JSON.stringify(result, null, 2));
        res.json(result);
      } catch {
        res.status(500).json({ error: 'Could not parse test output', raw: stdout.slice(0, 400) });
      }
    }
  );
});

// ============================================
// QUOTA DASHBOARD — read-only snapshot
// ============================================
app.get('/api/quota', (req, res) => {
  const out = {};
  // Groq models — populated from x-ratelimit-* response headers
  [MODELS.GROQ_8B, MODELS.GROQ_70B, MODELS.GROQ_SCOUT].forEach(m => {
    const s = quotaState[m];
    out[m] = {
      type:      'groq',
      remaining: s.limit === Infinity ? null : s.remaining,
      limit:     s.limit === Infinity ? null : s.limit,
      updatedAt: s.updatedAt
    };
  });
  // Gemini models — tracked via our own daily counter (resets midnight PT)
  [MODELS.GEM_LITE, MODELS.GEM_FLASH].forEach(m => {
    const c = geminiCounters[m];
    const lim = GEMINI_DAILY_LIMITS[m];
    out[m] = {
      type:      'gemini',
      used:      c.count,
      remaining: lim - c.count,
      limit:     lim,
      updatedAt: c.updatedAt
    };
  });
  res.json(out);
});

// ============================================
// START SERVER
// ============================================
const PORT = 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('  MULTI-MODEL AI ROUTER — RUNNING!');
  console.log('==========================================');
  console.log('  Open browser: http://localhost:' + PORT);
  console.log('');
  console.log('  Groq key:   ' + (GROQ_KEY   ? 'Loaded ✓' : 'MISSING! Check .env'));
  console.log('  Gemini key: ' + (GEMINI_KEY ? 'Loaded ✓' : 'MISSING! Check .env'));
  console.log('  Tavily key: ' + (TAVILY_KEY ? 'Loaded ✓ (search ON)' : 'MISSING (search OFF)'));
  console.log('==========================================');

  // Validate every Groq model in the chain at startup — catch decommissioned/missing models
  // immediately so they're never tried at request time. Runs async; server is live while it probes.
  if (GROQ_KEY) {
    (async () => {
      console.log('[startup] Probing Groq models...');
      for (const model of _GROQ_CHAIN) {
        await new Promise(r => setTimeout(r, 400)); // avoid burst on startup
        try {
          await callGroqModel(model, 'OK', 'Reply with OK', []);
          console.log(`[startup] ✓ ${model} — alive`);
        } catch (err) {
          const status = err.response?.status;
          const msg    = err.response?.data?.error?.message || err.message || '';
          if (status === 400 && msg.includes('decommissioned')) {
            deadModels.add(model);
            console.warn(`[startup] ✗ ${model} — DECOMMISSIONED, auto-skipping in fallback chain`);
          } else if (status === 404) {
            deadModels.add(model);
            console.warn(`[startup] ✗ ${model} — NOT FOUND (no access), auto-skipping in fallback chain`);
          } else if (status === 429) {
            console.warn(`[startup] ~ ${model} — rate-limited at startup (model is alive, will retry at request time)`);
          } else {
            console.warn(`[startup] ? ${model} — HTTP ${status ?? 'ERR'}: ${msg.slice(0, 100)}`);
          }
        }
      }
      if (deadModels.size) {
        console.warn(`[startup] Dead models auto-excluded: ${[...deadModels].join(', ')}`);
      } else {
        console.log('[startup] All Groq models alive ✓');
      }
    })();
  }
});
