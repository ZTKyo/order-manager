// Firebase Cloud Functions —— 订单状态 Telegram 定时提醒
// 部署后，Cloud Scheduler 会每 24 小时（默认 10:00 UTC+8）调用 scheduledNotifyOrders

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ====== 可配置参数 ======
// 建议通过 Firebase 的环境变量设置（推荐）：
//   firebase functions:config:set telegram.bot_token="123456:ABC..."
// 或直接在下面硬编码（仅供测试，不建议提交到公开仓库）
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
  || (functions.config().telegram && functions.config().telegram.bot_token)
  || '在这里填入你的 BotFather 给的 Token（仅临时测试）';

// 各提醒规则（单位：天）
const RULES = {
  pendingOver2Days:     { label: '待制作超过 2 天未开始', days: 2, key: 'pending_over_2d' },
  deliveredNoReply3:    { label: '已交付 3 天未回复/未收款', days: 3, key: 'delivered_no_reply_3d' },
  deliveredNoReply7:    { label: '已交付 7 天未收款（严重）', days: 7, key: 'delivered_no_reply_7d' },
  makingStuck3:         { label: '制作中超过 3 天未更新',   days: 3, key: 'making_stuck_3d' },
};

// =============================================================
// 1) 工具：发送 Telegram 消息
// =============================================================
async function sendTelegram(chatId, text) {
  if (!chatId) return { ok: false, reason: 'no chatId' };
  if (!BOT_TOKEN || BOT_TOKEN.startsWith('在')) return { ok: false, reason: 'bot token 未配置' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json();
    return json;
  } catch (e) {
    console.error('[Telegram] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// =============================================================
// 2) 判断一个订单是否命中某条规则
// =============================================================
function matchRule(order, rule, nowMs) {
  const status = order.status;

  // 规则1：待制作超过 2 天
  if (rule.key === 'pending_over_2d') {
    if (status !== 'pending') return false;
    const created = order.createdAt ? new Date(order.createdAt).getTime() : 0;
    return created && (nowMs - created) >= rule.days * 86400000;
  }

  // 规则2：制作中更新时间停超过 3 天
  if (rule.key === 'making_stuck_3d') {
    if (status !== 'making') return false;
    const updated = order.updatedAt ? new Date(order.updatedAt).getTime() : 0;
    return updated && (nowMs - updated) >= rule.days * 86400000;
  }

  // 规则3：已交付 3 天未收款
  if (rule.key === 'delivered_no_reply_3d') {
    if (status !== 'delivered') return false;
    const unpaid = (Number(order.price) || 0) - (Number(order.paidAmount) || 0);
    if (unpaid <= 0) return false;
    const deliveredAt = order.deliveredAt ? new Date(order.deliveredAt).getTime()
                   : (order.updatedAt ? new Date(order.updatedAt).getTime() : 0);
    return deliveredAt && (nowMs - deliveredAt) >= rule.days * 86400000;
  }

  // 规则4：已交付 7 天未收款（严重）
  if (rule.key === 'delivered_no_reply_7d') {
    if (status !== 'delivered') return false;
    const unpaid = (Number(order.price) || 0) - (Number(order.paidAmount) || 0);
    if (unpaid <= 0) return false;
    const deliveredAt = order.deliveredAt ? new Date(order.deliveredAt).getTime()
                   : (order.updatedAt ? new Date(order.updatedAt).getTime() : 0);
    return deliveredAt && (nowMs - deliveredAt) >= rule.days * 86400000;
  }

  return false;
}

// =============================================================
// 3) 判断是否已推送过（按 orderId + ruleKey 去重）
// =============================================================
async function hasNotified(userId, orderId, ruleKey) {
  const snap = await db
    .collection('users').doc(userId)
    .collection('notifications').doc(`${orderId}_${ruleKey}`)
    .get();
  return snap.exists;
}

async function markNotified(userId, orderId, ruleKey, summary) {
  await db
    .collection('users').doc(userId)
    .collection('notifications').doc(`${orderId}_${ruleKey}`)
    .set({
      orderId,
      ruleKey,
      summary,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

// =============================================================
// 4) 格式化一条提醒内容
// =============================================================
function buildMessage(ruleLabel, order, nowMs) {
  const customer = order.customer || '（未填客户）';
  const price = Number(order.price) || 0;
  const paid = Number(order.paidAmount) || 0;
  const unpaid = price - paid;
  const count = order.count || '';

  let header = `🔔 *订单提醒 — ${ruleLabel}*\n\n`;
  let body =
    `👤 客户：${customer}\n` +
    `💰 报价：¥${price.toLocaleString('zh-CN')}\n` +
    `✅ 已收：¥${paid.toLocaleString('zh-CN')}\n` +
    (unpaid > 0 ? `❌ 待收：¥${unpaid.toLocaleString('zh-CN')}\n` : '') +
    (count ? `🎨 数量：${count}\n` : '') +
    `📝 状态：${statusText(order.status)}\n` +
    (order.note ? `📄 备注：${order.note}\n` : '');

  const time = new Date(nowMs);
  const y = time.getFullYear();
  const m = String(time.getMonth()+1).padStart(2,'0');
  const d = String(time.getDate()).padStart(2,'0');
  const hh = String(time.getHours()).padStart(2,'0');
  const mm = String(time.getMinutes()).padStart(2,'0');

  return `${header}${body}\n🕒 ${y}-${m}-${d} ${hh}:${mm}`;
}

function statusText(s) {
  return ({
    pending: '待制作',
    making: '制作中',
    revise: '待修改',
    delivered: '已交付',
    done: '已完成',
    cancel: '已取消',
  })[s] || (s || '未知');
}

// =============================================================
// 5) 扫描全用户：每个用户如果配置了 telegramChatId，就扫他的订单
// =============================================================
async function runScan() {
  const nowMs = Date.now();
  let usersScanned = 0;
  let totalMessages = 0;
  let errors = [];

  // 1) 遍历所有用户（我们的数据结构是 users/{uid}/orders）
  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    usersScanned++;
    const userId = userDoc.id;
    const profile = userDoc.data() || {};

    // 用户没绑定 Telegram，跳过
    if (!profile.telegramChatId) continue;
    // 用户显式关闭了提醒，跳过
    if (profile.telegramEnabled === false) continue;

    const chatId = profile.telegramChatId;

    // 2) 扫该用户的所有订单
    const ordersSnap = await db
      .collection('users').doc(userId).collection('orders')
      .get();

    const hitsForUser = [];

    for (const orderDoc of ordersSnap.docs) {
      const order = orderDoc.data();
      order.id = orderDoc.id;

      // 已取消/已完成的订单不做未收款提醒以外的推送
      if (order.status === 'done' || order.status === 'cancel') continue;

      for (const ruleKey of Object.keys(RULES)) {
        const rule = RULES[ruleKey];
        if (matchRule(order, rule, nowMs)) {
          const already = await hasNotified(userId, order.id, ruleKey);
          if (already) continue;

          const text = buildMessage(rule.label, order, nowMs);
          const r = await sendTelegram(chatId, text);
          if (r && r.ok) {
            totalMessages++;
            await markNotified(userId, order.id, ruleKey, text);
            hitsForUser.push(`${ruleKey} -> ${order.customer}`);
          } else {
            errors.push(`user=${userId} order=${order.id}: ${r && r.description ? r.description : 'send fail'}`);
          }
        }
      }
    }

    // 3) 给每个用户一条"今日小结"（只在有命中时才发，避免骚扰）
    if (hitsForUser.length > 0) {
      await sendTelegram(chatId,
        `📋 *今日共 ${hitsForUser.length} 条提醒*\n` +
        hitsForUser.map((x,i)=>`${i+1}. ${x}`).join('\n') +
        `\n\n前往 https://ZTKyo.github.io/order-management 查看`
      );
      totalMessages++;
    }
  }

  return { usersScanned, totalMessages, errors };
}

// =============================================================
// 6) Cloud Scheduler 触发入口
//    默认：每天 10:00 (北京时间) = 02:00 UTC
// =============================================================
exports.scheduledNotifyOrders = functions
  .region('asia-east1')
  .pubsub.topic('daily-order-reminder')
  .onPublish(async (message) => {
    try {
      const result = await runScan();
      console.log('[Reminder] scan result:', result);
      return result;
    } catch (e) {
      console.error('[Reminder] fatal error:', e);
      throw e;
    }
  });

// =============================================================
// 7) 手动触发（HTTP 调试用）—— 部署后访问 URL 即可立即触发一次扫描
// =============================================================
exports.testNotify = functions
  .region('asia-east1')
  .https.onRequest(async (req, res) => {
    try {
      const result = await runScan();
      res.set('Content-Type', 'application/json');
      res.status(200).send(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('[Reminder] test fatal:', e);
      res.status(500).send(JSON.stringify({ error: e.message }));
    }
  });

// =============================================================
// 8) 新订单创建时立刻发一条"已创建"提醒（可选，避免漏单）
//    —— 通过监听 orders 子集合的 onCreate
// =============================================================
exports.onOrderCreated = functions
  .region('asia-east1')
  .firestore.document('users/{userId}/orders/{orderId}')
  .onCreate(async (snap, context) => {
    try {
      const order = snap.data();
      const userId = context.params.userId;
      const userDoc = await db.collection('users').doc(userId).get();
      const profile = userDoc.data() || {};
      if (!profile.telegramChatId || profile.telegramEnabled === false) return;

      const text = buildMessage('新订单已创建，记得跟进哦 🎯', order, Date.now());
      await sendTelegram(profile.telegramChatId, text);
    } catch (e) {
      console.error('[onOrderCreated] failed:', e);
    }
  });

