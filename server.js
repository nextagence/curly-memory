// Окошко — сервер. Без зависимостей: только встроенные модули Node 20+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { enabledConfig } from './config.js';
import { createReminders } from './reminders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 90 * 864e5;
const BOOKING_HORIZON_DAYS = 60;
const RESERVED_SLUGS = new Set(['api', 'm', 'admin', 'app', 'login', 'static', 'public', 'sw', 'manifest']);

const CONFIG = enabledConfig();

// ───────────────────────── хранилище (JSON-файл) ─────────────────────────
let db = { masters: {}, sessions: {}, services: {}, clients: {}, appointments: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch {
  /* первый запуск */
}
let saveTimer = null;
function flush() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 50);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      flush();
    } finally {
      process.exit(0);
    }
  });
}
const uid = () => crypto.randomBytes(6).toString('hex');
const reminders = createReminders({ db, save });

// ───────────────────────── утилиты ─────────────────────────
class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, msg);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw bad('Некорректный JSON');
  }
}

const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const fwd = process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || req.socket.remoteAddress || 'x';
  const k = `${key}:${ip}`;
  const now = Date.now();
  let e = hits.get(k);
  if (!e || e.reset < now) {
    e = { count: 0, reset: now + windowMs };
    hits.set(k, e);
  }
  if (++e.count > max) throw new HttpError(429, 'Слишком много попыток. Подождите немного.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
  for (const [t, s] of Object.entries(db.sessions)) if (s.createdAt + SESSION_TTL < now) delete db.sessions[t];
}, 60_000).unref();

