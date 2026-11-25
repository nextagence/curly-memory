// Напоминания клиентам за 24 часа и за 2 часа до записи.
// Каналы: Telegram (общий бот; клиент подключается по ссылке) и WhatsApp Cloud API (шаблонное сообщение,
// только клиентам, давшим согласие). Без зависимостей.
//
// Env:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME           (username без @)
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE, WHATSAPP_LANG=ru
//   REMINDER_TICK_MS=60000
//   TELEGRAM_API_BASE, WHATSAPP_API_BASE                (для тестов)

import crypto from 'node:crypto';

const HOUR = 3600e3;
// before — за сколько до начала напоминать; until — позже чем за столько до начала уже не шлём
export const KINDS = [
  { key: 'r24', before: 24 * HOUR, until: 3 * HOUR },
  { key: 'r2', before: 2 * HOUR, until: 0.5 * HOUR },
];
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// «настенное» время мастера → момент в UTC (мс)
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const offset = (ts) => {
    const p = fmt.formatToParts(new Date(ts));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ts;
  };
  let ts = guess - offset(guess);
  ts = guess - offset(ts);
  return ts;
}

const fmtDate = (date) =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

export function buildMessage(kind, a, master) {
  const contact = master.contact ? ` Если планы изменились: ${master.contact}.` : '';
  const when = kind === 'r24' ? `${fmtDate(a.date)} в ${a.time}` : `через 2 часа, в ${a.time}`;
  const text =
    kind === 'r24'
      ? `Напоминание о записи: ${a.serviceName}, ${when}. Мастер: ${master.name}.${contact}`
      : `Ждём вас ${when}: ${a.serviceName}. Мастер: ${master.name}.${contact}`;
  // параметры для шаблона WhatsApp: {{1}} мастер, {{2}} услуга, {{3}} когда, {{4}} контакт
  return { text, params: [master.name, a.serviceName, when, master.contact || '—'] };
}

