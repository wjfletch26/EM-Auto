/**
 * LLM Provider — abstraction layer for AI model calls.
 *
 * Supports Perplexity (with built-in web search) and any OpenAI-compatible
 * endpoint. Switching providers requires only changing env vars.
 *
 * Usage:
 *   import { createPerplexityProvider, createLLMProvider } from './llm-provider.js';
 *   const research = createPerplexityProvider(config);
 *   const analysis = createLLMProvider(config);
 */

import OpenAI from 'openai';
import { logger } from '../logging/logger.js';
import type { AppConfig } from '../config/schema.js';

// ─── Provider Interface ──────────────────────────────────────────────────────

export interface LLMCompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** 'json' asks the model to return valid JSON. Not all models support this. */
  responseFormat?: 'text' | 'json';
}

export interface LLMProvider {
  /** Send a prompt and get a completion string back. */
  complete(params: LLMCompletionParams): Promise<string>;
  /** Human-readable provider name for logging. */
  getName(): string;
}

// ─── OpenAI-Compatible Implementation ────────────────────────────────────────

class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private name: string;

  constructor(opts: { apiKey: string; baseURL: string; model: string; name: string }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
    this.model = opts.model;
    this.name = opts.name;
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const startMs = Date.now();

    logger.debug(
      { module: 'llm', provider: this.name, model: this.model },
      'LLM call starting',
    );

    try {
      // Build request options — some providers (e.g. Perplexity) don't support
      // response_format, so we only include it if the provider is known to support it.
      const requestOpts: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        temperature: params.temperature ?? 0.3,
        max_tokens: params.maxTokens ?? 4096,
      };

      const response = await this.client.chat.completions.create(requestOpts);

      const content = response.choices?.[0]?.message?.content ?? '';
      const durationMs = Date.now() - startMs;

      logger.info(
        {
          module: 'llm',
          provider: this.name,
          model: this.model,
          durationMs,
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        },
        'LLM call complete',
      );

      return content;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { module: 'llm', provider: this.name, model: this.model, error: message },
        'LLM call failed',
      );
      throw err;
    }
  }

  getName(): string {
    return this.name;
  }
}

// ─── JSON Extraction Helper ──────────────────────────────────────────────────

/**
 * Extracts JSON from an LLM response that may be wrapped in markdown fences
 * or have trailing text after the closing brace/bracket.
 * Handles: bare JSON, ```json ... ```, ``` ... ```, leading/trailing text.
 */
export function extractJSON(raw: string): string {
  let cleaned = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // If it still doesn't start with { or [, try to find the first JSON object
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const jsonStart = cleaned.search(/[\[{]/);
    if (jsonStart !== -1) {
      cleaned = cleaned.slice(jsonStart);
    }
  }

  // Trim trailing text after the JSON object/array closes.
  // Walk through the string tracking brace/bracket depth to find the real end.
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    const closeChar = cleaned.startsWith('{') ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;

      // Found the matching close — return everything up to and including it
      if (depth === 0 && ch === closeChar) {
        cleaned = cleaned.slice(0, i + 1);
        break;
      }
    }
  }

  return cleaned;
}

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Creates a Perplexity provider for company research.
 * Uses Perplexity's API which includes built-in web search.
 */
export function createPerplexityProvider(cfg: AppConfig): LLMProvider {
  if (!cfg.perplexity.apiKey) {
    throw new Error('PERPLEXITY_API_KEY is required for company research');
  }

  return new OpenAICompatibleProvider({
    apiKey: cfg.perplexity.apiKey,
    baseURL: 'https://api.perplexity.ai',
    model: cfg.perplexity.model,
    name: 'perplexity',
  });
}

/**
 * Creates a general-purpose LLM provider for analysis, generation, and review.
 * Can point to any OpenAI-compatible endpoint via LLM_BASE_URL.
 */
export function createLLMProvider(cfg: AppConfig): LLMProvider {
  if (!cfg.llm.apiKey) {
    throw new Error('LLM_API_KEY is required for the intelligence pipeline');
  }

  return new OpenAICompatibleProvider({
    apiKey: cfg.llm.apiKey,
    baseURL: cfg.llm.baseUrl,
    model: cfg.llm.model,
    name: cfg.llm.provider,
  });
}
