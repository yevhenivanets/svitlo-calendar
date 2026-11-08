// Локальна перевірка без календаря: той самий код src/*.gs проти живого каналу і Gemini.
// Запуск: TZ=Europe/Kyiv node tools/dry-run.js [шлях до .env, за замовчуванням ../records/.env]
// Друкує, які графіки знайдено і які події скрипт поставив би в календар. Ключ не виводиться.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const envFile = process.argv[2] || path.join(__dirname, '../../records/.env');
const keyLine = fs.readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('GEMINI_API_KEY='));
if (!keyLine) throw new Error('GEMINI_API_KEY немає в ' + envFile);
const KEY = keyLine.slice('GEMINI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');

// Шими сервісів Apps Script: HTTP через curl (конфіг через stdin, щоб ключ не потрапив у список процесів).
const props = {};
const UrlFetchApp = {
  fetch(url, o = {}) {
    const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const cfg = ['url = ' + q(url), 'silent', 'location', 'write-out = "\\n%{http_code}"'];
    if (o.method === 'post') {
      cfg.push('request = "POST"', 'header = "Content-Type: application/json"', 'data-binary = ' + q(o.payload));
    }
    for (const [k, v] of Object.entries(o.headers || {})) cfg.push('header = ' + q(k + ': ' + v));
    const out = execFileSync('curl', ['-K', '-'], { input: cfg.join('\n'), maxBuffer: 1 << 26 }).toString();
    const i = out.lastIndexOf('\n');
    const body = out.slice(0, i), code = Number(out.slice(i + 1));
    return { getResponseCode: () => code, getContentText: () => body };
  },
};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: (k) => (k === 'GEMINI_API_KEY' ? KEY : props[k] ?? null),
  setProperty: (k, v) => { props[k] = v; },
}) };
const Utilities = { formatDate: (d) => d.toTimeString().slice(0, 5) };

const code = ['core.gs', 'config.gs', 'main.gs'].map((f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
const api = new Function('UrlFetchApp', 'PropertiesService', 'Utilities', 'console', 'module',
  code + '\nreturn { ingest_, loadState_, desiredEvents, addDays, ymd, cfg };')(UrlFetchApp, PropertiesService, Utilities, console, undefined);

const state = api.loadState_();
const changed = api.ingest_(state);
console.log('Черга ' + api.cfg('QUEUE') + ', канал ' + api.cfg('CHANNEL'));
console.log('Графіки з постів:', changed.join(', ') || '-');
console.log('Викликів Gemini: ' + (state.geminiCalls || 0));
for (const [d, s] of Object.entries(state.schedules).sort()) {
  console.log('  ' + d + ' (#' + s.post + '): ' + s.intervals.map((i) => i.start + '-' + i.end).join(', '));
}
if (state.errors.length) console.log('Помилки:\n  ' + state.errors.join('\n  '));

const today = api.ymd(new Date());
const horizon = [today, api.addDays(today, 1)];
const ev = api.desiredEvents(state.schedules, [api.addDays(today, -1)].concat(horizon), 15)
  .filter((e) => horizon.includes(e.owner));
const hm = (d) => api.ymd(d).slice(5) + ' ' + d.toTimeString().slice(0, 5);
console.log('\nПодії в календарі на ' + horizon.join(' і ') + ':');
for (const e of ev) {
  console.log('  ' + (e.kind === 'off' ? 'Світла немає        ' : 'Світло повертається ') + hm(e.start) +
    (e.kind === 'off' ? ' - ' + hm(e.end) : '') + '  (нагадування о ' + hm(new Date(e.start - 10 * 60000)).slice(6) + ')');
}
