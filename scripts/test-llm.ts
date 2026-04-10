/**
 * Test script — verifies Perplexity and LLM provider connectivity.
 *
 * Run: npx tsx scripts/test-llm.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config/index.js';
import { createPerplexityProvider, createLLMProvider, extractJSON } from '../src/services/llm-provider.js';
import { loadPrompt } from '../src/services/prompt-loader.js';

async function testPerplexity(): Promise<void> {
  console.log('\n── Testing Perplexity Provider ──\n');

  const provider = createPerplexityProvider(config);
  console.log(`Provider: ${provider.getName()}`);

  // Simple research query to verify connectivity
  const result = await provider.complete({
    systemPrompt: 'You are a helpful research assistant. Respond in 2-3 sentences.',
    userPrompt: 'What does Deaton Engineering in Houston, Texas do?',
    temperature: 0.1,
    maxTokens: 256,
  });

  console.log(`\nResponse:\n${result}`);
  console.log('\n✓ Perplexity provider works.\n');
}

async function testLLMProvider(): Promise<void> {
  console.log('\n── Testing General LLM Provider ──\n');

  const provider = createLLMProvider(config);
  console.log(`Provider: ${provider.getName()}`);

  const result = await provider.complete({
    systemPrompt: 'You are a JSON generator. Return only valid JSON.',
    userPrompt: 'Return a JSON object with a single field "status" set to "ok".',
    temperature: 0,
    maxTokens: 64,
    responseFormat: 'json',
  });

  console.log(`\nRaw response:\n${result}`);

  // Extract JSON (strips markdown fences if present)
  const cleaned = extractJSON(result);
  console.log(`Extracted JSON: ${cleaned}`);

  const parsed = JSON.parse(cleaned);
  console.log(`Parsed: ${JSON.stringify(parsed)}`);
  console.log('\n✓ LLM provider works and returns valid JSON.\n');
}

async function testPromptLoader(): Promise<void> {
  console.log('\n── Testing Prompt Loader ──\n');

  const { systemPrompt, userPrompt } = loadPrompt('company-research', {
    company_url: 'https://example.com',
  });

  console.log(`System prompt length: ${systemPrompt.length} chars`);
  console.log(`User prompt length: ${userPrompt.length} chars`);
  console.log(`System prompt starts with: "${systemPrompt.slice(0, 60)}..."`);
  console.log(`User prompt contains URL: ${userPrompt.includes('https://example.com')}`);
  console.log('\n✓ Prompt loader works.\n');
}

async function main(): Promise<void> {
  console.log('=== LLM Infrastructure Test ===\n');

  // Test 1: Prompt loader (no API call needed)
  await testPromptLoader();

  // Test 2: Perplexity connectivity
  await testPerplexity();

  // Test 3: General LLM provider
  await testLLMProvider();

  console.log('=== All LLM tests passed ===\n');
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
