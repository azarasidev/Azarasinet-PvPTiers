# AzarasiPvP Tier Web（Render用）

Advanced Duels のキット別ELOレートを、ウェブで見られる Tier 一覧ページにするための
Webサービスです。依存ライブラリなし（Node標準のみ）。

## 仕組み

```
[AzarasiPvP サーバー]  連携プラグインがレート一覧を JSON で送信 (POST /api/snapshot)
        ↓ インターネット
[Render のこのアプリ]  最新スナップショットを保持して Tier を計算・表示
        ↓
[ブラウザ]  キット別タブ + Tier ごとに並んだプレイヤー一覧
```

自宅サーバーは外からアクセスできないので、サーバー側から Render へ「送る」方式です。
Tier のしきい値はゲーム内表示（PlaceholderAPI版）と揃えてあります。

## Render へのデプロイ手順

1. このフォルダの中身を GitHub リポジトリに push する。
2. Render (https://render.com) にログイン → 「New +」→「Web Service」→ そのリポジトリを選ぶ。
   - `render.yaml` があるので設定はほぼ自動で入ります。
   - Runtime: Node / Build Command: `npm install` / Start Command: `node server.js` / Plan: Free
3. Environment（環境変数）に `SNAPSHOT_SECRET` を追加する。
   - 値は好きな文字列でOK（長いランダム文字列推奨）。**連携プラグイン側にも同じ値を設定します。**
   - これが設定されていないと、スナップショットの投稿を受け付けません。
4. デプロイが終わると `https://azarasi-tier-xxxx.onrender.com` のようなURLが発行されます。
   開くとデモデータで Tier ページが表示されます（プラグイン接続前の確認用）。

### 無料プランの注意

- Render の無料 Web Service は、15分アクセスがないとスリープします。
  スリープ後にアクセスすると起動まで約1分かかります（Tier確認ページなら実用上問題なし）。
- データはメモリ保持です。サービスが再起動するとスナップショットは消えますが、
  連携プラグインが定期的に送り直すので自動で復旧します。

## API

### POST /api/snapshot（プラグイン → ここ）

ヘッダー: `Authorization: Bearer <SNAPSHOT_SECRET>`

ボディ:

```json
{
  "generatedAt": "2026-11-18T09:00:00Z",
  "kits": {
    "Axe": [
      { "name": "soujj", "rating": 1730, "wins": 25, "losses": 14 }
    ],
    "Crystal": []
  }
}
```

キット名は Advanced Duels の登録名のままでOK（大文字小文字や NetheriteOP / NethOP の表記揺れは吸収します）。

### GET /api/tiers（公開）

Tier 計算済みの JSON を返します。他の場所（Discord Bot や公式サイト等）に埋め込むとき用。

### GET /healthz

死活確認用。`ok` を返します。

## ローカルで試す

```
SNAPSHOT_SECRET=test node server.js
# http://localhost:3000 を開く
```
