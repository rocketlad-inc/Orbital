// ============================================================
// AI assistants as a traffic source. Plain JS so the worker can import
// it too (worker/attribution.js names the source; the admin dashboard
// groups them).
//
// ChatGPT tags its links ?utm_source=chatgpt.com, so that tag is the
// name already in the data, and the other assistants follow the same
// host-style naming. Each assistant lands on ONE name whichever way it
// arrives (tag or referrer), and every name is listed in AI_SOURCES.
//
// Order matters in AI_HOSTS: these run BEFORE the search engines, or
// gemini.google.com would count as Google search and copilot.microsoft
// .com would keep its raw host.
// ============================================================

/** Referring host -> the assistant's source name. */
export const AI_HOSTS = [
  [/^(chatgpt\.com|chat\.openai\.com)$/, 'chatgpt.com'],
  [/(^|\.)perplexity\.ai$/, 'perplexity.ai'],
  [/^claude\.ai$/, 'claude.ai'],
  [/^gemini\.google\.com$|^bard\.google\.com$/, 'gemini.google.com'],
  [/^copilot\.microsoft\.com$|^copilot\.cloud\.microsoft$/, 'copilot.microsoft.com'],
  [/(^|\.)deepseek\.com$/, 'deepseek.com'],
  [/^grok\.com$/, 'grok.com'],
  [/^(www\.)?meta\.ai$/, 'meta.ai'],
  [/^(www\.)?you\.com$/, 'you.com'],
  [/^(www\.)?phind\.com$/, 'phind.com'],
  [/^chat\.mistral\.ai$/, 'mistral.ai'],
];

/** utm_source spellings the assistants (or people) use -> the same names. */
const AI_TAGS = {
  chatgpt: 'chatgpt.com', 'chat.openai.com': 'chatgpt.com',
  perplexity: 'perplexity.ai', claude: 'claude.ai', gemini: 'gemini.google.com',
  copilot: 'copilot.microsoft.com', deepseek: 'deepseek.com', grok: 'grok.com',
};

/** Every name an AI assistant is stored under. */
export const AI_SOURCES = new Set(AI_HOSTS.map(([, name]) => name));

/** A cleaned host or tag -> the assistant's name, or null. */
export function aiSourceName(token) {
  if (!token) return null;
  if (AI_SOURCES.has(token)) return token;
  if (AI_TAGS[token]) return AI_TAGS[token];
  for (const [re, name] of AI_HOSTS) if (re.test(token)) return name;
  return null;
}

/** True for a stored source that is an AI assistant. */
export const isAiSource = (source) => AI_SOURCES.has(source);

/** The group's name on the dashboard. */
export const AI_GROUP = 'ai-assistants';
