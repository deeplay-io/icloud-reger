const $ = (s, root = document) => root.querySelector(s);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TIME_ZONE = 'Asia/Novosibirsk';
const timeOf = ms => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dateTimeOf = ms => new Date(ms).toLocaleString('ru-RU', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const whenOf = ms => ms <= Date.now() ? 'сейчас' : timeOf(ms);
/** Текст ошибки как законченное предложение, чтобы следующее не прилипало к нему. */
const sentence = text => { const t = String(text || '').trim(); return /[.!?…]$/.test(t) ? t : t + '.'; };

let currentTab = 'parents';

async function callApi(method, p, body) {
  return window.api.invoke('api:proxy', { method, path: p, body });
}

function apiError(r, fallback) {
  if (r.status === 0) return 'Сервис не запущен: нажмите «▶ Запустить сервис».';
  return (r.body && r.body.error) || fallback + ' (HTTP ' + r.status + ')';
}

function setChip(id, ok, text, title = '') {
  const el = $(id);
  el.textContent = text;
  el.title = title;
  el.className = 'chip ' + (ok ? 'ok' : 'bad');
}

// ---------- Родители ----------

let parents = [];
let renderedSignature = '';
const expanded = new Set();
/** Итог последнего действия по родителю: переживает перерисовку таблицы. */
const results = new Map();

const BROWSER_TEXT = {
  none: p => p.profile ? 'ещё не подключался' : 'нет профиля',
  connecting: () => 'подключаю…',
  connected: () => 'подключён',
  error: () => 'не подключён',
};
const GENERATOR_TEXT = {
  archived: 'отключён',
  off: 'выкл',
  full: 'заполнен',
  'waiting-browser': 'ждёт браузер',
  scheduled: 'вкл',
  creating: 'создаю…',
};
// Коды выдаёт сервис в кластере (cluster.url в config.json): запасного пути через браузер у него нет.
let clusterMode = false;
const IMAP_NONE_CLUSTER = 'Без пароля сервис кодов в кластере не читает ящик этого родителя: коды его алиасов не выдаются (запасного пути через браузер там нет).';
const IMAP_TEXT = {
  none: ['нет пароля', 'wait', 'Коды gRPC читает только через браузер. Задайте app-specific пароль в настройках родителя.'],
  unknown: ['пароль задан', 'wait', 'gRPC-сервис не запущен или ещё не входил в ящик.'],
  connected: ['подключён', 'ok', 'gRPC-сервис читает ящик по IMAP.'],
  auth: ['вход не принят', 'bad', ''],
  error: ['нет связи', 'bad', ''],
};

function browserCell(p) {
  if (p.archived) return '<span class="muted">—</span>';
  const state = p.browser.state;
  const cls = state === 'connected' ? 'ok' : state === 'error' || !p.profile ? 'bad' : 'wait';
  return '<span title="' + escapeHtml(p.browser.error || p.browser.cdpUrl) + '"><span class="dot ' + cls + '"></span>' + escapeHtml(BROWSER_TEXT[state](p)) + '</span>';
}

function hourCell(p) {
  const g = p.generator;
  if (p.archived) return '—';
  let text = g.createdThisHour + '/' + g.hourlyLimit;
  if (g.enabled && !p.full) {
    if (g.attemptsLastHour >= g.hourlyLimit && g.allowedAt > Date.now()) text += ' · лимит до ' + timeOf(g.allowedAt);
    else if (g.nextRunAt) text += ' · ' + whenOf(g.nextRunAt);
  }
  return text;
}

function imapCell(p) {
  const [text, cls, hint] = IMAP_TEXT[p.imap.state] || [p.imap.state, 'wait', ''];
  const title = p.imap.error || (p.imap.state === 'none' && clusterMode ? IMAP_NONE_CLUSTER : hint);
  return '<span title="' + escapeHtml(title) + '"><span class="dot ' + cls + '"></span>' + escapeHtml(text) + '</span>';
}

function browserDetail(p) {
  if (p.archived) return 'Родитель отключён: сервис не подключает его профиль.';
  if (!p.profile) return 'Укажите ID профиля Dolphin Anty с залогиненным iCloud этого родителя (или адрес CDP). Если Dolphin не запущен, сервис откроет его сам.';
  const b = p.browser;
  if (b.state === 'connected') return 'Подключён: ' + b.cdpUrl + '. Если профиль закрыть, сервис откроет его снова.';
  if (b.state === 'connecting') return 'Подключаю профиль…';
  if (b.state === 'error') return 'Ошибка: ' + sentence(b.error) + (b.code === 'PROFILE_REQUIRES_RESTART' ? ' Нажмите «Перезапустить профиль».' : ' Сервис повторит попытку сам через минуту или по кнопке «Подключить».');
  return 'Сервис подключит профиль сам в течение 15 секунд.';
}

function imapDetail(p) {
  const i = p.imap;
  if (i.state === 'none') {
    return clusterMode
      ? 'Пароля нет: сервис кодов в кластере не читает ящик этого родителя, коды его алиасов не выдаются (запасного пути через браузер там нет). Задайте app-specific пароль.'
      : 'Пароля нет: gRPC читает коды этого родителя только через браузер (медленнее, только открытая папка).';
  }
  const via = i.proxy ? ' Через прокси ' + i.proxy + '.' : '';
  if (i.state === 'connected') return 'Пароль задан, gRPC-сервис читает ящик по IMAP.' + via;
  if (i.state === 'unknown') return 'Пароль задан. Состояние появится, когда gRPC-сервис запущен и вошёл в ящик.' + via;
  return 'Пароль задан, но ' + sentence(i.error || 'вход не удался') + via;
}

function syncDetail(p) {
  const s = p.sync;
  if (s.state === 'running') return 'Загрузка из iCloud идёт…';
  if (s.state === 'ok') return 'Загрузка из iCloud ' + dateTimeOf(s.at) + ': ' + s.message + '. Дальше — раз в 6 часов и после каждого подключения профиля.';
  if (s.state === 'error') return 'Загрузка из iCloud ' + dateTimeOf(s.at) + ' не удалась: ' + s.message;
  return 'Алиасы загрузятся из iCloud сами, как только подключится профиль.';
}

function generatorDetail(p) {
  const g = p.generator;
  const parts = [];
  if (p.full) parts.push('Достигнут лимит ' + p.limit + ' алиасов: авторегистрация у этого родителя остановлена, коды читаются.');
  else if (g.state === 'waiting-browser') parts.push('Время создания подошло, но браузер родителя не подключён.');
  if (g.last) parts.push('Последняя авторегистрация ' + dateTimeOf(g.last.at) + ': ' + g.last.message);
  return parts.join(' ');
}

function detailsHtml(p) {
  return '<div class="details-grid">' +
    '<div class="field"><label>Профиль Dolphin Anty (ID) или адрес CDP</label>' +
      '<div class="row"><input type="text" data-input="profile" inputmode="numeric" spellcheck="false" placeholder="902053376" value="' + escapeHtml(p.profile) + '" />' +
      '<button class="secondary" data-action="save-profile">Сохранить</button>' +
      '<button class="secondary" data-action="connect">Подключить</button>' +
      '<button class="secondary" data-action="restart">Перезапустить профиль</button></div>' +
      '<div class="hint" data-f="browser-detail"></div></div>' +
    '<div class="field"><label>IMAP для gRPC: app-specific пароль (account.apple.com → Вход и безопасность → Пароли приложений)</label>' +
      '<div class="row"><input type="password" data-input="imap-password" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx" />' +
      '<input type="text" data-input="imap-proxy" spellcheck="false" placeholder="прокси, необязательно: socks5://…" value="' + escapeHtml(p.imap.proxy) + '" />' +
      '<button class="secondary" data-action="save-imap">Проверить и сохранить</button>' +
      '<button class="secondary" data-action="remove-imap">Удалить пароль</button></div>' +
      '<div class="hint" data-f="imap-detail"></div></div>' +
    '<div class="field"><label>Метка для авторегистрации (без номера и @icloud.com; пусто — начало e-mail родителя)</label>' +
      '<div class="row"><input type="text" data-input="prefix" maxlength="60" spellcheck="false" placeholder="' + escapeHtml(p.email.split('@')[0]) + '" value="' + escapeHtml(p.generator.customPrefix) + '" />' +
      '<button class="secondary" data-action="save-prefix">Сохранить метку</button></div>' +
      '<div class="hint" data-f="next-name"></div></div>' +
    '<div class="field"><label>Создать алиас вручную (адрес назначит iCloud; лимит 5 в час общий с авторегистрацией)</label>' +
      '<div class="row"><input type="text" data-input="alias-name" maxlength="100" spellcheck="false" value="' + escapeHtml(p.generator.nextName || '') + '" />' +
      '<button class="secondary" data-action="create">Создать в iCloud</button>' +
      '<button class="secondary" data-action="sync">Загрузить из iCloud</button></div>' +
      '<div class="hint" data-f="sync"></div>' +
      '<div class="hint" data-f="generator"></div></div>' +
    '<div class="row">' +
      '<button class="secondary" data-action="show-aliases">Алиасы родителя →</button>' +
      '<button class="secondary" data-action="archive" data-f="archive"></button>' +
      '<button class="secondary danger" data-action="delete" title="Только для родителя без алиасов, например добавленного по ошибке">Удалить</button>' +
    '</div>' +
    '<div class="result-line" data-f="result" role="status"></div>' +
  '</div>';
}

function rowHtml(p) {
  const open = expanded.has(p.id);
  return '<tr class="parent-row" data-id="' + p.id + '">' +
    '<td><button class="secondary expand" data-action="expand" title="Настройки родителя">' + (open ? '▾' : '▸') + '</button></td>' +
    '<td><div class="email">' + escapeHtml(p.email) + '</div><div class="sub" data-f="profile"></div></td>' +
    '<td data-f="browser"></td>' +
    '<td data-f="aliases"></td>' +
    '<td><label class="switch"><input type="checkbox" data-toggle="generator" /><span data-f="generator-state"></span></label></td>' +
    '<td data-f="hour"></td>' +
    '<td data-f="imap"></td>' +
    '</tr>' +
    '<tr class="details" data-details="' + p.id + '"' + (open ? '' : ' hidden') + '><td colspan="7">' + detailsHtml(p) + '</td></tr>';
}

/** Обновляет только ячейки состояния: поля ввода (в том числе пароль) при обновлении раз в 5 с не трогаются. */
function updateRow(p) {
  const row = $('tr[data-id="' + p.id + '"]');
  const details = $('tr[data-details="' + p.id + '"]');
  if (!row || !details) return;
  const html = (root, field, value) => {
    const el = root.querySelector('[data-f="' + field + '"]');
    if (el && el.innerHTML !== value) el.innerHTML = value;
  };
  const text = (root, field, value) => {
    const el = root.querySelector('[data-f="' + field + '"]');
    if (el && el.textContent !== value) el.textContent = value;
  };
  row.classList.toggle('archived', p.archived);
  details.classList.toggle('archived', p.archived);
  text(row, 'profile', p.profile ? 'профиль ' + p.profile : 'профиль не задан');
  html(row, 'browser', browserCell(p));
  html(row, 'aliases', '<span>' + p.aliases + '/' + p.limit + '</span><progress max="' + p.limit + '" value="' + Math.min(p.aliases, p.limit) + '"></progress>');
  const box = row.querySelector('[data-toggle="generator"]');
  if (!box.dataset.busy) {
    box.checked = p.generator.enabled;
    box.disabled = p.archived;
  }
  text(row, 'generator-state', GENERATOR_TEXT[p.generator.state] || p.generator.state);
  text(row, 'hour', hourCell(p));
  html(row, 'imap', imapCell(p));
  text(details, 'browser-detail', browserDetail(p));
  text(details, 'imap-detail', imapDetail(p));
  text(details, 'next-name', p.generator.nextName ? 'Следующая метка: ' + p.generator.nextName : 'Метка не подходит: задайте её вручную.');
  text(details, 'sync', syncDetail(p));
  text(details, 'generator', generatorDetail(p));
  text(details, 'archive', p.archived ? 'Вернуть в работу' : 'Отключить');
  details.querySelector('[data-action="delete"]').hidden = p.aliases > 0;
  for (const action of ['save-profile', 'connect', 'restart', 'create', 'sync']) {
    details.querySelector('[data-action="' + action + '"]').disabled = p.archived;
  }
  const result = results.get(p.id);
  const out = details.querySelector('[data-f="result"]');
  if (result && out.textContent !== result.text) {
    out.textContent = result.text;
    out.className = 'result-line ' + result.cls;
  }
}

async function refreshParents() {
  const list = $('#parents-list');
  if (!list) return;
  const r = await callApi('GET', '/parents');
  if (!$('#parents-list')) return;
  if (r.status !== 200 || !Array.isArray(r.body)) {
    list.innerHTML = '<div class="hint">' + escapeHtml(r.status === 0 ? 'Запустите сервис: родители и их настройки хранятся в его базе.' : apiError(r, 'Не удалось загрузить родителей')) + '</div>';
    renderedSignature = '';
    return;
  }
  parents = r.body;
  // Набор или порядок строк изменился (добавили, отключили, удалили) — перерисовываем таблицу целиком.
  const signature = parents.map(p => p.id + (p.archived ? 'a' : '')).join(',');
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    list.innerHTML = parents.length
      ? '<div class="table-scroll"><table class="parents"><thead><tr><th></th><th>родитель</th><th>браузер</th><th>алиасы</th><th>регистрация</th><th>за час · следующее</th><th>IMAP</th></tr></thead><tbody>' +
        parents.map(rowHtml).join('') + '</tbody></table></div>'
      : '<div class="hint">Родителей пока нет. Добавьте первого: e-mail iCloud-учётки и ID профиля Dolphin Anty, в котором она залогинена.</div>';
  }
  parents.forEach(updateRow);
}

