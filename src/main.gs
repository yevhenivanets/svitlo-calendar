/**
 * Точки входу (запускаються з редактора Apps Script кнопкою Run):
 *   setup   - один раз: дозволи, календар, таймер; потім одразу run
 *   run     - основний цикл (його кличе таймер)
 *   status  - що в стані: останні пости, графіки на дати, помилки
 *   cleanup - видалити всі майбутні події скрипта з календаря (напр. перед зміною CALENDAR)
 *   stop    - вимкнути таймер
 *   share   - застосувати PUBLIC / SHARE_WITH і показати посилання на календар (setup теж це робить)
 */

var TAG = 'svitlo';

function setup() {
  checkAccount_();
  stop();
  var every = Number(cfg('CHECK_EVERY_MIN'));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(every).create();
  var cal = calendar_();
  console.log('Акаунт: ' + Session.getEffectiveUser().getEmail() + '; календар: "' + cal.getName() + '"; таймер: кожні ' + every + ' хв');
  share();
  run();
}

/** Скрипт має працювати лише під акаунтом ACCOUNT (щоб не потрапити в робочий календар). */
function checkAccount_() {
  var want = String(cfg('ACCOUNT')).trim().toLowerCase();
  var me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  if (want && me !== want) {
    throw new Error('Скрипт запущено під ' + (me || 'невідомим акаунтом') + ', а має бути ' + want +
      '. Відкрий редактор під потрібним акаунтом (або зміни Script Property ACCOUNT).');
  }
}

/** Публічність і доступ для родини через Calendar API (advanced service), лише додає права. */
function share() {
  checkAccount_();
  var cal = calendar_();
  var id = cal.getId();
  var acl = (Calendar.Acl.list(id).items || []);
  var has = function (type, value) {
    return acl.some(function (r) { return r.scope.type === type && (value === undefined || String(r.scope.value).toLowerCase() === value); });
  };
  var isPublic = String(cfg('PUBLIC')).toLowerCase() === 'true';
  if (isPublic && !has('default')) {
    Calendar.Acl.insert({ role: 'reader', scope: { type: 'default' } }, id);
    console.log('Календар став публічним');
  }
  if (!isPublic) {
    acl.filter(function (r) { return r.scope.type === 'default'; }).forEach(function (r) {
      Calendar.Acl.remove(id, r.id);
      console.log('Публічний доступ вимкнено');
    });
  }
  String(cfg('SHARE_WITH')).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String).forEach(function (email) {
    if (has('user', email)) return;
    Calendar.Acl.insert({ role: 'reader', scope: { type: 'user', value: email } }, id, { sendNotifications: true });
    console.log('Надано доступ: ' + email + ' (прийде лист-запрошення)');
  });
  console.log(links_(id));
}

function links_(id) {
  var enc = encodeURIComponent(id);
  var cid = Utilities.base64Encode(id).replace(/=+$/, '');
  return 'Посилання на календар:\n' +
    '  додати собі (Google Calendar, оновлюється одразу): https://calendar.google.com/calendar/u/0?cid=' + cid + '\n' +
    '  переглянути в браузері: https://calendar.google.com/calendar/embed?src=' + enc + '&ctz=Europe%2FKiev\n' +
    '  iCal (Apple / Outlook, оновлюється рідше): https://calendar.google.com/calendar/ical/' + enc + '/public/basic.ics\n' +
    '  (два останні працюють, лише якщо PUBLIC = true)';
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
    checkAccount_();
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
    schedules: s.schedules, errors: s.errors.slice(-10), seen: Object.keys(s.seen).length,
    geminiCalls: s.geminiCalls || 0,
    geminiPausedUntil: s.geminiPauseUntil > Date.now() ? Utilities.formatDate(new Date(s.geminiPauseUntil), 'Europe/Kiev', 'dd.MM HH:mm') : null
  }, null, 2));
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

  // Gemini - лише запасний варіант: коли regex не впевнений у даті графіка. Після помилки API - пауза, а не повтор кожні 5 хв.
  var geminiOk = !(state.geminiPauseUntil > Date.now());
  var changed = [];
  posts.forEach(function (p) {
    var h = hashText(p.text + '|' + queue);
    if (state.seen[p.id] === h) return;
    var old = p.time && new Date(p.time).getTime() < Date.now() - 2 * 86400000;
    if (old || !looksLikeSchedule(p.text)) { state.seen[p.id] = h; return; } // старе або не графік

    var rx = regexQueue(p.text, queue);
    if (rx === null) { state.seen[p.id] = h; return; } // у пості немає цієї черги
    if (hasBadInterval(rx)) {
      state.seen[p.id] = h;
      logError_(state, 'Пост #' + p.id + ': не розібрано рядок черги ' + JSON.stringify(rx) + ' - пропущено');
      return;
    }
    var pub = ymd(new Date(p.time));
    var inRange = function (d) { return d && d >= addDays(pub, -1) && d <= addDays(pub, 2); };
    var hd = regexHeader(p.text);
    var date = hd.kind && inRange(hd.date) ? hd.date : null;
    var via = 'regex';

    if (!date) {
      if (!geminiOk) return; // пауза Gemini - пост перечитаємо після неї
      var g;
      try {
        g = gemini_(p, queue);
        state.geminiCalls = (state.geminiCalls || 0) + 1;
      } catch (e) {
        geminiOk = false;
        state.geminiPauseUntil = Date.now() + Number(cfg('GEMINI_PAUSE_MIN')) * 60000;
        logError_(state, 'Пост #' + p.id + ': regex не визначив дату, а Gemini недоступний (' + String(e.message).slice(0, 160) +
          ') - пауза ' + cfg('GEMINI_PAUSE_MIN') + ' хв');
        return;
      }
      state.seen[p.id] = h;
      if (g.kind !== 'gpv_schedule' && g.kind !== 'gpv_change') return;
      if (!sameIntervals(g.intervals, rx)) {
        logError_(state, 'Пост #' + p.id + ': Gemini ' + JSON.stringify(g.intervals) + ' != regex ' + JSON.stringify(rx) + ' - пропущено');
        return;
      }
      if (!inRange(g.target_date)) {
        logError_(state, 'Пост #' + p.id + ': дивна дата графіка ' + g.target_date + ' (опубліковано ' + pub + ') - пропущено');
        return;
      }
      date = g.target_date;
      via = 'Gemini';
    }
    state.seen[p.id] = h;

    var cur = state.schedules[date];
    if (cur && cur.post > p.id) return; // уже є новіший пост на цю дату
    if (cur && sameIntervals(cur.intervals, rx)) { cur.post = p.id; cur.at = p.time; return; } // для черги нічого не змінилось
    state.schedules[date] = { post: p.id, intervals: rx, at: p.time, via: via };
    changed.push(date + ' (#' + p.id + ', ' + via + ')');
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
  if (found.length) return found[0];
  var cal = CalendarApp.createCalendar(name, { color: CalendarApp.Color.YELLOW });
  cal.setTimeZone('Europe/Kiev');
  cal.setDescription('Графік відключень світла, черга ' + cfg('QUEUE') + ', з каналу t.me/' + cfg('CHANNEL') +
    '. Оновлюється автоматично (github.com/yevhenivanets/svitlo-calendar).');
  return cal;
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
