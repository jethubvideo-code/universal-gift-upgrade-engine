/**
 * @file src/core/logger.js
 * Structured JSON logger with automatic secret sanitization.
 */

const SECRET_PATTERNS = [/token/i, /hash/i, /secret/i, /key/i, /auth/i, /password/i, /session/i];

/**
 * Recursively sanitize objects to sanitize sensitive data.
 * @param {*} obj
 * @returns {*}
 */
function sanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Error) {
    return { name: obj.name, message: obj.message, code: obj.code, stack: obj.stack };
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitize(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

/**
 * Create a named logger instance.
 * @param {string} name - Logger module name
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }}
 */
export function createLogger(name) {
  const log = (level, message, meta = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      logger: name,
      message: typeof message === 'string' ? message : String(message),
      ...sanitize(meta)
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  };

  return {
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    debug: (msg, meta) => log('debug', msg, meta)
  };
}
