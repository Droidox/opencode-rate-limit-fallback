/**
 * Error Pattern Registry for rate limit error detection
 */

import type { ErrorPattern, LearnedPattern, PatternLearningConfig, LimitClassification } from '../types/index.js';
import type { Logger } from '../../logger.js';
import { DEFAULT_ERROR_PATTERNS_CONFIG } from '../config/defaults.js';
import { PatternLearner } from './PatternLearner.js';
import { ResetWindowParser } from './ResetWindowParser.js';

/**
 * Signals that a limit is account/plan-wide (a sibling model of the same
 * provider would hit it too) rather than per-model. Used to classify errors
 * as "account-wide" so the engine skips the whole provider (#229).
 */
const ACCOUNT_WIDE_SIGNALS: readonly (string | RegExp)[] = [
  'rate_limit_error',
  'account',
  'organization',
  'plan limit',
  'plan_limit',
  'daily limit',
  'insufficient_quota',
  'you exceeded your current quota',
];

/**
 * Signals that a limit is per-model and transient (per-minute TPM / burst that
 * recovers in ~60s), e.g. Alibaba Token Plan "Allocated quota exceeded". Used to
 * classify errors as "per-model-transient" so the engine retries the SAME model
 * after a short backoff before hopping (#225 / #229).
 */
const PER_MODEL_TRANSIENT_SIGNALS: readonly (string | RegExp)[] = [
  'allocated quota exceeded',
  'requests rate limit exceeded',
  'tokens per minute',
  'tpm',
  'requests per minute',
  'rpm',
  'high concurrency',
  'reduce concurrency',
  'too many requests',
];

/**
 * Error Pattern Registry class
 * Manages and matches error patterns for rate limit detection
 */
export class ErrorPatternRegistry {
  private patterns: ErrorPattern[] = [];
  private ignorePatterns: (string | RegExp)[] = [];
  private learnedPatterns: LearnedPattern[] = [];
  private patternLearner: PatternLearner | null = null;
  private learningConfig: PatternLearningConfig | null = null;
  // Logger is available for future use
  // @ts-ignore - Unused but kept for potential future use
  private _logger: Logger;

