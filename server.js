require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');

const app = express();

// LINE webhookはraw bodyが必要（署名検証のため）
app.use('/line-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// LINE 設定
// ---------------------------------------------------------------------------
const LINE_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || null;
const LINE_SECRET       = process.env.LINE_CHANNEL_SECRET || null;

if (LINE_ACCESS_TOKEN) {
  console.log('LINE通知: 有効');
} else {
  console.warn('警告: LINE_CHANNEL_ACCESS_TOKEN が未設定です');
}

// ---------------------------------------------------------------------------
// データファイル
// ---------------------------------------------------------------------------
const LINE_SUBS_FILE = path.join(__dirname, 'line_subscriptions.json');
const LOGS_FILE      = path.join(__dirname, 'logs.json');

function initDataFiles() {
  if (!fs.existsSync(LINE_SUBS_FILE)) fs.writeFileSync(LINE_SUBS_FILE, '[]', 'utf8');
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
// LINE API ヘルパー
// ---------------------------------------------------------------------------
async function linePush(to, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function lineReply(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// 日時パース（JST基準）
// ---------------------------------------------------------------------------
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstNow() {
  return new Date(Date.now() + JST_OFFSET_MS);
}

function parseSchedule(text) {
  const now = jstNow();

  // 「明日 HH:MM」
  const tomorrowMatch = text.match(/(?:明日|あした)\s*(\d{1,2}):(\d{2})/);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
             hours: parseInt(tomorrowMatch[1]), minutes: parseInt(tomorrowMatch[2]) };
  }

  // 「今日 HH:MM」
  const todayMatch = text.match(/(?:今日|きょう)\s*(\d{1,2}):(\d{2})/);
  if (todayMatch) {
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(),
             hours: parseInt(todayMatch[1]), minutes: parseInt(todayMatch[2]) };
  }

  // 「M/D HH:MM」
  const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (dateMatch) {
    return { year: now.getUTCFullYear(), month: parseInt(dateMatch[1]), day: parseInt(dateMatch[2]),
             hours: parseInt(dateMatch[3]), minutes: parseInt(dateMatch[4]) };
  }

  // 「HH:MM」のみ → 明日扱い
  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
             hours: parseInt(timeOnly[1]), minutes: parseInt(timeOnly[2]) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
app.get('/track-access', (req, res) => {
  appendLog('qr_accesses', { ua: (req.headers['user-agent'] || '').slice(0, 120) });
  res.json({ ok: true });
});

// LINE Webhook
app.post('/line-webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];

  if (LINE_SECRET) {
    const hash = crypto.createHmac('SHA256', LINE_SECRET).update(req.body).digest('base64');
    if (hash !== signature) {
      console.error('LINE署名検証失敗');
      return res.status(403).send('Forbidden');
    }
  }

  res.json({ ok: true }); // 即座にレスポンスを返す

  const events = JSON.parse(req.body.toString()).events || [];
  for (const event of events) {
    handleLineEvent(event).catch(err => console.error('[LINE event error]', err.message));
  }
});

async function handleLineEvent(event) {
  const lineUserId = event.source?.userId;
  if (!lineUserId) return;

  if (event.type === 'follow') {
    // 友だち追加時
    await lineReply(event.replyToken,
      '🚲 駐輪許可証リマインダーへようこそ！\n\n登校日と時刻を送ってください。\n\n例：\n「明日 08:30」\n「今日 17:00」\n「6/5 08:30」'
    );
    appendLog('subscriptions', { type: 'line_follow', lineUserId });

  } else if (event.type === 'message' && event.message?.type === 'text') {
    const text = event.message.text.trim();
    const schedule = parseSchedule(text);

    if (!schedule) {
      await lineReply(event.replyToken,
        '⚠️ 形式が正しくありません。\n\n以下の形式で送ってください：\n「明日 08:30」\n「今日 17:00」\n「6/5 08:30」'
      );
      return;
    }

    const { year, month, day, hours, minutes } = schedule;
    const targetAt = new Date(Date.UTC(year, month - 1, day, hours, minutes) - JST_OFFSET_MS);
    const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

    const subs = readJSON(LINE_SUBS_FILE).filter(s => s.lineUserId !== lineUserId);
    subs.push({ lineUserId, scheduledTime: timeStr, targetAt: targetAt.toISOString(), sent: false, createdAt: new Date().toISOString() });
    writeJSON(LINE_SUBS_FILE, subs);
    appendLog('subscriptions', { type: 'line', scheduled_time: timeStr });

    await lineReply(event.replyToken,
      `✅ 設定完了！\n${month}月${day}日 ${timeStr} にリマインドします。\n\n🚲 当日、許可証を忘れずに！`
    );
  }
}

// ログ（研究用）
app.get('/logs', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'))); }
  catch { res.status(500).json({ error: 'ログ読み込み失敗' }); }
});

app.get('/logs/summary', (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    res.json({
      qr_access_count:      logs.qr_accesses?.length || 0,
      subscription_count:   logs.subscriptions?.length || 0,
      notification_success: logs.notifications?.filter(n => n.status === 'success').length || 0,
      notification_failed:  logs.notifications?.filter(n => n.status === 'failed').length || 0
    });
  } catch { res.status(500).json({ error: 'ログ読み込み失敗' }); }
});

// ---------------------------------------------------------------------------
// Cron: 毎分チェック
// ---------------------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  const now = new Date();

  if (!LINE_ACCESS_TOKEN) return;

  const subs = readJSON(LINE_SUBS_FILE);
  let changed = false;

  for (const sub of subs) {
    if (sub.sent || new Date(sub.targetAt) > now) continue;
    try {
      await linePush(sub.lineUserId, '🚲 今日は忘れずに許可証を買おう！\n\n千葉大学 キャンパス整備係');
      sub.sent = true;
      appendLog('notifications', { type: 'line', status: 'success' });
      console.log(`[${now.toISOString()}] LINE送信成功: ${sub.lineUserId}`);
    } catch (err) {
      console.error(`[${now.toISOString()}] LINE送信失敗:`, err.message);
      appendLog('notifications', { type: 'line', status: 'failed', error: err.message });
    }
    changed = true;
  }

  if (changed) writeJSON(LINE_SUBS_FILE, subs);
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log('通知スケジューラー: 毎分チェック中');
});
