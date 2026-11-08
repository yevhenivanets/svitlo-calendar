// Тести чистої логіки (src/core.gs). Запуск: TZ=Europe/Kyiv node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src/core.gs'), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const C = mod.exports;
const html = fs.readFileSync(path.join(__dirname, 'fixtures/channel_2026-11-07.html'), 'utf8');
const posts = C.parsePosts(html);
const byId = (id) => posts.find((p) => p.id === id);
const hm = (d) => d.toTimeString().slice(0, 5);

test('часовий пояс тестів - Київ', () => {
  assert.ok(['Europe/Kyiv', 'Europe/Kiev'].includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
});

test('parsePosts: 20 постів #1715-#1734 з текстом і часом', () => {
  assert.strictEqual(posts.length, 20);
  assert.strictEqual(posts[0].id, 1715);
  assert.strictEqual(posts[19].id, 1734);
  assert.match(byId(1731).text, /Черга 2\.2: 02-04, 10-12, 14-16, 18-20\n/);
  assert.strictEqual(byId(1731).time, '2026-11-06T18:38:11+00:00');
  assert.match(byId(1731).text, /НЕК "Укренерго"/); // &quot; розкодовано
  assert.strictEqual(byId(1734).text, 'В 07:21 скасовано СГАВ 1, 2 чергу');
});

test('looksLikeSchedule: графіки так, прогноз / ГОП / СГАВ ні', () => {
  assert.ok(C.looksLikeSchedule(byId(1731).text));
  assert.ok(C.looksLikeSchedule(byId(1715).text));
  for (const id of [1721, 1722, 1732, 1733, 1734]) assert.ok(!C.looksLikeSchedule(byId(id).text), String(id));
});

test('regexQueue: формат 02-04', () => {
  assert.deepStrictEqual(C.regexQueue(byId(1731).text, '2.2'), [
    { start: '02:00', end: '04:00' }, { start: '10:00', end: '12:00' },
    { start: '14:00', end: '16:00' }, { start: '18:00', end: '20:00' }]);
});

test('regexQueue: формат 07:00-08:00 і 22:00-24:00', () => {
  const r = C.regexQueue(byId(1717).text, '2.2');
  assert.strictEqual(r.length, 5);
  assert.deepStrictEqual(r[0], { start: '07:00', end: '08:00' });
  assert.deepStrictEqual(r[4], { start: '22:00', end: '24:00' });
});

test('regexQueue: змішаний формат 20-21:30 і черга 2.1 не плутається з 2.2', () => {
  assert.deepStrictEqual(C.regexQueue(byId(1729).text, '5.1').at(-1), { start: '20:00', end: '21:30' });
  assert.notDeepStrictEqual(C.regexQueue(byId(1718).text, '2.1'), C.regexQueue(byId(1718).text, '2.2'));
});

test('regexQueue: черги немає -> null', () => {
  assert.strictEqual(C.regexQueue(byId(1734).text, '2.2'), null);
});

test('hashText стабільний і чутливий до правки', () => {
  assert.strictEqual(C.hashText('abc'), C.hashText('abc'));
  assert.notStrictEqual(C.hashText(byId(1732).text), C.hashText(byId(1734).text));
});

test('desiredEvents: 07.11, черга 2.2 -> 4 вимкнення і 4 увімкнення', () => {
  const sch = { '2026-11-07': { post: 1731, intervals: C.regexQueue(byId(1731).text, '2.2') } };
  const ev = C.desiredEvents(sch, ['2026-11-07', '2026-11-08'], 15);
  assert.strictEqual(ev.length, 8);
  assert.deepStrictEqual(ev.filter((e) => e.kind === 'off').map((e) => hm(e.start) + '-' + hm(e.end)),
    ['02:00-04:00', '10:00-12:00', '14:00-16:00', '18:00-20:00']);
  assert.deepStrictEqual(ev.filter((e) => e.kind === 'on').map((e) => hm(e.start)), ['04:00', '12:00', '16:00', '20:00']);
});

test('desiredEvents: суміжні інтервали і перехід через північ склеюються', () => {
  const sch = {
    '2026-11-07': { post: 1, intervals: [{ start: '10:00', end: '12:00' }, { start: '12:00', end: '14:00' }, { start: '22:00', end: '24:00' }] },
    '2026-11-08': { post: 2, intervals: [{ start: '00:00', end: '02:00' }] },
  };
  const ev = C.desiredEvents(sch, ['2026-11-07', '2026-11-08'], 15);
  const off = ev.filter((e) => e.kind === 'off');
  assert.deepStrictEqual(off.map((e) => hm(e.start) + '-' + hm(e.end)), ['10:00-14:00', '22:00-02:00']);
  const lastOn = ev.filter((e) => e.kind === 'on').at(-1);
  assert.strictEqual(C.ymd(lastOn.start), '2026-11-08');
  assert.strictEqual(lastOn.owner, '2026-11-08');
});

test('desiredEvents: 22-24 без графіка на завтра -> увімкнення о 00:00 належить сьогодні', () => {
  const sch = { '2026-11-07': { post: 1, intervals: [{ start: '22:00', end: '24:00' }] } };
  const on = C.desiredEvents(sch, ['2026-11-07', '2026-11-08'], 15).find((e) => e.kind === 'on');
  assert.strictEqual(C.ymd(on.start), '2026-11-08');
  assert.strictEqual(on.owner, '2026-11-07');
});

test('planSync: зміна графіка - нове створити, зникле майбутнє видалити, минуле і поточне не чіпати', () => {
  const now = new Date(2026, 10, 7, 11, 0);
  const old = C.desiredEvents({ '2026-11-07': { post: 1, intervals: [
    { start: '02:00', end: '04:00' }, { start: '10:00', end: '12:00' }, { start: '14:00', end: '16:00' }] } }, ['2026-11-07'], 15);
  const existing = old.map((e) => ({ key: e.key, owner: e.owner, start: e.start, end: e.end }));
  const fresh = C.desiredEvents({ '2026-11-07': { post: 2, intervals: [
    { start: '02:00', end: '04:00' }, { start: '10:00', end: '12:00' }, { start: '15:00', end: '16:00' }] } }, ['2026-11-07'], 15);
  const plan = C.planSync(fresh, existing, ['2026-11-07'], now);
  assert.deepStrictEqual(plan.del.map((e) => e.kind || e.key.split('|')[0] + ' ' + hm(e.start)), ['off 14:00']);
  assert.deepStrictEqual(plan.create.map((e) => e.kind + ' ' + hm(e.start)), ['off 15:00']);
});

test('planSync: дублікати однієї події видаляються, повтор без змін нічого не робить', () => {
  const now = new Date(2026, 10, 7, 0, 0);
  const d = C.desiredEvents({ '2026-11-07': { post: 1, intervals: [{ start: '02:00', end: '04:00' }] } }, ['2026-11-07'], 15);
  const ex = d.map((e) => ({ key: e.key, owner: e.owner, start: e.start, end: e.end }));
  assert.deepStrictEqual(C.planSync(d, ex, ['2026-11-07'], now), { create: [], del: [] });
  const plan = C.planSync(d, ex.concat([ex[0]]), ['2026-11-07'], now);
  assert.strictEqual(plan.del.length, 1);
  assert.strictEqual(plan.create.length, 0);
});

test('regexHeader: дата і тип графіка без Gemini на всіх постах-графіках #1715-#1739', () => {
  const live = C.parsePosts(fs.readFileSync(path.join(__dirname, 'fixtures/channel_2026-11-08.html'), 'utf8'));
  const all = new Map(posts.concat(live).map((p) => [p.id, p]));
  const want = {
    1715: '03.11', 1716: '03.11', 1717: '03.11', 1718: '03.11',
    1719: '04.11', // "Зміни на 21:53 03.11.2026", але графік на 04.11
    1720: '04.11', 1723: '04.11',
    1724: '05.11', 1725: '05.11', 1726: '05.11', 1727: '05.11', 1728: '05.11', 1729: '05.11',
    1730: '06.11', 1731: '07.11', 1735: '08.11', 1736: '08.11', 1737: '08.11', 1738: '08.11', 1739: '08.11',
  };
  const sched = [...all.values()].filter((p) => C.looksLikeSchedule(p.text)).map((p) => p.id).sort();
  assert.deepStrictEqual(sched, Object.keys(want).map(Number).sort());
  for (const [id, dm] of Object.entries(want)) {
    const h = C.regexHeader(all.get(Number(id)).text);
    assert.strictEqual(h.date, '2026-' + dm.slice(3) + '-' + dm.slice(0, 2), '#' + id);
    assert.ok(['gpv_schedule', 'gpv_change'].includes(h.kind), '#' + id);
  }
  assert.strictEqual(C.regexHeader(all.get(1731).text).kind, 'gpv_schedule');
  assert.strictEqual(C.regexHeader(all.get(1739).text).kind, 'gpv_change');
  assert.deepStrictEqual(C.regexQueue(all.get(1739).text, '2.2'), [
    { start: '06:00', end: '08:00' }, { start: '10:00', end: '12:00' }, { start: '22:00', end: '24:00' }]);
});

test('regexHeader: незнайомий формат або дві різні дати -> date null (тоді Gemini)', () => {
  assert.strictEqual(C.regexHeader('Графік на завтра:\nЧерга 2.2: 02-04').date, null);
  assert.strictEqual(C.regexHeader('07.11.2026 за розпорядженням НЕК "Укренерго" ... За розпорядженням НЕК "Укренерго" 08.11.2026').date, null);
  assert.strictEqual(C.regexHeader('Зміни на 22:13 04.11.2026 до графіка\nЧерга 2.2: 02-04').date, null);
});

test('hasBadInterval: нерозібраний інтервал', () => {
  assert.ok(C.hasBadInterval(C.regexQueue('Черга 2.2: 02-04, з 10 до 12', '2.2')));
  assert.ok(!C.hasBadInterval(C.regexQueue('Черга 2.2: 02-04, 20-21:30', '2.2')));
});
