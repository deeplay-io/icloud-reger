const $ = (s) => document.querySelector(s);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let currentTab = 'aliases';

const ALIASES_PER_PAGE = 20;
let aliasRows = [];
let aliasPage = 1;

function renderAliasTable() {
  const container = $('#alias-table');
  if (!container) return;
  const pages = Math.max(1, Math.ceil(aliasRows.length / ALIASES_PER_PAGE));
  aliasPage = Math.min(Math.max(1, aliasPage), pages);
  const start = (aliasPage - 1) * ALIASES_PER_PAGE;
  const pageRows = aliasRows.slice(start, start + ALIASES_PER_PAGE);
  const pager = pages > 1
    ? '<div class="pager">' +
      '<button class="secondary" data-page="1"' + (aliasPage === 1 ? ' disabled' : '') + ' title="Первая страница">«</button>' +
      '<button class="secondary" data-page="' + (aliasPage - 1) + '"' + (aliasPage === 1 ? ' disabled' : '') + '>‹ Назад</button>' +
      '<span class="pager-info">Стр. ' + aliasPage + ' из ' + pages + ' · ' + (start + 1) + '–' + (start + pageRows.length) + ' из ' + aliasRows.length + '</span>' +
      '<button class="secondary" data-page="' + (aliasPage + 1) + '"' + (aliasPage === pages ? ' disabled' : '') + '>Вперёд ›</button>' +
      '<button class="secondary" data-page="' + pages + '"' + (aliasPage === pages ? ' disabled' : '') + ' title="Последняя страница">»</button>' +
      '</div>'
    : '';
  container.innerHTML =
    '<div class="table-scroll"><table><tr><th>алиас</th><th>имя</th><th>родитель (id)</th><th>создан</th></tr>' +
    pageRows.map((a) => '<tr><td>' + escapeHtml(a.email) + '</td><td>' + escapeHtml(a.name) + '</td><td>' + escapeHtml(a.parent_id) + '</td><td>' + escapeHtml(a.created_at) + '</td></tr>').join('') +
    '</table></div>' + pager;
  container.querySelectorAll('.pager button').forEach((btn) => {
    btn.onclick = () => { aliasPage = Number(btn.dataset.page); renderAliasTable(); };
  });
}

async function importAliases() {
  const button = $('#sync-aliases');
  const out = $('#sync-result');
  button.disabled = true;
  out.textContent = 'Загружаю список из iCloud…';
  try {
    const result = await callApi('POST', '/aliases/sync');
    if (result.status !== 200) throw new Error(result.body?.error || 'Не удалось загрузить алиасы.');
    aliasPage = 1;
    await loadTab();
    const status = $('#sync-result');
    if (status) status.textContent = `Найдено в iCloud: ${result.body.found}. Добавлено: ${result.body.added}. Удалено: ${result.body.removed ?? 0}. У родителя в базе: ${result.body.total}.`;
    await refresh();
  } catch (e) {
    out.textContent = e.message;
  } finally { button.disabled = false; }
}

function syncControls() {
  return '<div class="row"><button id="sync-aliases" class="secondary">Загрузить из iCloud</button></div><div id="sync-result" class="hint" role="status"></div>';
}

async function connectDolphin(restart = false) {
  const button = $('#btn-dolphin-connect');
  const restartButton = $('#btn-dolphin-restart');
  const out = $('#dolphin-result');
  button.disabled = true;
  restartButton.disabled = true;
  restartButton.hidden = true;
  out.className = 'result busy';
  out.textContent = 'Подключаю профиль Dolphin Anty…';
  try {
    const result = await window.api.invoke('dolphin:connect', $('#dolphin-profile-id').value, restart);
    restartButton.hidden = result.code !== 'PROFILE_REQUIRES_RESTART';
    out.className = 'result ' + (result.ok ? 'ok' : 'err');
    out.textContent = result.ok
      ? 'Профиль подключён: ' + result.cdpUrl + '. Настройки сохранены. Для чтения писем должны быть настроены селекторы iCloud.'
      : result.error;
    await refresh();
  } catch (e) {
    out.className = 'result err';
    out.textContent = e.message || String(e);
  } finally {
    button.disabled = false;
    restartButton.disabled = false;
  }
}

