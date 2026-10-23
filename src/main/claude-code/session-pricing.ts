/**
 * What one Claude Code request cost
 *
 * Claude Code writes the running total of a session only now and then (a `cost-state` line at a
 * checkpoint and when the session exits), so between those lines the transcript says nothing about
 * what the last few turns cost. Every assistant record does carry the tokens its request used, and
 * those tokens priced per model give the cost of each turn, on the day it happened - which is what
 * the usage chart needs. The totals Claude Code writes stay authoritative: `session-spending.ts`
 * prices the turns to divide a session's spending over the days, not to replace that figure.
 *
 * Prices are per million tokens, as published for the Claude API (and the OpenAI API for Codex runs). A cached write costs 1.25x the
 * input price for the five minute cache and 2x for the one hour cache, and a cached read a tenth of
 * it (the newer models have their own read price). A model that is not listed is priced at nothing,
 * so an unknown model shows up as whatever Claude Code itself reported for the session.
 */

/** Price per million tokens of one model */
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Writing to the five minute cache */
  cacheWrite5m: number;
  /** Writing to the one hour cache */
  cacheWrite1h: number;
}

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/** Longest id first: `claude-opus-5-5` must win over `claude-opus-5` */
const PRICES: Array<[string, ModelPrice]> = (
  [
    ['claude-fable-5-1', price(10, 50, 0.25)],
    ['claude-mythos-5-1', price(10, 50, 0.25)],
    ['claude-fable-5', price(10, 50, 0.25)],
    ['claude-mythos-5', price(10, 50, 0.25)],
    ['claude-opus-5-5', price(4, 20, 0.2)],
    ['claude-opus-5', price(5, 25, 0.5)],
    ['claude-opus-4-8', price(5, 25, 0.5)],
    ['claude-opus-4-7', price(5, 25, 0.5)],
    ['claude-opus-4-6', price(5, 25, 0.5)],
    ['claude-sonnet-5-5', price(2, 10, 0.2)],
    ['claude-sonnet-5', price(2, 10, 0.2)],
    ['claude-sonnet-4-6', price(3, 15, 0.3)],
    ['claude-haiku-5-5', price(0.1, 0.5, 0.01)],
    ['claude-haiku-4-5', price(1, 5, 0.1)],
    // OpenAI models Codex runs (standard tier, up to 272K input tokens); OpenAI doesn't charge cache writes
    ['gpt-6.1-sol', price(2, 10, 0.1)],
    ['gpt-6-astra', price(10, 50, 1)],
    ['gpt-6-sol', price(2, 10, 0.2)],
    ['gpt-6-luna', price(0.1, 0.5, 0.01)],
    ['gpt-5.6-sol', price(4, 20, 0.4)],
    ['gpt-5.6-terra', price(2, 12, 0.2)],
    ['gpt-5.6-luna', price(0.2, 1.2, 0.02)],
    ['gpt-5.5', price(5, 30, 0.5)],
    ['gpt-5.4-mini', price(0.75, 4.5, 0.075)],
    ['gpt-5.4', price(2.5, 15, 0.25)],
    ['gpt-5', price(1.25, 10, 0.125)],
  ] as Array<[string, ModelPrice]>
).sort(([a], [b]) => b.length - a.length);

/** What a model is called in a transcript, without a cloud provider's prefix or a date suffix */
function priceOf(model: string): ModelPrice | undefined {
  const name = model.toLowerCase().replace(/^(?:[a-z]{2}\.)?anthropic\./, '');
  return PRICES.find(([id]) => name.startsWith(id))?.[1];
}

/** The tokens one request used, as an assistant record reports them */
export interface RequestUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What one request cost, from the tokens it used. Thinking tokens are part of the output tokens
 * already, and a request on a model with no published price counts as nothing.
 */
export function requestCostUsd(model: string | undefined, usage: RequestUsage | undefined): number {
  if (!model || !usage) return 0;
  const rate = priceOf(model);
  if (!rate) return 0;

  const created = usage.cache_creation;
  // Older transcripts only say how much was written, not which cache it went to
  const write5m = created ? tokens(created.ephemeral_5m_input_tokens) : tokens(usage.cache_creation_input_tokens);
  const write1h = created ? tokens(created.ephemeral_1h_input_tokens) : 0;

  return (
    (tokens(usage.input_tokens) * rate.input +
      tokens(usage.output_tokens) * rate.output +
      tokens(usage.cache_read_input_tokens) * rate.cacheRead +
      write5m * rate.cacheWrite5m +
      write1h * rate.cacheWrite1h) /
    1_000_000
  );
}
