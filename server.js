// ============================================
// MULTI-MODEL SPEED ROUTER
// Simple prompt  -> Groq   (0.3 sec, FREE!)
// Complex prompt -> Gemini (smart!)
// Tamil prompt   -> Gemini (best multilingual!)
// ============================================

console.log('SERVER BUILD: v-DEBUG-1');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const ConnectSQLite3 = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');

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

MENTOR MODE — When a user's request is VAGUE or BROAD (like "build software", "make an app", "help me code something", "software build pannanum", "app venum", "oru software venum" — without specifying what kind or what problem it solves), DO NOT immediately output generic code. Instead:
1. Ask 2-4 short clarifying questions to understand: what problem they are solving, who the users are, what type of app (web/mobile/desktop), and their goal
2. Offer 3-4 concrete example directions they could take (as a numbered list) so they can pick easily
3. Once they clarify, give a clear vision: recommended approach, tech stack, key features, and first steps
4. Be encouraging and strategic, like a mentor guiding a founder — think about real-world practicality, market fit, and what will actually succeed
5. Only give full code AFTER the direction is clear
BUT: if the user's request is already SPECIFIC (e.g. "write a Python function to reverse a string", "fix this bug", "create a login form with email and password"), answer directly with code — do NOT ask unnecessary clarifying questions.

When the user asks about an idea, plan, decision, or a "will this work?" type question, respond as a thoughtful strategic advisor:
- Give a balanced analysis with clear POSITIVES (strengths, opportunities) and NEGATIVES (risks, challenges)
- Give an honest verdict: will it likely work, and WHY
- Suggest concrete improvements or next steps
- Think about real-world practicality, market/competition, cost, and feasibility
- Be honest — if an idea has serious flaws, say so kindly but clearly

Always match the user's language style (English/Tamil/Thanglish). Be warm and clear like a caring senior developer.
For simple factual questions or greetings, answer directly without forcing any structure.`,

  app_dev: `You are ForgeAI's developer assistant.
The user wants to build/generate code or an application.
Provide clean, working code with brief explanation.`
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
- Celebrate small progress: "Nice, first step clear aaiduchu! 🎉"
- After explaining something, always check understanding with a short follow-up question like: "Ithu clear ah? Next ah enna pannanum nu solattuma?" or "Does that make sense? Ready to move to the next step?"
- Never make the user feel dumb for not knowing something

━━━ WHEN GIVING CODE (only when user explicitly asks for code) ━━━

⛔ HARD RULE — ONE FILE PER RESPONSE, NO EXCEPTIONS:
If the project needs multiple files (e.g. index.html + style.css + script.js), you MUST give ONLY ONE file's code per response. NEVER include the second file's code in the same response — not even a preview, not even a snippet. One file. Full stop.
After giving that one file, you MUST end the response with a confirmation question before continuing: e.g. "File create panniteengala? Sollunga, next CSS file pogalaam!" — and then STOP. Wait for the user to confirm before sending the next file.
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
3. Recommend ONE of them with a clear reason (e.g. "Option 1 recommend panren — beginner-ku simple ah start panna easy")
4. Ask: "Ithu try pannalama? Step-by-step guide thara sollu!" — then STOP and wait for confirmation
5. NEVER suggest Mac-only tools (e.g. Xcode, Homebrew-only tools) — always prefer cross-platform or Windows-friendly methods
6. Filter out tools that are too advanced, paid-only without free tier, or irrelevant to the user's actual goal

━━━ NO VAGUE PHRASES ━━━

⛔ NEVER use vague phrases like "it will handle it", "magic handle pannum", "automatically takes care of it" without explanation.

Every step must be either:
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
- If the user's approach has a flaw, kindly point it out and offer a better way
- Keep code comments in the user's Thanglish/Tamil style (e.g. // idhu user-a verify pannudhu)
- Be encouraging and mentor-like — like a senior developer teaching a junior
- Never give only theory when code is requested — code first, always`;

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
- Match the user's language style (English/Tamil/Thanglish)`;

// Language instructions — appended at END of system prompt for maximum effect
const langInstructions = {
  english:   'CRITICAL RULE: The user wrote in pure English. You MUST reply ONLY in pure English. Do NOT use any Tamil words or Thanglish words (like irukku, la, enna, pannu, illa, seri, venum). This rule overrides everything else.',
  tamil:     'CRITICAL RULE: The user wrote in Tamil script. You MUST reply in Tamil script (தமிழ்). Do not mix English sentences.',
  thanglish: 'CRITICAL RULE: The user wrote in Thanglish (Tamil in English letters). You MUST reply in the same casual Thanglish style. Example style: "Chennai la 15 zones irukku, traffic romba heavy a irukku". Stay in Thanglish throughout.'
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
                       'login page', 'pannunga', 'write', 'generate'];
  const isDevRequest = devKeywords.some(kw =>
    userMessage.toLowerCase().includes(kw));
  return isDevRequest ? 'app_dev' : 'casual_chat';
}

