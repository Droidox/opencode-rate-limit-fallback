import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FallbackHandler } from '../../src/fallback/FallbackHandler.js';
import { MetricsManager } from '../../src/metrics/MetricsManager.js';
import { SubagentTracker } from '../../src/session/SubagentTracker.js';
import type { PluginConfig, OpenCodeClient } from '../../src/types/index.js';
import { Logger } from '../../logger.js';

/**
 * Same-model retry-in-place for `per-model-transient` limits.
 * The engine should retry the SAME model after a backoff (up to maxAttempts)
 * before hopping to a sibling model. Any other class (or an undefined class,
 * or sameModelRetry disabled) must jump immediately.
 */
describe('FallbackHandler — same-model retry-in-place', () => {
  let fallbackHandler: FallbackHandler;
  let mockClient: OpenCodeClient;
  let mockLogger: Logger;
  let mockMetricsManager: MetricsManager;
  let mockSubagentTracker: SubagentTracker;
  let config: PluginConfig;

  const CURRENT = { providerID: 'alibaba', modelID: 'glm-5.2-tokenplan' };
  const SIBLING = { providerID: 'alibaba', modelID: 'deepseek-v4-pro' };
  const OTHER_PROVIDER = { providerID: 'openai', modelID: 'gpt-5.4' };

  const promptedModels = () =>
    vi.mocked(mockClient.session.promptAsync).mock.calls.map(
      (c) => (c[0] as { body: { model: { providerID: string; modelID: string } } }).body.model
    );

  beforeEach(() => {
    vi.useFakeTimers();

    mockClient = {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        promptAsync: vi.fn().mockResolvedValue(undefined),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { id: 'msg1', role: 'user' },
              parts: [{ type: 'text', text: 'hello' }],
            },
          ],
        }),
      },
    } as unknown as OpenCodeClient;

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    mockMetricsManager = new MetricsManager(
      { enabled: false, output: { console: false, format: 'json', file: '' }, resetInterval: 'daily' },
      mockLogger
    );

    mockSubagentTracker = {
      getRootSession: vi.fn().mockReturnValue(null),
      getHierarchy: vi.fn().mockReturnValue(null),
      trackSubagent: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as SubagentTracker;

    config = {
      fallbackModels: [CURRENT, SIBLING, OTHER_PROVIDER],
      cooldownMs: 5000,
      enabled: true,
      fallbackMode: 'cycle',
      enableHealthBasedSelection: false,
      retryPolicy: {
        maxRetries: 5,
        strategy: 'immediate',
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterEnabled: false,
        jitterFactor: 0,
      },
      sameModelRetry: { enabled: true, maxAttempts: 2, backoffMs: 60000 },
    };

    fallbackHandler = new FallbackHandler(
      config,
      mockClient,
      mockLogger,
      mockMetricsManager,
      mockSubagentTracker
    );
  });

  afterEach(() => {
    fallbackHandler.destroy();
    vi.useRealTimers();
  });

  it('(a) per-model-transient retries the SAME model and does not jump', async () => {
    const promise = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'per-model-transient'
    );
    await vi.runAllTimersAsync();
    await promise;

    const models = promptedModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(CURRENT);
  });

  it('(b) after maxAttempts, per-model-transient jumps to the next model', async () => {
    // attempts 1 and 2 retry same model
    for (let i = 0; i < 2; i++) {
      const p = fallbackHandler.handleRateLimitFallback(
        'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'per-model-transient'
      );
      await vi.runAllTimersAsync();
      await p;
      // clear dedup window so the next call for the same message is processed
      await vi.advanceTimersByTimeAsync(6000);
    }

    // third call: same-model attempts exhausted → must jump to the sibling
    const p3 = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'per-model-transient'
    );
    await vi.runAllTimersAsync();
    await p3;

    const models = promptedModels();
    // first two are same-model retries, the last must be the sibling
    expect(models[0]).toEqual(CURRENT);
    expect(models[1]).toEqual(CURRENT);
    expect(models[models.length - 1]).toEqual(SIBLING);
  });

  it('(c) account-wide jumps immediately to a DIFFERENT provider, skipping the same-provider sibling', async () => {
    const promise = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'account-wide'
    );
    await vi.runAllTimersAsync();
    await promise;

    const models = promptedModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(OTHER_PROVIDER);
  });

  it('(e) account-wide marks ALL same-provider siblings rate-limited, not just the failing model', async () => {
    const promise = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'account-wide'
    );
    await vi.runAllTimersAsync();
    await promise;

    const modelSelector = fallbackHandler.getModelSelector();
    expect(modelSelector.isModelRateLimited(CURRENT.providerID, CURRENT.modelID)).toBe(true);
    expect(modelSelector.isModelRateLimited(SIBLING.providerID, SIBLING.modelID)).toBe(true);
    expect(modelSelector.isModelRateLimited(OTHER_PROVIDER.providerID, OTHER_PROVIDER.modelID)).toBe(false);
  });

  it('(f) fallbackMode "cycle" does not re-offer a provider-wide-skipped sibling mid-cycle', async () => {
    // First account-wide failure marks the whole alibaba provider skipped, with a
    // far-future resetAt so the skip outlives the dedup-window wait below.
    const farFutureResetAt = Date.now() + 60 * 60 * 1000;
    const promise1 = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, farFutureResetAt, 'account-wide'
    );
    await vi.runAllTimersAsync();
    await promise1;
    await vi.advanceTimersByTimeAsync(6000); // clear dedup window (cooldownMs unaffected: resetAt is far future)

    // Second fallback (from OTHER_PROVIDER, e.g. it also failed) triggers "cycle"
    // mode, which resets attemptedModels and searches from index 0 — it must NOT
    // re-offer the alibaba sibling since it is still provider-wide rate-limited.
    const promise2 = fallbackHandler.handleRateLimitFallback(
      'session-1', OTHER_PROVIDER.providerID, OTHER_PROVIDER.modelID, undefined, 'unknown-limit'
    );
    await vi.runAllTimersAsync();
    await promise2;

    const models = promptedModels();
    expect(models[models.length - 1]).not.toEqual(SIBLING);
    expect(models[models.length - 1]).not.toEqual(CURRENT);
  });

  it('(c2) undefined limitClass jumps immediately (legacy behavior)', async () => {
    const promise = fallbackHandler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID
    );
    await vi.runAllTimersAsync();
    await promise;

    const models = promptedModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(SIBLING);
  });

  it('(d) sameModelRetry.enabled=false jumps immediately even for per-model-transient', async () => {
    const disabledConfig: PluginConfig = {
      ...config,
      sameModelRetry: { enabled: false, maxAttempts: 2, backoffMs: 60000 },
    };
    const handler = new FallbackHandler(
      disabledConfig, mockClient, mockLogger, mockMetricsManager, mockSubagentTracker
    );

    const promise = handler.handleRateLimitFallback(
      'session-1', CURRENT.providerID, CURRENT.modelID, undefined, 'per-model-transient'
    );
    await vi.runAllTimersAsync();
    await promise;

    const models = promptedModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(SIBLING);
    handler.destroy();
  });
});
