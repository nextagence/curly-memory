// Смоук-тест: поднимает сервер на свободном порту и прогоняет основной сценарий.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'okoshko-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const child = spawn('node', ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'db.json'), ENABLE_GEOS: 'KZ,AE' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => String(d).includes('запущено') && resolve());
  child.on('exit', (c) => reject(new Error('server exited ' + c)));
  setTimeout(() => reject(new Error('server start timeout')), 5000);
});

let token = '';
const call = async (method, url, body, auth = true) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(auth && token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
};
let passed = 0;
const ok = (name) => console.log('  ✓', name, (passed++, ''));

try {
  // конфиг: включены KZ и AE → валюты KZT и AED
  let r = await call('GET', '/api/config', null, false);
  assert.deepEqual(Object.keys(r.data.geos), ['KZ', 'AE']);
  assert.deepEqual(Object.keys(r.data.currencies).sort(), ['AED', 'KZT']);
  ok('конфиг: гео и валюты из окружения');

  // нельзя выбрать выключенное гео/валюту
  r = await call('POST', '/api/register', { name: 'Аня', slug: 'anya', password: 'password1', geo: 'US', currency: 'USD' }, false);
  assert.equal(r.status, 400);
  ok('выключенное гео отклоняется');

  // регистрация в Дубае с валютой тенге (гео и валюта независимы)
  r = await call('POST', '/api/register', { name: 'Аня', slug: 'anya', password: 'password1', geo: 'AE', currency: 'KZT' }, false);
  assert.equal(r.status, 201);
  token = r.data.token;
  assert.equal(r.data.me.timezone, 'Asia/Dubai');
  assert.equal(r.data.me.currency, 'KZT');
  ok('регистрация: гео AE, валюта KZT, пояс Asia/Dubai');

  r = await call('POST', '/api/register', { name: 'Аня2', slug: 'anya', password: 'password1', geo: 'KZ', currency: 'KZT' }, false);
  assert.equal(r.status, 409);
  ok('слаг уникален');

  r = await call('PUT', '/api/me', { geo: 'KZ', currency: 'AED', workStart: '09:00', workEnd: '18:00', step: 30, daysOff: [0], contact: '@anya' });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.timezone, 'Asia/Almaty');
  assert.equal(r.data.me.currency, 'AED');
  ok('смена гео и валюты в настройках');

  r = await call('POST', '/api/services', { name: 'Маникюр', duration: 90, price: 12500.5 });
  assert.equal(r.status, 201);
  const svc = r.data.service;
  r = await call('POST', '/api/services', { name: 'Бровки', duration: 'abc', price: 1 });
  assert.equal(r.status, 400);
  ok('услуги: создание и валидация');

  // ближайший будний день вперёд (не воскресенье)
  const d = new Date(Date.now() + 2 * 864e5);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);

  r = await call('GET', `/api/public/anya/slots?date=${date}&serviceId=${svc.id}`, null, false);
  assert.equal(r.status, 200);
  assert.ok(r.data.slots.includes('09:00') && r.data.slots.includes('16:30') && !r.data.slots.includes('17:00'), 'слоты по 90 мин до 18:00');
  ok('слоты: учитывают часы работы и длительность');

  r = await call('POST', '/api/public/anya/book', { serviceId: svc.id, date, time: '10:00', name: 'Лена', phone: '+7 701 123 45 67' }, false);
  assert.equal(r.status, 201);
  assert.equal(r.data.currency, 'AED');
  ok('запись клиентом по ссылке');

  r = await call('POST', '/api/public/anya/book', { serviceId: svc.id, date, time: '11:00', name: 'Оля', phone: '87011234568' }, false);
  assert.equal(r.status, 409);
  ok('двойная запись на занятое время → 409');

  r = await call('GET', `/api/public/anya/slots?date=${date}&serviceId=${svc.id}`, null, false);
  assert.ok(!r.data.slots.includes('10:00') && !r.data.slots.includes('11:00') && r.data.slots.includes('11:30'));
  ok('занятые слоты пропали из выдачи');

  // воскресенье — выходной
  const sun = new Date(Date.now() + 3 * 864e5);
  while (sun.getUTCDay() !== 0) sun.setUTCDate(sun.getUTCDate() + 1);
  r = await call('GET', `/api/public/anya/slots?date=${sun.toISOString().slice(0, 10)}&serviceId=${svc.id}`, null, false);
  assert.deepEqual(r.data.slots, []);
  ok('выходной день без слотов');

  // мастер видит запись, клиент создан, статистика
  r = await call('GET', `/api/appointments?from=${date}&to=${date}`);
  assert.equal(r.data.appointments.length, 1);
  const appt = r.data.appointments[0];
  assert.equal(appt.clientName, 'Лена');
  assert.equal(appt.source, 'link');
  r = await call('PATCH', `/api/appointments/${appt.id}`, { status: 'done' });
  assert.equal(r.data.appointment.status, 'done');
  r = await call('GET', '/api/clients');
  assert.equal(r.data.clients[0].visits, 1);
  assert.equal(r.data.clients[0].spent, 12500.5);
  ok('мастер: запись видна, статус «пришёл», статистика клиента');

  // мастер создаёт запись вручную на занятое → 409; на свободное → 201
  r = await call('POST', '/api/appointments', { serviceId: svc.id, date, time: '10:30', clientName: 'Мария', clientPhone: '' });
  assert.equal(r.status, 409);
  r = await call('POST', '/api/appointments', { serviceId: svc.id, date, time: '12:00', clientName: 'Мария', clientPhone: '' });
  assert.equal(r.status, 201);
  ok('ручная запись: конфликт и успех');

  // отмена освобождает время
  r = await call('PATCH', `/api/appointments/${r.data.appointment.id}`, { status: 'cancelled' });
  r = await call('GET', `/api/public/anya/slots?date=${date}&serviceId=${svc.id}`, null, false);
  assert.ok(r.data.slots.includes('12:00'));
  ok('отмена освобождает слот');

  // изоляция мастеров
  r = await call('POST', '/api/register', { name: 'Боря', slug: 'borya', password: 'password2', geo: 'KZ', currency: 'KZT' }, false);
  const t2 = r.data.token;
  const other = await fetch(base + `/api/appointments/${appt.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t2 }, body: JSON.stringify({ status: 'cancelled' }) });
  assert.equal(other.status, 404);
  ok('чужие записи недоступны');

  // авторизация
  r = await call('GET', '/api/clients', null, false);
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { slug: 'anya', password: 'wrong-pass' }, false);
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { slug: 'anya', password: 'password1' }, false);
  assert.equal(r.status, 200);
  ok('авторизация: без токена 401, логин работает');

  // статика и SPA-fallback
  let s = await fetch(base + '/m/anya');
  assert.equal(s.status, 200);
  assert.match(await s.text(), /<div id="app">/);
  s = await fetch(base + '/..%2fserver.js');
  assert.ok([403, 404].includes(s.status) || !(await s.text()).includes('createServer'));
  s = await fetch(base + '/nope.js');
  assert.equal(s.status, 404);
  ok('статика: SPA-fallback, защита от выхода из каталога');

  console.log(`\nГотово: ${passed} проверок прошли.`);
} catch (e) {
  console.error('\nПровал:', e);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
