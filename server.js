require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// VAPID 設定（オプション：Web Push用）
// ---------------------------------------------------------------------------
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ---------------------------------------------------------------------------
// メール設定
// ---------------------------------------------------------------------------
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  console.log('メール送信: 有効');
} else {
  console.warn('警告: SMTP_USER / SMTP_PASS が未設定です。メール送信は無効です。');
}

// ---------------------------------------------------------------------------
// データファイル
// ---------------------------------------------------------------------------
const EMAIL_SUBS_FILE = path.join(__dirname, 'email_subscriptions.json');
const PUSH_SUBS_FILE  = path.join(__dirname, 'subscriptions.json');
const LOGS_FILE       = path.join(__dirname, 'logs.json');

function initDataFiles() {
  if (!fs.existsSync(EMAIL_SUBS_FILE)) fs.writeFileSync(EMAIL_SUBS_FILE, '[]', 'utf8');
  if (!fs.existsSync(PUSH_SUBS_FILE))  fs.writeFileSync(PUSH_SUBS_FILE, '[]', 'utf8');
  if (!fs.existsSync(LOGS_FILE)) {
    fs.writeFileSync(LOGS_FILE, JSON.stringify(
      { qr_accesses: [], subscriptions: [], notifications: [] }, null, 2
    ), 'utf8');
  }
}
initDataFiles();

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function appendLog(category, entry) {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    if (!logs[category]) logs[category] = [];
    logs[category].push({ timestamp: new Date().toISOString(), ...entry });
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('[ログエラー]', err.message);
  }
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

app.get('/track-access', (req, res) => {
  appendLog('qr_accesses', { ua: (req.headers['user-agent'] || '').slice(0, 120) });
  res.json({ ok: true });
});

// メール登録
app.post('/subscribe-email', (req, res) => {
  const { email, scheduledTime } = req.body;

  if (!email || !scheduledTime) {
    return res.status(400).json({ error: 'email と scheduledTime は必須です' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  }
  if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
    return res.status(400).json({ error: '時刻の形式が不正です（HH:MM）' });
  }
  if (!mailer) {
    return res.status(503).json({ error: 'メール送信が設定されていません' });
  }

  const [hours, minutes] = scheduledTime.split(':').map(Number);
  const targetAt = new Date();
  targetAt.setDate(targetAt.getDate() + 1);
  targetAt.setHours(hours, minutes, 0, 0);

  const subs = readJSON(EMAIL_SUBS_FILE).filter(s => s.email !== email);
  subs.push({ email, scheduledTime, targetAt: targetAt.toISOString(), sent: false, createdAt: new Date().toISOString() });
  writeJSON(EMAIL_SUBS_FILE, subs);
  appendLog('subscriptions', { type: 'email', scheduled_time: scheduledTime });

  res.json({ ok: true, targetAt: targetAt.toISOString() });
});

// Web Push登録
app.post('/subscribe', (req, res) => {
  const { subscription, scheduledTime } = req.body;
  if (!subscription?.endpoint || !scheduledTime) {
    return res.status(400).json({ error: 'subscription と scheduledTime は必須です' });
  }
  if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
    return res.status(400).json({ error: '時刻の形式が不正です' });
  }

  const [hours, minutes] = scheduledTime.split(':').map(Number);
  const targetAt = new Date();
  targetAt.setDate(targetAt.getDate() + 1);
  targetAt.setHours(hours, minutes, 0, 0);

  const subs = readJSON(PUSH_SUBS_FILE).filter(s => s.subscription.endpoint !== subscription.endpoint);
  subs.push({ subscription, scheduledTime, targetAt: targetAt.toISOString(), sent: false, createdAt: new Date().toISOString() });
  writeJSON(PUSH_SUBS_FILE, subs);
  appendLog('subscriptions', { type: 'webpush', scheduled_time: scheduledTime });

  res.json({ ok: true, targetAt: targetAt.toISOString() });
});

// ログ（研究用）
app.get('/logs', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'))); }
  catch { res.status(500).json({ error: 'ログ読み込み失敗' }); }
});

app.get('/logs/summary', (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    res.json({
      qr_access_count:      logs.qr_accesses.length,
      subscription_count:   logs.subscriptions.length,
      notification_success: logs.notifications.filter(n => n.status === 'success').length,
      notification_failed:  logs.notifications.filter(n => n.status === 'failed').length
    });
  } catch { res.status(500).json({ error: 'ログ読み込み失敗' }); }
});

// ---------------------------------------------------------------------------
// Cron: 毎分チェック
// ---------------------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  const now = new Date();

  // --- メール通知 ---
  if (mailer) {
    const emailSubs = readJSON(EMAIL_SUBS_FILE);
    let emailChanged = false;
    for (const sub of emailSubs) {
      if (sub.sent || new Date(sub.targetAt) > now) continue;
      try {
        await mailer.sendMail({
          from: `"千葉大学 駐輪リマインダー" <${process.env.SMTP_USER}>`,
          to: sub.email,
          subject: '駐輪許可証のお知らせ',
          text: '今日は忘れずに許可証を買おう！\n\n千葉大学 キャンパス整備係',
          html: `<p style="font-size:16px">🚲 <strong>今日は忘れずに許可証を買おう！</strong></p><p style="color:#888;font-size:12px">千葉大学 キャンパス整備係</p>`
        });
        sub.sent = true;
        appendLog('notifications', { type: 'email', status: 'success', scheduled_time: sub.scheduledTime });
        console.log(`[${now.toISOString()}] メール送信成功: ${sub.email}`);
      } catch (err) {
        console.error(`[${now.toISOString()}] メール送信失敗:`, err.message);
        appendLog('notifications', { type: 'email', status: 'failed', error: err.message });
      }
      emailChanged = true;
    }
    if (emailChanged) writeJSON(EMAIL_SUBS_FILE, emailSubs);
  }

  // --- Web Push 通知 ---
  if (process.env.VAPID_PUBLIC_KEY) {
    const pushSubs = readJSON(PUSH_SUBS_FILE);
    let pushChanged = false;
    for (const sub of pushSubs) {
      if (sub.sent || new Date(sub.targetAt) > now) continue;
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: '駐輪許可証のお知らせ',
          body: '今日は忘れずに許可証を買おう！'
        }));
        sub.sent = true;
        appendLog('notifications', { type: 'webpush', status: 'success' });
        console.log(`[${now.toISOString()}] Web Push送信成功`);
      } catch (err) {
        appendLog('notifications', { type: 'webpush', status: 'failed', error: err.message });
        if (err.statusCode === 410 || err.statusCode === 404) sub.sent = true;
      }
      pushChanged = true;
    }
    if (pushChanged) writeJSON(PUSH_SUBS_FILE, pushSubs);
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
