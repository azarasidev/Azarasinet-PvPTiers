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

// ---- HTML ページ ----
const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AzarasiPvP Tier List</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #e8eaf0; font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
         background: radial-gradient(1100px 480px at 50% -120px, #1b2450 0%, rgba(27,36,80,0) 60%), #070a16; min-height: 100vh; }
  .px { font-family: "Press Start 2P", monospace; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 14px 40px; }
  header { padding: 30px 8px 4px; text-align: center; }
  header h1 { margin: 0; font-size: 19px; letter-spacing: .02em; color: #f2f5ff; text-shadow: 0 0 18px rgba(90,120,255,.45); }
  header h1 .seal { font-family: sans-serif; }
  header p { color: #8b96b0; margin: 10px 0 0; font-size: 12px; }
  .badge { display: inline-block; background: #7a4b12; color: #ffd9a0; border-radius: 999px; padding: 3px 12px; font-size: 12px; margin-top: 10px; }
  /* チャンピオン (キット内1位) */
  .champion { text-align: center; padding: 26px 0 4px; }
  .champ-badge { display: inline-block; font-family: "Press Start 2P", monospace; font-size: 21px; color: #ffd21f;
                 border: 2px solid rgba(255,210,31,.75); border-radius: 12px; padding: 10px 20px 8px;
                 box-shadow: 0 0 22px rgba(255,210,31,.28), inset 0 0 14px rgba(255,210,31,.12); background: rgba(20,18,4,.35); }
  .champ-imgwrap { position: relative; height: 208px; display: flex; align-items: flex-end; justify-content: center; margin-top: 6px; }
  .champ-imgwrap::before { content: ""; position: absolute; left: 50%; top: 46%; width: 340px; height: 190px; transform: translate(-50%,-50%);
                 background: radial-gradient(closest-side, rgba(255,209,63,.34), rgba(255,209,63,.08) 55%, rgba(255,209,63,0) 72%); filter: blur(2px); }
  .champ-imgwrap img { position: relative; height: 196px; image-rendering: pixelated; filter: drop-shadow(0 10px 22px rgba(0,0,0,.55)); }
  .champ-name { font-family: "Press Start 2P", monospace; font-size: 19px; color: #ffffff; margin-top: 12px; word-break: break-all; text-shadow: 0 2px 14px rgba(0,0,0,.6); }
  .champ-tier { font-size: 16px; font-weight: 700; margin-top: 8px; }
  .champ-rating { color: #8b96b0; font-size: 12px; margin-top: 5px; }
  /* キットタブ */
  .tabs { display: flex; flex-wrap: wrap; gap: 9px; justify-content: center; padding: 20px 0 4px; }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 86px;
         background: linear-gradient(180deg, #131a30, #0d1327); border: 1px solid #26304f; color: #c9d2e8;
         border-radius: 13px; padding: 11px 10px 9px; cursor: pointer; font-size: 12px; font-weight: 700; letter-spacing: .12em; }
  .tab img { width: 27px; height: 27px; image-rendering: pixelated; }
  .tab.active { border-color: #ffd21f; color: #ffe98a; background: linear-gradient(180deg, #26230f, #171708); box-shadow: 0 0 14px rgba(255,210,31,.18); }
  /* 検索・並び替え */
  .search { margin-top: 18px; }
  .search input { width: 100%; background: #0b1122; border: 1px solid #26304f; border-radius: 12px; color: #e8eaf0;
                  padding: 13px 16px; font-size: 15px; outline: none; }
  .search input:focus { border-color: #41538a; }
  .sortrow { display: flex; gap: 9px; margin-top: 11px; }
  .sortrow button { flex: 1; background: #0d1327; border: 1px solid #26304f; color: #aeb9d4; border-radius: 11px;
                    padding: 11px 0; font-size: 13px; cursor: pointer; }
  .sortrow button.active { color: #ffe98a; border-color: #ffd21f; background: #1a1807; }
  /* プレイヤーカード */
  .list { margin-top: 18px; }
  .card { position: relative; overflow: hidden; background: linear-gradient(180deg, #121830, #0d1327);
          border: 1px solid #232c47; border-radius: 15px; padding: 15px 16px 13px; margin-bottom: 12px; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: transparent; }
  .card.r1::before { background: linear-gradient(180deg, #ffe259, #ffa751); }
  .card.r2::before { background: linear-gradient(180deg, #f4f6fb, #9aa7bd); }
  .card.r3::before { background: linear-gradient(180deg, #f0a35e, #c46a2d); }
  .card-top { display: flex; align-items: center; gap: 13px; }
  .rank { font-family: "Press Start 2P", monospace; font-size: 17px; color: #c7cede; width: 42px; text-align: center; flex-shrink: 0; }
  .card.r1 .rank { color: #ffd21f; } .card.r2 .rank { color: #e8edf7; } .card.r3 .rank { color: #f0a35e; }
  .card-top img.head { width: 46px; height: 46px; border-radius: 9px; image-rendering: pixelated; background: #0b1122; flex-shrink: 0; }
  .who { min-width: 0; }
  .pname { font-family: "Press Start 2P", monospace; font-size: 13px; color: #f4f7ff; word-break: break-all; line-height: 1.5; }
  .pname .arrow { color: #5b6a8c; font-size: 12px; }
  .pname .arrow.up { color: #4ade80; }
  .pname .arrow.down { color: #f87171; }
  .pname .arrow.same { color: #5b6a8c; }
  .champ-name .arrow { font-size: 14px; }
  .champ-name .arrow.up { color: #4ade80; }
  .champ-name .arrow.down { color: #f87171; }
  .champ-name .arrow.same { color: #5b6a8c; }
  .ptier { font-size: 13.5px; font-weight: 700; margin-top: 5px; }
  .card-stats { display: flex; border-top: 1px solid #1e2742; margin-top: 13px; padding-top: 11px; }
  .stat { flex: 1; text-align: center; }
  .stat .lab { font-size: 10.5px; color: #7c87a0; letter-spacing: .08em; }
  .stat .val { font-family: "Press Start 2P", monospace; font-size: 13px; color: #dfe6ff; margin-top: 6px; }
  .empty { color: #8b96b0; text-align: center; padding: 34px 0; font-size: 14px; }
  .pager { display: flex; gap: 8px; justify-content: center; align-items: center; margin-top: 16px; flex-wrap: wrap; }
  .pager button { background: #0d1327; border: 1px solid #26304f; color: #aeb9d4; border-radius: 10px; padding: 9px 14px; font-size: 13px; cursor: pointer; }
  .pager button.active { color: #ffe98a; border-color: #ffd21f; background: #1a1807; }
  .pager button:disabled { opacity: .35; cursor: default; }
  .pager .info { color: #7c87a0; font-size: 12px; }
  /* Tier一覧 */
  .tierlist { max-width: 560px; margin: 30px auto 0; }
  .tierlist h3 { text-align: center; font-size: 14px; color: #c9d2e8; letter-spacing: .15em; margin: 0 0 12px; }
  .tierrow { display: flex; justify-content: space-between; align-items: center; background: #0d1327;
             border: 1px solid #232c47; border-radius: 11px; padding: 8px 13px; margin-bottom: 6px; font-weight: 600; font-size: 14px; }
  .tierrange { color: #8b96b0; font-size: 12.5px; white-space: nowrap; }
  footer { text-align: center; color: #525c74; font-size: 11.5px; padding: 22px 0 6px; }
  @media (max-width: 480px) {
    .pname { font-size: 11px; }
    .stat .val { font-size: 11px; }
    .champ-name { font-size: 15px; }
    header h1 { font-size: 15px; }
  }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="seal">🦭</span> <span class="px">AZARASI PVP</span></h1>
  <p id="updated">読み込み中…</p>
  <div id="demo"></div>
</header>
<nav class="tabs" id="tabs"></nav>
<section class="champion" id="champion"></section>
<div class="search"><input id="q" type="search" placeholder="🔍 プレイヤーを検索…" autocomplete="off"></div>
<div class="sortrow" id="sortrow">
  <button data-sort="rating" class="active">レート順</button>
  <button data-sort="wins">勝利数順</button>
  <button data-sort="winrate">勝率順</button>
</div>
<main class="list" id="content"></main>
<div class="pager" id="pager"></div>
<section class="tierlist"><h3>— TIER 一覧 —</h3>${TIER_LIST_HTML}</section>
<footer>AzarasiPvP — キットごとのELOレートから自動でTierを付けています</footer>
</div>
<script>
var DATA = null, currentKit = null, query = '', sortMode = 'rating', page = 1;
var PER_PAGE = 10;
function esc(s) { return String(s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function winrate(p) { if (p.wins === null || p.losses === null || (p.wins + p.losses) === 0) return null; return p.wins / (p.wins + p.losses) * 100; }
function renderTabs() {
  var tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  DATA.kits.forEach(function(kit) {
    var b = document.createElement('button');
    b.className = 'tab' + (kit.key === currentKit ? ' active' : '');
    b.innerHTML = '<img src="/icons/' + kit.key + '.png" alt="" onerror="this.style.display=\\'none\\'"><span>' + esc(kit.label.toUpperCase()) + '</span>';
    b.onclick = function() { currentKit = kit.key; page = 1; renderTabs(); renderKit(); };
    tabs.appendChild(b);
  });
  var fb = document.createElement('button');
  fb.className = 'tab' + (currentKit === 'ffa' ? ' active' : '');
  fb.innerHTML = '<img src="/icons/crystal.png" alt="" onerror="this.remove()"><span>FFA</span>';
  fb.onclick = function() { currentKit = 'ffa'; page = 1; renderTabs(); renderKit(); };
  tabs.appendChild(fb);
}
function trendHtml(p) {
  if (!p || !p.trend) return '';
  if (p.trend === 'up') return ' <span class="arrow up" title="レート上昇">▲</span>';
  if (p.trend === 'down') return ' <span class="arrow down" title="レート下降">▼</span>';
  return ' <span class="arrow same" title="変化なし">→</span>';
}
function renderChampion(kit) {
  var box = document.getElementById('champion');
  if (!kit || kit.players.length === 0) { box.innerHTML = ''; return; }
  var p = kit.players[0];
  var name = encodeURIComponent(p.name);
  box.innerHTML =
    '<div class="champ-badge">#1</div>' +
    '<div class="champ-imgwrap"><img src="https://mc-heads.net/body/' + name + '/140" alt="" ' +
    'onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src=\\'https://mc-heads.net/avatar/' + name + '/100\\';this.style.height=\\'100px\\';}else{this.style.visibility=\\'hidden\\';}"></div>' +
    '<div class="champ-name">' + esc(p.name) + trendHtml(p) + '</div>' +
    '<div class="champ-tier" style="color:' + p.tier.color + '">' + esc(p.tier.label) + '</div>' +
    '<div class="champ-rating">' + esc(kit.label) + ' レート ' + p.rating + '</div>';
}
function renderKit() {
  var kit = DATA.kits.find(function(k) { return k.key === currentKit; });
  var main = document.getElementById('content');
  if (currentKit === 'ffa') { renderFfa(main); return; }
  renderChampion(kit);
  if (!kit || kit.players.length === 0) { main.innerHTML = '<div class="empty">このキットのデータはまだありません</div>'; document.getElementById('pager').innerHTML = ''; return; }
  var rankOf = {};
  kit.players.forEach(function(p, i) { rankOf[p.name.toLowerCase()] = i + 1; });
  var players = kit.players.slice();
  if (query) players = players.filter(function(p) { return p.name.toLowerCase().indexOf(query) !== -1; });
  if (sortMode === 'wins') players.sort(function(a, b) { return (b.wins === null ? -1 : b.wins) - (a.wins === null ? -1 : a.wins) || b.rating - a.rating; });
  if (sortMode === 'winrate') players.sort(function(a, b) { var x = winrate(a), y = winrate(b); return (y === null ? -1 : y) - (x === null ? -1 : x) || b.rating - a.rating; });
  if (players.length === 0) { main.innerHTML = '<div class="empty">見つかりませんでした</div>'; document.getElementById('pager').innerHTML = ''; return; }
  var totalPages = Math.max(1, Math.ceil(players.length / PER_PAGE));
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  var pagePlayers = players.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  main.innerHTML = pagePlayers.map(function(p) {
    var rank = rankOf[p.name.toLowerCase()];
    var wr = winrate(p);
    return '<div class="card' + (rank <= 3 ? ' r' + rank : '') + '">' +
      '<div class="card-top"><div class="rank">' + rank + '</div>' +
      '<img class="head" src="https://mc-heads.net/avatar/' + encodeURIComponent(p.name) + '/92" alt="" onerror="this.style.visibility=\\'hidden\\'">' +
      '<div class="who"><div class="pname">' + esc(p.name) + trendHtml(p) + '</div>' +
      '<div class="ptier" style="color:' + p.tier.color + '">' + esc(p.tier.label) + '</div></div></div>' +
      '<div class="card-stats">' +
      '<div class="stat"><div class="lab">RATING</div><div class="val">' + p.rating.toLocaleString('en-US') + '</div></div>' +
      '<div class="stat"><div class="lab">WINS</div><div class="val">' + (p.wins === null ? '—' : p.wins) + '</div></div>' +
      '<div class="stat"><div class="lab">WIN RATE</div><div class="val">' + (wr === null ? '—' : wr.toFixed(1) + '%') + '</div></div>' +
      '</div></div>';
  }).join('');
  renderPager(players.length, totalPages);
}
var FFA = { players: [] };
function kdText(p) { if (p.kills === 0) return '0.00'; return p.deaths === 0 ? p.kills.toFixed(2) : (p.kills / p.deaths).toFixed(2); }
function renderFfa(main) {
  var champ = document.getElementById('champion');
  if (!FFA.players || FFA.players.length === 0) {
    champ.innerHTML = '';
    main.innerHTML = '<div class="empty">FFAのデータはまだありません（プラグインからの送信待ち）</div>';
    document.getElementById('pager').innerHTML = '';
    return;
  }
  var top = FFA.players[0];
  champ.innerHTML =
    '<div class="champ-badge">#1</div>' +
    '<div class="champ-imgwrap"><img src="https://mc-heads.net/body/' + encodeURIComponent(top.name) + '/140" alt="" onerror="this.remove()"></div>' +
    '<div class="champ-name">' + esc(top.name) + '</div>' +
    '<div class="champ-tier" style="color:#ff55ff">FFA チャンピオン</div>' +
    '<div class="champ-rating">Crystal FFA · ' + top.kills + ' キル</div>';
  var rankOf = {};
  FFA.players.forEach(function(p, i) { rankOf[p.name.toLowerCase()] = i + 1; });
  var players = FFA.players.slice();
  if (query) players = players.filter(function(p) { return p.name.toLowerCase().indexOf(query) !== -1; });
  if (players.length === 0) { main.innerHTML = '<div class="empty">見つかりませんでした</div>'; document.getElementById('pager').innerHTML = ''; return; }
  var totalPages = Math.max(1, Math.ceil(players.length / PER_PAGE));
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  var pagePlayers = players.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  main.innerHTML = pagePlayers.map(function(p) {
    var rank = rankOf[p.name.toLowerCase()];
    return '<div class="card' + (rank <= 3 ? ' r' + rank : '') + '">' +
      '<div class="card-top"><div class="rank">' + rank + '</div>' +
      '<img class="head" src="https://mc-heads.net/avatar/' + encodeURIComponent(p.name) + '/92" alt="" onerror="this.remove()">' +
      '<div class="who"><div class="pname">' + esc(p.name) + '</div>' +
      '<div class="ptier" style="color:#ff55ff">Crystal FFA</div></div></div>' +
      '<div class="card-stats">' +
      '<div class="stat"><div class="lab">KILLS</div><div class="val">' + p.kills + '</div></div>' +
      '<div class="stat"><div class="lab">DEATHS</div><div class="val">' + p.deaths + '</div></div>' +
      '<div class="stat"><div class="lab">K/D</div><div class="val">' + kdText(p) + '</div></div>' +
      '</div></div>';
  }).join('');
  renderPager(players.length, totalPages);
}
function renderPager(total, totalPages) {
  var box = document.getElementById('pager');
  if (totalPages <= 1) { box.innerHTML = total ? '<span class="info">全 ' + total + ' 人</span>' : ''; return; }
  var h = '<button ' + (page <= 1 ? 'disabled' : '') + ' onclick="goPage(' + (page - 1) + ')">← 前へ</button>';
  for (var i = 1; i <= totalPages; i++) {
    h += '<button class="' + (i === page ? 'active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
  }
  h += '<button ' + (page >= totalPages ? 'disabled' : '') + ' onclick="goPage(' + (page + 1) + ')">次へ →</button>';
  box.innerHTML = h;
}
function goPage(n) { page = n; renderKit(); var c = document.getElementById('content'); window.scrollTo({ top: Math.max(0, c.offsetTop - 12), behavior: 'smooth' }); }
function load() {
  fetch('/api/tiers').then(function(r) { return r.json(); }).then(function(d) {
    DATA = d;
    document.getElementById('updated').textContent = d.updatedAt
      ? '最終更新: ' + new Date(d.updatedAt).toLocaleString('ja-JP')
      : 'プラグインからのデータ待ち';
    document.getElementById('demo').innerHTML = d.demo
      ? '<span class="badge">デモデータ表示中（プラグイン未接続）</span>' : '';
    if (!currentKit || (currentKit !== 'ffa' && !d.kits.some(function(k) { return k.key === currentKit; }))) {
      currentKit = d.kits.length ? d.kits[0].key : null;
    }
    renderTabs(); renderKit();
  }).catch(function() { document.getElementById('updated').textContent = '読み込みに失敗しました'; });
}
document.getElementById('q').addEventListener('input', function(e) { query = e.target.value.trim().toLowerCase(); page = 1; if (DATA) renderKit(); });
document.getElementById('sortrow').addEventListener('click', function(e) {
  var b = e.target.closest('button'); if (!b) return;
  sortMode = b.dataset.sort; page = 1;
  document.querySelectorAll('#sortrow button').forEach(function(x) { x.classList.toggle('active', x === b); });
  if (DATA) renderKit();
});
function loadFfa() {
  fetch('/api/ffa').then(function(r) { return r.json(); }).then(function(d) {
    FFA = (d && Array.isArray(d.players)) ? d : { players: [] };
    if (DATA) { renderTabs(); if (currentKit === 'ffa') renderKit(); }
  }).catch(function() {});
}
load();
loadFfa();
setInterval(load, 60000);
setInterval(loadFfa, 60000);
</script>
</body>
</html>
`;

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
