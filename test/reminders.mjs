// Тест напоминаний: локальные заглушки Telegram и WhatsApp, база с готовыми записями.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { zonedToUtc, buildMessage } from '../reminders.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (name) => console.log('  ✓', name, (passed++, ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── чистые функции
assert.equal(zonedToUtc('2026-11-25', '21:00', 'Asia/Almaty'), Date.UTC(2026, 10, 25, 16, 0));
assert.equal(zonedToUtc('2026-07-01', '12:00', 'America/New_York'), Date.UTC(2026, 6, 1, 16, 0));
assert.equal(zonedToUtc('2026-01-15', '09:30', 'Europe/Istanbul'), Date.UTC(2026, 0, 15, 6, 30));
ok('часовые пояса: Алматы +5, Нью-Йорк летом −4, Стамбул +3');
const msg = buildMessage('r2', { date: '2026-11-26', time: '11:00', serviceName: 'Маникюр' }, { name: 'Анна', contact: '@anna' });
assert.match(msg.text, /через 2 часа, в 11:00/);
assert.deepEqual(msg.params, ['Анна', 'Маникюр', 'через 2 часа, в 11:00', '@anna']);
ok('тексты и параметры шаблона WhatsApp');

// ── заглушки внешних API
const tgSent = [];
const waSent = [];
let tgUpdatesGiven = false;
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(JSON.parse(b || '{}'))); });
const fakeTg = http.createServer(async (req, res) => {
  const body = await readBody(req);
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/getUpdates')) {
    if (!tgUpdatesGiven) {
      tgUpdatesGiven = true;
      return res.end(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { chat: { id: 555 }, text: '/start tgtok1' } }] }));
    }
    await sleep(300);
    return res.end(JSON.stringify({ ok: true, result: [] }));
  }
  if (req.url.endsWith('/sendMessage')) {
    tgSent.push(body);
    return res.end(JSON.stringify({ ok: true, result: {} }));
  }
  res.statusCode = 404;
  res.end('{}');
});
const fakeWa = http.createServer(async (req, res) => {
  const body = await readBody(req);
  waSent.push({ url: req.url, auth: req.headers.authorization, body });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
});
await Promise.all([new Promise((r) => fakeTg.listen(0, '127.0.0.1', r)), new Promise((r) => fakeWa.listen(0, '127.0.0.1', r))]);

// ── база с записями
const tz = 'Asia/Almaty';
const now = Date.now();
const local = (ms) => {
  const f = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', ...o }).format(new Date(ms));
  return { date: f({ year: 'numeric', month: '2-digit', day: '2-digit' }), time: f({ hour: '2-digit', minute: '2-digit' }) };
};
const soon = local(now + 100 * 60_000); // начало через ~100 минут: «за 2 часа» уже пора, «за 24 часа» поздно
const old = now - 3 * 864e5;
const appt = (id, clientId, bookedAt) => ({
  id, masterId: 'm1', serviceId: 's1', serviceName: 'Маникюр', clientId, date: soon.date, time: soon.time, duration: 60,
  price: 5000, status: 'planned', source: 'master', note: '', reminders: {}, bookedAt, createdAt: bookedAt,
});
const seed = {
  masters: { m1: { id: 'm1', slug: 'anna', name: 'Анна', salt: 'x', hash: 'x', geo: 'KZ', currency: 'KZT', timezone: tz, workStart: '09:00', workEnd: '23:00', step: 30, daysOff: [], contact: '@anna', reminders: true, createdAt: old } },
  sessions: { tok: { masterId: 'm1', createdAt: now } },
  services: { s1: { id: 's1', masterId: 'm1', name: 'Маникюр', duration: 60, price: 5000, active: true } },
  clients: {
    c1: { id: 'c1', masterId: 'm1', name: 'Елена', phone: '+77011234567', note: '', tgToken: 'tgtok1', waOptIn: false, createdAt: old },
    c2: { id: 'c2', masterId: 'm1', name: 'Мария', phone: '+77019998877', note: '', tgToken: 'tgtok2', waOptIn: true, createdAt: old },
    c3: { id: 'c3', masterId: 'm1', name: 'Ольга', phone: '+77015556677', note: '', tgToken: 'tgtok3', waOptIn: false, createdAt: old },
    c4: { id: 'c4', masterId: 'm1', name: 'Ира', phone: '+77010001122', note: '', tgToken: 'tgtok4', waOptIn: true, createdAt: old },
  },
  appointments: {
    a1: appt('a1', 'c1', old), // Telegram (клиент подключится через /start)
    a2: appt('a2', 'c2', old), // WhatsApp (есть согласие)
    a3: appt('a3', 'c3', old), // нет канала
    a4: appt('a4', 'c4', now), // записалась только что — напоминать не нужно
  },
};
const dir = mkdtempSync(path.join(tmpdir(), 'okoshko-rem-'));
writeFileSync(path.join(dir, 'db.json'), JSON.stringify(seed));
const PORT = 3800 + Math.floor(Math.random() * 90);
const child = spawn('node', ['server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), REMINDER_TICK_MS: '400',
    TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_BOT_USERNAME: '@okoshko_test_bot', TELEGRAM_API_BASE: `http://127.0.0.1:${fakeTg.address().port}`,
    WHATSAPP_TOKEN: 'watoken', WHATSAPP_PHONE_ID: 'PHID', WHATSAPP_TEMPLATE: 'booking_reminder', WHATSAPP_API_BASE: `http://127.0.0.1:${fakeWa.address().port}`,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => String(d).includes('запущено') && resolve());
  child.on('exit', (c) => reject(new Error('server exited ' + c)));
  setTimeout(() => reject(new Error('server start timeout')), 5000);
});
const base = `http://127.0.0.1:${PORT}`;
const call = async (method, url, body, auth = true) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer tok' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

