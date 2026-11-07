/**
 * Точки входу (запускаються з редактора Apps Script кнопкою Run):
 *   setup   - один раз: дозволи, календар, таймер; потім одразу run
 *   run     - основний цикл (його кличе таймер)
 *   status  - що в стані: останні пости, графіки на дати, помилки
 *   cleanup - видалити всі майбутні події скрипта з календаря (напр. перед зміною CALENDAR)
 *   stop    - вимкнути таймер
 */

var TAG = 'svitlo';

function setup() {
  stop();
  var every = Number(cfg('CHECK_EVERY_MIN'));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(every).create();
  var cal = calendar_();
  console.log('Календар: "' + cal.getName() + '" (' + cal.getId() + '), таймер: кожні ' + every + ' хв');
  run();
}

function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
}

function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var state = loadState_();
    var changed = ingest_(state);
    var res = sync_(state);
    saveState_(state);
    if (changed.length || res.created || res.deleted) {
      console.log('Нові графіки: ' + (changed.join(', ') || '-') + '; подій створено ' + res.created + ', видалено ' + res.deleted);
    }
  } finally {
    lock.releaseLock();
  }
}

function status() {
  var s = loadState_();
  console.log(JSON.stringify({ queue: cfg('QUEUE'), channel: cfg('CHANNEL'), calendar: cfg('CALENDAR'),
    schedules: s.schedules, errors: s.errors.slice(-10), seen: Object.keys(s.seen).length }, null, 2));
}

function cleanup() {
  var cal = calendar_();
  var now = new Date();
  var n = 0;
  cal.getEvents(now, new Date(now.getTime() + 7 * 86400000)).forEach(function (e) {
    if (e.getTag(TAG)) { e.deleteEvent(); n++; }
  });
  console.log('Видалено подій: ' + n);
}

/* ---------- стан ---------- */

function loadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty('STATE');
  var s = raw ? JSON.parse(raw) : {};
  s.seen = s.seen || {};
  s.schedules = s.schedules || {};
  s.errors = s.errors || [];
  return s;
}

function saveState_(s) {
  var ids = Object.keys(s.seen).map(Number).sort(function (a, b) { return a - b; });
  ids.slice(0, Math.max(0, ids.length - 60)).forEach(function (id) { delete s.seen[id]; });
  var keep = addDays(ymd(new Date()), -3);
  Object.keys(s.schedules).forEach(function (d) { if (d < keep) delete s.schedules[d]; });
  s.errors = s.errors.slice(-20);
  PropertiesService.getScriptProperties().setProperty('STATE', JSON.stringify(s));
}

function logError_(s, msg) {
  console.warn(msg);
  s.errors.push(Utilities.formatDate(new Date(), 'Europe/Kiev', 'dd.MM HH:mm') + ' ' + msg);
}

/* ---------- канал -> графіки ---------- */

