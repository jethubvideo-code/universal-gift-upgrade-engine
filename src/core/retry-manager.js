import { EngineError, ErrorCodes } from './errors.js';

export function classifyError(err) {
  const code = err?.code || 'UNKNOWN';
  const temporaryCodes = new Set([
    ErrorCodes.FLOOD_WAIT,
    ErrorCodes.RATE_LIMIT,
    ErrorCodes.TIMEOUT,
    ErrorCodes.NETWORK_ERROR,
    ErrorCodes.LOCK_BUSY,
    ErrorCodes.SESSION_ERROR
  ]);

  const permanentCodes = new Set([
    ErrorCodes.ALREADY_UPGRADED,
    ErrorCodes.INVALID_SAVED_GIFT,
    ErrorCodes.AUTH_ERROR,
    ErrorCodes.PRICE_LIMIT_EXCEEDED,
    ErrorCodes.UPGRADE_UNAVAILABLE,
    ErrorCodes.VERIFICATION_FAILED,
    ErrorCodes.CONFIG_ERROR
  ]);

  if (temporaryCodes.has(code)) {
    return { kind: 'temporary', code };
  }
  if (permanentCodes.has(code)) {
    return { kind: 'permanent', code };
  }
  // Default non-EngineErrors or unknown errors to temporary or permanent depending on message/instance
  if (err instanceof EngineError) {
    return { kind: 'permanent', code };
  }
  return { kind: 'temporary', code };
}

export class RetryManager {
  constructor({ maxRetries = 5, baseMs = 250, maxMs = 15000 } = {}) {
    this.maxRetries = maxRetries;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }

  async run(fn, { onRetry, label } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        const { kind } = classifyError(err);
        if (kind === 'permanent' || attempt > this.maxRetries) {
          throw err;
        }

        let delay = Math.min(this.maxMs, this.baseMs * Math.pow(2, attempt - 1));
        if (err?.code === ErrorCodes.FLOOD_WAIT && err.extra?.seconds) {
          delay = err.extra.seconds * 1000;
        } else {
          // Add jitter
          delay = Math.floor(delay * (0.8 + Math.random() * 0.4));
        }

        if (onRetry) {
          onRetry(err, attempt, delay, label);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
