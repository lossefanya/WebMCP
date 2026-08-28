import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { geminiAdapter } from "./gemini.js";
import { perplexityAdapter } from "./perplexity.js";
import type { SiteAdapter } from "./types.js";

const BY_HOST: { test: RegExp; adapter: SiteAdapter }[] = [
  { test: /(^|\.)chatgpt\.com$/i, adapter: chatgptAdapter },
  { test: /(^|\.)chat\.openai\.com$/i, adapter: chatgptAdapter },
  { test: /(^|\.)claude\.ai$/i, adapter: claudeAdapter },
  { test: /(^|\.)perplexity\.ai$/i, adapter: perplexityAdapter },
  { test: /^gemini\.google\.com$/i, adapter: geminiAdapter },
];

export function adapterForHost(host: string): SiteAdapter | null {
  return BY_HOST.find((entry) => entry.test.test(host))?.adapter ?? null;
}

export type { SiteAdapter } from "./types.js";
