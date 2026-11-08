/**
 * Чиста логіка без сервісів Google: розбір HTML каналу, рядка черги, склейка інтервалів, бажані події.
 * Час - локальний для скрипта (appsscript.json: Europe/Kyiv; у тестах TZ=Europe/Kyiv).
 */

function decodeHtml_(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&amp;/g, '&');
}

/** HTML t.me/s/<канал> -> [{id, time, text}] за зростанням id. */
function parsePosts(html) {
  var out = [];
  var blocks = html.split('class="tgme_widget_message_wrap').slice(1);
  blocks.forEach(function (b) {
    var id = b.match(/data-post="[^"\/]+\/(\d+)"/);
    if (!id) return;
    var tm = b.match(/<time datetime="([^"]+)"/);
    var tx = b.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    out.push({ id: Number(id[1]), time: tm ? tm[1] : null, text: tx ? decodeHtml_(tx[1]).trim() : '' });
  });
  return out.sort(function (a, b) { return a.id - b.id; });
}

/** Простий стабільний хеш тексту (щоб помітити редагування поста). */
function hashText(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Пост схожий на графік ГПВ (є рядки "Черга N.N:"). */
function looksLikeSchedule(text) {
  return /Черга\s*\d+\.\d+\s*:/.test(text);
}

function normTime_(t) {
  var m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

/** Інтервали з рядка "Черга <queue>: 02-04, 07:00-08:00, 20-21:30" -> [{start:'02:00', end:'04:00'}]; null - рядка немає. */
function regexQueue(text, queue) {
  var re = new RegExp('Черга\\s*' + queue.replace('.', '\\.') + '\\s*:\\s*([^\\n]*)');
  var m = text.match(re);
  if (!m) return null;
  var body = m[1].trim();
  if (body === '' || /^(—|-|немає|відсутн)/i.test(body)) return [];
  var res = [];
  body.split(',').forEach(function (part) {
    var p = part.trim().match(/^(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)$/);
    if (!p) { res.push({ start: 'ERR', end: part.trim() }); return; }
    res.push({ start: normTime_(p[1]) || 'ERR', end: normTime_(p[2]) || 'ERR' });
  });
  return res;
}

/**
 * Тип і дата графіка з шапки поста без Gemini.
 * Дата графіка - та, що стоїть поруч із "за розпорядженням НЕК Укренерго":
 *   "07.11.2026 за розпорядженням ... буде діяти", "На 08.11.2026 за розпорядженням ... внесено зміни",
 *   "За розпорядженням НЕК "Укренерго" 05.11.2026 внесено зміни" (а "Зміни на 22:13 04.11.2026" - час публікації, не дата).
 * Повертає {kind: 'gpv_schedule'|'gpv_change'|null, date: 'YYYY-MM-DD'|null}; date = null, якщо дат немає або вони різні.
 */
function regexHeader(text) {
  var kind = /внесено\s+зміни/i.test(text) ? 'gpv_change' : /буде\s+діяти/i.test(text) ? 'gpv_schedule' : null;
  var nek = 'за\\s+розпорядженням\\s+НЕК\\s*["“«]?\\s*Укренерго\\s*["”»]?';
  var res = [new RegExp('(\\d{2})\\.(\\d{2})\\.(\\d{4})\\s+' + nek, 'gi'), new RegExp(nek + '\\s+(\\d{2})\\.(\\d{2})\\.(\\d{4})', 'gi')];
  var dates = {};
  res.forEach(function (re) {
    var m;
    while ((m = re.exec(text))) dates[m[3] + '-' + m[2] + '-' + m[1]] = true;
  });
  var list = Object.keys(dates);
  return { kind: kind, date: list.length === 1 ? list[0] : null };
}

function hasBadInterval(iv) {
  return iv.some(function (x) { return x.start === 'ERR' || x.end === 'ERR'; });
}

function sameIntervals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (normTime_(a[i].start) !== normTime_(b[i].start) || normTime_(a[i].end) !== normTime_(b[i].end)) return false;
  }
  return true;
}

function ymd(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function addDays(dateStr, n) {
  var p = dateStr.split('-').map(Number);
  return ymd(new Date(p[0], p[1] - 1, p[2] + n));
}

function at_(dateStr, hhmm) {
  var p = dateStr.split('-').map(Number);
  var t = hhmm.split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0], t[1]); // 24:00 -> 00:00 наступного дня
}

/**
 * schedules: {'2026-11-07': {post, intervals:[{start,end}]}}; dates - які дати брати.
 * Повертає бажані події: [{key, kind:'off'|'on', start:Date, end:Date, owner, post}].
 * Суміжні й перекриті інтервали склеюються, зокрема через північ.
 */
function desiredEvents(schedules, dates, onMinutes) {
  var spans = [];
  dates.forEach(function (d) {
    var s = schedules[d];
    if (!s) return;
    s.intervals.forEach(function (iv) {
      spans.push({ start: at_(d, iv.start), end: at_(d, iv.end), owner: d, post: s.post });
    });
  });
  spans.sort(function (a, b) { return a.start - b.start; });
  var merged = [];
  spans.forEach(function (sp) {
    var last = merged[merged.length - 1];
    if (last && sp.start <= last.end) {
      if (sp.end > last.end) { last.end = sp.end; last.endOwner = sp.owner; last.endPost = sp.post; }
    } else {
      merged.push({ start: sp.start, end: sp.end, owner: sp.owner, post: sp.post, endOwner: sp.owner, endPost: sp.post });
    }
  });
  var ev = [];
  merged.forEach(function (m) {
    if (m.end <= m.start) return;
    ev.push({ key: 'off|' + m.start.getTime() + '|' + m.end.getTime(), kind: 'off', start: m.start, end: m.end, owner: m.owner, post: m.post });
    ev.push({ key: 'on|' + m.end.getTime(), kind: 'on', start: m.end, end: new Date(m.end.getTime() + onMinutes * 60000), owner: m.endOwner, post: m.endPost });
  });
  return ev;
}

/** Порівняння бажаних і наявних подій. existing: [{key, owner, start, end, ref}]. Чіпаємо лише те, що ще не закінчилось. */
function planSync(desired, existing, managedDates, now) {
  var want = {};
  desired.forEach(function (e) { want[e.key] = e; });
  var have = {};
  var toDelete = [];
  existing.forEach(function (e) {
    if (have[e.key] || (!want[e.key] && managedDates.indexOf(e.owner) >= 0 && e.end > now)) toDelete.push(e);
    else have[e.key] = e;
  });
  var toCreate = desired.filter(function (e) { return !have[e.key] && e.end > now; });
  return { create: toCreate, del: toDelete };
}

if (typeof module !== 'undefined') {
  module.exports = { parsePosts: parsePosts, hashText: hashText, looksLikeSchedule: looksLikeSchedule, regexQueue: regexQueue,
    regexHeader: regexHeader, hasBadInterval: hasBadInterval,
    sameIntervals: sameIntervals, desiredEvents: desiredEvents, planSync: planSync, ymd: ymd, addDays: addDays };
}
