// AzarasiPvP Tier Web — Advanced Duels のレートスナップショットを受け取って Tier 一覧を表示する
// 依存ライブラリなし (Node 標準のみ)。Render の Web Service で `node server.js` で起動する。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SNAPSHOT_SECRET || '';
if (!SECRET) {
  console.warn('[warn] SNAPSHOT_SECRET が未設定です。この状態ではスナップショット投稿を受け付けません。');
}

// ---- Tier 定義 (ゲーム内 PAPI placeholder と同じしきい値) ----
const KIT_ORDER = ['crystal', 'smp', 'mace', 'axe', 'sword', 'nethop', 'uhc', 'pot'];
const KIT_LABEL = {
  crystal: 'Crystal', smp: 'SMP', mace: 'Mace', axe: 'Axe',
  sword: 'Sword', nethop: 'NethOP', uhc: 'UHC', pot: 'Pot',
};

function tierOf(rating) {
  if (rating < 1300) return { label: '駆け出しアザラシ', color: '#aaaaaa', rank: 7, bold: false };
  if (rating < 1500) return { label: '普通のアザラシ', color: '#f5f5f5', rank: 6, bold: false };
  if (rating < 1700) return { label: '半人前アザラシ', color: '#55ff55', rank: 5, bold: false };
  if (rating < 1900) return { label: '一人前アザラシ', color: '#55ffff', rank: 4, bold: false };
  if (rating >= 2500) return { label: 'マスターあざらし', color: '#ffaa00', rank: 0, bold: true };
  const plus = Math.floor((rating - 1900) / 200); // 0,1,2
  return {
    label: 'あざらシンメトリぃ' + (plus > 0 ? ' ' + '+'.repeat(plus) : ''),
    color: '#ff55ff', rank: 3 - plus, bold: false,
  };
}

// ---- Tier一覧（ページ下部に表示） ----
const TIER_LIST = [
  { html: '<span style="color:#ffaa00;font-weight:800">マスターあざらし</span>', range: '2500〜' },
  { html: '<span style="color:#ff55ff">あざらシンメトリぃ</span> <span style="color:#ffaa00">++</span>', range: '2300〜2499' },
  { html: '<span style="color:#ff55ff">あざらシンメトリぃ</span> <span style="color:#ffaa00">+</span>', range: '2100〜2299' },
  { html: '<span style="color:#ff55ff">あざらシンメトリぃ</span>', range: '1900〜2099' },
  { html: '<span style="color:#55ffff">一人前アザラシ</span>', range: '1700〜1899' },
  { html: '<span style="color:#55ff55">半人前アザラシ</span>', range: '1500〜1699' },
  { html: '<span style="color:#f5f5f5">普通のアザラシ</span>', range: '1300〜1499' },
  { html: '<span style="color:#aaaaaa">駆け出しアザラシ</span>', range: '〜1299' },
];
const TIER_LIST_HTML = TIER_LIST.map(t =>
  '<div class="tierrow">' + t.html + '<span class="tierrange">' + t.range + '</span></div>'
).join('');

function normalizeKitKey(name) {
  const k = String(name || '').toLowerCase().replace(/[\s_\-]/g, '');
  if (k === 'netheriteop' || k === 'nethop') return 'nethop';
  if (k === 'nodebuffpot' || k === 'pot') return 'pot';
  if (k === 'cpvp') return 'crystal';
  return k;
}

// ---- デモデータ (スナップショット未受信時に表示) ----
const DEMO = {
  generatedAt: null,
  kits: {
    Crystal: [
      { name: 'soujj', rating: 2540, wins: 61, losses: 20 },
      { name: 'demo_ace', rating: 2210, wins: 44, losses: 25 },
      { name: 'demo_mint', rating: 1960, wins: 30, losses: 22 },
      { name: 'demo_rookie', rating: 1180, wins: 3, losses: 15 },
    ],
    Axe: [
      { name: 'soujj', rating: 1730, wins: 25, losses: 14 },
      { name: 'demo_ace', rating: 1490, wins: 18, losses: 17 },
      { name: 'demo_mint', rating: 1330, wins: 9, losses: 12 },
    ],
    SMP: [
      { name: 'demo_mint', rating: 1580, wins: 15, losses: 9 },
      { name: 'demo_rookie', rating: 1410, wins: 6, losses: 6 },
    ],
  },
};

let snapshot = null;   // { generatedAt, kits: { rawKitName: [ {name, rating, wins, losses} ] } }
let snapshotAt = null; // Date received
// プロセス起動ごとに変わるID。プラグイン側が「Renderが再起動してデータが消えた」ことを検知するために使う
const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- 永続化 (Render 側でデータを保存し、再起動・再デプロイ・スリープ復帰でも消えないようにする) ----
// 保存先 (両方使える。復元は Upstash → ファイルの順に試す):
//   1) Upstash Redis — 環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN があれば使う。
//      無料枠で足りるし、Render の再デプロイでも消えないので本命はこちら。
//   2) ローカルファイル — DATA_DIR/snapshot.json。Render Disk を付けた場合はそのマウント先を
//      DATA_DIR に指定する。Disk なしだと再デプロイで消えることがある (スリープ復帰では残る)。
// どちらも無ければメモリのみ (従来動作)。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = 'azarasi-tier-snapshot';

