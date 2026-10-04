export class Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }

  _labelKey(name, labels = {}) {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return name;
    const str = keys.map((k) => `${k}="${labels[k]}"`).join(',');
    return `${name}{${str}}`;
  }

  counter(name, labels = {}, inc = 1) {
    const key = this._labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + inc);
  }

  gauge(name, value, labels = {}) {
    const key = this._labelKey(name, labels);
    this.gauges.set(key, value);
  }

  observe(name, value, labels = {}) {
    const key = this._labelKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key).push(value);
  }

  snapshot() {
    const obj = {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: {}
    };
    for (const [k, vals] of this.histograms.entries()) {
      const sum = vals.reduce((a, b) => a + b, 0);
      const count = vals.length;
      const avg = count ? sum / count : 0;
      const min = count ? Math.min(...vals) : 0;
      const max = count ? Math.max(...vals) : 0;
      obj.histograms[k] = { count, sum, avg, min, max };
    }
    return obj;
  }

  renderText() {
    const lines = [];
    for (const [k, v] of this.counters.entries()) {
      lines.push(`${k} ${v}`);
    }
    for (const [k, v] of this.gauges.entries()) {
      lines.push(`${k} ${v}`);
    }
    for (const [k, vals] of this.histograms.entries()) {
      const count = vals.length;
      const sum = vals.reduce((a, b) => a + b, 0);
      lines.push(`${k}_count ${count}`);
      lines.push(`${k}_sum ${sum}`);
    }
    return lines.join('\n');
  }
}

export async function withTimer(metrics, name, labels, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    if (metrics) {
      metrics.observe(name, duration, labels);
    }
    return result;
  } catch (err) {
    const duration = performance.now() - start;
    if (metrics) {
      metrics.observe(name, duration, { ...labels, error: 'true' });
    }
    throw err;
  }
}
