import { describe, it, expect } from 'vitest';
import { ResetWindowParser } from '../src/errors/ResetWindowParser';

describe('ResetWindowParser', () => {
  const NOW = 1_000_000_000_000;

  it('returns undefined for empty or non-matching text', () => {
    expect(ResetWindowParser.parse('', NOW)).toBeUndefined();
    expect(ResetWindowParser.parse('some unrelated error', NOW)).toBeUndefined();
  });

  describe('Retry-After (seconds)', () => {
    it('parses an HTTP Retry-After header value', () => {
      expect(ResetWindowParser.parse('Retry-After: 30', NOW)).toBe(NOW + 30_000);
    });

    it('parses "retry after 120s" phrasing', () => {
      expect(ResetWindowParser.parse('please retry after 120 seconds', NOW)).toBe(NOW + 120_000);
    });
  });

  describe('"resets in <n><unit>" relative', () => {
    it('parses hours', () => {
      expect(ResetWindowParser.parse('quota resets in 4h', NOW)).toBe(NOW + 4 * 3_600_000);
    });

    it('parses minutes', () => {
      expect(ResetWindowParser.parse('resets in 30 minutes', NOW)).toBe(NOW + 30 * 60_000);
    });

    it('parses seconds', () => {
      expect(ResetWindowParser.parse('reset in 90s', NOW)).toBe(NOW + 90_000);
    });

    it('parses days', () => {
      expect(ResetWindowParser.parse('resets in 2 days', NOW)).toBe(NOW + 2 * 86_400_000);
    });
  });

  describe('ISO timestamp (absolute)', () => {
    it('parses a future ISO timestamp', () => {
      const future = new Date(NOW + 86_400_000).toISOString();
      expect(ResetWindowParser.parse(`resets ${future}`, NOW)).toBe(Date.parse(future));
    });

    it('ignores a past ISO timestamp', () => {
      const past = new Date(NOW - 86_400_000).toISOString();
      expect(ResetWindowParser.parse(`was at ${past}`, NOW)).toBeUndefined();
    });
  });

  it('prefers Retry-After over a relative phrase when both present', () => {
    expect(ResetWindowParser.parse('Retry-After: 10; resets in 4h', NOW)).toBe(NOW + 10_000);
  });
});