// ============================================
// WEB SEARCH — Tavily
// ============================================
function needsSearch(prompt) {
  const p = prompt.toLowerCase();

  // Year-based triggers
  if (/\b(2024|2025|2026)\b/.test(p)) return true;

  // Word-boundary check prevents false positives like 'now' matching inside 'know',
  // 'rate' inside 'separate', 'match' inside 'dispatch', etc.
  const searchTerms = [
    'today','current','latest','now','news','price','rate','recent',
    'who is','chief minister','president','prime minister','ceo','chairman',
    'stock','weather','score','match','election','winner','result',
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
async function callGroqModel(model, prompt, sysPrompt, history = []) {
  const MAX_OUT = { [MODELS.GROQ_8B]: 1500, [MODELS.GROQ_70B]: 4096, [MODELS.GROQ_SCOUT]: 8192 };
  const maxTok = MAX_OUT[model] ?? 2048;
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
async function callGeminiModel(model, prompt, sysPrompt, history = []) {
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
      generationConfig: { maxOutputTokens: 8192 }
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
// FALLBACK CHAIN
// Groq primary=70b:  70b -> 8b -> scout
// Groq primary=8b:   8b  -> 70b -> scout
// Gemini: flash <-> lite, then full Groq chain
// Skips models below 5% quota OR confirmed dead at startup.
// Applies per-model history truncation before each attempt.
// Throws only when entire chain is exhausted.
// ============================================
const _GROQ_CHAIN = [MODELS.GROQ_70B, MODELS.GROQ_8B, MODELS.GROQ_SCOUT];

async function callWithFallback(primaryModel, prompt, sysPrompt, history) {
  const isGemini = m => m.startsWith('gemini');

  let chain;
  if (isGemini(primaryModel)) {
    const alt = primaryModel === MODELS.GEM_FLASH ? MODELS.GEM_LITE : MODELS.GEM_FLASH;
    chain = [primaryModel, alt, ..._GROQ_CHAIN];
  } else {
    // Primary first, then all other Groq models in priority order.
    const others = _GROQ_CHAIN.filter(m => m !== primaryModel);
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
        ? await callGeminiModel(model, prompt, sysPrompt, safeHistory)
        : await callGroqModel(model, prompt, sysPrompt, safeHistory);
      return { reply, model };
    } catch (err) {
      const status = err.response?.status;
      console.log(`[fallback] ${model} -> HTTP ${status ?? err.code}: ${JSON.stringify(err.response?.data || err.message).slice(0, 120)}`);
      if (status === 401) throw err; // bad API key — stop immediately
      lastError = err;               // 429 / 413 / 400 / 5xx -> try next in chain
    }
  }
  throw lastError || new Error('All models in fallback chain exhausted');
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

// ============================================
// MAIN CHAT ENDPOINT — With Router!
// ============================================
app.post('/api/chat', requireAuth, async (req, res) => {
  if (rlCheck(req.session.userId, req.session.userPlan)) {
    return res.status(429).json({ error: 'Innikku 100 messages limit mudinjuchu — naaliku continue pannunga!' });
  }

  const { prompt, history, enterpriseMode, simpleMode, attachment } = req.body;
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
  if (simpleMode) {
    sysPrompt = SIMPLE_MODE_PROMPT + '\n\n' + langInstructions[lang];
  } else {
    const identity = isStudent ? STUDENT_IDENTITY
      : (lang === 'tamil' || lang === 'thanglish') ? TAMIL_CODING_IDENTITY
      : CODING_IDENTITY;
    sysPrompt = identity + '\n\n' + systemPrompts[intent] + '\n\n' + langInstructions[lang];
    isEnterprise = !!(enterpriseMode && isCodeRequest(prompt));
    if (isEnterprise) {
      sysPrompt += '\n\nENTERPRISE MODE ACTIVE — generated code must meet production standards:\n- Input validation on all user inputs\n- Proper error handling with try-catch and meaningful error messages\n- Security best practices: no hardcoded secrets, parameterized queries, XSS-safe output\n- Comments explaining key sections\n- After the code, add a short \'Production Checklist\' section listing what to verify before deploying (security, testing, environment variables)';
    }
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
  let tRewrite = 0, tTavily = 0;
  if (needsSearch(prompt) && TAVILY_KEY) {
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

  console.log(`Lang: ${lang} | Intent: ${intent} | Tokens~${estimatedTokens} | Primary: ${primaryModel} | Search: ${searched}`);
  console.log(`[router] ${decision.reason}`);

  try {
    const tModelStart = Date.now();
    const { reply, model: usedModel } = await callWithFallback(primaryModel, finalPrompt, sysPrompt, recentHistory);
    const tModel   = Date.now() - tModelStart;
    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[timing] detect=${tDetect}ms rewrite=${tRewrite}ms search=${tTavily}ms model=${tModel}ms total=${Date.now() - startTime}ms`);
    if (usedModel !== primaryModel) console.log(`[fallback] Served by ${usedModel} (primary ${primaryModel} unavailable)`);

    res.json({
      reply,
      model:      usedModel,
      reason:     decision.reason,
      time:       timeTaken + 's',
      searched,
      enterprise: isEnterprise
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
// SEARCH ENDPOINT — Tavily
// ============================================
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query is empty!' });
  }
  if (!TAVILY_KEY) {
    return res.status(503).json({ error: 'Search not configured. Add TAVILY_API_KEY to .env' });
  }
  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      { api_key: TAVILY_KEY, query: query.trim(), max_results: 6, include_answer: true },
      { timeout: 15000 }
    );
    const data = response.data;
    res.json({
      answer: data.answer || '',
      results: (data.results || []).map(r => ({
        title: r.title || '',
        url: r.url || '',
        content: (r.content || r.snippet || '').slice(0, 300)
      }))
    });
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
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
