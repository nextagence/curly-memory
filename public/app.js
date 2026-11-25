// Окошко — клиент. Без сборки и зависимостей. DOM строится через h(): innerHTML не используется.
const root = document.getElementById('app');

// ───────────────────────── утилиты ─────────────────────────
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked') late[k] = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if ('value' in late) el.value = late.value;
  if ('checked' in late) el.checked = !!late.checked;
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  calendar: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 19v-1a3 3 0 0 0-2-2.8M15 5.2a3 3 0 0 1 0 5.6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  sliders: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4',
};
function icon(name) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  s.append(p);
  return s;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, [a, b, c]) => {
  const m = Math.abs(n) % 100;
  const k = m % 10;
  return `${n} ${m > 10 && m < 20 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c}`;
};
const fmtMoney = (n, cur) => {
  const frac = Number.isInteger(n) ? 0 : 2;
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur, minimumFractionDigits: frac, maximumFractionDigits: frac }).format(n);
};
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const wdOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const fmt = (d, opts) => new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const endTime = (t, dur) => {
  const m = (Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + dur) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const STATUS = { planned: 'Ожидается', done: 'Пришёл', cancelled: 'Отмена' };
const WEEK = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];

const S = {
  token: store.get('okoshko_token'),
  config: null,
  me: null,
  tab: 'schedule',
  date: null,
  services: [],
  clients: [],
  appts: [],
  range: null,
  authMode: 'login',
};

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth && S.token) headers.authorization = `Bearer ${S.token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('Нет связи с сервером');
    e.status = 0;
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Ошибка ${res.status}`);
    e.status = res.status;
    if (res.status === 401 && auth && S.token) logout();
    throw e;
  }
  return data;
}

// кнопка на время действия блокируется, ошибки показываются тостом
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
const select = (opts, value, attrs = {}) =>
  h('select', { class: 'input', ...attrs, value }, opts.map(([v, l]) => h('option', { value: v }, l)));

function openSheet(title, ...content) {
  const prev = document.activeElement;
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (prev && prev.isConnected) prev.focus();
  }
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: close }, '✕')),
    ...content);
  overlay.append(sheet);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  sheet.focus();
  return { close };
}

// ───────────────────────── данные ─────────────────────────
function logout() {
  store.del('okoshko_token');
  S.token = null;
  S.me = null;
  render();
}
async function loadAppts(force) {
  const need = { from: addDays(S.date, -3), to: addDays(S.date, 3) };
  if (!force && S.range && S.range.from <= need.from && S.range.to >= need.to) return;
  const from = addDays(S.date, -14);
  const to = addDays(S.date, 14);
  S.appts = (await api(`/appointments?from=${from}&to=${to}`)).appointments;
  S.range = { from, to };
}
async function loadAll() {
  const [s, c] = await Promise.all([api('/services'), api('/clients')]);
  S.services = s.services;
  S.clients = c.clients;
  S.date = S.date || todayIn(S.me.timezone);
  await loadAppts(true);
}
async function refresh() {
  await loadAll();
  render();
}

