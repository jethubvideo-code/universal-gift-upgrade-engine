import { EngineError, ErrorCodes } from './errors.js';

export const P = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

export class TelegramRateLimiter {
  constructor({ globalPerSecond = 20, perAccountPerMethodMinIntervalMs = 1200, maxQueue = 10000 } = {}) {
    this.globalPerSecond = globalPerSecond;
    this.perAccountPerMethodMinIntervalMs = perAccountPerMethodMinIntervalMs;
    this.maxQueue = maxQueue;

    this.queue = []; // array of { account, method, priority, fn, resolve, reject }
    this.cooldowns = new Map(); // key `${account}:${method}` -> timestamp (ms) until which blocked
    this.lastExecTime = new Map(); // key `${account}:${method}` -> last exec timestamp
    this.activePerMethod = new Map(); // key `${account}:${method}` -> count
    this.processing = false;
  }

  async run({ account = 'default', method = 'default', priority = P.P3 } = {}, fn) {
    if (this.queue.length >= this.maxQueue) {
      throw new EngineError(ErrorCodes.RATE_LIMIT, 'Rate limiter queue full');
    }

    return new Promise((resolve, reject) => {
      const item = { account, method, priority, fn, resolve, reject };
      if (priority === P.P0) {
        // Find index after existing P0 items
        let idx = 0;
        while (idx < this.queue.length && this.queue[idx].priority === P.P0) {
          idx++;
        }
        this.queue.splice(idx, 0, item);
      } else {
        // Insert sorted by priority
        let idx = this.queue.length;
        while (idx > 0 && this.queue[idx - 1].priority > priority) {
          idx--;
        }
        this.queue.splice(idx, 0, item);
      }

      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      let selectedIdx = -1;

      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i];
        const key = `${item.account}:${item.method}`;
        const cd = this.cooldowns.get(key) || 0;
        if (now >= cd) {
          const last = this.lastExecTime.get(key) || 0;
          if (now - last >= this.perAccountPerMethodMinIntervalMs || item.priority === P.P0) {
            selectedIdx = i;
            break;
          }
        }
      }

      if (selectedIdx === -1) {
        // No item currently ready due to interval or cooldown
        setTimeout(() => {
          this.processing = false;
          this._processQueue();
        }, 10);
        return;
      }

      const item = this.queue.splice(selectedIdx, 1)[0];
      const key = `${item.account}:${item.method}`;

      this.lastExecTime.set(key, Date.now());
      this.activePerMethod.set(key, (this.activePerMethod.get(key) || 0) + 1);

      (async () => {
        try {
          const res = await item.fn();
          item.resolve(res);
        } catch (err) {
          if (err?.code === ErrorCodes.FLOOD_WAIT && err.extra?.seconds) {
            const cooldownUntil = Date.now() + err.extra.seconds * 1000;
            this.cooldowns.set(key, cooldownUntil);
          }
          item.reject(err);
        } finally {
          const active = (this.activePerMethod.get(key) || 1) - 1;
          if (active <= 0) this.activePerMethod.delete(key);
          else this.activePerMethod.set(key, active);
        }
      })();
    }

    this.processing = false;
  }

  stats() {
    const activePerMethodObj = {};
    for (const [k, v] of this.activePerMethod.entries()) {
      activePerMethodObj[k] = v;
    }
    return {
      queued: this.queue.length,
      activePerMethod: activePerMethodObj
    };
  }
}