export function createReminders({ db, save, env = process.env, log = console }) {
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const tgUser = String(env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const tgBase = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const waToken = env.WHATSAPP_TOKEN;
  const waPhone = env.WHATSAPP_PHONE_ID;
  const waTemplate = env.WHATSAPP_TEMPLATE;
  const waLang = env.WHATSAPP_LANG || 'ru';
  const waBase = env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0';
  const tickMs = Number(env.REMINDER_TICK_MS || 60_000);
  const telegram = !!(tgToken && tgUser);
  const whatsapp = !!(waToken && waPhone && waTemplate);

  async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data || {}).slice(0, 200)}`);
    return data;
  }
  const sendTelegram = (chatId, text) => postJson(`${tgBase}/bot${tgToken}/sendMessage`, { chat_id: chatId, text });
  const sendWhatsApp = (phone, params) =>
    postJson(
      `${waBase}/${waPhone}/messages`,
      {
        messaging_product: 'whatsapp',
        to: String(phone).replace(/\D/g, ''),
        type: 'template',
        template: {
          name: waTemplate,
          language: { code: waLang },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }],
        },
      },
      { authorization: `Bearer ${waToken}` },
    );

  const pickChannel = (c) => {
    if (!c) return null;
    if (telegram && c.telegramChatId) return 'telegram';
    if (whatsapp && c.waOptIn && c.phone) return 'whatsapp';
    return null;
  };

  function mark(a, key, status, extra = {}) {
    a.reminders[key] = { status, at: Date.now(), ...extra };
    save();
  }

  let ticking = false;
  async function tick(now = Date.now()) {
    if (ticking) return;
    ticking = true;
    try {
      for (const a of Object.values(db.appointments)) {
        if (a.status !== 'planned') continue;
        const m = db.masters[a.masterId];
        if (!m || m.reminders === false) continue;
        const start = zonedToUtc(a.date, a.time, m.timezone);
        if (start <= now) continue;
        a.reminders ||= {};
        for (const k of KINDS) {
          const cur = a.reminders[k.key];
          if (cur && cur.status !== 'retry') continue;
          const due = start - k.before;
          if (now < due) continue;
          if ((a.bookedAt || a.createdAt) > due) { mark(a, k.key, 'skipped', { reason: 'late_booking' }); continue; }
          if (now >= start - k.until) { mark(a, k.key, 'skipped', { reason: 'missed' }); continue; }
          const client = db.clients[a.clientId];
          const channel = pickChannel(client);
          if (!channel) continue; // подождём: клиент ещё может подключить Telegram
          const msg = buildMessage(k.key, a, m);
          try {
            if (channel === 'telegram') await sendTelegram(client.telegramChatId, msg.text);
            else await sendWhatsApp(client.phone, msg.params);
            mark(a, k.key, 'sent', { channel });
          } catch (e) {
            if (channel === 'telegram' && String(e.message).startsWith('403')) {
              client.telegramChatId = null; // клиент заблокировал бота
              save();
            }
            const attempts = (cur?.attempts || 0) + 1;
            log.error(`[напоминания] ${k.key} запись ${a.id} через ${channel}: ${e.message}`);
            mark(a, k.key, attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', { channel, attempts, error: String(e.message).slice(0, 120) });
          }
        }
      }
    } finally {
      ticking = false;
    }
  }

  // Telegram: подписка клиента по ссылке t.me/<bot>?start=<токен клиента>
  async function handleUpdate(u) {
    const msg = u.message;
    if (!msg || typeof msg.text !== 'string' || !msg.chat) return;
    const chatId = msg.chat.id;
    const [cmd, arg] = msg.text.trim().split(/\s+/);
    const reply = (t) => sendTelegram(chatId, t).catch((e) => log.error(`[telegram] ${e.message}`));
    if (cmd.startsWith('/start')) {
      const c = arg ? Object.values(db.clients).find((x) => x.tgToken === arg) : null;
      if (c) {
        c.telegramChatId = chatId;
        save();
        const m = db.masters[c.masterId];
        await reply(`Готово! Пришлю напоминания о записях к мастеру ${m ? m.name : ''}. Отключить: /stop`);
      } else {
        await reply('Откройте ссылку из подтверждения записи, чтобы подключить напоминания.');
      }
    } else if (cmd.startsWith('/stop')) {
      for (const c of Object.values(db.clients)) if (c.telegramChatId === chatId) c.telegramChatId = null;
      save();
      await reply('Напоминания отключены.');
    }
  }

  async function pollTelegram() {
    let offset = 0;
    for (;;) {
      const t0 = Date.now();
      try {
        const r = await postJson(`${tgBase}/bot${tgToken}/getUpdates`, { offset, timeout: 25, allowed_updates: ['message'] });
        const updates = r?.result || [];
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u);
        }
        if (!updates.length && Date.now() - t0 < 500) await sleep(500);
      } catch (e) {
        log.error(`[telegram] getUpdates: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  return {
    available: () => ({ telegram, whatsapp }),
    tgLink(client) {
      if (!telegram) return null;
      if (!client.tgToken) {
        client.tgToken = crypto.randomBytes(8).toString('hex');
        save();
      }
      return `https://t.me/${tgUser}?start=${client.tgToken}`;
    },
    summary(a) {
      const r = a.reminders || {};
      const one = (x) => (x ? { status: x.status, channel: x.channel || null, reason: x.reason || null } : null);
      return { r24: one(r.r24), r2: one(r.r2) };
    },
    tick,
    start() {
      if (!telegram && !whatsapp) {
        log.log('Напоминания: каналы не настроены (задайте TELEGRAM_* и/или WHATSAPP_*)');
        return;
      }
      log.log(`Напоминания: ${[telegram && 'Telegram', whatsapp && 'WhatsApp'].filter(Boolean).join(' + ')}`);
      setTimeout(() => tick().catch((e) => log.error(e)), 2000).unref();
      setInterval(() => tick().catch((e) => log.error(e)), tickMs).unref();
      if (telegram) pollTelegram();
    },
  };
}