// ───────────────────────── вход ─────────────────────────
function viewAuth() {
  const cfg = S.config;
  const reg = S.authMode === 'register';
  const geos = Object.entries(cfg.geos).map(([k, g]) => [k, g.name]);
  const curs = Object.entries(cfg.currencies).map(([k, c]) => [k, `${k} · ${c.name}`]);
  const err = h('p', { class: 'err', role: 'alert' });
  const name = h('input', { class: 'input', autocomplete: 'name', maxlength: '60', required: true });
  const slugHint = h('span', { class: 'hint' }, `${location.host}/m/…`);
  const slug = h('input', {
    class: 'input', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    pattern: '[a-zA-Z0-9\\-]{3,30}', maxlength: '30', required: true, placeholder: 'anna-nails',
  });
  slug.addEventListener('input', () => { slugHint.textContent = `${location.host}/m/${slug.value.toLowerCase() || '…'}`; });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', minlength: reg ? '8' : null, required: true });
  const geo = select(geos, geos[0][0], { disabled: geos.length === 1 });
  const cur = select(curs, cfg.geos[geos[0][0]].currency, { disabled: curs.length === 1 });
  geo.addEventListener('change', () => {
    const c = cfg.geos[geo.value].currency;
    if (cfg.currencies[c]) cur.value = c;
  });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, reg ? 'Создать аккаунт' : 'Войти');
  const form = h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    err.textContent = '';
    act(submit, async () => {
      try {
        const body = reg
          ? { name: name.value, slug: slug.value, password: pass.value, geo: geo.value, currency: cur.value }
          : { slug: slug.value, password: pass.value };
        const r = await api(reg ? '/register' : '/login', { method: 'POST', body, auth: false });
        S.token = r.token;
        store.set('okoshko_token', r.token);
        S.me = r.me;
        S.date = null;
        await loadAll();
        render();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  } },
    reg ? field('Как вас называть клиентам', name) : null,
    field(reg ? 'Ваша ссылка для записи' : 'Ссылка (логин)', slug, reg ? slugHint : null),
    field('Пароль', pass, reg ? 'Не короче 8 символов' : null),
    reg ? h('div', { class: 'two' }, field('Страна', geo), field('Валюта', cur)) : null,
    err, submit);
  mount(h('main', { class: 'page' },
    h('div', { class: 'stack' },
      h('div', {}, h('h1', {}, cfg.appName), h('p', { class: 'muted' }, 'Запись клиентов для мастеров')),
      form,
      h('button', { class: 'link-btn', type: 'button', onclick: () => { S.authMode = reg ? 'login' : 'register'; render(); } },
        reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать'))));
}

// ───────────────────────── каркас мастера ─────────────────────────
function mount(...nodes) {
  root.replaceChildren(...nodes);
}
function tabbar() {
  const tabs = [['schedule', 'Расписание', 'calendar'], ['clients', 'Клиенты', 'users'], ['services', 'Услуги', 'list'], ['settings', 'Настройки', 'sliders']];
  return h('nav', { class: 'tabbar', 'aria-label': 'Разделы' },
    tabs.map(([id, label, ic]) => h('button', { class: 'tab', 'aria-current': S.tab === id ? 'page' : null, onclick: () => { S.tab = id; render(); } }, icon(ic), label)));
}
function render() {
  if (!S.me) return viewAuth();
  const views = { schedule: viewSchedule, clients: viewClients, services: viewServices, settings: viewSettings };
  const { content, fab } = views[S.tab]();
  mount(
    h('main', { class: 'page' }, content),
    fab ? h('button', { class: 'fab', onclick: fab.onclick }, fab.label) : null,
    tabbar());
}

// ───────────────────────── расписание ─────────────────────────
function apptItem(a) {
  return h('button', { class: `item ${a.status === 'cancelled' ? 'cancelled' : ''}`, onclick: () => openApptSheet(a) },
    h('div', { class: 'time' }, a.time, h('small', {}, endTime(a.time, a.duration))),
    h('div', { class: 'grow' },
      h('div', { class: 'strong title' }, a.clientName || 'Без имени'),
      h('div', { class: 'muted small' }, `${a.serviceName} · ${fmtMoney(a.price, S.me.currency)}`)),
    h('span', { class: `chip ${a.status}` }, STATUS[a.status]));
}

function viewSchedule() {
  const today = todayIn(S.me.timezone);
  const cur = S.me.currency;
  const strip = [...Array(7)].map((_, i) => addDays(S.date, i - 3));
  const count = (d) => S.appts.filter((a) => a.date === d && a.status !== 'cancelled').length;
  const list = S.appts.filter((a) => a.date === S.date);
  const live = list.filter((a) => a.status !== 'cancelled');
  const total = live.reduce((s, a) => s + a.price, 0);
  const go = async (d) => {
    S.date = d;
    try { await loadAppts(); } catch (e) { toast(e.message); }
    render();
  };
  const long = { weekday: 'long', day: 'numeric', month: 'long' };
  return {
    content: [
      h('div', { class: 'topbar' }, h('h1', {}, 'Расписание'), S.date !== today ? h('button', { class: 'link-btn', onclick: () => go(today) }, 'Сегодня') : null),
      h('div', { class: 'days' },
        h('button', { class: 'icon-btn', 'aria-label': 'Предыдущая неделя', onclick: () => go(addDays(S.date, -7)) }, '‹'),
        strip.map((d) => h('button', {
          class: `day ${count(d) ? 'has' : ''} ${S.me.daysOff.includes(wdOf(d)) ? 'off' : ''}`,
          'aria-pressed': String(d === S.date),
          'aria-label': fmt(d, long),
          onclick: () => go(d),
        }, fmt(d, { weekday: 'short' }), h('b', {}, fmt(d, { day: 'numeric' })), h('i', { class: 'dot' }))),
        h('button', { class: 'icon-btn', 'aria-label': 'Следующая неделя', onclick: () => go(addDays(S.date, 7)) }, '›')),
      h('div', { class: 'summary' },
        h('h2', {}, cap(fmt(S.date, long))),
        h('span', { class: 'muted small' }, live.length ? `${plural(live.length, ['запись', 'записи', 'записей'])} · ${fmtMoney(total, cur)}` : '')),
      list.length ? h('div', { class: 'list' }, list.map(apptItem)) : h('div', { class: 'empty' }, 'На этот день записей нет'),
    ],
    fab: { label: '+ Запись', onclick: () => openApptForm() },
  };
}

const CH = { telegram: 'Telegram', whatsapp: 'WhatsApp' };
function reminderLine(a) {
  const r = a.reminders;
  if (!r || (!r.r24 && !r.r2)) return null;
  const one = (x, label) => {
    if (!x) return null;
    const t = x.status === 'sent' ? `отправлено${x.channel ? ` (${CH[x.channel]})` : ''}` : x.status === 'skipped' ? 'не требуется' : x.status === 'failed' ? 'не удалось' : 'повтор';
    return `${label}: ${t}`;
  };
  return [one(r.r24, 'за 24 ч'), one(r.r2, 'за 2 ч')].filter(Boolean).join(' · ');
}

function openApptSheet(a) {
  const cur = S.me.currency;
  const setStatus = (status, btn) => act(btn, async () => {
    await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status } });
    sh.close();
    await refresh();
    toast('Готово');
  });
  const date = h('input', { class: 'input', type: 'date', value: a.date, required: true });
  const time = h('input', { class: 'input', type: 'time', value: a.time, required: true });
  const move = h('button', { class: 'btn block', type: 'button', onclick: () => act(move, async () => {
    await api(`/appointments/${a.id}`, { method: 'PATCH', body: { date: date.value, time: time.value } });
    S.date = date.value;
    sh.close();
    await refresh();
    toast('Запись перенесена');
  }) }, 'Перенести');
  const digits = a.clientPhone.replace(/\D/g, '');
  const buttons = [];
  if (a.status === 'planned') {
    const done = h('button', { class: 'btn primary', onclick: () => setStatus('done', done) }, 'Пришёл');
    const cancel = h('button', { class: 'btn danger', onclick: () => setStatus('cancelled', cancel) }, 'Отменить');
    buttons.push(done, cancel);
  } else {
    const back = h('button', { class: 'btn block', onclick: () => setStatus('planned', back) }, 'Вернуть в план');
    buttons.push(back);
  }
  const sh = openSheet(`${a.time} · ${a.serviceName}`,
    h('div', { class: 'stack' },
      h('div', { class: 'card stack-s' },
        h('div', { class: 'row' }, h('span', { class: 'strong grow' }, a.clientName || 'Без имени'), h('span', { class: `chip ${a.status}` }, STATUS[a.status])),
        h('div', { class: 'muted small' }, `${fmt(a.date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${a.time}–${endTime(a.time, a.duration)}`),
        h('div', { class: 'small' }, `${a.serviceName} · ${fmtMoney(a.price, cur)}`),
        a.source === 'link' ? h('div', { class: 'tiny muted' }, 'Записался сам по ссылке') : null,
        a.clientPhone ? h('div', { class: 'row' },
          h('a', { class: 'link-btn', href: `tel:${a.clientPhone}` }, a.clientPhone),
          h('a', { class: 'link-btn', href: `https://wa.me/${digits}`, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp')) : null,
        a.note ? h('div', { class: 'small' }, a.note) : null,
        reminderLine(a) ? h('div', { class: 'tiny muted' }, `Напоминания — ${reminderLine(a)}`) : null),
      h('div', { class: 'actions' }, buttons),
      h('div', { class: 'stack-s' },
        h('span', { class: 'strong small' }, 'Перенести'),
        h('div', { class: 'two' }, date, time),
        move)));
}

function openApptForm() {
  if (!S.services.length) {
    toast('Сначала добавьте услугу');
    S.tab = 'services';
    render();
    return;
  }
  const hint = S.config.geos[S.me.geo]?.phoneHint || '';
  const svc = select(S.services.map((s) => [s.id, `${s.name} · ${s.duration} мин · ${fmtMoney(s.price, S.me.currency)}`]), S.services[0].id);
  const client = select([['', '+ Новый клиент'], ...S.clients.map((c) => [c.id, c.phone ? `${c.name} · ${c.phone}` : c.name])], '');
  const name = h('input', { class: 'input', maxlength: '60', autocomplete: 'off' });
  const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', placeholder: hint, autocomplete: 'off' });
  const fresh = h('div', { class: 'stack-s' }, field('Имя клиента', name), field('Телефон', phone, 'Можно оставить пустым'));
  client.addEventListener('change', () => { fresh.hidden = client.value !== ''; });
  const date = h('input', { class: 'input', type: 'date', value: S.date, required: true });
  const time = h('input', { class: 'input', type: 'time', value: S.me.workStart, required: true });
  const note = h('textarea', { class: 'input', maxlength: '500' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Записать');
  const sh = openSheet('Новая запись', h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    act(submit, async () => {
      const body = { serviceId: svc.value, date: date.value, time: time.value, note: note.value };
      if (client.value) body.clientId = client.value;
      else { body.clientName = name.value; body.clientPhone = phone.value; }
      await api('/appointments', { method: 'POST', body });
      S.date = date.value;
      sh.close();
      await refresh();
      toast('Запись добавлена');
    });
  } },
    field('Услуга', svc), field('Клиент', client), fresh,
    h('div', { class: 'two' }, field('Дата', date), field('Время', time)),
    field('Заметка', note), submit));
}

// ───────────────────────── клиенты ─────────────────────────
function viewClients() {
  const cur = S.me.currency;
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Поиск по имени или телефону', 'aria-label': 'Поиск клиентов' });
  const box = h('div', { class: 'list' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    const items = S.clients.filter((c) => !s || c.name.toLowerCase().includes(s) || (digits && c.phone.replace(/\D/g, '').includes(digits)));
    box.replaceChildren(...(items.length
      ? items.map((c) => h('button', { class: 'item', onclick: () => openClientSheet(c) },
        h('div', { class: 'grow' },
          h('div', { class: 'strong' }, c.name),
          h('div', { class: 'muted small' }, c.phone || 'Без телефона')),
        h('div', { class: 'small muted' }, c.visits ? `${plural(c.visits, ['визит', 'визита', 'визитов'])} · ${fmtMoney(c.spent, cur)}` : c.upcoming ? 'Есть запись' : '')))
      : [h('div', { class: 'empty' }, S.clients.length ? 'Никого не нашли' : 'Клиентов пока нет. Они появятся после первой записи.')]));
  };
  q.addEventListener('input', draw);
  draw();
  return {
    content: [h('div', { class: 'topbar' }, h('h1', {}, 'Клиенты')), h('div', { class: 'stack' }, q, box)],
    fab: { label: '+ Клиент', onclick: () => openClientSheet(null) },
  };
}

function openClientSheet(c) {
  const hint = S.config.geos[S.me.geo]?.phoneHint || '';
  const name = h('input', { class: 'input', maxlength: '60', required: true, value: c?.name || '' });
  const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', placeholder: hint, value: c?.phone || '' });
  const note = h('textarea', { class: 'input', maxlength: '500', value: c?.note || '' });
  const ch = S.config.channels || {};
  const wa = h('input', { type: 'checkbox', checked: !!c?.waOptIn });
  const tg = c && ch.telegram ? (c.tgLinked
    ? h('p', { class: 'small muted' }, 'Telegram подключён: напоминания придут туда.')
    : h('button', { class: 'btn block', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(c.tgLink); toast('Ссылка скопирована. Отправьте её клиенту'); } catch { toast(c.tgLink); }
    } }, 'Скопировать ссылку для Telegram')) : null;
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Сохранить');
  const remove = c ? h('button', { class: 'btn danger block', type: 'button', onclick: () => act(remove, async () => {
    await api(`/clients/${c.id}`, { method: 'DELETE' });
    sh.close();
    await refresh();
    toast('Клиент удалён');
  }) }, 'Удалить клиента') : null;
  const sh = openSheet(c ? 'Клиент' : 'Новый клиент', h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    act(submit, async () => {
      const body = { name: name.value, phone: phone.value, note: note.value };
      if (ch.whatsapp) body.waOptIn = wa.checked;
      await api(c ? `/clients/${c.id}` : '/clients', { method: c ? 'PUT' : 'POST', body });
      sh.close();
      await refresh();
      toast('Сохранено');
    });
  } }, field('Имя', name), field('Телефон', phone),
    ch.whatsapp ? h('label', { class: 'check' }, wa, h('span', {}, 'Клиент согласен на напоминания в WhatsApp')) : null,
    tg, field('Заметка', note), submit, remove));
}

