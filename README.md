# 駐輪許可証リマインダー

千葉大学の無断駐輪対策として、イエローカードに貼ったQRコードを学生が読み取ると、翌朝の指定時刻にWeb Push通知が届くシステムです。

## 使い方の流れ

1. 学生がイエローカードのQRコードをスキャン
2. Webページが開き、登校時間を入力してボタンを押す
3. スマホの通知許可ダイアログが表示される
4. 翌朝その時刻に「今日は忘れずに許可証を買おう！」という通知が届く

---

## セットアップ手順

### 1. 必要なもの

- Node.js 18 以上
- npm

### 2. パッケージのインストール

```bash
cd nudge-reminder
npm install
```

### 3. VAPIDキーの生成

Web Push 通知に必要な VAPID キーを生成します（初回のみ）。

```bash
npm run generate-keys
```

以下のような出力が得られます：

```
VAPID_PUBLIC_KEY=BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA
VAPID_PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4. 環境変数の設定

#### ローカル開発の場合

プロジェクトルートに `.env` ファイルを作成して以下を記入します（`.env` は `.gitignore` に含まれているため Git にはコミットされません）：

```
VAPID_PUBLIC_KEY=（生成した公開鍵）
VAPID_PRIVATE_KEY=（生成した秘密鍵）
VAPID_EMAIL=mailto:あなたのメールアドレス@example.com
PORT=3000
```

> ⚠️ `.env` の自動読み込みには `dotenv` パッケージが必要です。ローカルのみ使う場合は次のように起動してください：

```bash
VAPID_PUBLIC_KEY="..." VAPID_PRIVATE_KEY="..." node server.js
```

または `dotenv` を追加する場合：

```bash
npm install dotenv
```

`server.js` の先頭に `require('dotenv').config();` を追加してください。

### 5. ローカルで起動

```bash
node server.js
```

ブラウザで `http://localhost:3000` を開いてください。

> **注意**: ローカル（http）では Web Push 通知は動作しません。通知のテストには HTTPS 環境が必要です。

---

## Render.com へのデプロイ

Render.com の無料プランを使用してデプロイします。

### 手順

#### 1. GitHub にリポジトリを作成してプッシュ

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/あなたのユーザー名/nudge-reminder.git
git push -u origin main
```

#### 2. Render.com でサービスを作成

1. [render.com](https://render.com) にサインアップ・ログイン
2. ダッシュボードの「**New +**」→「**Web Service**」をクリック
3. GitHubリポジトリと連携して `nudge-reminder` を選択

#### 3. サービスの設定

| 項目 | 設定値 |
|------|--------|
| **Name** | nudge-reminder（任意） |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

#### 4. 環境変数の設定

「**Environment**」タブで以下の環境変数を追加します：

| キー | 値 |
|------|----|
| `VAPID_PUBLIC_KEY` | 生成した公開鍵 |
| `VAPID_PRIVATE_KEY` | 生成した秘密鍵 |
| `VAPID_EMAIL` | `mailto:あなたのアドレス@example.com` |

#### 5. デプロイ

「**Create Web Service**」をクリックするとデプロイが始まります。数分後に `https://nudge-reminder-xxxx.onrender.com` のような URL が発行されます。

#### 6. QRコードの作成

発行された URL を [QRコードジェネレーター](https://qr.quel.jp/) などで QRコードに変換し、イエローカードに印刷して貼付します。

---

## ⚠️ Render.com 無料プランの制限事項

### スリープの問題

無料プランでは **15分間アクセスがないとサーバーがスリープ**します。スリープ中はcronジョブが動作しないため、その時間帯に設定されている通知が届かない可能性があります。

**対策：**

- **UptimeRobot**（無料）などの死活監視サービスで5分間隔でアクセスさせる
  - [uptimerobot.com](https://uptimerobot.com) でモニターを追加 → URLに `https://あなたのURL` を設定
- Render.com の有料プラン（$7/月～）にアップグレードする

### ファイルストレージの揮発性

無料プランではサーバーを再起動するとファイル（`subscriptions.json`・`logs.json`）が消えます。通知の送り損ないやログのリセットが発生する場合があります。

**研究本番運用の場合は、有料プランの「Persistent Disk」を追加することを推奨します。**

---

## ログの確認（研究用）

サーバーの動作ログは以下のエンドポイントで確認できます：

```
GET https://あなたのURL/logs          # 全ログ（JSON）
GET https://あなたのURL/logs/summary  # サマリー（件数のみ）
```

### ログの内容

| カテゴリ | 記録内容 |
|----------|----------|
| `qr_accesses` | QRページへのアクセス日時・UA |
| `subscriptions` | 通知申請日時・申請した登校時刻 |
| `notifications` | 通知送信日時・成功/失敗・エラー内容 |

---

## ファイル構成

```
nudge-reminder/
├── server.js          # Express サーバー・Cronスケジューラー
├── package.json
├── .gitignore
├── README.md
├── subscriptions.json # 購読データ（自動生成・Git管理外）
├── logs.json          # 研究ログ（自動生成・Git管理外）
└── public/
    ├── index.html     # フロントエンド（1ファイル完結）
    ├── sw.js          # Service Worker
    └── manifest.json  # PWA マニフェスト
```

---

## iOS 対応について

| 環境 | 対応状況 |
|------|----------|
| iOS 16.4 以上 / Safari / ホーム画面追加済み | ✅ 通知可能 |
| iOS 16.4 以上 / Safari / ブラウザのまま | ⚠️ ホーム画面への追加を案内 |
| iOS 16.3 以下 | ❌ 非対応メッセージを表示 |
| LINE 内ブラウザ | ❌ Safariで開くよう案内 |
| Android Chrome | ✅ 通知可能 |
