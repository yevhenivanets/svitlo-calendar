/**
 * Налаштування за замовчуванням. Змінювати без коду: редактор Apps Script -> Project Settings -> Script Properties
 * (той самий ключ, напр. QUEUE = 3.1). Script Properties мають пріоритет.
 */
var DEFAULTS = {
  ACCOUNT: 'evgeniyivanets@gmail.com',   // під яким Google-акаунтом має працювати скрипт (інший - помилка)
  PUBLIC: 'true',                        // календар публічний: будь-хто з посиланням бачить і може додати собі
  SHARE_WITH: '',                        // Gmail-и через кому - поділитися напряму (прийде лист-запрошення)
  CHANNEL: 'SvitloHolovanivskohoRayonu', // публічний канал, https://t.me/s/<CHANNEL>
  QUEUE: '2.2',                          // черга ГПВ
  CALENDAR: 'Світло 2.2',                // назва календаря (створиться сам) або ID календаря (з "@")
  REMIND_MIN: '10',                      // за скільки хвилин нагадувати
  DAYS: '2',                             // скільки днів вести: 2 = сьогодні + завтра
  TITLE_OFF: 'Світла немає',
  TITLE_ON: 'Світло повертається',
  ON_EVENT_MIN: '15',                    // тривалість події "Світло повертається"
  GEMINI_MODEL: 'gemini-3.8-flash',
  CHECK_EVERY_MIN: '5'                   // 1, 5, 10, 15 або 30 (після зміни - запустити setup)
};

function cfg(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v !== null && v !== '' ? v : DEFAULTS[key];
}

function geminiKey_() {
  var v = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (v) return v;
  if (typeof GEMINI_API_KEY_FROM_ENV !== 'undefined' && GEMINI_API_KEY_FROM_ENV) return GEMINI_API_KEY_FROM_ENV;
  throw new Error('Немає ключа Gemini: запусти ./deploy.sh (бере GEMINI_API_KEY з .env) або додай Script Property GEMINI_API_KEY');
}
