require('dotenv').config(); // .env ファイルから環境変数を読み込む（本番では不要）
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// VAPID 設定
// ---------------------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('');
  console.error('  [エラー] VAPID キーが設定されていません。');
  console.error('  以下のコマンドで生成してください:');
  console.error('    npm run generate-keys');
  console.error('  生成したキーを環境変数に設定してから再起動してください。');
  console.error('');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---------------------------------------------------------------------------
// データファイルのパス
// ---------------------------------------------------------------------------
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');

function initDataFiles() {
  if (!fs.existsSync(SUBS_FILE)) {
    fs.writeFileSync(SUBS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(LOGS_FILE)) {
    const initial = { qr_accesses: [], subscriptions: [], notifications: [] };
    fs.writeFileSync(LOGS_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

initDataFiles();

// ---------------------------------------------------------------------------
// ファイル操作ヘルパー
// ---------------------------------------------------------------------------
function readSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeSubs(data) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function appendLog(category, entry) {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    if (!logs[category]) logs[category] = [];
    logs[category].push({ timestamp: new Date().toISOString(), ...entry });
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('[ログ書き込みエラー]', err.message);
  }
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

// VAPID 公開鍵を返す
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// QRページアクセスのトラッキング
app.get('/track-access', (req, res) => {
  const ua = (req.headers['user-agent'] || '').slice(0, 120);
  appendLog('qr_accesses', { ua });
  res.json({ ok: true });
});

// 通知の購読登録
app.post('/subscribe', (req, res) => {
  const { subscription, scheduledTime } = req.body;

  if (!subscription?.endpoint || !scheduledTime) {
    return res.status(400).json({ error: 'subscription と scheduledTime は必須です' });
  }

  // HH:MM 形式チェック
  if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
    return res.status(400).json({ error: '時刻の形式が不正です（HH:MM）' });
  }

  const [hours, minutes] = scheduledTime.split(':').map(Number);

  // 翌朝の通知時刻を計算
  const targetAt = new Date();
  targetAt.setDate(targetAt.getDate() + 1);
  targetAt.setHours(hours, minutes, 0, 0);

  // 同じエンドポイントの古い登録を削除して上書き
  const subs = readSubs().filter(s => s.subscription.endpoint !== subscription.endpoint);
  subs.push({
    subscription,
    scheduledTime,
    targetAt: targetAt.toISOString(),
    sent: false,
    createdAt: new Date().toISOString()
  });

  writeSubs(subs);
  appendLog('subscriptions', { scheduled_time: scheduledTime });

  res.json({ ok: true, targetAt: targetAt.toISOString() });
});

// ログの確認（研究用）
app.get('/logs', (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    res.json(logs);
  } catch {
    res.status(500).json({ error: 'ログの読み込みに失敗しました' });
  }
});

// ログのサマリー（研究用）
app.get('/logs/summary', (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    const successCount = logs.notifications.filter(n => n.status === 'success').length;
    const failedCount  = logs.notifications.filter(n => n.status === 'failed').length;
    res.json({
      qr_access_count:      logs.qr_accesses.length,
      subscription_count:   logs.subscriptions.length,
      notification_success: successCount,
      notification_failed:  failedCount
    });
  } catch {
    res.status(500).json({ error: 'ログの読み込みに失敗しました' });
  }
});

// ---------------------------------------------------------------------------
// Cron: 毎分チェックして通知を送信
// ---------------------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const subs = readSubs();
  let changed = false;

  for (const sub of subs) {
    if (sub.sent) continue;
    if (new Date(sub.targetAt) > now) continue;

    const payload = JSON.stringify({
      title: '駐輪許可証のお知らせ',
      body: '今日は忘れずに許可証を買おう！'
    });

    try {
      await webpush.sendNotification(sub.subscription, payload);
      sub.sent = true;
      appendLog('notifications', { status: 'success', scheduled_time: sub.scheduledTime });
      console.log(`[${now.toISOString()}] 通知送信成功`);
    } catch (err) {
      console.error(`[${now.toISOString()}] 通知送信失敗:`, err.message);
      appendLog('notifications', {
        status: 'failed',
        error: err.message,
        statusCode: err.statusCode
      });
      // 410 Gone / 404: サブスクリプション失効 → 再送しない
      if (err.statusCode === 410 || err.statusCode === 404) {
        sub.sent = true;
      }
    }
    changed = true;
  }

  if (changed) {
    writeSubs(subs);
  }
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log('通知スケジューラー: 毎分チェック中');
});
