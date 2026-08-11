/**
 * Parse a provider-supplied "reset" / "retry after" hint out of an error's text
 * into an absolute epoch-ms timestamp.
 *
 * Providers signal recovery time in inconsistent shapes. This extracts the most
 * common ones so the fallback engine can skip a limited model until it actually
 * recovers, instead of blindly re-probing after a fixed cooldown.
 */

const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

// "retry-after: 30" / "retry after 30s" / "Retry-After: 120" (HTTP header, seconds)
const RETRY_AFTER_SECONDS = /retry[-\s]?after[:\s]+(\d+)\s*(?:s|sec|secs|seconds)?\b/i;

// "resets in 4h" / "reset in 30m" / "resets in 90s" / "in 2 hours"
const RESETS_IN_RELATIVE = /reset[s]?\s+in\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|d|day|days)\b/i;

// ISO-8601 absolute timestamp, e.g. "resets 2026-09-10T00:00:00Z" or bare ISO in text.
const ISO_TIMESTAMP = /(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/;

function unitToMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('d')) return DAYS;
  if (u.startsWith('h')) return HOURS;
  if (u.startsWith('m')) return MINUTES;
  return SECONDS;
}

export class ResetWindowParser {
  /**
   * Return an absolute epoch-ms reset time parsed from the text, or undefined.
   *
   * @param now injectable clock for deterministic tests (defaults to Date.now())
   */
  static parse(text: string, now: number = Date.now()): number | undefined {
    if (!text) return undefined;

    const retryAfter = text.match(RETRY_AFTER_SECONDS);
    if (retryAfter) {
      const seconds = Number(retryAfter[1]);
      if (Number.isFinite(seconds)) return now + seconds * SECONDS;
    }

    const relative = text.match(RESETS_IN_RELATIVE);
    if (relative) {
      const value = Number(relative[1]);
      if (Number.isFinite(value)) return now + value * unitToMs(relative[2]);
    }

    const iso = text.match(ISO_TIMESTAMP);
    if (iso) {
      const parsed = Date.parse(iso[1]);
      // Only accept a resolved timestamp that is in the future relative to now.
      if (!Number.isNaN(parsed) && parsed > now) return parsed;
    }

    return undefined;
  }
}
