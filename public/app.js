'use strict';
const $ = id => document.getElementById(id);
const notice = $('notice');
let noticeTimer;
function showNotice(message, type) {
  notice.textContent = message; notice.className = 'notice ' + (type || 'success'); notice.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
}
async function request(url, options) {
  const response = await fetch(url, options || {}); let data;
  try { data = await response.json(); } catch (_) { data = {}; }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function post(url, body) { return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function addOption(select, value, label) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option); }
const SERVICE_GUIDANCE = {
  'General Enquiry': 'For general questions about office procedures. Bring your student ID and any related reference details.',
  'Fees and Accounts': 'For fee payments, receipts, balances, or account corrections. Keep fee receipts and payment references ready.',
  'Certificate Request': 'For official certificate requests. Check the college requirements and bring your student ID and supporting documents.',
  'Bonafide / ID Card': 'For bonafide certificates or ID-card issues. Bring your student ID and any forms or proof requested by your college.',
  'Examination Section': 'For exam forms, hall-ticket issues, and examination records. Keep your register number and relevant exam details ready.',
  'Admissions': 'For admission-related questions and document status. Bring application details and available supporting documents.',
  'Document Verification': 'For checking submitted documents. Bring originals and copies if your college requires them.',
  'Other Services': 'For requests that do not fit another category. Describe the issue clearly so staff can direct you if needed.'
};
function statusLabel(status) { return ({ waiting: 'Waiting', serving: 'Serving', completed: 'Completed', skipped: 'Skipped' })[status] || status; }
async function loadServices() {
  try {
    const data = await request('/api/services');
    data.services.forEach(service => { const label = service.name + (service.paused ? ' — temporarily unavailable' : ''); const option = document.createElement('option'); option.value = service.name; option.textContent = label; option.disabled = Boolean(service.paused); $('purpose').appendChild(option); addOption($('publicService'), service.name, service.name); });
    if (data.services.length) $('publicService').value = data.services[0].name;
    $('heroServiceLabel').textContent = $('publicService').value || 'Service queue';
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadQueue() {
  try {
    const service = $('publicService').value;
    const data = await request('/api/queue' + (service ? '?service=' + encodeURIComponent(service) : ''));
    $('statServing').textContent = data.current ? data.current.token_label : '—';
    $('statWaiting').textContent = data.waiting;
    $('statLast').textContent = data.lastToken ? 'A' + String(data.lastToken).padStart(3, '0') : '—';
    $('statWait').textContent = data.waiting ? Math.max(1, Math.floor(data.waiting * data.averageServiceMinutes * 0.8)) + '–' + Math.max(1, Math.ceil(data.waiting * data.averageServiceMinutes * 1.3)) + ' min' : '0 min';
    $('publicService').setCustomValidity('');
    $('heroLastToken').textContent = data.lastToken ? String(data.lastToken).padStart(3, '0') : '---';
    $('heroServiceLabel').textContent = data.selectedService || 'Service queue';
    $('currentToken').textContent = data.current ? data.current.token_label : '---';
    $('currentPurpose').textContent = data.paused ? 'Service temporarily paused' : (data.current ? data.current.purpose : 'Waiting for next token');
    $('statWait').title = 'Estimate only; actual wait depends on request complexity and staff availability.';
    $('recallAnnouncement').textContent = data.recallAnnouncement || ''; $('recallAnnouncement').hidden = !data.recallAnnouncement;
    $('queueWaiting').textContent = data.waiting;
  } catch (error) { showNotice(error.message, 'error'); }
}
$('tokenForm').addEventListener('submit', async event => {
  event.preventDefault(); $('generateBtn').disabled = true;
  const details = { studentName: $('studentName').value.trim(), registerNumber: $('registerNumber').value.trim(), department: $('department').value.trim(), purpose: $('purpose').value, description: $('description').value.trim() };
  try {
    const data = await post('/api/tokens', details); const token = data.token;
    const receipt = $('issuedToken'); receipt.replaceChildren();
    const caption = document.createElement('span'); caption.textContent = 'YOUR TOKEN NUMBER';
    const number = document.createElement('strong'); number.textContent = token.token_label;
    const info = document.createElement('p'); info.textContent = token.purpose;
    const note = document.createElement('small'); note.textContent = 'Keep this number and your register number to check your status.';
    receipt.append(caption, number, info, note); receipt.hidden = false; $('lookupToken').value = token.token_label; $('lookupRegister').value = token.register_number;
    $('tokenForm').reset(); $('publicService').value = token.purpose; await loadQueue(); showNotice('Token ' + token.token_label + ' generated successfully. The live display now shows your service queue.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
  finally { $('generateBtn').disabled = false; }
});
$('lookupForm').addEventListener('submit', async event => {
  event.preventDefault(); const result = $('lookupResult'); result.hidden = false; result.className = 'lookup-result'; result.textContent = 'Checking token…';
  const params = new URLSearchParams({ token: $('lookupToken').value.trim(), registerNumber: $('lookupRegister').value.trim() });
  try {
    const data = await request('/api/lookup?' + params.toString()); const token = data.token; result.replaceChildren();
    const heading = document.createElement('strong'); heading.className = 'lookup-token'; heading.textContent = token.token_label;
    const status = document.createElement('span'); status.className = 'status-pill status-' + token.status; status.textContent = statusLabel(token.status);
    const info = document.createElement('p');
    if (token.status === 'waiting') info.textContent = 'You are number ' + token.position + ' in the ' + token.purpose + ' queue. Estimated wait: ' + token.estimated_wait_min + '–' + token.estimated_wait_max + ' minutes; this is not guaranteed.';
    else if (token.status === 'serving') info.textContent = 'Your token is being served now. Please proceed to the service desk.';
    else if (token.status === 'completed') info.textContent = 'Your service has been completed.';
    else info.textContent = 'This token was skipped. Please contact the service desk if you still need assistance.';
    const service = document.createElement('small'); service.textContent = token.purpose + (token.department ? ' · ' + token.department : ''); result.append(heading, status, info, service);
  } catch (error) { result.className = 'lookup-result lookup-error'; result.textContent = error.message; }
});
$('publicService').addEventListener('change', loadQueue);
$('purpose').addEventListener('change', () => { const service = $('purpose').value; $('serviceGuidance').textContent = SERVICE_GUIDANCE[service] || 'Choose a service to see what it handles and what to bring.'; });
(async function init() { await loadServices(); await loadQueue(); window.setInterval(loadQueue, 5000); })();
