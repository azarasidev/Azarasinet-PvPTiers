// AzarasiPvP Tier Web — Advanced Duels のレートスナップショットを受け取って Tier 一覧を表示する
// 依存ライブラリなし (Node 標準のみ)。Render の Web Service で `node server.js` で起動する。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SNAPSHOT_SECRET || '';
const FFA_SECRET = process.env['AZARASI-PVP'] || '';
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
  { html: '<span class="tierlabel" style="--tc:#ffaa00">マスターあざらし</span>', range: '2500〜' },
  { html: '<span class="tierlabel" style="--tc:#ff55ff">あざらシンメトリぃ</span> <span class="tierlabel" style="--tc:#ffaa00">++</span>', range: '2300〜2499' },
  { html: '<span class="tierlabel" style="--tc:#ff55ff">あざらシンメトリぃ</span> <span class="tierlabel" style="--tc:#ffaa00">+</span>', range: '2100〜2299' },
  { html: '<span class="tierlabel" style="--tc:#ff55ff">あざらシンメトリぃ</span>', range: '1900〜2099' },
  { html: '<span class="tierlabel" style="--tc:#55ffff">一人前アザラシ</span>', range: '1700〜1899' },
  { html: '<span class="tierlabel" style="--tc:#55ff55">半人前アザラシ</span>', range: '1500〜1699' },
  { html: '<span class="tierlabel" style="--tc:#f5f5f5">普通のアザラシ</span>', range: '1300〜1499' },
  { html: '<span class="tierlabel" style="--tc:#aaaaaa">駆け出しアザラシ</span>', range: '〜1299' },
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
const FFA_FILE = path.join(DATA_DIR, 'ffa.json');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = 'azarasi-tier-snapshot';
const UPSTASH_FFA_KEY = 'azarasi-ffa-stats';

function countPlayers(kits) {
  let n = 0;
  for (const arr of Object.values(kits || {})) if (Array.isArray(arr)) n += arr.length;
  return n;
}

// ---- マージ方式 (2026-11-20 ユーザー選択) ----
// 新しいスナップショットで丸ごと置き換えず、キット別・プレイヤー別に重ねる。
// 部分的なスナップショットが届いても、含まれていないプレイヤーは消えない。
// 同じプレイヤーが含まれていれば、新しい方のレートで上書きする。
// 注意: 引退・リセットされたプレイヤーも残り続ける (消したい場合は Upstash のデータを消す必要がある)。
function mergeKits(oldKits, newKits) {
  // kitKey -> Map(playerLower -> player)
  const byKit = new Map();
  const kitRawName = new Map(); // kitKey -> 表示用キー名
  function ingest(kits, isNew) {
    for (const [rawName, players] of Object.entries(kits || {})) {
      if (!Array.isArray(players)) continue;
      const key = normalizeKitKey(rawName);
      if (!byKit.has(key)) { byKit.set(key, new Map()); kitRawName.set(key, KIT_LABEL[key] || rawName); }
      const map = byKit.get(key);
      for (const p of players) {
        if (!p || !p.name) continue;
        const lower = String(p.name).toLowerCase();
        const prev = map.get(lower);
        const merged = prev ? { ...prev } : {};
        merged.name = String(p.name);
        if (p.trend !== undefined) merged.trend = p.trend;
        if (p.rating !== undefined && p.rating !== null) merged.rating = p.rating;
        if (isNew) {
          // 前回スナップショットのレートと比較して矢印 (trend) を決める
          if (prev && prev.rating !== undefined && prev.rating !== null
              && p.rating !== undefined && p.rating !== null) {
            merged.trend = p.rating > prev.rating ? 'up' : p.rating < prev.rating ? 'down' : 'same';
          } else if (!prev) {
            merged.trend = null; // 初登場は比較対象なし
          }
        }
        // wins/losses が新しい方で省略・null の場合は古い値を残す
        if (p.wins !== undefined && p.wins !== null) merged.wins = p.wins;
        if (p.losses !== undefined && p.losses !== null) merged.losses = p.losses;
        if (!isNew && prev) {
          // 古い側の取り込みでは既存を壊さない (通常は空から入れるので影響なし)
        }
        map.set(lower, merged);
      }
    }
  }
  ingest(oldKits, false);
  ingest(newKits, true);
  const out = {};
  for (const [key, map] of byKit.entries()) {
    out[kitRawName.get(key)] = [...map.values()];
  }
  return out;
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

let ffaData = null; // { generatedAt, players: [{name, kills, deaths}] }
let ffaAt = null;

async function persistFfa() {
  const payload = JSON.stringify({ generatedAt: ffaData.generatedAt, players: ffaData.players, ffaAt });
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try { await upstash(['SET', UPSTASH_FFA_KEY, payload]); }
    catch (e) { console.warn('[persist] FFA Upstash 保存に失敗: ' + e.message); }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FFA_FILE + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, FFA_FILE);
  } catch (e) { console.warn('[persist] FFA ファイル保存に失敗: ' + e.message); }
}