function str(v, min, max, label) {
  if (typeof v !== 'string') throw bad(`${label}: нужен текст`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${label}: от ${min} до ${max} символов`);
  return s;
}
function num(v, min, max, label) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) throw bad(`${label}: число от ${min} до ${max}`);
  return n;
}

// даты и время — «стенные», в часовом поясе мастера, без пересчётов
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const validTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const validDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
function nowIn(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

function normPhone(s) {
  const raw = String(s || '').replace(/[^\d+]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (raw.startsWith('+') ? '+' : '') + digits;
}
const digitsOf = (s) => String(s || '').replace(/\D/g, '');

// ───────────────────────── доменная логика ─────────────────────────
const busyFor = (masterId, date, ignoreId) =>
  Object.values(db.appointments).filter(
    (a) => a.masterId === masterId && a.date === date && a.status !== 'cancelled' && a.id !== ignoreId,
  );
const overlaps = (list, start, dur) =>
  list.some((a) => {
    const s = toMin(a.time);
    return start < s + a.duration && start + dur > s;
  });

function freeSlots(master, date, duration) {
  if (master.daysOff.includes(weekday(date))) return [];
  const now = nowIn(master.timezone);
  if (date < now.date || date > addDays(now.date, BOOKING_HORIZON_DAYS)) return [];
  const ws = toMin(master.workStart);
  const we = toMin(master.workEnd);
  const busy = busyFor(master.id, date);
  const out = [];
  for (let t = ws; t + duration <= we; t += master.step) {
    if (date === now.date && t <= now.minutes) continue;
    if (!overlaps(busy, t, duration)) out.push(toHHMM(t));
  }
  return out;
}

const publicMaster = (m) => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  geo: m.geo,
  currency: m.currency,
  timezone: m.timezone,
  workStart: m.workStart,
  workEnd: m.workEnd,
  step: m.step,
  daysOff: m.daysOff,
  contact: m.contact,
  reminders: m.reminders !== false,
});
const serviceOut = (s) => ({ id: s.id, name: s.name, duration: s.duration, price: s.price, active: s.active });
const apptOut = (a) => {
  const c = a.clientId ? db.clients[a.clientId] : null;
  return {
    id: a.id,
    date: a.date,
    time: a.time,
    duration: a.duration,
    price: a.price,
    status: a.status,
    note: a.note,
    source: a.source,
    serviceId: a.serviceId,
    serviceName: a.serviceName,
    clientId: a.clientId,
    clientName: c ? c.name : '',
    clientPhone: c ? c.phone : '',
    reminders: reminders.summary(a),
  };
};

function findOrCreateClient(masterId, name, phone) {
  if (phone) {
    const d = digitsOf(phone);
    const found = Object.values(db.clients).find((c) => c.masterId === masterId && c.phone && digitsOf(c.phone) === d);
    if (found) return found;
  }
  const c = { id: uid(), masterId, name, phone: phone || '', note: '', waOptIn: false, tgToken: crypto.randomBytes(8).toString('hex'), createdAt: Date.now() };
  db.clients[c.id] = c;
  return c;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(password, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(password, salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function startSession(masterId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { masterId, createdAt: Date.now() };
  return token;
}

function validateGeoCurrency(geo, currency) {
  if (!CONFIG.geos[geo]) throw bad('Это гео пока недоступно');
  if (!CONFIG.currencies[currency]) throw bad('Эта валюта пока недоступна');
}
function validateSchedule(b, base) {
  const out = {};
  const workStart = b.workStart ?? base.workStart;
  const workEnd = b.workEnd ?? base.workEnd;
  if (!validTime(workStart) || !validTime(workEnd) || toMin(workStart) >= toMin(workEnd)) throw bad('Рабочие часы заданы неверно');
  const step = b.step === undefined ? base.step : Number(b.step);
  if (![10, 15, 20, 30, 45, 60].includes(step)) throw bad('Шаг записи: 10, 15, 20, 30, 45 или 60 минут');
  const daysOff = b.daysOff === undefined ? base.daysOff : b.daysOff;
  if (!Array.isArray(daysOff) || daysOff.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Выходные заданы неверно');
  Object.assign(out, { workStart, workEnd, step, daysOff: [...new Set(daysOff)].sort() });
  return out;
}

// ───────────────────────── маршруты ─────────────────────────
const routes = [];
const route = (method, pattern, handler, auth = false) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth });
const created = (obj) => [201, obj];

route('GET', '/api/config', () => ({ ...CONFIG, channels: reminders.available() }));

route('POST', '/api/register', ({ req, body }) => {
  rateLimit(req, 'register', 20, 3600_000);
  const name = str(body.name, 2, 60, 'Имя');
  const slug = str(body.slug, 3, 30, 'Ссылка').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(slug)) throw bad('Ссылка: латиница, цифры и дефис, 3–30 символов');
  if (RESERVED_SLUGS.has(slug)) throw bad('Эта ссылка занята');
  if (Object.values(db.masters).some((m) => m.slug === slug)) throw new HttpError(409, 'Эта ссылка уже занята');
  const password = str(body.password, 8, 100, 'Пароль');
  validateGeoCurrency(body.geo, body.currency);
  const { salt, hash } = hashPassword(password);
  const m = {
    id: uid(),
    slug,
    name,
    salt,
    hash,
    geo: body.geo,
    currency: body.currency,
    timezone: CONFIG.geos[body.geo].timezone,
    workStart: '10:00',
    workEnd: '20:00',
    step: 30,
    daysOff: [],
    contact: '',
    reminders: true,
    createdAt: Date.now(),
  };
  db.masters[m.id] = m;
  const token = startSession(m.id);
  save();
  return created({ token, me: publicMaster(m) });
});

route('POST', '/api/login', ({ req, body }) => {
  rateLimit(req, 'login', 10, 60_000);
  const slug = String(body.slug || '').trim().toLowerCase();
  const m = Object.values(db.masters).find((x) => x.slug === slug);
  if (!m || typeof body.password !== 'string' || !checkPassword(body.password, m.salt, m.hash)) throw new HttpError(401, 'Неверная ссылка или пароль');
  const token = startSession(m.id);
  save();
  return { token, me: publicMaster(m) };
});

route('POST', '/api/logout', ({ token }) => {
  delete db.sessions[token];
  save();
  return { ok: true };
}, true);

route('GET', '/api/me', ({ master }) => ({ me: publicMaster(master) }), true);

route('PUT', '/api/me', ({ master, body }) => {
  const name = body.name === undefined ? master.name : str(body.name, 2, 60, 'Имя');
  const geo = body.geo ?? master.geo;
  const currency = body.currency ?? master.currency;
  validateGeoCurrency(geo, currency);
  const sched = validateSchedule(body, master);
  const contact = body.contact === undefined ? master.contact : str(body.contact, 0, 120, 'Контакт');
  const remindersOn = body.reminders === undefined ? master.reminders !== false : body.reminders === true;
  Object.assign(master, sched, { name, geo, currency, contact, reminders: remindersOn });
  if (geo !== master.geo || body.geo) master.timezone = CONFIG.geos[geo].timezone;
  save();
  return { me: publicMaster(master) };
}, true);

// услуги
function parseService(b) {
  return {
    name: str(b.name, 1, 60, 'Название'),
    duration: Math.round(num(b.duration, 5, 600, 'Длительность (мин)')),
    price: Math.round(num(b.price, 0, 1e9, 'Цена') * 100) / 100,
  };
}
route('GET', '/api/services', ({ master }) => ({
  services: Object.values(db.services).filter((s) => s.masterId === master.id && s.active).map(serviceOut),
}), true);
route('POST', '/api/services', ({ master, body }) => {
  const s = { id: uid(), masterId: master.id, active: true, ...parseService(body) };
  db.services[s.id] = s;
  save();
  return created({ service: serviceOut(s) });
}, true);
route('PUT', '/api/services/:id', ({ master, params, body }) => {
  const s = db.services[params.id];
  if (!s || s.masterId !== master.id || !s.active) throw new HttpError(404, 'Услуга не найдена');
  Object.assign(s, parseService(body));
  save();
  return { service: serviceOut(s) };
}, true);
route('DELETE', '/api/services/:id', ({ master, params }) => {
  const s = db.services[params.id];
  if (!s || s.masterId !== master.id) throw new HttpError(404, 'Услуга не найдена');
  s.active = false; // старые записи сохраняют снимок названия и цены
  save();
  return { ok: true };
}, true);

// клиенты
function clientStats(masterId) {
  const stats = {};
  for (const a of Object.values(db.appointments)) {
    if (a.masterId !== masterId || !a.clientId) continue;
    const s = (stats[a.clientId] ||= { visits: 0, spent: 0, upcoming: 0, last: '' });
    if (a.status === 'done') {
      s.visits++;
      s.spent += a.price;
      if (a.date > s.last) s.last = a.date;
    } else if (a.status === 'planned') s.upcoming++;
  }
  return stats;
}
const parseClient = (b) => {
  const name = str(b.name, 1, 60, 'Имя клиента');
  let phone = '';
  if (b.phone !== undefined && String(b.phone).trim() !== '') {
    phone = normPhone(b.phone);
    if (!phone) throw bad('Телефон: от 7 до 15 цифр');
  }
  const note = b.note === undefined ? '' : str(b.note, 0, 500, 'Заметка');
  return { name, phone, note, waOptIn: b.waOptIn === undefined ? undefined : b.waOptIn === true };
};
route('GET', '/api/clients', ({ master }) => {
  const stats = clientStats(master.id);
  const clients = Object.values(db.clients)
    .filter((c) => c.masterId === master.id)
    .map((c) => ({ id: c.id, name: c.name, phone: c.phone, note: c.note, waOptIn: !!c.waOptIn, tgLinked: !!c.telegramChatId, tgLink: reminders.tgLink(c), ...(stats[c.id] || { visits: 0, spent: 0, upcoming: 0, last: '' }) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { clients };
}, true);
route('POST', '/api/clients', ({ master, body }) => {
  const p = parseClient(body);
  const c = { id: uid(), masterId: master.id, createdAt: Date.now(), tgToken: crypto.randomBytes(8).toString('hex'), ...p, waOptIn: p.waOptIn === true };
  db.clients[c.id] = c;
  save();
  return created({ client: { id: c.id, ...p } });
}, true);
route('PUT', '/api/clients/:id', ({ master, params, body }) => {
  const c = db.clients[params.id];
  if (!c || c.masterId !== master.id) throw new HttpError(404, 'Клиент не найден');
  const p = parseClient(body);
  if (p.waOptIn === undefined) delete p.waOptIn;
  Object.assign(c, p);
  save();
  return { client: { id: c.id, name: c.name, phone: c.phone, note: c.note } };
}, true);
route('DELETE', '/api/clients/:id', ({ master, params }) => {
  const c = db.clients[params.id];
  if (!c || c.masterId !== master.id) throw new HttpError(404, 'Клиент не найден');
  if (Object.values(db.appointments).some((a) => a.clientId === c.id)) throw new HttpError(409, 'У клиента есть записи — удалить нельзя');
  delete db.clients[c.id];
  save();
  return { ok: true };
}, true);

// записи
route('GET', '/api/appointments', ({ master, query }) => {
  const from = query.get('from');
  const to = query.get('to');
  if (!validDate(from) || !validDate(to) || from > to || to > addDays(from, 62)) throw bad('Период указан неверно (до 62 дней)');
  const appointments = Object.values(db.appointments)
    .filter((a) => a.masterId === master.id && a.date >= from && a.date <= to)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map(apptOut);
  return { appointments };
}, true);

route('POST', '/api/appointments', ({ master, body }) => {
  const svc = db.services[body.serviceId];
  if (!svc || svc.masterId !== master.id || !svc.active) throw bad('Выберите услугу');
  if (!validDate(body.date) || !validTime(body.time)) throw bad('Дата или время указаны неверно');
  let client;
  if (body.clientId) {
    client = db.clients[body.clientId];
    if (!client || client.masterId !== master.id) throw bad('Клиент не найден');
  } else {
    const p = parseClient({ name: body.clientName, phone: body.clientPhone });
    client = findOrCreateClient(master.id, p.name, p.phone);
  }
  if (overlaps(busyFor(master.id, body.date), toMin(body.time), svc.duration)) throw new HttpError(409, 'Это время уже занято');
  const a = {
    id: uid(),
    masterId: master.id,
    serviceId: svc.id,
    serviceName: svc.name,
    clientId: client.id,
    date: body.date,
    time: body.time,
    duration: svc.duration,
    price: svc.price,
    status: 'planned',
    source: 'master',
    note: body.note === undefined ? '' : str(body.note, 0, 500, 'Заметка'),
    reminders: {},
    bookedAt: Date.now(),
    createdAt: Date.now(),
  };
  db.appointments[a.id] = a;
  save();
  return created({ appointment: apptOut(a) });
}, true);

route('PATCH', '/api/appointments/:id', ({ master, params, body }) => {
  const a = db.appointments[params.id];
  if (!a || a.masterId !== master.id) throw new HttpError(404, 'Запись не найдена');
  const next = { date: a.date, time: a.time, status: a.status, note: a.note, price: a.price };
  if (body.status !== undefined) {
    if (!['planned', 'done', 'cancelled'].includes(body.status)) throw bad('Статус неверный');
    next.status = body.status;
  }
  if (body.date !== undefined) {
    if (!validDate(body.date)) throw bad('Дата неверная');
    next.date = body.date;
  }
  if (body.time !== undefined) {
    if (!validTime(body.time)) throw bad('Время неверное');
    next.time = body.time;
  }
  if (body.note !== undefined) next.note = str(body.note, 0, 500, 'Заметка');
  if (body.price !== undefined) next.price = Math.round(num(body.price, 0, 1e9, 'Цена') * 100) / 100;
  if (next.status !== 'cancelled' && overlaps(busyFor(master.id, next.date, a.id), toMin(next.time), a.duration)) {
    throw new HttpError(409, 'Это время уже занято');
  }
  if (next.date !== a.date || next.time !== a.time) {
    a.reminders = {}; // новое время — напоминания считаются заново
    a.bookedAt = Date.now();
  }
  Object.assign(a, next);
  save();
  return { appointment: apptOut(a) };
}, true);

// публичная запись клиентом
const masterBySlug = (slug) => {
  const m = Object.values(db.masters).find((x) => x.slug === String(slug).toLowerCase());
  if (!m) throw new HttpError(404, 'Мастер не найден');
  return m;
};
route('GET', '/api/public/:slug', ({ params }) => {
  const m = masterBySlug(params.slug);
  const now = nowIn(m.timezone);
  return {
    name: m.name,
    contact: m.contact,
    currency: m.currency,
    geo: m.geo,
    phoneHint: CONFIG.geos[m.geo]?.phoneHint || '',
    daysOff: m.daysOff,
    today: now.date,
    horizon: BOOKING_HORIZON_DAYS,
    services: Object.values(db.services).filter((s) => s.masterId === m.id && s.active).map(serviceOut),
  };
});
route('GET', '/api/public/:slug/slots', ({ params, query }) => {
  const m = masterBySlug(params.slug);
  const svc = db.services[query.get('serviceId')];
  const date = query.get('date');
  if (!svc || svc.masterId !== m.id || !svc.active) throw bad('Услуга не найдена');
  if (!validDate(date)) throw bad('Дата неверная');
  return { slots: freeSlots(m, date, svc.duration) };
});
route('POST', '/api/public/:slug/book', ({ req, params, body }) => {
  rateLimit(req, 'book', 10, 3600_000);
  const m = masterBySlug(params.slug);
  const svc = db.services[body.serviceId];
  if (!svc || svc.masterId !== m.id || !svc.active) throw bad('Услуга не найдена');
  if (!validDate(body.date) || !validTime(body.time)) throw bad('Дата или время указаны неверно');
  const name = str(body.name, 2, 60, 'Имя');
  const phone = normPhone(body.phone);
  if (!phone) throw bad('Телефон: от 7 до 15 цифр');
  if (!freeSlots(m, body.date, svc.duration).includes(body.time)) throw new HttpError(409, 'Это время уже занято. Выберите другое.');
  const client = findOrCreateClient(m.id, name, phone);
  if (body.consent === true) client.waOptIn = true;
  const today = nowIn(m.timezone).date;
  const active = Object.values(db.appointments).filter((a) => a.clientId === client.id && a.status === 'planned' && a.date >= today).length;
  if (active >= 3) throw new HttpError(429, 'Слишком много активных записей. Свяжитесь с мастером.');
  const a = {
    id: uid(),
    masterId: m.id,
    serviceId: svc.id,
    serviceName: svc.name,
    clientId: client.id,
    date: body.date,
    time: body.time,
    duration: svc.duration,
    price: svc.price,
    status: 'planned',
    source: 'link',
    note: '',
    reminders: {},
    bookedAt: Date.now(),
    createdAt: Date.now(),
  };
  db.appointments[a.id] = a;
  save();
  return created({
    ok: true,
    appointment: { date: a.date, time: a.time, duration: a.duration, serviceName: a.serviceName, price: a.price },
    contact: m.contact,
    masterName: m.name,
    currency: m.currency,
    remindersOn: m.reminders !== false,
    telegramLink: client.telegramChatId ? null : reminders.tgLink(client),
    whatsapp: reminders.available().whatsapp && !!client.waOptIn,
  });
});

// ───────────────────────── статика ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel === '/') rel = '/index.html';
  let file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  let ext = path.extname(file);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* нет файла */
  }
  if (!stat || !stat.isFile()) {
    if (ext) {
      res.writeHead(404, SECURITY_HEADERS);
      return res.end('Not found');
    }
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA-страницы вроде /m/slug
    ext = '.html';
  }
  const cache = ext === '.png' ? 'public, max-age=86400' : 'no-cache';
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ───────────────────────── сервер ─────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }
    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === req.method) {
        matched = { r, params: m.groups || {} };
        break;
      }
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Не найдено');
    const ctx = { req, res, params: matched.params, query: url.searchParams, body: {}, master: null, token: null };
    if (matched.r.auth) {
      const h = String(req.headers.authorization || '');
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      const s = db.sessions[token];
      if (!s || s.createdAt + SESSION_TTL < Date.now() || !db.masters[s.masterId]) throw new HttpError(401, 'Нужно войти');
      ctx.master = db.masters[s.masterId];
      ctx.token = token;
    }
    if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
    const out = await matched.r.handler(ctx);
    if (Array.isArray(out)) sendJson(res, out[0], out[1]);
    else sendJson(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.code, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`Окошко запущено: http://localhost:${PORT}  (гео: ${Object.keys(CONFIG.geos).join(', ')})`);
  reminders.start();
});