async function addParent() {
  const email = $('#new-parent-email').value.trim();
  const profile = $('#new-parent-profile').value.trim();
  const out = $('#add-parent-result');
  if (!email) { out.textContent = 'Введите e-mail родителя.'; return; }
  const button = $('#add-parent');
  button.disabled = true;
  try {
    const r = await callApi('POST', '/parents', { email, profile });
    if (r.status !== 200) throw new Error(apiError(r, 'Не удалось добавить родителя'));
    $('#new-parent-email').value = '';
    $('#new-parent-profile').value = '';
    expanded.add(r.body.id);
    results.set(r.body.id, { text: 'Добавлен. Сервис подключит профиль и загрузит алиасы сам. Задайте IMAP-пароль, а авторегистрацию включите переключателем в строке.', cls: 'ok' });
    out.textContent = '';
    await refreshParents();
  } catch (e) {
    out.textContent = e.message;
  } finally { button.disabled = false; }
}

async function toggleGenerator(id, box) {
  box.dataset.busy = '1';
  box.disabled = true;
  try {
    const r = await callApi('PATCH', '/parents/' + id, { generatorEnabled: box.checked });
    if (r.status !== 200) throw new Error(apiError(r, 'Не удалось переключить авторегистрацию'));
    results.set(id, { text: r.body.generator.enabled ? 'Авторегистрация включена: первое создание — через обычный интервал.' : 'Авторегистрация выключена. Коды и загрузка из iCloud работают.', cls: 'ok' });
  } catch (e) {
    box.checked = !box.checked;
    results.set(id, { text: e.message, cls: 'err' });
    expanded.add(id);
    const details = $('tr[data-details="' + id + '"]');
    if (details) details.hidden = false;
    const expand = $('tr[data-id="' + id + '"] [data-action="expand"]');
    if (expand) expand.textContent = '▾';
  } finally {
    delete box.dataset.busy;
    box.disabled = false;
    await refreshParents();
  }
}