  constructor(
    logger?: Logger,
    ignorePatterns: readonly (string | RegExp)[] = [...(DEFAULT_ERROR_PATTERNS_CONFIG.ignorePatterns ?? [])],
  ) {
    // Initialize logger
    this._logger = logger || {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;

    this.registerDefaultPatterns();
    this.registerIgnorePatterns(ignorePatterns);
  }

  /**
   * Register default rate limit error patterns
   */
  registerDefaultPatterns(): void {
    // Common rate limit patterns (provider-agnostic)
    this.register({
      name: 'http-429',
      patterns: [/\b429\b/gi],  // HTTP 429 status code with word boundaries
      priority: 100,
    });

    this.register({
      name: 'rate-limit-general',
      patterns: [
        'rate limit',
        'rate_limit',
        'ratelimit',
        'too many requests',
        'usage limit',
        'quota exceeded',
        'usage exceeded',
        'high concurrency',
        'reduce concurrency',
      ],
      priority: 90,
    });

    // Anthropic-specific patterns
    this.register({
      name: 'anthropic-rate-limit',
      provider: 'anthropic',
      patterns: [
        'rate limit exceeded',
        'too many requests',
        'quota exceeded',
        'rate_limit_error',
        'overloaded',
      ],
      priority: 80,
    });

    // Google/Gemini-specific patterns
    this.register({
      name: 'google-rate-limit',
      provider: 'google',
      patterns: [
        'quota exceeded',
        'resource exhausted',
        'rate limit exceeded',
        'user rate limit exceeded',
        'daily limit exceeded',
        '429',
      ],
      priority: 80,
    });

    // OpenAI-specific patterns
    this.register({
      name: 'openai-rate-limit',
      provider: 'openai',
      patterns: [
        'rate limit exceeded',
        'you exceeded your current quota',
        'quota exceeded',
        'maximum requests per minute reached',
        'insufficient_quota',
      ],
      priority: 80,
    });
  }

  /**
   * Register a new error pattern
   */
  register(pattern: ErrorPattern): void {
    // Check for duplicate names
    const existingIndex = this.patterns.findIndex(p => p.name === pattern.name);
    if (existingIndex >= 0) {
      // Update existing pattern
      this.patterns[existingIndex] = pattern;
    } else {
      // Add new pattern, sorted by priority (higher priority first)
      this.patterns.push(pattern);
      this.patterns.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * Register multiple error patterns
   */
  registerMany(patterns: ErrorPattern[]): void {
    for (const pattern of patterns) {
      this.register(pattern);
    }
  }

  registerIgnorePatterns(patterns: readonly (string | RegExp)[]): void {
    this.ignorePatterns = [...patterns];
  }

  getIgnorePatterns(): (string | RegExp)[] {
    return [...this.ignorePatterns];
  }

  /**
   * Initialize pattern learning
   */
  initializePatternLearning(config: PatternLearningConfig, configFilePath: string): void {
    this.learningConfig = config;
    this.patternLearner = new PatternLearner(config, this._logger);
    this.patternLearner.setConfigFilePath(configFilePath);
  }

  /**
   * Check if pattern learning is enabled
   */
  isLearningEnabled(): boolean {
    return this.learningConfig?.enabled === true && this.patternLearner !== null;
  }

  /**
   * Get the pattern learner instance
   */
  getPatternLearner(): PatternLearner | null {
    return this.patternLearner;
  }

  /**
   * Add a learned pattern
   */
  addLearnedPattern(pattern: LearnedPattern): void {
    // Check for duplicates by name
    const existingIndex = this.learnedPatterns.findIndex(p => p.name === pattern.name);
    if (existingIndex >= 0) {
      this.learnedPatterns[existingIndex] = pattern;
    } else {
      this.learnedPatterns.push(pattern);
    }
  }

  /**
   * Get all learned patterns
   */
  getLearnedPatterns(): LearnedPattern[] {
    return [...this.learnedPatterns];
  }

  /**
   * Clear all learned patterns
   */
  clearLearnedPatterns(): void {
    this.learnedPatterns = [];
  }

  /**
   * Update learned patterns
   */
  updateLearnedPatterns(patterns: LearnedPattern[]): void {
    this.learnedPatterns = [...patterns];
  }

  /**
   * Check if an error matches any registered rate limit pattern
   */
  isRateLimitError(error: unknown): boolean {
    return this.getMatchedPattern(error) !== null;
  }

  /**
   * True for a benign ignorePattern notice with no strong rate-limit signal.
   * Consumers use this to skip side effects (e.g. circuit-breaker failures)
   * that a benign notice must not trigger.
   */
  isIgnoredError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const err = error as {
      name?: string;
      message?: string;
      data?: {
        statusCode?: number;
        message?: string;
        responseBody?: string;
      };
    };

    const responseBody = String(err.data?.responseBody || '');
    const message = String(err.data?.message || err.message || '');
    const name = String(err.name || '');
    const statusCode = err.data?.statusCode?.toString() || '';
    const allText = [responseBody, message, name, statusCode].join(' ').toLowerCase();

    if (this.hasStrongRateLimitSignal(allText)) {
      return false;
    }

    return this.matchesIgnorePattern(allText);
  }

  /**
   * Classify an error by its limit semantics (#229). Single decision point that
   * unifies the benign-notice gate with the provider-limit taxonomy so the
   * fallback engine can act correctly (ignore / retry-same / skip-provider /
   * skip-until-reset) instead of always hopping to the next model.
   */
  classifyLimit(error: unknown, provider?: string, now: number = Date.now()): LimitClassification {
    const text = this.extractErrorText(error);
    const resolvedProvider = provider || this.getMatchedPattern(error)?.provider;

    const strong = this.hasStrongRateLimitSignal(text);

    // Benign notice: an ignorePattern match with no strong rate-limit signal.
    if (!strong && this.matchesIgnorePattern(text)) {
      return { limitClass: 'benign-notice', provider: resolvedProvider };
    }

    // A reset time is the strongest signal regardless of scope — skip until it.
    const resetAt = ResetWindowParser.parse(text, now);
    if (resetAt !== undefined) {
      return { limitClass: 'hard-cap-with-reset', provider: resolvedProvider, resetAt };
    }

    // Not a rate limit at all -> nothing for the engine to do.
    if (!this.isRateLimitError(error)) {
      return { limitClass: 'benign-notice', provider: resolvedProvider };
    }

    if (this.matchesAny(text, ACCOUNT_WIDE_SIGNALS)) {
      return { limitClass: 'account-wide', provider: resolvedProvider };
    }

    if (this.matchesAny(text, PER_MODEL_TRANSIENT_SIGNALS)) {
      return { limitClass: 'per-model-transient', provider: resolvedProvider };
    }

    return { limitClass: 'unknown-limit', provider: resolvedProvider };
  }

  private extractErrorText(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return '';
    }

    const err = error as {
      name?: string;
      message?: string;
      data?: {
        statusCode?: number;
        message?: string;
        responseBody?: string;
      };
    };

    const responseBody = String(err.data?.responseBody || '');
    const message = String(err.data?.message || err.message || '');
    const name = String(err.name || '');
    const statusCode = err.data?.statusCode?.toString() || '';
    return [responseBody, message, name, statusCode].join(' ').toLowerCase();
  }

  private matchesAny(text: string, patterns: readonly (string | RegExp)[]): boolean {
    for (const pattern of patterns) {
      if (this.matchesPattern(pattern, text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the matched pattern for an error, or null if no match
   * Checks default patterns first, then learned patterns
   */
  getMatchedPattern(error: unknown): ErrorPattern | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const err = error as {
      name?: string;
      message?: string;
      data?: {
        statusCode?: number;
        message?: string;
        responseBody?: string;
      };
    };

    // Extract error text to search
    const responseBody = String(err.data?.responseBody || '');
    const message = String(err.data?.message || err.message || '');
    const name = String(err.name || '');
    const statusCode = err.data?.statusCode?.toString() || '';

    // Combine all text sources for matching
    const allText = [responseBody, message, name, statusCode].join(' ').toLowerCase();

    const hasStrongRateLimitSignal = this.hasStrongRateLimitSignal(allText);
    if (!hasStrongRateLimitSignal && this.matchesIgnorePattern(allText)) {
      return null;
    }

    // Check each pattern in default patterns first
    for (const pattern of this.patterns) {
      for (const patternStr of pattern.patterns) {
        if (this.matchesPattern(patternStr, allText)) {
          return pattern;
        }
      }
    }

    // Check learned patterns
    for (const pattern of this.learnedPatterns) {
      for (const patternStr of pattern.patterns) {
        if (this.matchesPattern(patternStr, allText)) {
          return pattern;
        }
      }
    }

    return null;
  }

  /**
   * Get all registered patterns (including learned patterns)
   */
  getAllPatterns(): ErrorPattern[] {
    return [...this.patterns, ...this.learnedPatterns];
  }

  /**
   * Get patterns for a specific provider
   */
  getPatternsForProvider(provider: string): ErrorPattern[] {
    return this.patterns.filter(p => !p.provider || p.provider === provider);
  }

  /**
   * Get patterns by name
   */
  getPatternByName(name: string): ErrorPattern | undefined {
    return this.patterns.find(p => p.name === name);
  }

  /**
   * Remove a pattern by name
   */
  removePattern(name: string): boolean {
    const index = this.patterns.findIndex(p => p.name === name);
    if (index >= 0) {
      this.patterns.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all patterns (including default ones)
   */
  clearAllPatterns(): void {
    this.patterns = [];
  }

  /**
   * Reset to default patterns only
   */
  resetToDefaults(): void {
    this.clearAllPatterns();
    this.registerDefaultPatterns();
  }

  /**
   * Get statistics about registered patterns
   */
  getStats(): { total: number; default: number; learned: number; byProvider: Record<string, number>; byPriority: Record<string, number> } {
    const byProvider: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    for (const pattern of [...this.patterns, ...this.learnedPatterns]) {
      // Count by provider
      const provider = pattern.provider || 'generic';
      byProvider[provider] = (byProvider[provider] || 0) + 1;

      // Count by priority range
      const priorityRange = this.getPriorityRange(pattern.priority);
      byPriority[priorityRange] = (byPriority[priorityRange] || 0) + 1;
    }

    return {
      total: this.patterns.length + this.learnedPatterns.length,
      default: this.patterns.length,
      learned: this.learnedPatterns.length,
      byProvider,
      byPriority,
    };
  }

  /**
   * Get a readable priority range string
   */
  private getPriorityRange(priority: number): string {
    if (priority >= 90) return 'high (90-100)';
    if (priority >= 70) return 'medium (70-89)';
    if (priority >= 50) return 'low (50-69)';
    return 'very low (<50)';
  }

  private matchesIgnorePattern(text: string): boolean {
    for (const pattern of this.ignorePatterns) {
      if (this.matchesPattern(pattern, text)) {
        return true;
      }
    }

    return false;
  }

  private hasStrongRateLimitSignal(text: string): boolean {
    return this.matchesPattern(/\b429\b/i, text) || this.matchesPattern('rate_limit_error', text);
  }

  private matchesPattern(pattern: string | RegExp, text: string): boolean {
    if (typeof pattern === 'string') {
      return text.includes(pattern.toLowerCase());
    }

    pattern.lastIndex = 0;
    return pattern.test(text);
  }
}
