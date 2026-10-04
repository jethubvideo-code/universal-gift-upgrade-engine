export class TargetScheduler {
  constructor({ concurrency = 8 } = {}) {
    this.concurrency = concurrency;
    this.tasks = new Map(); // key -> { priority, intervalMs, fn, timer }
    this.queued = [];
    this.running = 0;
  }

  schedulePoll({ key, priority = 3, intervalMs = 10000, fn }) {
    if (this.tasks.has(key)) {
      this.cancel(key);
    }

    const task = { key, priority, intervalMs, fn, timer: null };
    this.tasks.set(key, task);

    const runLoop = async () => {
      if (!this.tasks.has(key)) return;
      try {
        await this.runOnce({ key, priority: task.priority, label: key }, fn);
      } catch {
        // error handled in fn
      }
      if (this.tasks.has(key)) {
        // Adaptive interval based on priority
        let effectiveInterval = task.intervalMs;
        if (task.priority === 0) effectiveInterval = Math.min(effectiveInterval, 1000);
        else if (task.priority === 1) effectiveInterval = Math.min(effectiveInterval, 2000);
        else if (task.priority === 2) effectiveInterval = Math.min(effectiveInterval, 5000);

        task.timer = setTimeout(runLoop, effectiveInterval);
      }
    };

    task.timer = setTimeout(runLoop, 0);
  }

  setPriority(key, priority) {
    const task = this.tasks.get(key);
    if (task) {
      task.priority = priority;
    }
  }

  cancel(key) {
    const task = this.tasks.get(key);
    if (task) {
      if (task.timer) clearTimeout(task.timer);
      this.tasks.delete(key);
    }
  }

  async runOnce({ key, priority = 3, label }, fn) {
    return new Promise((resolve, reject) => {
      this.queued.push({ key, priority, label, fn, resolve, reject });
      this.queued.sort((a, b) => a.priority - b.priority); // P0 first
      this._drain();
    });
  }

  async _drain() {
    if (this.running >= this.concurrency || this.queued.length === 0) return;

    const job = this.queued.shift();
    this.running++;

    try {
      const res = await job.fn();
      job.resolve(res);
    } catch (err) {
      job.reject(err);
    } finally {
      this.running--;
      this._drain();
    }
  }

  stats() {
    return {
      tasks: this.tasks.size,
      queued: this.queued.length,
      running: this.running
    };
  }

  stopAll() {
    for (const key of Array.from(this.tasks.keys())) {
      this.cancel(key);
    }
  }
}