function ingest_(state) {
  var channel = cfg('CHANNEL');
  var queue = cfg('QUEUE');
  var resp = UrlFetchApp.fetch('https://t.me/s/' + channel, { muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() !== 200) throw new Error('t.me/s/' + channel + ': HTTP ' + resp.getResponseCode());
  var posts = parsePosts(resp.getContentText());
  if (!posts.length) throw new Error('t.me/s/' + channel + ': постів не знайдено (канал приватний або змінилась верстка?)');

  var changed = [];
  posts.forEach(function (p) {
    var h = hashText(p.text + '|' + queue);
    if (state.seen[p.id] === h) return;
    var old = p.time && new Date(p.time).getTime() < Date.now() - 2 * 86400000;
    if (old || !looksLikeSchedule(p.text)) { state.seen[p.id] = h; return; } // старе або не графік - без Gemini

    var g = gemini_(p, queue); // помилка мережі / API -> виняток, пост перечитаємо наступного разу
    state.seen[p.id] = h;
    if (g.kind !== 'gpv_schedule' && g.kind !== 'gpv_change') return;

    var rx = regexQueue(p.text, queue);
    if (rx === null) return; // у пості немає цієї черги
    if (!sameIntervals(g.intervals, rx)) {
      logError_(state, 'Пост #' + p.id + ': Gemini ' + JSON.stringify(g.intervals) + ' != regex ' + JSON.stringify(rx) + ' - пропущено');
      return;
    }
    var pub = ymd(new Date(p.time));
    if (!g.target_date || g.target_date < addDays(pub, -1) || g.target_date > addDays(pub, 2)) {
      logError_(state, 'Пост #' + p.id + ': дивна дата графіка ' + g.target_date + ' (опубліковано ' + pub + ') - пропущено');
      return;
    }
    var cur = state.schedules[g.target_date];
    if (cur && cur.post > p.id) return; // уже є новіший пост на цю дату
    state.schedules[g.target_date] = { post: p.id, intervals: rx, at: p.time };
    changed.push(g.target_date + ' (#' + p.id + ')');
  });
  return changed;
}

function gemini_(post, queue) {
  var prompt =
    'Це пост з Telegram-каналу обленерго про відключення світла. Опубліковано: ' + post.time + ' (UTC; Україна - Europe/Kyiv).\n' +
    'Визнач:\n' +
    '- kind: gpv_schedule (графік погодинних відключень ГПВ на дату), gpv_change (зміни до ГПВ на дату), forecast (прогноз без годин), gop, sgav, other;\n' +
    '- target_date (YYYY-MM-DD): дата, НА ЯКУ діє графік. Увага: рядок "Зміни на HH:MM DD.MM.YYYY" - це час публікації змін, а не дата графіка; ' +
    'дата графіка - та, що стоїть біля "За розпорядженням НЕК Укренерго ... DD.MM.YYYY" або "DD.MM.YYYY ... буде діяти" або "На DD.MM.YYYY";\n' +
    '- intervals: інтервали відключень лише для "Черга ' + queue + '" у форматі HH:MM (02-04 -> 02:00-04:00, 24 -> 24:00), у тому порядку, як у тексті; ' +
    'якщо черги немає - порожній масив.\n\nТекст поста:\n' + post.text;
  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['gpv_schedule', 'gpv_change', 'forecast', 'gop', 'sgav', 'other'] },
          target_date: { type: 'STRING', nullable: true },
          intervals: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] } }
        },
        required: ['kind', 'intervals']
      }
    }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + cfg('GEMINI_MODEL') + ':generateContent';
  var resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { 'x-goog-api-key': geminiKey_() }, muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('Gemini HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 300));
  var j = JSON.parse(resp.getContentText());
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

/* ---------- графіки -> календар ---------- */

function calendar_() {
  var name = cfg('CALENDAR');
  if (name.indexOf('@') >= 0) {
    var byId = CalendarApp.getCalendarById(name);
    if (!byId) throw new Error('Календар з ID ' + name + ' не знайдено');
    return byId;
  }
  var found = CalendarApp.getOwnedCalendarsByName(name);
  return found.length ? found[0] : CalendarApp.createCalendar(name, { color: CalendarApp.Color.YELLOW });
}

function sync_(state) {
  var now = new Date();
  var today = ymd(now);
  var days = Number(cfg('DAYS'));
  var horizon = [];
  for (var i = 0; i < days; i++) horizon.push(addDays(today, i));
  var managed = horizon.filter(function (d) { return state.schedules[d]; });

  var desired = desiredEvents(state.schedules, [addDays(today, -1)].concat(horizon), Number(cfg('ON_EVENT_MIN')))
    .filter(function (e) { return horizon.indexOf(e.owner) >= 0 || e.end > now; });

  var cal = calendar_();
  var from = new Date(now.getTime() - 86400000);
  var to = new Date(now.getTime() + (days + 1) * 86400000);
  var existing = cal.getEvents(from, to).filter(function (e) { return e.getTag(TAG); }).map(function (e) {
    return { key: e.getTag(TAG), owner: e.getTag('owner'), start: e.getStartTime(), end: e.getEndTime(), ref: e };
  });

  var plan = planSync(desired, existing, managed, now);
  plan.del.forEach(function (e) { e.ref.deleteEvent(); });

  var remind = Number(cfg('REMIND_MIN'));
  var channel = cfg('CHANNEL');
  var queue = cfg('QUEUE');
  var stamp = Utilities.formatDate(now, 'Europe/Kiev', 'dd.MM HH:mm');
  plan.create.forEach(function (e) {
    var title = (e.kind === 'off' ? cfg('TITLE_OFF') : cfg('TITLE_ON')) + ' (' + queue + ')';
    var ev = cal.createEvent(title, e.start, e.end, {
      description: 'Черга ' + queue + ', графік з поста https://t.me/' + channel + '/' + e.post + '\nСтворено: ' + stamp
    });
    ev.removeAllReminders();
    if (e.start.getTime() - remind * 60000 > now.getTime()) ev.addPopupReminder(remind);
    ev.setTag(TAG, e.key);
    ev.setTag('owner', e.owner);
  });
  return { created: plan.create.length, deleted: plan.del.length };
}
