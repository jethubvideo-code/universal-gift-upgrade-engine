/**
 * Gift Upgrade Engine — Mini App (GitHub Pages deployable).
 *
 * GITHUB-ONLY MODE (default): reads the public snapshot docs/miniapp-data.json
 * published by the monitor workflow. NO secrets, NO private user data in the
 * frontend — target management happens via bot commands.
 *
 * SELF-HOSTED MODE: when the engine API is running, set API_BASE and the same
 * UI switches to live endpoints with Mini App initData auth.
 */
const API_BASE = window.ENGINE_API_BASE || '';
const SNAPSHOT_URL = 'miniapp-data.json';

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const $ = (id) => document.getElementById(id);
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('ru-RU'));

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- data loading ----------
async function loadSnapshot() {
  if (API_BASE) {
    // live engine API (self-hosted mode)
    const [collections, state, health] = await Promise.all([
      fetch(`${API_BASE}/api/collections`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/state`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/health`).then(r => r.json()).catch(() => ({ ok: false }))
    ]);
    return { collections, state, metrics: health.metrics || {}, health };
  }
  const res = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('snapshot not published yet');
  return res.json();
}

const HOT_STATES = ['HOT_TARGET', 'UPGRADE_READY', 'UPGRADING', 'CONFIRMING'];
const DONE_STATES = ['COMPLETED'];

function targetCard(t, states) {
  const st = states.find(s => s.collection_id === t.collection_id) || {};
  const card = document.createElement('div');
  card.className = 'card';
  const hot = HOT_STATES.includes(t.status);
  const done = DONE_STATES.includes(t.status);
  card.innerHTML = `
    <h3>🎁 ${esc(t.collection_title || t.collection_id)}</h3>
    <div class="big">#${fmt(t.target_number)}</div>
    <div class="trow"><span>Supply</span><b>${fmt(t.total_supply ?? st.total_supply)}</b></div>
    <div class="trow"><span>Upgraded</span><b>${fmt(st.upgraded_count)}/${fmt(st.total_supply)}</b></div>
    <div class="trow"><span>Next</span><b>#${fmt(st.next_expected_number)}</b></div>
    <div class="trow"><span>Auto Upgrade</span><b>${t.auto_upgrade ? 'ON' : 'OFF'}</b></div>
    ${t.auto_upgrade ? `<div class="trow"><span>Maximum</span><b>${fmt(t.max_upgrade_stars)} ⭐</b></div>` : ''}
    <span class="chip ${t.status}">${t.status}</span>
  `;
  return card;
}