// ───────────────────────── услуги ─────────────────────────
function viewServices() {
  const cur = S.me.currency;
  return {
    content: [
      h('div', { class: 'topbar' }, h('h1', {}, 'Услуги')),
      S.services.length
        ? h('div', { class: 'list' }, S.services.map((s) => h('button', { class: 'item', onclick: () => openServiceSheet(s) },
          h('div', { class: 'grow' }, h('div', { class: 'strong' }, s.name), h('div', { class: 'muted small' }, `${s.duration} мин`)),
          h('div', { class: 'strong' }, fmtMoney(s.price, cur)))))
        : h('div', { class: 'empty' }, 'Добавьте первую услугу — клиенты выбирают её при записи.'),
    ],
    fab: { label: '+ Услуга', onclick: () => openServiceSheet(null) },
  };
}

function openServiceSheet(s) {
  const cur = S.me.currency;
  const name = h('input', { class: 'input', maxlength: '60', required: true, value: s?.name || '', placeholder: 'Маникюр с покрытием' });
  const duration = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '5', max: '600', step: '5', required: true, value: s ? String(s.duration) : '60' });
  const price = h('input', { class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: 'any', required: true, value: s ? String(s.price) : '' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Сохранить');
  const remove = s ? h('button', { class: 'btn danger block', type: 'button', onclick: () => act(remove, async () => {
    await api(`/services/${s.id}`, { method: 'DELETE' });
    sh.close();
    await refresh();
    toast('Услуга удалена');
  }) }, 'Удалить услугу') : null;
  const sh = openSheet(s ? 'Услуга' : 'Новая услуга', h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    act(submit, async () => {
      const body = { name: name.value, duration: duration.value, price: price.value };
      await api(s ? `/services/${s.id}` : '/services', { method: s ? 'PUT' : 'POST', body });
      sh.close();
      await refresh();
      toast('Сохранено');
    });
  } }, field('Название', name), h('div', { class: 'two' }, field('Длительность, мин', duration), field(`Цена, ${cur}`, price)), submit, remove));
}

