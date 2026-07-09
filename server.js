// ============================================
// MULTI-MODEL SPEED ROUTER
// Simple prompt  -> Groq   (0.3 sec, FREE!)
// Complex prompt -> Gemini (smart!)
// Tamil prompt   -> Gemini (best multilingual!)
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

// ============================================
// ROUTER LOGIC — The Brain!
// ============================================
function decideModel(prompt) {
  // 1. Tamil detection (Tamil unicode range)
  const hasTamil = /[\u0B80-\u0BFF]/.test(prompt);
  if (hasTamil) {
    return { model: 'gemini', reason: 'Tamil detected — Gemini handles Tamil well' };
  }

  // 2. Thanglish detection (Tamil written in English letters)
  const thanglishWords = ['enna','ethna','epdi','panu','pannu','irukku','venum',
                          'sollu','kudu','seri','illa','aagum','mudiyum','vanakkam',
                          'nandri','romba','konjam','theriyum','puriyuthu','solla',
                          'panunga','kuduga','sollunga','parunga','pakalam','mattum',
                          'ungaluku','enaku','avanga','inga','anga','yenna'];
  const words = prompt.toLowerCase().split(/\s+/);
  const hasThanglish = thanglishWords.some(w => words.includes(w));
  if (hasThanglish) {
    return { model: 'gemini', reason: 'Thanglish detected — Gemini understands better' };
  }

  // 3. Complexity detection
  const complexWords = [
    'architecture', 'design', 'security', 'optimize', 'refactor',
    'database schema', 'system design', 'authentication', 'deploy',
    'microservice', 'scale', 'performance', 'review', 'analyze',
    'explain why', 'compare', 'best practice', 'vulnerability'
  ];
  const isComplex = complexWords.some(w => prompt.toLowerCase().includes(w));
  const isLong = prompt.length > 300;

  if (isComplex || isLong) {
    return { model: 'gemini', reason: 'Complex task — Gemini is smarter' };
  }

  // 4. Default: simple = fast Groq!
  return { model: 'groq', reason: 'Simple task — Groq is fastest!' };
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

  // English / Thanglish search terms
  const searchTerms = [
    'today','current','latest','now','news','price','rate','recent',
    'who is','chief minister','president','prime minister','ceo','chairman',
    'stock','weather','score','match','election','winner','result',
    // Thanglish equivalents
    'indraiku','ipo','ippo','ippa','evlo','thandha','velai',
    'mudalvar','mudhalvar'
  ];
  if (searchTerms.some(w => p.includes(w))) return true;

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
    { timeout: 10000 }
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
        model: 'llama-3.3-70b-versatile',
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
// GROQ API CALL (Lightning fast!)
// ============================================
async function callGroq(prompt, systemPrompt, history = []) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
      ],
      max_tokens: 2048
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );
  return response.data.choices[0].message.content;
}

// ============================================
// GEMINI API CALL (Smart + Multilingual!)
// ============================================
async function callGemini(prompt, systemPrompt, history = []) {
  // Convert history: 'assistant' → 'model' (Gemini format)
  const contents = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 8192 }
    },
    { timeout: 60000 }
  );
  return response.data.candidates[0].content.parts[0].text;
}

// ============================================
// MAIN CHAT ENDPOINT — With Router!
// ============================================
app.post('/api/chat', async (req, res) => {
  const { prompt, history, enterpriseMode, simpleMode } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is empty!' });
  }

  const recentHistory = (Array.isArray(history) ? history : []).slice(-10);

  const startTime = Date.now();
  const decision = decideModel(prompt);
  const intent = detectIntent(prompt);
  const lang = detectLanguage(prompt);
  const isStudent = isStudentRequest(prompt);
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
  let finalPrompt = prompt;
  let searched = false;
  if (needsSearch(prompt) && TAVILY_KEY) {
    try {
      // Rewrite follow-up questions into standalone English queries before searching
      const searchQuery = recentHistory.length > 0
        ? await rewriteSearchQuery(prompt, recentHistory)
        : prompt;
      if (searchQuery !== prompt) {
        console.log(`Search query rewritten: "${searchQuery}" (original: "${prompt}")`);
      }
      const results = await callTavily(searchQuery);
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

  console.log(`Lang: ${lang} | Intent: ${intent} | Model: ${decision.model} | Search: ${searched}`);

  try {
    let reply;
    // Force Gemini when search context is present — better at synthesis
    const useModel = searched ? 'gemini' : decision.model;
    let usedModel = useModel;

    if (useModel === 'groq') {
      try {
        reply = await callGroq(finalPrompt, sysPrompt, recentHistory);
      } catch (groqError) {
        const groqStatus = groqError.response?.status;
        console.log(`Groq failed [HTTP ${groqStatus}]: ${groqError.message}`);
        reply = await callGemini(finalPrompt, sysPrompt, recentHistory);
        usedModel = 'gemini (fallback)';
      }
    } else {
      try {
        reply = await callGemini(finalPrompt, sysPrompt, recentHistory);
      } catch (geminiError) {
        const geminiStatus = geminiError.response?.status;
        const geminiBody = JSON.stringify(geminiError.response?.data || geminiError.message);
        console.log(`Gemini failed [HTTP ${geminiStatus}]: ${geminiBody}`);
        // Retry once on 503 (transient overload) before falling back
        if (geminiStatus === 503) {
          try {
            console.log('Retrying Gemini once after 503...');
            reply = await callGemini(finalPrompt, sysPrompt, recentHistory);
            usedModel = 'gemini';
          } catch (retryError) {
            console.log('Gemini retry also failed, falling back to Groq:', retryError.message);
            reply = await callGroq(finalPrompt, sysPrompt, recentHistory);
            usedModel = 'groq (fallback)';
          }
        } else {
          reply = await callGroq(finalPrompt, sysPrompt, recentHistory);
          usedModel = 'groq (fallback)';
        }
      }
    }

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);

    res.json({
      reply,
      model: usedModel,
      reason: decision.reason,
      time: timeTaken + 's',
      searched,
      enterprise: isEnterprise
    });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);

    let errorMsg = 'Something went wrong. Please try again.';
    if (error.response?.status === 401) {
      errorMsg = 'API key wrong! Check your .env file.';
    } else if (error.response?.status === 429) {
      errorMsg = 'High traffic right now! Please try again in a minute.';
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
});