async function parentAction(id, action, button) {
  const p = parents.find(x => x.id === id);
  const details = $('tr[data-details="' + id + '"]');
  if (!p || !details) return;
  const input = name => details.querySelector('[data-input="' + name + '"]');
  if (action === 'expand') {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    details.hidden = !expanded.has(id);
    button.textContent = expanded.has(id) ? '▾' : '▸';
    return;
  }
  if (action === 'show-aliases') {
    aliasState = { parent: String(id), q: '', page: 1 };
    switchTab('aliases');
    return;
  }
  const say = (text, cls) => {
    results.set(id, { text, cls });
    const out = details.querySelector('[data-f="result"]');
    out.textContent = text;
    out.className = 'result-line ' + cls;
  };
  const run = async (busyText, request, done, after) => {
    button.disabled = true;
    say(busyText, 'busy');
    try {
      const r = await request();
      if (r.status !== 200) throw new Error(apiError(r, 'Не удалось'));
      say(done(r.body), 'ok');
      await refreshParents();
      if (after) after();
    } catch (e) {
      say(e.message, 'err');
    } finally { button.disabled = false; }
  };
  const url = '/parents/' + id;
  const nextNameToInput = () => {
    const fresh = parents.find(x => x.id === id);
    const field = $('tr[data-details="' + id + '"] [data-input="alias-name"]');
    if (fresh && field) field.value = fresh.generator.nextName || '';
  };
  switch (action) {
    case 'save-profile':
      return run('Сохраняю профиль…', () => callApi('PATCH', url, { profile: input('profile').value.trim() }),
        b => b.profile ? 'Профиль сохранён: ' + b.profile + '. Сервис подключит его сам и загрузит алиасы.' : 'Профиль убран: сервис больше не подключает браузер этого родителя.');
    case 'connect':
      return run('Подключаю профиль… Если Dolphin Anty не запущен, он откроется.', () => callApi('POST', url + '/connect', {}),
        b => 'Профиль подключён: ' + b.browser.cdpUrl);
    case 'restart':
      if (!confirm('Перезапустить профиль ' + p.email + '? Окно профиля закроется и откроется заново.')) return;
      return run('Перезапускаю профиль…', () => callApi('POST', url + '/connect', { restart: true }),
        b => 'Профиль перезапущен и подключён: ' + b.browser.cdpUrl);
    case 'save-imap': {
      const password = input('imap-password').value.trim();
      if (!password) { say('Введите app-specific пароль.', 'err'); return; }
      return run('Проверяю вход в iCloud Mail…', () => callApi('PUT', url + '/imap', { password, proxy: input('imap-proxy').value.trim() }),
        () => {
          input('imap-password').value = '';
          return clusterMode
            ? 'Вход принят, пароль сохранён и сразу уходит сервису кодов в кластере.'
            : 'Вход принят, пароль сохранён в mail-code.json. gRPC-сервис подхватит его без перезапуска.';
        });
    }
    case 'remove-imap':
      if (!confirm(clusterMode
        ? 'Удалить IMAP-пароль ' + p.email + '?\n\nСервис кодов в кластере перестанет читать ящик этого родителя: коды его алиасов выдаваться не будут.'
        : 'Удалить IMAP-пароль ' + p.email + ' из mail-code.json? Коды этого родителя gRPC будет читать только через браузер.')) return;
      return run('Удаляю пароль…', () => callApi('DELETE', url + '/imap'), () => 'Пароль удалён.');
    case 'save-prefix':
      return run('Сохраняю метку…', () => callApi('PATCH', url, { namePrefix: input('prefix').value.trim() }),
        b => 'Сохранено. Следующая метка: ' + (b.generator.nextName || '—'), nextNameToInput);
    case 'create': {
      const name = input('alias-name').value.trim();
      if (!name) { say('Введите метку нового алиаса.', 'err'); return; }
      return run('Создаю адрес в iCloud…', () => callApi('POST', url + '/aliases', { name }),
        b => 'Создан в iCloud и сохранён: ' + b.email, nextNameToInput);
    }
    case 'sync':
      return run('Загружаю список из iCloud…', () => callApi('POST', url + '/sync', {}),
        b => 'Найдено в iCloud: ' + b.found + '. Добавлено: ' + b.added + '. Удалено: ' + b.removed + '. В базе: ' + b.total + '.', nextNameToInput);
    case 'archive':
      if (!p.archived && !confirm('Отключить ' + p.email + '?\n\nСервис перестанет держать его профиль, загружать и создавать алиасы. Алиасы останутся в базе, коды по IMAP продолжат читаться.')) return;
      return run(p.archived ? 'Возвращаю в работу…' : 'Отключаю…', () => callApi('PATCH', url, { archived: !p.archived }),
        b => b.archived ? 'Родитель отключён.' : 'Родитель снова в работе: сервис подключит профиль сам.');
    case 'delete':
      if (!confirm('Удалить ' + p.email + ' из списка родителей?')) return;
      return run('Удаляю…', () => callApi('DELETE', url), () => { expanded.delete(id); results.delete(id); return 'Удалён.'; });
  }
}

