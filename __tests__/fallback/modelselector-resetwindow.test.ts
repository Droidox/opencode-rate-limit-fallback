import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelSelector } from '../../src/fallback/ModelSelector.js';
import type { PluginConfig, OpenCodeClient } from '../../src/types/index.js';

function makeConfig(): PluginConfig {
  return {
    fallbackModels: [
      { providerID: 'anthropic', modelID: 'claude-3-5-sonnet-20250514' },
      { providerID: 'google', modelID: 'gemini-2.5-pro' },
      { providerID: 'openai', modelID: 'gpt-4o' },
    ],
    cooldownMs: 60000,
    enabled: true,
    fallbackMode: 'cycle',
    enableHealthBasedSelection: false,
  } as PluginConfig;
}

describe('ModelSelector reset-window awareness', () => {
  let selector: ModelSelector;
  const client = { toast: { showToast: vi.fn() } } as unknown as OpenCodeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    selector = new ModelSelector(makeConfig(), client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the fixed cooldown when no resetAt is given (legacy behavior)', () => {
    selector.markModelRateLimited('anthropic', 'claude-3-5-sonnet-20250514');
    // Still cooling just before cooldownMs elapses.
    vi.advanceTimersByTime(59_000);
    expect(selector.getSoonestReset()).toBe(Date.now() + 1_000);
    // Recovered after cooldownMs.
    vi.advanceTimersByTime(2_000);
    expect(selector.getSoonestReset()).toBeUndefined();
  });

  it('skips a model until an explicit resetAt, overriding the fixed cooldown', () => {
    const resetAt = Date.now() + 4 * 60 * 60 * 1000; // 4h hard cap
    selector.markModelRateLimited('anthropic', 'claude-3-5-sonnet-20250514', resetAt);

    vi.advanceTimersByTime(120_000);
    expect(selector.getSoonestReset()).toBe(resetAt);

    // Recovers only once the real reset passes.
    vi.setSystemTime(resetAt + 1);
    expect(selector.getSoonestReset()).toBeUndefined();
  });

  it('getSoonestReset returns the earliest future reset across models', () => {
    const now = Date.now();
    selector.markModelRateLimited('anthropic', 'claude-3-5-sonnet-20250514', now + 3 * 3_600_000);
    selector.markModelRateLimited('google', 'gemini-2.5-pro', now + 1 * 3_600_000);
    selector.markModelRateLimited('openai', 'gpt-4o', now + 2 * 3_600_000);
    expect(selector.getSoonestReset()).toBe(now + 1 * 3_600_000);
  });

  it('selectFallbackModel honors a resetAt on the limited current model', async () => {
    const resetAt = Date.now() + 4 * 3_600_000;
    const attempted = new Set<string>();
    await selector.selectFallbackModel('anthropic', 'claude-3-5-sonnet-20250514', attempted, resetAt);
    // The current model is now cooling until resetAt, well past the 60s cooldown.
    vi.advanceTimersByTime(120_000);
    expect(selector.getSoonestReset()).toBe(resetAt);
  });
});
