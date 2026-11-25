// Гео и валюты. Что включено — задаётся переменными окружения:
//   ENABLE_GEOS=KZ,AE,TR      (по умолчанию только KZ)
//   ENABLE_CURRENCIES=USD     (добавить валюты сверх валют включённых гео)
// Добавить новую страну: одна строка в GEOS.

export const APP_NAME = 'Окошко';

export const CURRENCIES = {
  KZT: { name: 'Тенге' },
  AED: { name: 'Дирхам' },
  TRY: { name: 'Лира' },
  USD: { name: 'Доллар' },
  EUR: { name: 'Евро' },
  RUB: { name: 'Рубль' },
};

export const GEOS = {
  KZ: { name: 'Казахстан', currency: 'KZT', timezone: 'Asia/Almaty', phoneHint: '+7 7XX XXX XX XX' },
  AE: { name: 'ОАЭ (Дубай)', currency: 'AED', timezone: 'Asia/Dubai', phoneHint: '+971 5X XXX XXXX' },
  TR: { name: 'Турция', currency: 'TRY', timezone: 'Europe/Istanbul', phoneHint: '+90 5XX XXX XX XX' },
  US: { name: 'США', currency: 'USD', timezone: 'America/New_York', phoneHint: '+1 XXX XXX XXXX' },
  RU: { name: 'Россия', currency: 'RUB', timezone: 'Europe/Moscow', phoneHint: '+7 9XX XXX XX XX' },
};

const list = (s) => String(s || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

export function enabledConfig(env = process.env) {
  let geoCodes = list(env.ENABLE_GEOS || 'KZ').filter((c) => GEOS[c]);
  if (!geoCodes.length) geoCodes = ['KZ'];
  const curCodes = [
    ...new Set([
      ...geoCodes.map((c) => GEOS[c].currency),
      ...list(env.ENABLE_CURRENCIES).filter((c) => CURRENCIES[c]),
    ]),
  ];
  return {
    appName: APP_NAME,
    geos: Object.fromEntries(geoCodes.map((c) => [c, GEOS[c]])),
    currencies: Object.fromEntries(curCodes.map((c) => [c, CURRENCIES[c]])),
  };
}