async function loadParents() {
  $('#tab-content').innerHTML =
    '<label for="new-parent-email">Добавить родителя</label>' +
    '<div class="row">' +
    '  <input id="new-parent-email" type="text" spellcheck="false" placeholder="e-mail родительской iCloud-учётки" />' +
    '  <input id="new-parent-profile" type="text" inputmode="numeric" spellcheck="false" placeholder="ID профиля Dolphin Anty с открытым iCloud" />' +
    '  <button id="add-parent">Добавить</button>' +
    '</div>' +
    '<div id="add-parent-result" class="hint" role="status">Каждый родитель — отдельный профиль Dolphin. Сервис держит профили всех родителей открытыми и сам подключается к ним.</div>' +
    '<div id="parents-list"></div>';
  $('#add-parent').onclick = addParent;
  for (const id of ['#new-parent-email', '#new-parent-profile']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') addParent(); });
  }
  renderedSignature = '';
  await refreshParents();
}

// ---------- Алиасы ----------

const ALIASES_PER_PAGE = 20;
let aliasState = { parent: '', q: '', page: 1 };
let aliasSearchTimer = null;

async function renderAliasTable() {
  const offset = (aliasState.page - 1) * ALIASES_PER_PAGE;
  const query = '?limit=' + ALIASES_PER_PAGE + '&offset=' + offset +
    (aliasState.parent ? '&parent=' + encodeURIComponent(aliasState.parent) : '') +
    (aliasState.q ? '&q=' + encodeURIComponent(aliasState.q) : '');
  const r = await callApi('GET', '/aliases' + query);
  const container = $('#alias-table');
  if (!container) return;
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.rows)) {
    container.innerHTML = '<div class="hint">' + escapeHtml(apiError(r, 'Не удалось загрузить алиасы')) + '</div>';
    return;
  }
  const { total, rows } = r.body;
  const pages = Math.max(1, Math.ceil(total / ALIASES_PER_PAGE));
  if (aliasState.page > pages) {
    aliasState.page = pages;
    return renderAliasTable();
  }
  const page = aliasState.page;
  const pager = pages > 1
    ? '<div class="pager">' +
      '<button class="secondary" data-page="1"' + (page === 1 ? ' disabled' : '') + ' title="Первая страница">«</button>' +
      '<button class="secondary" data-page="' + (page - 1) + '"' + (page === 1 ? ' disabled' : '') + '>‹ Назад</button>' +
      '<span class="pager-info">Стр. ' + page + ' из ' + pages + ' · ' + (offset + 1) + '–' + (offset + rows.length) + ' из ' + total + '</span>' +
      '<button class="secondary" data-page="' + (page + 1) + '"' + (page === pages ? ' disabled' : '') + '>Вперёд ›</button>' +
      '<button class="secondary" data-page="' + pages + '"' + (page === pages ? ' disabled' : '') + ' title="Последняя страница">»</button>' +
      '</div>'
    : '';
  container.innerHTML = (total
    ? '<div class="table-scroll"><table><tr><th>алиас</th><th>метка</th><th>родитель</th><th>создан</th></tr>' +
      rows.map(a => '<tr><td>' + escapeHtml(a.email) + '</td><td>' + escapeHtml(a.name) + '</td><td>' + escapeHtml(a.parent) + '</td><td>' + escapeHtml(a.created_at) + '</td></tr>').join('') +
      '</table></div>'
    : '<div class="hint">' + (aliasState.q || aliasState.parent ? 'Ничего не найдено.' : 'Алиасов пока нет: они загрузятся из iCloud, когда подключатся профили родителей.') + '</div>') + pager;
  container.querySelectorAll('.pager button').forEach(btn => {
    btn.onclick = () => { aliasState.page = Number(btn.dataset.page); renderAliasTable(); };
  });
}

