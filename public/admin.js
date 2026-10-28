'use strict';
const $ = id => document.getElementById(id);
let isBusy = false, currentServingId = null, currentPage = 1, totalRecords = 0, noticeTimer, searchTimer;
const loginSection = $('loginSection'), dashboardSection = $('dashboardSection');
function showNotice(message, type, target) {
  const el = $(target || 'adminNotice'); el.textContent = message; el.className = 'notice ' + (type || 'success'); el.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.hidden = true; }, 6500);
}
async function request(url, options) {
  const response = await fetch(url, options || {}); let data;
  try { data = await response.json(); } catch (_) { data = {}; }
  if (response.status === 401 && url.indexOf('/api/auth/') !== 0) { showLogin(); throw new Error('Your staff session has expired. Please sign in again.'); }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function post(url, body) { return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function formatToken(n) { return 'A' + String(n).padStart(3, '0'); }
function statusLabel(status) { return ({ waiting: 'Waiting', serving: 'Serving', completed: 'Completed', skipped: 'Skipped' })[status] || status; }
function formatTime(value) {
  if (!value) return '—';
  const parsed = new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function addOption(select, value, label) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option); }
function setBusy(value) {
  isBusy = value;
  ['callNextBtn','completeBtn','recallBtn','resetBtn'].forEach(id => { const el = $(id); if (el) el.disabled = value || (id === 'completeBtn' && !currentServingId) || (id === 'recallBtn' && !currentServingId); });
}
function showLogin() {
  dashboardSection.hidden = true; loginSection.hidden = false; $('logoutBtn').hidden = true; $('staffIdentity').hidden = true;
  $('password').value = '';
}
function showDashboard(staff) {
  loginSection.hidden = true; dashboardSection.hidden = false; $('logoutBtn').hidden = false; $('staffIdentity').hidden = false; $('staffIdentity').textContent = 'Signed in: ' + staff.username;
  loadServices().then(() => { $('walkinService').value = $('queueServiceSelect').value; refreshAll(); });
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginBtn').disabled = true;
  try { const data = await post('/api/auth/login', { username: $('username').value.trim(), password: $('password').value }); showNotice('Signed in successfully.', 'success', 'loginNotice'); showDashboard(data.staff); }
  catch (error) { showNotice(error.message, 'error', 'loginNotice'); }
  finally { $('loginBtn').disabled = false; }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await post('/api/auth/logout'); showLogin(); showNotice('You have signed out.', 'success', 'loginNotice'); }
  catch (error) { showNotice(error.message, 'error'); }
});
async function loadServices() {
  try {
    const data = await request('/api/services');
    const select = $('serviceFilter'); const current = select.value; select.replaceChildren(); addOption(select, '', 'All services');
    const queueSelect = $('queueServiceSelect'); const selectedQueue = queueSelect.value; queueSelect.replaceChildren();
    data.services.forEach(s => { addOption(select, s.name, s.name); addOption(queueSelect, s.name, s.name); addOption($('walkinService'), s.name, s.name + (s.paused ? ' (paused)' : '')); });
    select.value = current; queueSelect.value = data.services.some(s => s.name === selectedQueue) ? selectedQueue : (data.services[0] ? data.services[0].name : '');
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadQueue(silent) {
  try {
    const service = $('queueServiceSelect').value;
    const data = await request('/api/admin/queue' + (service ? '?service=' + encodeURIComponent(service) : '')); currentServingId = data.current ? data.current.id : null;
    $('statServing').textContent = data.current ? data.current.token_label : '—'; $('statWaiting').textContent = data.waiting; $('statCompleted').textContent = data.completed; $('statIssued').textContent = data.issuedToday;
    $('currentToken').textContent = data.current ? data.current.token_label : '---'; $('currentName').textContent = data.current ? data.current.student_name : 'No student is being served'; $('currentPurpose').textContent = data.current ? data.current.purpose : 'Waiting for next token';
    $('currentDepartment').textContent = data.current && data.current.department ? data.current.department : '—'; $('queueStatusText').textContent = data.current ? 'In service' : (data.waiting ? 'Ready to call' : 'No active token'); $('waitingBadge').textContent = data.waiting + ' waiting';
    $('callNextBtn').disabled = isBusy || data.waiting === 0 || data.paused; $('completeBtn').disabled = isBusy || !data.current; $('recallBtn').disabled = isBusy || !data.current;
    $('pauseServiceBtn').textContent = data.paused ? 'Resume service' : 'Pause service'; $('serviceAvailability').textContent = data.paused ? 'Paused — no new tokens accepted' : 'Service accepting tokens'; $('pauseServiceBtn').disabled = isBusy;
    renderWaitingList(data.queue || []); return data;
  } catch (error) { if (!silent) showNotice(error.message, 'error'); return null; }
}
function renderWaitingList(queue) {
  const list = $('waitingList'); list.replaceChildren();
  if (!queue.length) { const p = document.createElement('p'); p.className = 'empty-state'; p.textContent = 'No students are waiting.'; list.appendChild(p); return; }
  queue.slice(0, 8).forEach(token => {
    const item = document.createElement('div'); item.className = 'waiting-item';
    const number = document.createElement('strong'); number.textContent = token.token_label;
    const details = document.createElement('div'); details.className = 'waiting-details';
    const name = document.createElement('strong'); name.textContent = token.student_name;
    const meta = document.createElement('small'); meta.textContent = token.purpose + ' · ' + (token.register_number || 'No register number'); details.append(name, meta);
    const pos = document.createElement('span'); pos.className = 'waiting-position'; pos.textContent = '#' + token.position;
    item.append(number, details, pos); list.appendChild(item);
  });
  if (queue.length > 8) { const more = document.createElement('p'); more.className = 'muted'; more.textContent = (queue.length - 8) + ' more waiting — see all records below.'; list.appendChild(more); }
}
function cell(row, value, className) { const td = document.createElement('td'); if (className) td.className = className; td.textContent = value == null || value === '' ? '—' : String(value); row.appendChild(td); return td; }
function addAction(parent, label, className, handler) { const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = label; b.addEventListener('click', handler); parent.appendChild(b); }
async function loadRecords(resetPage) {
  if (resetPage) currentPage = 1;
  const params = new URLSearchParams({ page: String(currentPage), limit: '25' });
  if ($('searchInput').value.trim()) params.set('search', $('searchInput').value.trim()); if ($('serviceFilter').value) params.set('service', $('serviceFilter').value); if ($('statusFilter').value) params.set('status', $('statusFilter').value);
  try {
    const data = await request('/api/admin/tokens?' + params.toString()); totalRecords = data.total;
    if (currentPage === 1) $('queueBody').replaceChildren();
    if (!data.tokens.length && currentPage === 1) { const row = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 7; td.className = 'empty-state'; td.textContent = 'No matching token records.'; row.appendChild(td); $('queueBody').appendChild(row); }
    data.tokens.forEach(token => appendTokenRow(token)); $('recordCount').textContent = totalRecords + (totalRecords === 1 ? ' record' : ' records'); $('pageInfo').textContent = 'Page ' + currentPage + ' · ' + Math.min(currentPage * data.limit, totalRecords) + ' of ' + totalRecords; $('loadMoreBtn').hidden = currentPage * data.limit >= totalRecords;
  } catch (error) { showNotice(error.message, 'error'); }
}
function appendTokenRow(token) {
  const row = document.createElement('tr'); cell(row, token.token_label || formatToken(token.token_number), 'token-cell');
  const student = document.createElement('td'); const name = document.createElement('strong'); name.className = 'student-table-name'; name.textContent = token.student_name; const desc = document.createElement('small'); desc.className = 'table-subtitle'; desc.textContent = token.department || 'Student'; student.append(name, desc); row.appendChild(student);
  cell(row, token.register_number + (token.department ? ' / ' + token.department : '')); cell(row, token.purpose); cell(row, formatTime(token.created_at));
  const statusCell = document.createElement('td'); const pill = document.createElement('span'); pill.className = 'status-pill status-' + token.status; pill.textContent = statusLabel(token.status); statusCell.appendChild(pill); row.appendChild(statusCell);
  const actions = document.createElement('td'); if (token.status === 'waiting') addAction(actions, 'Skip', 'small-action', () => skipToken(token.id)); else if (token.status === 'serving') addAction(actions, 'Complete', 'small-action complete-action', () => completeToken(token.id)); else if (token.status === 'skipped') addAction(actions, 'Requeue', 'small-action complete-action', () => requeueToken(token.id)); else { const dash = document.createElement('span'); dash.className = 'muted'; dash.textContent = '—'; actions.appendChild(dash); } row.appendChild(actions); $('queueBody').appendChild(row);
}
async function refreshAll() { await loadQueue(true); await loadRecords(true); }
async function performAction(url, successMessage, body) {
  if (isBusy) return; setBusy(true);
  try { const data = await post(url, body || {}); await refreshAll(); showNotice(data.message || successMessage || 'Action completed.'); }
  catch (error) { showNotice(error.message, 'error'); }
  finally { setBusy(false); await loadQueue(true); }
}
$('callNextBtn').addEventListener('click', () => performAction('/api/admin/next', '', { service: $('queueServiceSelect').value }));
$('completeBtn').addEventListener('click', () => { if (currentServingId) completeToken(currentServingId); });
async function completeToken(id) { await performAction('/api/admin/tokens/' + encodeURIComponent(id) + '/complete'); }
async function skipToken(id) { if (window.confirm('Skip this token? It can be returned to the queue later.')) await performAction('/api/admin/tokens/' + encodeURIComponent(id) + '/skip'); }
async function requeueToken(id) { if (window.confirm('Return this skipped token to the end of its service queue?')) await performAction('/api/admin/tokens/' + encodeURIComponent(id) + '/requeue'); }
$('recallBtn').addEventListener('click', () => performAction('/api/admin/recall', '', { service: $('queueServiceSelect').value }));
$('resetBtn').addEventListener('click', async () => {
  if (!window.confirm('Reset the entire demo queue? All token and activity records will be deleted.')) return;
  if (window.prompt('Type RESET to confirm:') !== 'RESET') return showNotice('Reset cancelled.', 'error');
  if (isBusy) return; setBusy(true); try { const data = await post('/api/admin/reset', { confirm: 'RESET' }); await refreshAll(); showNotice(data.message); } catch (error) { showNotice(error.message, 'error'); } finally { setBusy(false); await loadQueue(true); }
});
[$('searchInput'), $('serviceFilter'), $('statusFilter')].forEach(control => control.addEventListener(control === $('searchInput') ? 'input' : 'change', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadRecords(true), control === $('searchInput') ? 250 : 0); }));
$('clearFiltersBtn').addEventListener('click', () => { $('searchInput').value = ''; $('serviceFilter').value = ''; $('statusFilter').value = ''; loadRecords(true); });
$('queueServiceSelect').addEventListener('change', async () => { await loadQueue(); $('walkinService').value = $('queueServiceSelect').value; });
$('pauseServiceBtn').addEventListener('click', async () => { const service = $('queueServiceSelect').value; const data = await loadQueue(true); if (!data) return; const paused = !data.paused; if (paused && !window.confirm('Pause ' + service + '? Students will not be able to create new tokens for this service. Existing tokens remain in the queue.')) return; await performAction('/api/admin/services/pause', '', { service, paused }); });
$('walkinForm').addEventListener('submit', async event => { event.preventDefault(); $('walkinSubmit').disabled = true; const result = $('walkinResult'); result.hidden = true; try { const data = await post('/api/tokens', { studentName: $('walkinName').value.trim(), registerNumber: $('walkinRegister').value.trim(), department: $('walkinDepartment').value.trim(), purpose: $('walkinService').value, description: $('walkinDetails').value.trim() }); result.textContent = 'Walk-in token issued: ' + data.token.token_label + ' (' + data.token.purpose + '). Give this token number to the student.'; result.hidden = false; $('walkinForm').reset(); $('walkinService').value = $('queueServiceSelect').value; await refreshAll(); } catch (error) { showNotice(error.message, 'error'); } finally { $('walkinSubmit').disabled = false; } });
$('loadMoreBtn').addEventListener('click', () => { currentPage += 1; loadRecords(false); });
(async function init() {
  try { const data = await request('/api/auth/me'); if (data.authenticated) showDashboard(data.staff); else showLogin(); }
  catch (_) { showLogin(); }
  window.setInterval(() => { if (!dashboardSection.hidden) { loadQueue(true); loadRecords(true); } }, 7000);
})();
