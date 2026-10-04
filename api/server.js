/**
 * Protected HTTP API for the Mini App (zero-dep node:http).
 *
 * SECURITY: all write endpoints require validated Telegram Mini App initData
 * (HMAC-SHA256). No secrets ever live in the frontend. In GitHub-only mode
 * there is no persistent API process — the Mini App then reads a published
 * public snapshot (docs/miniapp-data.json, updated by the monitor workflow)
 * and target management happens via bot commands. This server becomes active
 * when the engine runs persistently (self-hosted mode).
 */
import { createServer } from 'node:http';
import { validateInitData } from '../src/services/miniapp-auth.js';
import { TargetStates } from '../src/core/state-machine.js';

export function createApi(engine, config) {
  const { store, targets, index, metrics } = engine;

  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });

  /** Mini App auth: official initData validation. */
  const auth = (req) => {
    const raw = req.headers['x-init-data'] || '';
    const parsed = new URLSearchParams(raw);
    const initData = parsed.get('initData') || raw;
    if (!initData) return null;
    const check = validateInitData(initData, config.BOT_TOKEN);
    return check.ok ? check : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && (path === '/api/health' || path === '/healthz')) {
        return json(res, 200, {
          ok: true,
          mode: config.MODE,
          transport: config.TRANSPORT,
          dc_id: engine.getDcId ? engine.getDcId() : null,
          metrics: metrics.snapshot(),
          collections: engine.tracked.size
        });
      }
      if (req.method === 'GET' && path === '/api/collections') {
        return json(res, 200, store.findAll('gift_collections').map(c => ({
          id: c.id, collection_id: c.collection_id, title: c.title, slug: c.slug, total_supply: c.total_supply
        })));
      }
      if (req.method === 'GET' && path === '/api/state') {
        return json(res, 200, store.findAll('collection_state'));
      }
      // ---- authenticated (Mini App initData) ----
      if (path.startsWith('/api/targets') || path === '/api/my-gifts' || path === '/api/history') {
        const session = auth(req);
        if (!session) return json(res, 401, { error: 'UNAUTHORIZED' });
        const userId = String(session.user?.id || session.userId || '');

        if (req.method === 'GET' && path === '/api/targets') {
          return json(res, 200, targets.listByUser(userId));
        }
        if (req.method === 'POST' && path === '/api/targets') {
          const body = await readBody(req);
          const num = Number(body.target_number);
          if (!Number.isInteger(num) || num < 1) return json(res, 400, { error: 'INVALID_TARGET_NUMBER' });
          if (!body.collection_id || !body.gift_id) return json(res, 400, { error: 'COLLECTION_AND_GIFT_REQUIRED' });
          const row = targets.create({
            user_id: userId,
            collection_id: String(body.collection_id),
            gift_id: String(body.gift_id),
            target_number: num,
            auto_upgrade: Boolean(body.auto_upgrade),
            max_upgrade_stars: body.max_upgrade_stars != null ? Number(body.max_upgrade_stars) : null
          });
          index.add(row);
          engine.tracked.add(row.collection_id);
          engine.monitor.track(row.collection_id);
          return json(res, 201, row);
        }
        const m = path.match(/^\/api\/targets\/([\w-]+)(\/auto-upgrade)?$/);
        if (m) {
          const target = targets.get(m[1]);
          if (!target) return json(res, 404, { error: 'NOT_FOUND' });
          if (target.user_id !== userId) return json(res, 403, { error: 'FORBIDDEN' });
          if (req.method === 'POST' && m[2]) {
            const body = await readBody(req);
            const row = targets.setAutoUpgrade(m[1], {
              auto_upgrade: Boolean(body.auto_upgrade),
              max_upgrade_stars: body.max_upgrade_stars != null ? Number(body.max_upgrade_stars) : null
            });
            index.add(row);
            return json(res, 200, row);
          }
          if (req.method === 'DELETE') {
            targets.delete(m[1]);
            index.remove(m[1]);
            return json(res, 200, { deleted: true });
          }
        }
        if (req.method === 'GET' && path === '/api/my-gifts') {
          const gifts = engine.store.findAll('gifts');
          return json(res, 200, { gifts, note: 'Saved gifts require a linked MTProto session' });
        }
        if (req.method === 'GET' && path === '/api/history') {
          const tids = new Set(targets.listByUser(userId).map(t => t.id));
          const events = store.findAll('target_events').filter(e => tids.has(e.target_id));
          return json(res, 200, events.slice(-200));
        }
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      return json(res, 500, { error: 'INTERNAL', message: err.message });
    }
  });
  return server;
}

export default createApi;