async function loadAliases() {
  const r = await callApi('GET', '/parents');
  const list = Array.isArray(r.body) ? r.body : parents;
  $('#tab-content').innerHTML =
    '<div class="row">' +
    '<select id="alias-parent" aria-label="Родитель"><option value="">Все родители</option>' +
    list.map(p => '<option value="' + p.id + '"' + (String(p.id) === aliasState.parent ? ' selected' : '') + '>' +
      escapeHtml(p.email) + ' · ' + p.aliases + (p.archived ? ' (отключён)' : '') + '</option>').join('') +
    '</select>' +
    '<input id="alias-q" type="text" spellcheck="false" placeholder="поиск по адресу или метке" value="' + escapeHtml(aliasState.q) + '" />' +
    '</div>' +
    '<div id="alias-table"></div>';
  $('#alias-parent').onchange = () => {
    aliasState.parent = $('#alias-parent').value;
    aliasState.page = 1;
    renderAliasTable();
  };
  $('#alias-q').oninput = () => {
    clearTimeout(aliasSearchTimer);
    aliasSearchTimer = setTimeout(() => {
      aliasState.q = $('#alias-q').value.trim();
      aliasState.page = 1;
      renderAliasTable();
    }, 300);
  };
  await renderAliasTable();
}

// ---------- Лог ----------