// ───────────────────────── настройки ─────────────────────────
function viewSettings() {
  const cfg = S.config;
  const me = S.me;
  const geos = Object.entries(cfg.geos).map(([k, g]) => [k, g.name]);
  const curs = Object.entries(cfg.currencies).map(([k, c]) => [k, `${k} · ${c.name}`]);
  const name = h('input', { class: 'input', maxlength: '60', required: true, value: me.name });
  const geo = select(geos, me.geo, { disabled: geos.length === 1 });
  const cur = select(curs, me.currency, { disabled: curs.length === 1 });
  geo.addEventListener('change', () => {
    const c = cfg.geos[geo.value].currency;
    if (cfg.currencies[c]) cur.value = c;
  });
  const ws = h('input', { class: 'input', type: 'time', required: true, value: me.workStart });
  const we = h('input', { class: 'input', type: 'time', required: true, value: me.workEnd });
  const step = select([10, 15, 20, 30, 45, 60].map((n) => [String(n), `${n} мин`]), String(me.step));
  const off = WEEK.map(([d, label]) => ({ d, el: h('input', { type: 'checkbox', checked: me.daysOff.includes(d), 'aria-label': `Выходной: ${label}` }), label }));
  const contact = h('input', { class: 'input', maxlength: '120', value: me.contact, placeholder: '@instagram или телефон' });
  const hasChannel = cfg.channels && (cfg.channels.telegram || cfg.channels.whatsapp);
  const rem = h('input', { type: 'checkbox', checked: me.reminders });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Сохранить');
  const link = `${location.origin}/m/${me.slug}`;
  const form = h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    act(submit, async () => {
      const body = {
        name: name.value, geo: geo.value, currency: cur.value, workStart: ws.value, workEnd: we.value,
        step: Number(step.value), daysOff: off.filter((o) => o.el.checked).map((o) => o.d), contact: contact.value,
      };
      if (hasChannel) body.reminders = rem.checked;
      S.me = (await api('/me', { method: 'PUT', body })).me;
      await refresh();
      toast('Сохранено');
    });
  } },
    field('Как вас называть клиентам', name),
    h('div', { class: 'two' }, field('Страна', geo), field('Валюта', cur)),
    h('div', { class: 'two' }, field('Начало работы', ws), field('Конец работы', we)),
    field('Шаг записи', step),
    h('div', { class: 'field' }, h('span', {}, 'Выходные'),
      h('div', { class: 'weekdays' }, off.map((o) => h('label', { class: 'wd' }, o.el, h('span', {}, o.label))))),
    field('Контакт для клиентов', contact, 'Показывается после записи и в напоминаниях'),
    hasChannel ? h('label', { class: 'check' }, rem, h('span', {}, 'Напоминать клиентам за 24 часа и за 2 часа')) : null,
    submit);
  return {
    content: [
      h('div', { class: 'topbar' }, h('h1', {}, 'Настройки')),
      h('div', { class: 'stack' },
        h('div', { class: 'card stack-s' },
          h('span', { class: 'strong' }, 'Ссылка для записи'),
          h('span', { class: 'small' }, link),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', onclick: async () => {
              try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch { toast(link); }
            } }, 'Копировать'),
            h('a', { class: 'btn', href: `/m/${me.slug}`, target: '_blank', rel: 'noopener' }, 'Открыть')),
          h('span', { class: 'hint' }, 'Отправьте клиентам в Instagram, WhatsApp или Telegram.')),
        form,
        h('button', { class: 'btn danger block', onclick: async () => { try { await api('/logout', { method: 'POST' }); } catch { /* уже вышли */ } logout(); } }, 'Выйти')),
    ],
    fab: null,
  };
}