try {
  let r = await call('GET', '/api/config', null, false);
  assert.deepEqual(r.data.channels, { telegram: true, whatsapp: true });
  ok('конфиг сообщает, какие каналы включены');

  await sleep(4500); // привязка Telegram + несколько тиков планировщика

  // Telegram: клиент подключился по /start, получил приветствие и напоминание
  const toChat = tgSent.filter((m) => m.chat_id === 555);
  assert.ok(toChat.some((m) => /Готово/.test(m.text) && /Анна/.test(m.text)), 'приветствие после /start');
  const tgReminders = toChat.filter((m) => /через 2 часа/.test(m.text));
  assert.equal(tgReminders.length, 1, 'ровно одно напоминание в Telegram');
  assert.match(tgReminders[0].text, new RegExp(`в ${soon.time}`));
  assert.match(tgReminders[0].text, /Маникюр/);
  assert.match(tgReminders[0].text, /@anna/);
  ok('Telegram: /start привязывает клиента, напоминание приходит один раз');

  // WhatsApp: шаблон с параметрами и токеном
  assert.equal(waSent.length, 1, 'одно сообщение WhatsApp');
  assert.equal(waSent[0].url, '/PHID/messages');
  assert.equal(waSent[0].auth, 'Bearer watoken');
  assert.equal(waSent[0].body.to, '77019998877');
  assert.equal(waSent[0].body.template.name, 'booking_reminder');
  assert.deepEqual(waSent[0].body.template.components[0].parameters.map((p) => p.text), ['Анна', 'Маникюр', `через 2 часа, в ${soon.time}`, '@anna']);
  ok('WhatsApp: шаблонное сообщение уходит только клиенту с согласием');

  // статусы у мастера
  r = await call('GET', `/api/appointments?from=${soon.date}&to=${soon.date}`);
  const by = Object.fromEntries(r.data.appointments.map((a) => [a.id, a.reminders]));
  assert.equal(by.a1.r2.status, 'sent');
  assert.equal(by.a1.r2.channel, 'telegram');
  assert.equal(by.a1.r24.status, 'skipped');
  assert.equal(by.a1.r24.reason, 'missed');
  assert.equal(by.a2.r2.channel, 'whatsapp');
  assert.equal(by.a3.r2, null, 'без канала напоминание ждёт');
  assert.equal(by.a4.r2.status, 'skipped');
  assert.equal(by.a4.r2.reason, 'late_booking');
  ok('статусы: sent / skipped(missed) / ждёт без канала / skipped(late_booking)');

  // клиент без канала подключает Telegram позже — напоминание уходит
  const before = tgSent.length;
  r = await call('GET', '/api/clients');
  const c3 = r.data.clients.find((c) => c.id === 'c3');
  assert.match(c3.tgLink, /^https:\/\/t\.me\/okoshko_test_bot\?start=tgtok3$/);
  assert.equal(c3.tgLinked, false);
  const c1 = r.data.clients.find((c) => c.id === 'c1');
  assert.equal(c1.tgLinked, true);
  ok('ссылка на бота для клиента и признак подключения');

  // перенос записи сбрасывает напоминания
  r = await call('PATCH', '/api/appointments/a1', { date: local(now + 30 * 3600e3).date, time: '10:00' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.appointment.reminders, { r24: null, r2: null });
  ok('перенос записи сбрасывает статусы напоминаний');

  // отмена: напоминаний нет
  await call('PATCH', '/api/appointments/a2', { status: 'cancelled' });
  const waBefore = waSent.length;
  await sleep(1200);
  assert.equal(waSent.length, waBefore);
  ok('отменённые записи не напоминаем');

  // выключатель у мастера
  r = await call('PUT', '/api/me', { reminders: false });
  assert.equal(r.data.me.reminders, false);
  r = await call('PUT', '/api/me', { reminders: true });
  assert.equal(r.data.me.reminders, true);
  ok('настройка «напоминать» сохраняется');

  // публичная запись: согласие на WhatsApp и ссылка Telegram в ответе
  const tomorrow = local(now + 30 * 3600e3).date;
  r = await call('POST', '/api/public/anna/book', { serviceId: 's1', date: tomorrow, time: '12:00', name: 'Наташа', phone: '+7 701 777 66 55', consent: true }, false);
  assert.equal(r.status, 201);
  assert.equal(r.data.whatsapp, true);
  assert.match(r.data.telegramLink, /^https:\/\/t\.me\/okoshko_test_bot\?start=[0-9a-f]{16}$/);
  assert.equal(r.data.remindersOn, true);
  r = await call('POST', '/api/public/anna/book', { serviceId: 's1', date: tomorrow, time: '14:00', name: 'Света', phone: '+7 701 111 22 33' }, false);
  assert.equal(r.data.whatsapp, false, 'без согласия WhatsApp не включаем');
  ok('запись по ссылке: согласие и ссылка на Telegram');

  console.log(`\nГотово: ${passed} проверок прошли.`);
} catch (e) {
  console.error('\nПровал:', e);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  fakeTg.close();
  fakeWa.close();
  fakeTg.closeAllConnections?.();
  fakeWa.closeAllConnections?.();
  rmSync(dir, { recursive: true, force: true });
}