async function callApi(method, p, body) {
  return window.api.invoke('api:proxy', { method, path: p, body });
}

function setChip(id, ok, text) {
  const el = $(id);
  el.textContent = text;
  el.className = 'chip ' + (ok ? 'ok' : 'bad');
}

async function refresh() {
  try {
    const h = await callApi('GET', '/health');
    if (h.status !== 200 || typeof h.body !== 'object') throw new Error('bad health');
    setChip('#chip-svc', true, 'сервис: работает');
    setChip('#chip-cdp', h.body.browser === 'connected', 'браузер: ' + h.body.browser);
    setChip('#chip-parent', !!h.body.activeParent, 'родитель: ' + (h.body.activeParent || '—'));
    setChip('#chip-aliases', true, 'алиасов в базе: ' + h.body.aliases);
    const generator = h.body.generator;
    const timeOptions = { timeZone: 'Asia/Novosibirsk' };
    const nextTime = generator?.nextRunAt ? new Date(generator.nextRunAt).toLocaleTimeString('ru-RU', timeOptions) : 'ожидание';
    const hour = generator?.currentHourStart ? new Date(generator.currentHourStart).toLocaleTimeString('ru-RU', { ...timeOptions, hour: '2-digit', minute: '2-digit' }) : '—';
    setChip('#chip-generator', !!generator?.enabled && !generator.limitReached,
      !generator?.enabled ? 'авто: выключено' : generator.limitReached ? 'авто: лимит достигнут' : `авто: следующее в ${nextTime} · создано с ${hour}: ${generator.createdThisHour}/${generator.hourlyLimit}`);
    $('#chip-generator').title = generator
      ? `Подтверждённые создания за текущий час (Новосибирск). Счётчик обновляется каждый час. Запросов за последние 60 минут: ${generator.attemptsLastHour}/${generator.hourlyLimit}; ограничение сохраняется при смене часа.`
      : '';
  } catch {
    setChip('#chip-svc', false, 'сервис: не запущен');
    setChip('#chip-cdp', false, 'браузер: —');
    setChip('#chip-parent', false, 'родитель: —');
    setChip('#chip-aliases', false, 'алиасов: —');
    setChip('#chip-generator', false, 'авто: —');
  }
  const st = await window.api.invoke('svc:state');
  $('#btn-start').disabled = st.running;
  $('#btn-stop').disabled = !st.running;
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
  out.textContent = 'Запрашиваю… (сервис откроет почту родителя в браузере)';
  const r = await callApi('GET', '/code?email=' + encodeURIComponent(email));
  if (r.status === 200) {
    out.textContent = String(r.body);
    out.className = 'result ok';
  } else {
    out.textContent = (r.body && r.body.error) || 'HTTP ' + r.status;
    out.className = 'result err';
  }
}