let logLines = [];
let logFilter = '';
const logMatches = line => !logFilter || line.toLowerCase().includes(logFilter);

function renderLog() {
  const el = $('#log-pre');
  if (!el) return;
  el.textContent = logLines.filter(logMatches).join('\n');
  scrollLog();
}

async function loadLog() {
  logLines = await window.api.invoke('svc:logs');
  $('#tab-content').innerHTML =
    '<div class="row"><input id="log-filter" type="text" spellcheck="false" placeholder="фильтр: e-mail родителя, [gRPC] или любой текст" value="' + escapeHtml(logFilter) + '" /></div>' +
    '<pre id="log-pre"></pre>';
  $('#log-filter').oninput = () => {
    logFilter = $('#log-filter').value.trim().toLowerCase();
    renderLog();
  };
  renderLog();
}

function appendLog(line) {
  if (currentTab !== 'log') return;
  logLines.push(line);
  if (logLines.length > 2000) logLines.splice(0, 1000);
  const el = $('#log-pre');
  if (!el || !logMatches(line)) return;
  el.textContent += (el.textContent ? '\n' : '') + line;
  scrollLog();
}

function scrollLog() {
  const el = $('#log-pre');
  if (el) el.scrollTop = el.scrollHeight;
}

// ---------- Подключение ----------

function copyBlock(text) {
  return '<div class="row"><div class="result cmd">' + escapeHtml(text) + '</div>' +
    '<button class="secondary" data-copy="' + escapeHtml(text) + '">Копировать</button></div>';
}

function bindCopy(container) {
  container.querySelectorAll('[data-copy]').forEach((button) => {
    button.onclick = async () => {
      await window.api.invoke('clipboard:write', button.dataset.copy);
      button.textContent = 'Скопировано';
      setTimeout(() => { button.textContent = 'Копировать'; }, 1500);
    };
  });
}