function countPlayers(kits) {
  let n = 0;
  for (const arr of Object.values(kits || {})) if (Array.isArray(arr)) n += arr.length;
  return n;
}

async function upstash(command) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('upstash http ' + r.status);
  return r.json();
}

async function persistSnapshot() {
  const payload = JSON.stringify({ generatedAt: snapshot.generatedAt, kits: snapshot.kits, snapshotAt });
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try { await upstash(['SET', UPSTASH_KEY, payload]); }
    catch (e) { console.warn('[persist] Upstash 保存に失敗: ' + e.message); }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (e) { console.warn('[persist] ファイル保存に失敗: ' + e.message); }
}

async function restoreSnapshot() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const out = await upstash(['GET', UPSTASH_KEY]);
      if (out && out.result) {
        const p = JSON.parse(out.result);
        if (p && typeof p.kits === 'object' && countPlayers(p.kits) > 0) {
          snapshot = { generatedAt: p.generatedAt || null, kits: p.kits };
          snapshotAt = p.snapshotAt || null;
          console.log('[persist] Upstash から復元しました (' + countPlayers(p.kits) + ' players)');
          return;
        }
      }
    } catch (e) { console.warn('[persist] Upstash 復元に失敗: ' + e.message); }
  }
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const p = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (p && typeof p.kits === 'object' && countPlayers(p.kits) > 0) {
        snapshot = { generatedAt: p.generatedAt || null, kits: p.kits };
        snapshotAt = p.snapshotAt || null;
        console.log('[persist] ファイルから復元しました (' + countPlayers(p.kits) + ' players)');
      }
    }
  } catch (e) { console.warn('[persist] ファイル復元に失敗: ' + e.message); }
}

function currentData() {
  if (snapshot) return { demo: false, updatedAt: snapshotAt, generatedAt: snapshot.generatedAt, kits: snapshot.kits };
  return { demo: true, updatedAt: null, generatedAt: null, kits: DEMO.kits };
}