async function loadAliases() {
  const [r, naming] = await Promise.all([callApi('GET', '/aliases'), callApi('GET', '/generator/settings')]);
  const settings = naming.status === 200 ? naming.body : {};
  aliasRows = Array.isArray(r.body) ? r.body : [];
  $('#tab-content').innerHTML =
    syncControls() +
    '<label for="alias-name-prefix">Имя для авторегистрации (без номера и @icloud.com)</label>' +
    '<div class="row"><input id="alias-name-prefix" type="text" maxlength="60" placeholder="mybox" value="' + escapeHtml(settings.namePrefix) + '" /><button id="save-alias-prefix" class="secondary">Сохранить имя</button></div>' +
    '<div id="prefix-result" class="hint" role="status">Следующий: ' + escapeHtml(settings.nextName || 'выберите родителя') + '</div>' +
    '<div class="row">' +
    '  <input id="add-alias-name" type="text" maxlength="100" placeholder="метка нового алиаса" value="' + escapeHtml(settings.nextName || '') + '" />' +
    '  <button id="add-alias" class="secondary">Создать в iCloud</button>' +
    '</div>' +
    '<div class="hint">Адрес назначит iCloud. В базу попадёт только подтверждённый адрес с сайта.</div>' +
    '<div id="create-result" class="hint" role="status"></div>' +
    '<div id="alias-table"></div>';
  renderAliasTable();
  $('#sync-aliases').onclick = importAliases;
  $('#save-alias-prefix').onclick = async () => {
    const button = $('#save-alias-prefix');
    const out = $('#prefix-result');
    button.disabled = true;
    try {
      const result = await callApi('POST', '/generator/settings', { namePrefix: $('#alias-name-prefix').value.trim() });
      if (result.status !== 200) throw new Error(result.body?.error || 'Не удалось сохранить имя.');
      out.textContent = 'Сохранено. Следующий: ' + result.body.nextName;
      $('#add-alias-name').value = result.body.nextName || '';
    } catch (e) { out.textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('#add-alias').onclick = async () => {
    const name = $('#add-alias-name').value.trim();
    const out = $('#create-result');
    if (!name) { out.textContent = 'Введите метку для нового алиаса.'; return; }
    const button = $('#add-alias');
    button.disabled = true;
    out.textContent = 'Создаю адрес в iCloud…';
    try {
      const rr = await callApi('POST', '/aliases/create', { name });
      if (rr.status !== 200) throw new Error(rr.body?.error || 'Не удалось создать алиас.');
      aliasPage = 1;
      await loadAliases();
      $('#create-result').textContent = 'Создан в iCloud и сохранён: ' + rr.body.email;
      await refresh();
    } catch (e) { out.textContent = e.message; }
    finally { button.disabled = false; }
  };
}

async function loadParents() {
  const r = await callApi('GET', '/parents');
  const rows = Array.isArray(r.body) ? r.body : [];
  $('#tab-content').innerHTML =
    syncControls() +
    '<div class="row">' +
    '  <input id="set-parent" type="text" placeholder="e-mail нового родительского аккаунта" />' +
    '  <button id="set-parent-btn" class="secondary">Сделать активным (ротация)</button>' +
    '</div>' +
    '<div class="table-scroll"><table><tr><th>родитель</th><th>статус</th><th>алиасов в базе</th><th>лимит</th></tr>' +
    rows.map((p) => '<tr><td>' + p.email + '</td><td>' + p.status + '</td><td>' + p.aliases + '</td><td>' + p.alias_limit + '</td></tr>').join('') +
    '</table></div>';
  $('#sync-aliases').onclick = importAliases;
  $('#set-parent-btn').onclick = async () => {
    const e = $('#set-parent').value.trim();
    if (!e) return;
    const rr = await callApi('POST', '/parent', { email: e });
    const msg = rr.status === 200 ? 'Активный родитель: ' + rr.body.activeParent : 'Ошибка: ' + (rr.body && rr.body.error);
    alert(msg);
    loadParents();
    refresh();
  };
}

async function loadLog() {
  const lines = await window.api.invoke('svc:logs');
  $('#tab-content').innerHTML = '<pre id="log-pre"></pre>';
  $('#log-pre').textContent = lines.join('\n');
  scrollLog();
}

function appendLog(line) {
  if (currentTab !== 'log') return;
  const el = $('#log-pre');
  if (!el) return;
  el.textContent += '\n' + line;
  scrollLog();
}

function scrollLog() {
  const el = $('#log-pre');
  if (el) el.scrollTop = el.scrollHeight;
}

async function loadTab() {
  if (currentTab === 'aliases') await loadAliases();
  else if (currentTab === 'parents') await loadParents();
  else await loadLog();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btn-dolphin-connect').onclick = () => connectDolphin();
  $('#btn-dolphin-restart').onclick = () => connectDolphin(true);
  $('#dolphin-profile-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-dolphin-connect').disabled) connectDolphin();
  });
  window.api.invoke('dolphin:settings').then((settings) => {
    $('#dolphin-profile-id').value = settings.profileId;
  }).catch((e) => { $('#dolphin-result').textContent = e.message; });
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
  $('#btn-code').onclick = requestCode;
  $('#code-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      loadTab();
    };
  });

  window.api.on('dolphin-status', (text) => {
    const out = $('#dolphin-result');
    if (out.classList.contains('busy')) out.textContent = text;
  });
  window.api.on('svc-log', appendLog);
  window.api.on('svc-state', () => refresh());

  refresh();
  loadTab();
  setInterval(refresh, 5000);
  if (currentTab === 'log') setInterval(scrollLog, 3000);
});
