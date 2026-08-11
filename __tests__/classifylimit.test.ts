import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorPatternRegistry } from '../src/errors/PatternRegistry';
import { Logger } from '../logger';

describe('ErrorPatternRegistry.classifyLimit', () => {
  let registry: ErrorPatternRegistry;

  beforeEach(() => {
    registry = new ErrorPatternRegistry(new Logger({ level: 'error' }, 'Test'));
  });

  it('classifies a benign Anthropic notice as benign-notice', () => {
    const err = { message: 'You will draw from your extra usage, not your plan limits.' };
    expect(registry.classifyLimit(err, 'anthropic').limitClass).toBe('benign-notice');
  });

  it('classifies a real Anthropic rate_limit_error as account-wide', () => {
    const err = { data: { responseBody: '{"type":"rate_limit_error"}', statusCode: 429 } };
    const result = registry.classifyLimit(err, 'anthropic');
    expect(result.limitClass).toBe('account-wide');
    expect(result.provider).toBe('anthropic');
  });

  it('classifies Alibaba "Allocated quota exceeded" as per-model-transient', () => {
    const err = { message: 'Allocated quota exceeded, please try again later' };
    expect(registry.classifyLimit(err, 'alibaba').limitClass).toBe('per-model-transient');
  });

  it('classifies an error carrying a reset time as hard-cap-with-reset', () => {
    const now = 1_000_000_000_000;
    const err = { message: 'Quota exceeded. Resets in 4h.' };
    const result = registry.classifyLimit(err, 'google', now);
    expect(result.limitClass).toBe('hard-cap-with-reset');
    expect(result.resetAt).toBe(now + 4 * 3_600_000);
  });

  it('reset time takes precedence over an account-wide signal', () => {
    const now = 1_000_000_000_000;
    const err = { data: { responseBody: 'rate_limit_error; retry-after: 60', statusCode: 429 } };
    const result = registry.classifyLimit(err, 'anthropic', now);
    expect(result.limitClass).toBe('hard-cap-with-reset');
    expect(result.resetAt).toBe(now + 60_000);
  });

  it('classifies a non-error / non-object as benign-notice', () => {
    expect(registry.classifyLimit(null).limitClass).toBe('benign-notice');
    expect(registry.classifyLimit('a string').limitClass).toBe('benign-notice');
  });

  it('infers provider from the matched pattern when not supplied', () => {
    const err = { message: 'insufficient_quota: you exceeded your current quota' };
    const result = registry.classifyLimit(err);
    expect(result.provider).toBe('openai');
  });

  it('does not misclassify a benign notice even with a provider hint', () => {
    const err = { message: 'not your plan limits' };
    expect(registry.classifyLimit(err, 'anthropic').limitClass).toBe('benign-notice');
  });
});
