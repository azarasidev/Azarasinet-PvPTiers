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
- データは Render 側に保存されます（下記「データの永続化」参照）。再起動・再デプロイでも消えません。
- プレイヤー0人の「空スナップショット」が届いても、保存済みデータは上書きされません
  （人が居ない時にプラグインが空データを送ってもランキングが消えないための仕様です）。

## データの永続化（消えないようにする）

保存先は2つあり、両方使えます（復元は Upstash → ファイルの順）。

### 1) Upstash Redis（推奨・無料・再デプロイでも消えない）

1. https://upstash.com で無料アカウントを作る（GitHubログイン可）。
2. 「Create Database」で Redis データベースを作成（Region は近い所でOK、プランは Free）。
3. データベース画面の「REST API」欄にある **UPSTASH_REDIS_REST_URL** と **UPSTASH_REDIS_REST_TOKEN** をコピー。
4. Render のこのサービスの「Environment」に、その2つを環境変数として追加する。
5. 再デプロイされれば有効。以後、スナップショットは Upstash に保存され、
   Render が再起動・再デプロイしても自動で復元されます。

### 2) ローカルファイル（DATA_DIR）

- 受信したスナップショットは `DATA_DIR/snapshot.json`（既定: アプリ内 `data/`）にも保存されます。
- Render の無料プランではアプリ内ファイルは再デプロイで消えることがあるため、単体では保険程度です。
- Render Disk（有料）を使う場合は、Disk のマウントパスを環境変数 `DATA_DIR` に指定してください。

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
`wins` / `losses` は省略可能です（省略した場合はレートとTierのみ表示されます）。
AzarasiKitHat プラグインの Web同期はこの形式で送信します。

### GET /api/tiers（公開）

Tier 計算済みの JSON を返します。他の場所（Discord Bot や公式サイト等）に埋め込むとき用。

### GET /healthz

死活確認用。`ok` を返します。

## ローカルで試す

```
SNAPSHOT_SECRET=test node server.js
# http://localhost:3000 を開く
```