async function restoreFfa() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const out = await upstash(['GET', UPSTASH_FFA_KEY]);
      if (out && out.result) {
        const p = JSON.parse(out.result);
        if (p && Array.isArray(p.players)) {
          ffaData = { generatedAt: p.generatedAt || null, players: p.players };
          ffaAt = p.ffaAt || null;
          console.log('[persist] FFA を Upstash から復元しました (' + p.players.length + ' players)');
          return;
        }
      }
    } catch (e) { console.warn('[persist] FFA Upstash 復元に失敗: ' + e.message); }
  }
  try {
    if (fs.existsSync(FFA_FILE)) {
      const p = JSON.parse(fs.readFileSync(FFA_FILE, 'utf8'));
      if (p && Array.isArray(p.players)) {
        ffaData = { generatedAt: p.generatedAt || null, players: p.players };
        ffaAt = p.ffaAt || null;
      }
    }
  } catch (e) { console.warn('[persist] FFA ファイル復元に失敗: ' + e.message); }
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
        trend: p.trend === 'up' || p.trend === 'down' || p.trend === 'same' ? p.trend : null,
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

// ---- HTML ページ (page.html を読み込み、Tier 一覧を差し込む) ----
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
  .replace('{{TIER_LIST_HTML}}', TIER_LIST_HTML);

// ---- HTTP サーバー ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, hasData: snapshot !== null, bootId: BOOT_ID, updatedAt: snapshotAt, ffaPlayers: ffaData ? ffaData.players.length : 0,
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
        // マージ方式: 既存データに新しいスナップショットを重ねる (部分送信で人が消えない)
        const mergedKits = snapshot ? mergeKits(snapshot.kits, parsed.kits) : mergeKits({}, parsed.kits);
        snapshot = { generatedAt: parsed.generatedAt || null, kits: mergedKits };
        snapshotAt = new Date().toISOString();
        persistSnapshot().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, merged: true, players: countPlayers(mergedKits) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ffa') {
    const auth = req.headers.authorization || '';
    const okAuth = (SECRET && auth === 'Bearer ' + SECRET) || (FFA_SECRET && auth === 'Bearer ' + FFA_SECRET);
    if (!okAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || !Array.isArray(parsed.players)) throw new Error('bad shape');
        const players = parsed.players.slice(0, 1000).map((p) => ({
          name: String((p && p.name) || '').slice(0, 32),
          kills: Math.max(0, Math.floor(Number(p && p.kills) || 0)),
          deaths: Math.max(0, Math.floor(Number(p && p.deaths) || 0)),
        })).filter((p) => p.name.length > 0);
        players.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        ffaData = { generatedAt: parsed.generatedAt || null, players };
        ffaAt = new Date().toISOString();
        persistFfa().catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, players: players.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ffa') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      updatedAt: ffaAt,
      generatedAt: ffaData ? ffaData.generatedAt : null,
      players: ffaData ? ffaData.players : [],
    }));
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

  if (req.method === 'GET' && (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico' || url.pathname === '/logo.png' || url.pathname === '/apple-touch-icon.png')) {
    const file = path.join(__dirname, 'public', url.pathname === '/logo.png' ? 'logo.png' : url.pathname === '/apple-touch-icon.png' ? 'apple-touch-icon.png' : 'favicon.png');
    if (fs.existsSync(file)) {
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

Promise.all([restoreSnapshot(), restoreFfa()]).finally(() => {
  server.listen(PORT, () => console.log('azarasi-tier-web listening on ' + PORT));
});