function buildTiers() {
  const data = currentData();
  const byKit = new Map();
  for (const [rawName, players] of Object.entries(data.kits || {})) {
    const key = normalizeKitKey(rawName);
    if (!byKit.has(key)) byKit.set(key, { key, label: KIT_LABEL[key] || rawName, players: [] });
    for (const p of players || []) {
      const rating = Number(p.rating);
      if (!p.name || !Number.isFinite(rating)) continue;
      byKit.get(key).players.push({
        name: String(p.name),
        rating: Math.round(rating),
        wins: p.wins === undefined || p.wins === null ? null : Number(p.wins) || 0,
        losses: p.losses === undefined || p.losses === null ? null : Number(p.losses) || 0,
        tier: tierOf(rating),
      });
    }
  }
  const kits = [...byKit.values()];
  for (const kit of kits) kit.players.sort((a, b) => b.rating - a.rating);
  kits.sort((a, b) => {
    const ia = KIT_ORDER.indexOf(a.key), ib = KIT_ORDER.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return { demo: data.demo, updatedAt: data.updatedAt, generatedAt: data.generatedAt, kits };
}

// ---- HTML ページ ----
const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AzarasiPvP Tier List</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #101216; color: #e8eaf0; font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  header { padding: 28px 16px 8px; text-align: center; }
  header h1 { margin: 0; font-size: 28px; letter-spacing: .04em; }
  header p { color: #9aa3b2; margin: 6px 0 0; font-size: 13px; }
  .badge { display: inline-block; background: #7a4b12; color: #ffd9a0; border-radius: 999px; padding: 2px 10px; font-size: 12px; margin-top: 8px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; padding: 16px; }
  .tab { display: flex; align-items: center; gap: 6px; background: #1b1e26; border: 1px solid #2c303c; color: #e8eaf0;
         border-radius: 10px; padding: 6px 12px; cursor: pointer; font-size: 14px; }
  .tab img { width: 22px; height: 22px; image-rendering: pixelated; }
  .tab.active { border-color: #ffaa00; background: #262019; }
  main { max-width: 720px; margin: 0 auto; padding: 0 16px 48px; }
  .tier { margin-top: 22px; }
  .tier h2 { font-size: 17px; margin: 0 0 8px; }
  .row { display: flex; align-items: center; gap: 10px; background: #171a21; border: 1px solid #262a35;
         border-radius: 10px; padding: 8px 12px; margin-bottom: 6px; }
  .row img.head { width: 28px; height: 28px; border-radius: 6px; }
  .row .name { font-weight: 600; }
  .row .meta { margin-left: auto; color: #9aa3b2; font-size: 13px; white-space: nowrap; }
  .row .rating { color: #ffd76a; font-weight: 700; }
  .empty { color: #9aa3b2; text-align: center; padding: 32px 0; }
  .tierlist { max-width: 560px; margin: 28px auto 0; padding: 0 16px; }
  .tierlist h3 { text-align: center; font-size: 15px; color: #e8eaf0; margin: 0 0 10px; }
  .tierrow { display: flex; justify-content: space-between; align-items: center; background: #171a21;
             border: 1px solid #262a35; border-radius: 10px; padding: 7px 12px; margin-bottom: 6px; font-weight: 600; }
  .tierrange { color: #9aa3b2; font-size: 13px; white-space: nowrap; }
  footer { text-align: center; color: #5c6370; font-size: 12px; padding-bottom: 24px; }
</style>
</head>
<body>
<header>
  <h1>🦭 AzarasiPvP Tier List</h1>
  <p id="updated">読み込み中…</p>
  <div id="demo"></div>
</header>
<nav class="tabs" id="tabs"></nav>
<main id="content"></main>
<section class="tierlist"><h3>Tier一覧</h3>${TIER_LIST_HTML}</section>
<footer>AzarasiPvP — kit ごとの ELO レートから自動で Tier を付けています</footer>
<script>
let DATA = null, currentKit = null;
function esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const kit of DATA.kits) {
    const b = document.createElement('button');
    b.className = 'tab' + (kit.key === currentKit ? ' active' : '');
    b.innerHTML = '<img src="/icons/' + kit.key + '.png" alt="" onerror="this.style.display=\\'none\\'"> ' + esc(kit.label);
    b.onclick = () => { currentKit = kit.key; renderTabs(); renderKit(); };
    tabs.appendChild(b);
  }
}
function renderKit() {
  const kit = DATA.kits.find(k => k.key === currentKit);
  const main = document.getElementById('content');
  if (!kit || kit.players.length === 0) { main.innerHTML = '<div class="empty">このキットのデータはまだありません</div>'; return; }
  const groups = new Map();
  for (const p of kit.players) {
    const key = p.tier.label;
    if (!groups.has(key)) groups.set(key, { tier: p.tier, players: [] });
    groups.get(key).players.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.tier.rank - b.tier.rank);
  main.innerHTML = sorted.map(g =>
    '<section class="tier"><h2 style="color:' + g.tier.color + (g.tier.bold ? ';font-weight:800' : '') + '">' + esc(g.tier.label) + '</h2>' +
    g.players.map(p =>
      '<div class="row"><img class="head" src="https://mc-heads.net/avatar/' + encodeURIComponent(p.name) + '/56" alt="" onerror="this.style.visibility=\\'hidden\\'">' +
      '<span class="name">' + esc(p.name) + '</span>' +
      '<span class="meta"><span class="rating">' + p.rating + '</span>' + (p.wins !== null && p.losses !== null ? ' · ' + p.wins + '勝 ' + p.losses + '敗' : '') + '</span></div>'
    ).join('') + '</section>'
  ).join('');
}
function load() {
  fetch('/api/tiers').then(r => r.json()).then(d => {
    DATA = d;
    document.getElementById('updated').textContent = d.updatedAt
      ? '最終更新: ' + new Date(d.updatedAt).toLocaleString('ja-JP')
      : 'プラグインからのデータ待ち';
    document.getElementById('demo').innerHTML = d.demo
      ? '<span class="badge">デモデータ表示中（プラグイン未接続）</span>' : '';
    if (!currentKit || !d.kits.some(k => k.key === currentKit)) {
      currentKit = d.kits.length ? d.kits[0].key : null;
    }
    renderTabs(); renderKit();
  }).catch(() => { document.getElementById('updated').textContent = '読み込みに失敗しました'; });
}
load();
setInterval(load, 60000);
</script>
</body>
</html>`;

// ---- HTTP サーバー ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, hasData: snapshot !== null, bootId: BOOT_ID, updatedAt: snapshotAt,
    }));
  }

  if (req.method === 'POST' && url.pathname === '/api/snapshot') {
    if (!SECRET || req.headers.authorization !== 'Bearer ' + SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.kits !== 'object') throw new Error('bad shape');
        // 空スナップショット (プレイヤー0人) は受け取っても反映しない。
        // 人が居ない時にプラグインが空データを送ってきても、保存済みランキングが消えなくなる。
        if (countPlayers(parsed.kits) === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, ignored: 'empty' }));
        }
        snapshot = { generatedAt: parsed.generatedAt || null, kits: parsed.kits };
        snapshotAt = new Date().toISOString();
        persistSnapshot().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tiers') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(buildTiers()));
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'GET' && url.pathname.startsWith('/icons/')) {
    const key = normalizeKitKey(path.basename(url.pathname, '.png'));
    const file = path.join(__dirname, 'public', 'icons', key + '.png');
    if (KIT_ORDER.includes(key) && fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

restoreSnapshot().finally(() => {
  server.listen(PORT, () => console.log('azarasi-tier-web listening on ' + PORT));
});