function render(data) {
  const states = data.state || [];
  const targets = data.targets || [];
  const collections = data.collections || [];

  $('engineState').textContent = data.health?.ok || data.snapshot_at
    ? `engine ok · ${fmt(data.collections_monitored ?? collections.length)} collections · ${fmt(data.active_targets ?? targets.length)} targets`
    : 'offline';

  // targets tab
  const tc = $('targetCards');
  tc.innerHTML = '';
  if (!targets.length) {
    tc.innerHTML = '<p class="hint">Активных таргетов нет. Создай через бота: <code>/add &lt;collection&gt; &lt;number&gt;</code></p>';
  } else {
    for (const t of targets) tc.appendChild(targetCard(t, states));
  }

  // hot banner
  const hot = targets.find(t => HOT_STATES.includes(t.status));
  const banner = $('hotBanner');
  if (hot) {
    const st = states.find(s => s.collection_id === hot.collection_id) || {};
    const stage = hot.status === 'UPGRADE_READY' ? '⚡ UPGRADE READY'
      : DONE_STATES.includes(hot.status) ? '✅ UPGRADE COMPLETED'
      : hot.status === 'UPGRADING' || hot.status === 'CONFIRMING' ? '⚙️ UPGRADING'
      : '🔥 HOT TARGET';
    const ready = hot.status === 'UPGRADE_READY' || DONE_STATES.includes(hot.status);
    banner.className = `hot-banner ${ready ? 'ready' : ''}`;
    banner.innerHTML = `
      <div class="t">${stage}</div>
      <div><b>${esc(hot.collection_title || hot.collection_id)}</b></div>
      <div class="trow"><span>Target</span><b>#${fmt(hot.target_number)}</b></div>
      <div class="trow"><span>Upgraded</span><b>${fmt(st.upgraded_count)}</b></div>
      <div class="trow"><span>Expected</span><b>#${fmt(st.next_expected_number)}</b></div>
      <div class="trow"><span>Telegram status</span><b>${esc(hot.status)}</b></div>
    `;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // gifts tab: dynamic collections
  const gc = $('giftCards');
  gc.innerHTML = '';
  for (const c of collections.slice(0, 200)) {
    const card = document.createElement('div');
    card.className = 'card';
    const st = states.find(s => s.collection_id === c.collection_id) || {};
    card.innerHTML = `
      <h3>🎁 ${esc(c.title || c.slug || c.collection_id)}</h3>
      <div class="trow"><span>Supply</span><b>${fmt(c.total_supply)}</b></div>
      <div class="trow"><span>Upgraded</span><b>${fmt(st.upgraded_count ?? c.upgraded_count ?? 0)}</b></div>
      <div class="trow"><span>Next expected</span><b>#${fmt(st.next_expected_number)}</b></div>`;
    gc.appendChild(card);
  }

  // auto tab: targets with auto_upgrade
  const ac = $('autoCards');
  ac.innerHTML = '';
  const autos = targets.filter(t => t.auto_upgrade);
  if (!autos.length) ac.innerHTML = '<p class="hint">AUTO UPGRADE ещё не включён ни на одном таргете. Бот: <code>/auto &lt;id&gt; &lt;max_stars&gt;</code></p>';
  for (const t of autos) ac.appendChild(targetCard(t, states));

  // history
  const hl = $('historyList');
  hl.innerHTML = '';
  const events = (data.events || []).slice(-50).reverse();
  if (!events.length) hl.innerHTML = '<p class="hint">Событий пока нет.</p>';
  for (const e of events) {
    const div = document.createElement('div');
    div.className = 'ev';
    div.innerHTML = `
      <div class="evhead"><span>${esc(e.created_at || '')}</span><span>${esc(e.entity_id || e.target_id || '')}</span></div>
      <b>${esc(e.action || `${e.from_status || '∅'} → ${e.to_status}`)}</b>
      ${e.reason ? `<div class="muted">${esc(e.reason)}</div>` : ''}`;
    hl.appendChild(div);
  }

  // metrics
  const m = $('metrics');
  m.innerHTML = '';
  const metrics = data.metrics || {};
  const rows = [
    ['Collections monitored', metrics.collections_monitored],
    ['Active targets', metrics.active_targets],
    ['Hot targets', metrics.hot_targets],
    ['Upgrades (ok / fail)', `${metrics.upgrades_success ?? 0} / ${metrics.upgrades_failed ?? 0}`],
    ['Detection latency', ms(metrics.detection_latency_ms)],
    ['Verification latency', ms(metrics.verification_latency_ms)],
    ['Execution latency', ms(metrics.execution_latency_ms)],
    ['Rate-limit events', metrics.rate_limit_events]
  ];
  for (const [k, v] of rows) {
    if (v == null) continue;
    const d = document.createElement('div');
    d.className = 'trow';
    d.innerHTML = `<span>${esc(k)}</span><b>${esc(String(v))}</b>`;
    m.appendChild(d);
  }
}

function ms(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v.avg != null ? `${Math.round(v.avg)} ms` : null;
  return `${Math.round(v)} ms`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadSnapshot().then(render).catch(err => {
  $('engineState').textContent = 'snapshot unavailable';
  $('targetCards').innerHTML = `<p class="hint">Дашборд станет доступен после первого прогона мониторинга: workflow опубликует miniapp-data.json на GitHub Pages.</p>`;
  console.error(err);
});