async function loadConnection() {
  const info = await window.api.invoke('net:info');
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(info.host);
  const first = info.addresses[0] ? info.addresses[0].address : '<IP>';
  const grpcurl = 'grpcurl -plaintext -d \'{"email":"<алиас>@icloud.com","kind":"CODE_KIND_SIGN_UP","wait_seconds":5}\' ' +
    first + ':' + info.port + ' deeplay.mail_code.v1.MailCodeService/GetCode';
  const firewall = 'New-NetFirewallRule -DisplayName "ICloud Codes gRPC" -Direction Inbound -Protocol TCP -LocalPort ' +
    info.port + ' -RemoteAddress <IP клиента> -Action Allow';
  let cluster = null;
  try {
    const h = await callApi('GET', '/health');
    cluster = h.status === 200 && h.body ? h.body.cluster : null;
  } catch { /* сервис не запущен */ }
  const clusterBlock = !cluster ? '' :
    '<div class="result ' + (cluster.ok ? 'ok' : 'err') + '">Коды выдаёт сервис в кластере ' + escapeHtml(cluster.url) + ' · ' +
      (cluster.ok ? 'связь есть' + (cluster.pushedAt ? ', снимок отправлен ' + dateTimeOf(cluster.pushedAt) : '')
        : cluster.ok === null ? 'подключаюсь…' : escapeHtml(cluster.error)) + '</div>' +
    '<div class="hint">Приложение отправляет ему IMAP-пароли и алиасы родителей (<code>cluster.url</code> и <code>cluster.token</code> в config.json). ' +
      'Пилот обращается к нему внутри кластера. Локальный gRPC ниже — только для проверки: в работе держите его остановленным.</div>';
  $('#tab-content').innerHTML = clusterBlock +
    '<div class="result ' + (info.running && !localOnly ? 'ok' : 'err') + '">' +
    (info.running ? 'gRPC работает' : 'gRPC не запущен — нажмите «▶ Запустить gRPC»') + ' · слушает ' + escapeHtml(info.host + ':' + info.port) + '</div>' +
    (localOnly ? '<div class="hint">Сейчас gRPC доступен только с этой машины: поставьте <code>grpc.host</code> = <code>0.0.0.0</code> в mail-code.json и перезапустите gRPC.</div>' : '') +
    '<label>Адрес для клиента в той же сети</label>' +
    (info.addresses.length
      ? '<div class="table-scroll"><table><tr><th>сеть</th><th>адрес</th><th></th></tr>' +
        info.addresses.map((a) => '<tr><td>' + escapeHtml(a.name) + '</td><td>' + escapeHtml(a.address + ':' + info.port) + '</td>' +
          '<td><button class="secondary" data-copy="' + escapeHtml(a.address + ':' + info.port) + '">Копировать</button></td></tr>').join('') +
        '</table></div>' +
        '<div class="hint">Обычно нужен адрес основного адаптера (Ethernet или Wi-Fi). Адрес VPN подойдёт, только если клиент в той же VPN; виртуальные адаптеры (vEthernet, VirtualBox, WSL) снаружи недоступны.</div>'
      : '<div class="hint">Сетевых адаптеров с IPv4 не найдено.</div>') +
    '<label>Адрес из интернета (например, из кластера)</label>' +
    '<div class="row"><button id="public-ip" class="secondary">Узнать внешний IP</button></div>' +
    '<div id="public-ip-result" class="hint" role="status">Запрос уходит на api.ipify.org. Снаружи машина доступна по этому адресу, только если порт ' + escapeHtml(info.port) + ' проброшен на роутере или открыт у хостера.</div>' +
    '<label>Проверка с другого компьютера (grpcurl)</label>' + copyBlock(grpcurl) +
    '<label>Правило файрвола Windows (PowerShell от администратора)</label>' + copyBlock(firewall) +
    '<div class="hint">Пускайте на порт только адреса клиентов: сервис отдаёт коды без TLS и без авторизации.</div>';
  bindCopy($('#tab-content'));
  $('#public-ip').onclick = async () => {
    const out = $('#public-ip-result');
    out.textContent = 'Узнаю…';
    const r = await window.api.invoke('net:public-ip');
    out.innerHTML = r.ok ? copyBlock(r.address + ':' + info.port) : escapeHtml(r.error);
    bindCopy(out);
  };
}

// ---------- Шапка, код, обновления ----------

async function refresh() {
  let health = null;
  try {
    const h = await callApi('GET', '/health');
    if (h.status !== 200 || typeof h.body !== 'object') throw new Error('bad health');
    const b = h.body;
    health = b;
    const ps = b.parents || {};
    setChip('#chip-svc', true, 'сервис: работает');
    setChip('#chip-parent', ps.working > 0,
      'родители: ' + ps.working + (ps.registering ? ' · регистрируют ' + ps.registering : '') + (ps.full ? ' · заполнено ' + ps.full : ''),
      ps.archived ? 'Отключённых: ' + ps.archived : '');
    setChip('#chip-cdp', ps.withProfile > 0 && ps.connected === ps.withProfile, 'браузеры: ' + ps.connected + '/' + ps.withProfile,
      'Подключённые профили родителей в работе (из тех, у кого задан профиль).');
    setChip('#chip-aliases', true, 'алиасов: ' + b.aliases);
    const next = b.generator && b.generator.next;
    setChip('#chip-generator', ps.registering > 0,
      !ps.registering ? 'регистрация: выключена у всех' : next ? 'регистрация: ближайшее ' + whenOf(next.at) + ' · ' + next.parent : 'регистрация: ждёт',
      'Время по Новосибирску. Расписание и лимит 5 в час — у каждого родителя свои.');
  } catch {
    setChip('#chip-svc', false, 'сервис: не запущен');
    setChip('#chip-parent', false, 'родители: —');
    setChip('#chip-cdp', false, 'браузеры: —');
    setChip('#chip-aliases', false, 'алиасов: —');
    setChip('#chip-generator', false, 'регистрация: —');
  }
  const st = await window.api.invoke('svc:state');
  $('#btn-start').disabled = st.running;
  $('#btn-stop').disabled = !st.running;
  const grpc = await window.api.invoke('grpc:state');
  const cluster = health && health.cluster;
  clusterMode = !!cluster;
  if (cluster) {
    // Коды выдаёт сервис в кластере; локальный gRPC при этом лишний: к одному Apple ID ходили бы два клиента.
    const link = cluster.ok ? 'связь есть' : cluster.ok === null ? 'подключаюсь…' : 'нет связи';
    setChip('#chip-grpc', !!cluster.ok && !grpc.running, 'gRPC: в кластере · ' + link + (grpc.running ? ' · локальный тоже запущен' : ''),
      grpc.running ? 'Остановите локальный gRPC: к одному Apple ID не должны ходить два клиента.' : (cluster.error || cluster.url));
  } else {
    setChip('#chip-grpc', grpc.running, 'gRPC: ' + (grpc.running ? 'работает' : 'не запущен'));
  }
  $('#btn-grpc-start').disabled = grpc.running;
  $('#btn-grpc-stop').disabled = !grpc.running;
  if (currentTab === 'parents') await refreshParents();
}

