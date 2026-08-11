import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/utils/helpers.js';

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('rounds up partial seconds', () => {
    expect(formatDuration(1_500)).toBe('2s');
  });

  it('formats sub-hour durations as minutes', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(30 * 60_000)).toBe('30m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('formats hour+ durations as hours (and minutes)', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
    expect(formatDuration(4 * 60 * 60_000)).toBe('4h');
    expect(formatDuration((2 * 60 + 30) * 60_000)).toBe('2h 30m');
  });

  it('clamps negative durations to 0s', () => {
    expect(formatDuration(-5_000)).toBe('0s');
  });
});