// ───────────────────────── запись клиентом ─────────────────────────
async function viewBooking(slug) {
  let info;
  try {
    info = await api(`/public/${slug}`, { auth: false });
  } catch (e) {
    mount(h('main', { class: 'page public' }, h('div', { class: 'empty' }, e.status === 404 ? 'Страница записи не найдена' : e.message)));
    return;
  }
  document.title = `${info.name} — запись`;
  const st = { service: null, date: null, time: null, slots: null, done: null, name: '', phone: '', consent: false };
  const fmtLong = { weekday: 'long', day: 'numeric', month: 'long' };
  const days = [...Array(Math.min(info.horizon, 30)).keys()].map((i) => addDays(info.today, i));

  async function loadSlots() {
    st.slots = null;
    st.time = null;
    draw();
    if (!st.service || !st.date) return;
    try {
      st.slots = (await api(`/public/${slug}/slots?date=${st.date}&serviceId=${st.service.id}`, { auth: false })).slots;
    } catch (e) {
      st.slots = [];
      toast(e.message);
    }
    draw();
  }

  function draw() {
    if (st.done) return drawDone();
    const err = h('p', { class: 'err', role: 'alert' });
    const name = h('input', { class: 'input', autocomplete: 'name', maxlength: '60', required: true, value: st.name });
    const phone = h('input', { class: 'input', type: 'tel', inputmode: 'tel', autocomplete: 'tel', required: true, placeholder: info.phoneHint, value: st.phone });
    name.addEventListener('input', () => { st.name = name.value; });
    phone.addEventListener('input', () => { st.phone = phone.value; });
    const consent = h('input', { type: 'checkbox', checked: st.consent });
    consent.addEventListener('change', () => { st.consent = consent.checked; });
    const submit = h('button', { class: 'btn primary block', type: 'submit', disabled: !st.time }, 'Записаться');
    const form = h('form', { class: 'stack', onsubmit: (e) => {
      e.preventDefault();
      err.textContent = '';
      act(submit, async () => {
        try {
          const r = await api(`/public/${slug}/book`, { method: 'POST', auth: false,
            body: { serviceId: st.service.id, date: st.date, time: st.time, name: name.value, phone: phone.value, consent: st.consent } });
          st.done = r;
          draw();
        } catch (ex) {
          err.textContent = ex.message;
          if (ex.status === 409) loadSlots();
        }
      });
    } }, field('Ваше имя', name), field('Телефон', phone, 'Мастер подтвердит запись по этому номеру'),
      S.config.channels?.whatsapp ? h('label', { class: 'check' }, consent, h('span', {}, 'Согласен получать напоминания о записи в WhatsApp')) : null,
      err, submit);

    mount(h('main', { class: 'page public' }, h('div', { class: 'stack' },
      h('div', {}, h('h1', {}, info.name), h('p', { class: 'muted' }, 'Онлайн-запись')),
      info.services.length ? [
        h('section', { class: 'stack-s', 'aria-label': 'Услуга' }, h('h2', {}, '1. Услуга'),
          info.services.map((s) => h('button', { class: 'item', 'aria-pressed': String(st.service?.id === s.id), onclick: () => { st.service = s; loadSlots(); } },
            h('div', { class: 'grow' }, h('div', { class: 'strong' }, s.name), h('div', { class: 'muted small' }, `${s.duration} мин`)),
            h('div', { class: 'strong' }, fmtMoney(s.price, info.currency)),
            st.service?.id === s.id ? h('span', { class: 'chip done' }, 'Выбрано') : null))),
        st.service ? h('section', { class: 'stack-s', 'aria-label': 'Дата' }, h('h2', {}, '2. Дата'),
          h('div', { class: 'chips' }, days.map((d) => h('button', {
            class: 'dchip', 'aria-pressed': String(st.date === d), disabled: info.daysOff.includes(wdOf(d)), 'aria-label': fmt(d, fmtLong),
            onclick: () => { st.date = d; loadSlots(); },
          }, fmt(d, { weekday: 'short' }), h('b', {}, fmt(d, { day: 'numeric' })), fmt(d, { month: 'short' }))))) : null,
        st.service && st.date ? h('section', { class: 'stack-s', 'aria-label': 'Время' }, h('h2', {}, '3. Время'),
          st.slots === null ? h('p', { class: 'muted' }, 'Загружаем…')
            : st.slots.length ? h('div', { class: 'slots' }, st.slots.map((t) => h('button', { class: 'slot', 'aria-pressed': String(st.time === t), onclick: () => { st.time = t; draw(); } }, t)))
              : h('p', { class: 'muted' }, 'На этот день свободного времени нет. Выберите другой день.')) : null,
        st.time ? h('section', { class: 'stack-s', 'aria-label': 'Контакты' }, h('h2', {}, '4. Ваши данные'), form) : null,
      ] : h('div', { class: 'empty' }, 'Мастер ещё не добавил услуги.'),
      info.contact ? h('p', { class: 'muted small' }, `Контакт мастера: ${info.contact}`) : null)));
  }

  function drawDone() {
    const r = st.done;
    const a = r.appointment;
    mount(h('main', { class: 'page public' }, h('div', { class: 'stack' },
      h('div', {}, h('div', { class: 'ok-mark', 'aria-hidden': 'true' }, '✓'), h('h1', {}, 'Вы записаны')),
      h('div', { class: 'card stack-s' },
        h('div', { class: 'strong' }, a.serviceName),
        h('div', {}, `${cap(fmt(a.date, fmtLong))}, ${a.time}–${endTime(a.time, a.duration)}`),
        h('div', { class: 'muted small' }, `${r.masterName} · ${fmtMoney(a.price, r.currency)}`)),
      r.remindersOn && r.telegramLink ? h('a', { class: 'btn block', href: r.telegramLink, target: '_blank', rel: 'noopener noreferrer' }, 'Получать напоминания в Telegram') : null,
      r.remindersOn && r.whatsapp ? h('p', { class: 'muted small' }, 'Напоминание придёт в WhatsApp на ваш номер.') : null,
      r.contact ? h('p', { class: 'muted' }, `Если планы изменятся, напишите мастеру: ${r.contact}`) : null,
      h('button', { class: 'btn block', onclick: () => { st.done = null; st.time = null; loadSlots(); } }, 'Записаться ещё'))));
  }
  draw();
}

// ───────────────────────── старт ─────────────────────────
async function boot() {
  try {
    S.config = await api('/config', { auth: false });
  } catch (e) {
    mount(h('main', { class: 'page' }, h('div', { class: 'empty' }, e.message), h('button', { class: 'btn block', onclick: () => location.reload() }, 'Повторить')));
    return;
  }
  const m = location.pathname.match(/^\/m\/([a-z0-9-]+)\/?$/i);
  if (m) return viewBooking(m[1]);
  if (S.token) {
    try {
      S.me = (await api('/me')).me;
      await loadAll();
    } catch (e) {
      if (e.status === 0) {
        mount(h('main', { class: 'page' }, h('div', { class: 'empty' }, 'Нет связи с сервером'), h('button', { class: 'btn block', onclick: () => location.reload() }, 'Повторить')));
        return;
      }
      S.me = null;
    }
  }
  render();
}
boot();

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