const UPDATE_TEXT = {
  off: () => 'dev-сборка',
  'no-token': () => 'обновления: нет update.token в config.json',
  checking: () => 'проверка обновлений…',
  latest: () => 'актуальная',
  downloading: (u) => 'скачивается ' + u.next + (u.percent != null ? ' (' + u.percent + '%)' : ''),
  ready: (u) => 'готово обновление ' + u.next,
  error: () => 'ошибка обновления',
};

function renderUpdate(u) {
  const chip = $('#chip-update');
  chip.textContent = 'версия ' + (u.version || '—') + ' · ' + (UPDATE_TEXT[u.status] || UPDATE_TEXT.off)(u);
  chip.className = 'chip' + (u.status === 'latest' || u.status === 'ready' ? ' ok' : u.status === 'error' || u.status === 'no-token' ? ' bad' : '');
  chip.title = u.error || '';
  const button = $('#btn-update');
  button.hidden = u.status !== 'ready';
  button.textContent = 'Обновить до ' + u.next;
}

async function installUpdate() {
  if (!confirm('Остановить сервисы, установить обновление и перезапустить приложение? Работавшие сервисы запустятся снова.')) return;
  $('#btn-update').disabled = true;
  const r = await window.api.invoke('update:install');
  if (!r.ok) {
    alert(r.error);
    $('#btn-update').disabled = false;
  }
}

async function requestCode() {
  const email = $('#code-email').value.trim();
  const out = $('#code-result');
  if (!email) {
    out.textContent = 'Введите e-mail алиаса.';
    out.className = 'result err';
    return;
  }
  out.className = 'result busy';
  out.textContent = 'Запрашиваю… (сервис откроет почту родителя алиаса в его профиле)';
  const r = await callApi('GET', '/code?format=json&email=' + encodeURIComponent(email));
  if (r.status === 200 && r.body && r.body.code) {
    out.innerHTML = escapeHtml(r.body.email + ':' + r.body.code) + '<span class="result-meta">родитель ' + escapeHtml(r.body.parent) + (r.body.subject ? ' · «' + escapeHtml(r.body.subject) + '»' : '') + '</span>';
    out.className = 'result ok';
  } else {
    out.textContent = apiError(r, 'Код не получен');
    out.className = 'result err';
  }
}

async function loadTab() {
  if (currentTab === 'parents') await loadParents();
  else if (currentTab === 'aliases') await loadAliases();
  else if (currentTab === 'connection') await loadConnection();
  else await loadLog();
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  loadTab();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btn-start').onclick = async () => {
    const r = await window.api.invoke('svc:start');
    if (!r.ok) alert(r.error);
    refresh();
  };
  $('#btn-stop').onclick = async () => {
    await window.api.invoke('svc:stop');
    refresh();
  };
  $('#btn-config').onclick = () => window.api.invoke('config:open');
  $('#btn-grpc-start').onclick = async () => {
    const r = await window.api.invoke('grpc:start');
    if (!r.ok) alert(r.error);
    refresh();
  };
  $('#btn-grpc-stop').onclick = async () => {
    await window.api.invoke('grpc:stop');
    refresh();
  };
  $('#btn-mail-config').onclick = () => window.api.invoke('mail-config:open');
  $('#btn-update').onclick = installUpdate;
  $('#btn-code').onclick = requestCode;
  $('#code-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  // Действия в строках родителей: таблица перерисовывается, поэтому обработчики — на контейнере.
  const content = $('#tab-content');
  content.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button || currentTab !== 'parents') return;
    const holder = button.closest('[data-id], [data-details]');
    const id = Number(holder && (holder.dataset.id || holder.dataset.details));
    if (id) parentAction(id, button.dataset.action, button);
  });
  content.addEventListener('change', (e) => {
    if (!e.target.matches('[data-toggle="generator"]')) return;
    const id = Number(e.target.closest('[data-id]').dataset.id);
    toggleGenerator(id, e.target);
  });
  content.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-input]')) return;
    const actions = { profile: 'save-profile', 'imap-password': 'save-imap', 'imap-proxy': 'save-imap', prefix: 'save-prefix', 'alias-name': 'create' };
    const button = e.target.closest('.field')?.querySelector('[data-action="' + actions[e.target.dataset.input] + '"]');
    if (button && !button.disabled) button.click();
  });

  window.api.on('svc-log', appendLog);
  window.api.on('svc-state', () => refresh());
  window.api.on('grpc-state', () => {
    refresh();
    if (currentTab === 'connection') loadConnection();
  });
  window.api.on('update-state', renderUpdate);
  window.api.invoke('update:state').then(renderUpdate);

  refresh();
  loadTab();
  setInterval(refresh, 5000);
});
