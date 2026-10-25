'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const customerToken = () => sessionStorage.getItem('salonCustomerToken') || '';
const state = { page: 1, pageSize: 12, filters: {}, providers: [], occasions: [], selected: null, toastTimer: 0 };
const modeLabels = { business: 'At provider location', home: 'At your home', venue: 'At your event venue' };
const statusLabels = { quote_requested: 'Waiting for provider', quote_sent: 'Quote ready', quote_accepted: 'Accepted · awaiting team confirmation', change_requested: 'Changes requested', rejected: 'Declined', expired: 'Expired', awaiting_deposit: 'Deposit setup needed', confirmed: 'Confirmed', cancelled: 'Cancelled' };

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(customerToken() ? { 'x-customer-token': customerToken() } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function toast(message, error = false) {
  const el = $('#eventToast'); el.textContent = message; el.className = `event-toast show${error ? ' error' : ''}`;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { el.className = 'event-toast'; }, 3600);
}
function currency(value, code = 'INR') {
  try { return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(Number(value || 0)); }
  catch { return `${code} ${Math.round(Number(value || 0))}`; }
}
function dateText(value) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function modeLabel(value) { return modeLabels[value] || value; }
function setProviderStatus(message, error = false) { const node = $('#providerStatus'); node.textContent = message; node.style.color = error ? '#a84838' : ''; }

async function loadOccasions() {
  state.occasions = await api('/api/public/events/occasions');
  const search = $('#eventSearchForm').elements.occasionId;
  const modal = $('#eventRequestForm').elements.occasionId;
  for (const item of state.occasions) {
    search.add(new Option(item.name, item.id));
    modal.add(new Option(item.name, item.id));
  }
}
function renderProviders(data) {
  state.providers = data.providers || [];
  $('#eventProviders').innerHTML = state.providers.length ? state.providers.map((entry) => {
    const item = entry.package; const modes = item.fulfillmentModes.map((mode) => `<span>${escapeHtml(modeLabel(mode))}</span>`).join('');
    const travel = item.fulfillmentModes.some((mode) => mode !== 'business') ? `<span>Travel up to ${escapeHtml(item.maxDistanceKm)} km</span>` : '';
    const portfolio = item.portfolioUrls.length ? `<a class="event-portfolio-link" href="${escapeHtml(item.portfolioUrls[0])}" target="_blank" rel="noopener noreferrer">View portfolio ↗</a>` : '';
    return `<article class="event-provider-card"><div class="event-category"><span>${escapeHtml(entry.categoryName || 'Verified provider')}</span><span class="event-verified">✓ FORMÉ verified</span></div><h3>${escapeHtml(entry.businessName)}</h3><div class="event-location">${escapeHtml([entry.branchName, entry.city, entry.country].filter(Boolean).join(' · '))}</div><strong class="event-package-name">${escapeHtml(item.name)}</strong><p class="event-package-description">${escapeHtml(item.description || 'A custom event package from this provider.')}</p><div class="event-mode-chips">${modes}${travel}</div><div class="event-provider-price"><strong>${escapeHtml(currency(item.startingPrice, item.currency))}</strong><span>starting price · provider quote required</span></div>${portfolio}<button class="button button-dark" type="button" data-request-package="${escapeHtml(item.id)}">Request a quote <span>↗</span></button></article>`;
  }).join('') : '<div class="empty-state event-empty-state">No event packages match these filters yet. Try another city or event type.</div>';
  $('#eventPageLabel').textContent = `Page ${data.page} · ${data.total} package${data.total === 1 ? '' : 's'}`;
  $('#eventPrevious').disabled = data.page <= 1;
  $('#eventNext').disabled = data.page * data.pageSize >= data.total;
}
async function searchProviders(page = 1) {
  state.page = page; setProviderStatus('Finding approved event providers…'); $('#eventProviders').innerHTML = '<div class="loading">Loading event packages…</div>';
  const params = new URLSearchParams({ page: String(page), pageSize: String(state.pageSize) });
  for (const [key, value] of Object.entries(state.filters)) if (String(value || '').trim()) params.set(key, String(value).trim());
  try {
    const result = await api(`/api/public/events/providers?${params}`); renderProviders(result);
    setProviderStatus(`${result.total} bookable package${result.total === 1 ? '' : 's'} from approved FORME providers.`);
  } catch (error) { $('#eventProviders').innerHTML = ''; setProviderStatus(error.message, true); }
}
function openRequest(packageId) {
  const entry = state.providers.find((item) => item.package.id === packageId); if (!entry) return;
  state.selected = entry;
  const form = $('#eventRequestForm'); form.reset();
  form.elements.businessSlug.value = entry.businessSlug; form.elements.branchId.value = entry.branchId; form.elements.packageId.value = entry.package.id;
  const occasionSelect = form.elements.occasionId; occasionSelect.value = entry.package.occasionId || $('#eventSearchForm').elements.occasionId.value || '';
  const modeSelect = form.elements.fulfillmentMode; modeSelect.replaceChildren();
  for (const mode of entry.package.fulfillmentModes) modeSelect.add(new Option(modeLabel(mode), mode));
  form.elements.eventDate.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  form.elements.eventStartTime.value = '09:00'; form.elements.readyByTime.value = '12:00'; form.elements.requiredProfessionals.value = '1';
  form.elements.participants.value = 'Bride'; form.elements.venueCity.value = entry.city || '';
  $('#eventDialogTitle').textContent = `Plan with ${entry.businessName}.`;
  $('#eventPackageSummary').textContent = `${entry.package.name} · ${entry.branchName}${entry.city ? `, ${entry.city}` : ''} · from ${currency(entry.package.startingPrice, entry.package.currency)}`;
  $('#eventPackageItems').innerHTML = entry.package.items.map((item) => `<label class="event-package-choice"><input type="checkbox" name="packageService" value="${escapeHtml(item.id)}" ${item.included ? 'checked' : ''}><span>${escapeHtml(item.name)}${item.participantRole !== 'any' ? ` · ${escapeHtml(item.participantRole)}` : ''}</span><small>${item.durationMinutes} min</small></label>`).join('');
  $('#eventAuthNote').hidden = Boolean(customerToken()); $('#eventFormMessage').textContent = '';
  updateVenueFields(); $('#eventRequestDialog').showModal();
}
function updateVenueFields() {
  const form = $('#eventRequestForm'); const mode = form.elements.fulfillmentMode.value; const fields = $('#eventVenueFields');
  fields.hidden = mode === 'business';
  form.elements.venueAddress.required = mode !== 'business'; form.elements.venueCity.required = mode !== 'business';
  form.elements.latitude.required = mode !== 'business'; form.elements.longitude.required = mode !== 'business';
}
function parseParticipants(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s*[|—]\s*/, 2); return { role: parts[0].slice(0, 50), name: (parts[1] || '').slice(0, 80) };
  });
}
async function submitRequest(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]');
  if (!customerToken()) { $('#eventAuthNote').hidden = false; $('#eventFormMessage').textContent = 'Sign in to your customer account, then return here to send this request.'; $('#eventFormMessage').className = 'event-form-message error'; return; }
  const participants = parseParticipants(form.elements.participants.value);
  if (!participants.length) { $('#eventFormMessage').textContent = 'Enter at least one participant role.'; $('#eventFormMessage').className = 'event-form-message error'; return; }
  const services = [...form.querySelectorAll('[name="packageService"]:checked')].map((input) => ({ packageItemId: input.value, quantity: 1 }));
  const extras = form.elements.additionalServices.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  for (const name of extras) services.push({ name: name.slice(0, 100), quantity: 1 });
  if (!services.length) { $('#eventFormMessage').textContent = 'Choose or add at least one service.'; $('#eventFormMessage').className = 'event-form-message error'; return; }
  const payload = {
    businessSlug: form.elements.businessSlug.value, branchId: form.elements.branchId.value, packageId: form.elements.packageId.value,
    occasionId: form.elements.occasionId.value, fulfillmentMode: form.elements.fulfillmentMode.value,
    eventDate: form.elements.eventDate.value, eventStartTime: form.elements.eventStartTime.value, readyByTime: form.elements.readyByTime.value,
    requiredProfessionals: Number(form.elements.requiredProfessionals.value), participants, services,
    venueAddress: form.elements.venueAddress.value, venueCity: form.elements.venueCity.value,
    latitude: form.elements.latitude.value, longitude: form.elements.longitude.value, requirements: form.elements.requirements.value,
  };
  button.disabled = true; $('#eventFormMessage').textContent = 'Sending your quote request…'; $('#eventFormMessage').className = 'event-form-message';
  try {
    const key = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await api('/api/events/quote-requests', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
    $('#eventFormMessage').textContent = `Request ${result.request.reference} sent. It is not a confirmed booking.`;
    $('#eventFormMessage').className = 'event-form-message'; toast('Your request is with the provider.');
    await loadMyRequests(); setTimeout(() => $('#eventRequestDialog').close(), 1100);
  } catch (error) { $('#eventFormMessage').textContent = error.message; $('#eventFormMessage').className = 'event-form-message error'; }
  finally { button.disabled = false; }
}
function renderRequests(requests) {
  const list = $('#eventRequestsList');
  if (!requests.length) { list.innerHTML = '<div class="empty-state">Your event requests will appear here after you send one.</div>'; return; }
  list.innerHTML = requests.map((request) => {
    const quote = request.quote;
    const quoteBox = quote ? `<div class="event-quote-box"><div class="event-request-card-head"><strong>Provider quote · revision ${quote.revision}</strong><span>${escapeHtml(quote.currency)}</span></div><div class="event-quote-items">${quote.items.map((item) => `<div class="event-quote-line"><span>${escapeHtml(item.description)} × ${item.quantity}${item.durationMinutes ? ` · ${item.durationMinutes} min` : ''}</span><span>${escapeHtml(currency(item.total, quote.currency))}</span></div>`).join('')}<div class="event-quote-line"><span>Travel charge</span><span>${escapeHtml(currency(quote.travelFee, quote.currency))}</span></div>${quote.taxes ? `<div class="event-quote-line"><span>Taxes and fees</span><span>${escapeHtml(currency(quote.taxes, quote.currency))}</span></div>` : ''}<div class="event-quote-total"><span>Total</span><strong>${escapeHtml(currency(quote.total, quote.currency))}</strong></div><div class="event-quote-line"><span>Advance required (${quote.depositPercent}%)</span><strong>${escapeHtml(currency(quote.depositAmount, quote.currency))}</strong></div>${quote.terms ? `<p>${escapeHtml(quote.terms)}</p>` : ''}<p>Quote expires ${escapeHtml(new Date(quote.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}.</p></div>${request.status === 'quote_sent' ? `<div class="event-request-actions"><button class="button button-dark" data-event-response="accept" data-quote-id="${escapeHtml(quote.id)}">Accept quote</button><button class="button button-outline" data-event-response="changes" data-quote-id="${escapeHtml(quote.id)}">Request changes</button><button class="button button-outline" data-event-response="reject" data-quote-id="${escapeHtml(quote.id)}">Decline quote</button></div>` : ''}` : '';
    const cancel = !['cancelled', 'rejected', 'expired'].includes(request.status) ? `<button class="button button-outline" data-event-cancel="${escapeHtml(request.id)}">Cancel request</button>` : '';
    return `<article class="event-request-card"><div class="event-request-card-head"><div><h3>${escapeHtml(request.businessName)} · ${escapeHtml(request.packageName || 'Custom event')}</h3><p>Ref ${escapeHtml(request.reference)} · ${escapeHtml(request.occasionName)} · ${escapeHtml(dateText(request.eventDate))} at ${escapeHtml(request.eventStartTime)} · ready by ${escapeHtml(request.readyByTime)}</p><p>${escapeHtml(modeLabel(request.fulfillmentMode))} · ${request.participantCount} participant${request.participantCount === 1 ? '' : 's'} · ${request.requiredProfessionals} professional${request.requiredProfessionals === 1 ? '' : 's'}</p></div><span class="event-request-status">${escapeHtml(statusLabels[request.status] || request.status)}</span></div>${quoteBox}<div class="event-request-actions">${cancel}</div></article>`;
  }).join('');
}
async function loadMyRequests() {
  const section = $('#myEventRequests'); if (!customerToken()) { section.hidden = true; return; }
  section.hidden = false; $('#eventRequestsStatus').textContent = 'Loading your event requests…';
  try { const requests = await api('/api/customer/events'); renderRequests(requests); $('#eventRequestsStatus').textContent = `${requests.length} event request${requests.length === 1 ? '' : 's'} in your account.`; }
  catch (error) { $('#eventRequestsStatus').textContent = error.message; }
}
async function respondToQuote(button) {
  const action = button.dataset.eventResponse; const quoteId = button.dataset.quoteId;
  const note = action === 'changes' ? prompt('What would you like the provider to change?') : '';
  if (action === 'changes' && note === null) return;
  const confirmed = action === 'accept' ? confirm('Accept this quote? The event is not confirmed until the provider confirms the assigned team and schedule.') : action === 'reject' ? confirm('Decline this quote?') : true;
  if (!confirmed) return;
  button.disabled = true;
  try { const result = await api(`/api/events/quotes/${encodeURIComponent(quoteId)}/respond`, { method: 'POST', body: JSON.stringify({ action: action === 'changes' ? 'request_changes' : action, note }) }); toast(result.message); await loadMyRequests(); }
  catch (error) { toast(error.message, true); button.disabled = false; }
}
async function cancelRequest(button) {
  if (!confirm('Cancel this event request? Any payment, if already collected by a provider, follows the agreed cancellation terms.')) return;
  button.disabled = true;
  try { const result = await api(`/api/events/${encodeURIComponent(button.dataset.eventCancel)}/cancel`, { method: 'POST', body: '{}' }); toast(result.message); await loadMyRequests(); }
  catch (error) { toast(error.message, true); button.disabled = false; }
}

$('#eventSearchForm').addEventListener('submit', (event) => { event.preventDefault(); state.filters = Object.fromEntries(new FormData(event.currentTarget)); searchProviders(1); });
$('#eventPrevious').addEventListener('click', () => { if (state.page > 1) searchProviders(state.page - 1); });
$('#eventNext').addEventListener('click', () => searchProviders(state.page + 1));
$('#eventProviders').addEventListener('click', (event) => { const button = event.target.closest('[data-request-package]'); if (button) openRequest(button.dataset.requestPackage); });
$('#eventRequestForm').addEventListener('change', (event) => { if (event.target.name === 'fulfillmentMode') updateVenueFields(); });
$('#eventRequestForm').addEventListener('submit', submitRequest);
$('#eventRequestsList').addEventListener('click', (event) => { const response = event.target.closest('[data-event-response]'); const cancel = event.target.closest('[data-event-cancel]'); if (response) respondToQuote(response); else if (cancel) cancelRequest(cancel); });
$('#refreshEventRequests').addEventListener('click', () => loadMyRequests());
$('#useCurrentEventLocation').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location is not available. Enter the venue coordinates manually.', true);
  const button = $('#useCurrentEventLocation'); button.disabled = true;
  navigator.geolocation.getCurrentPosition((position) => { $('#eventRequestForm').elements.latitude.value = position.coords.latitude.toFixed(6); $('#eventRequestForm').elements.longitude.value = position.coords.longitude.toFixed(6); button.disabled = false; }, () => { toast('Could not get your location. Enter venue coordinates manually.', true); button.disabled = false; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
});
document.querySelectorAll('[data-close-event-dialog]').forEach((button) => button.addEventListener('click', () => $('#eventRequestDialog').close()));
$('#eventRequestDialog').addEventListener('click', (event) => { if (event.target === $('#eventRequestDialog')) $('#eventRequestDialog').close(); });
$('#eventSignInNote')?.addEventListener('click', () => { location.href = '/account'; });
Promise.all([loadOccasions(), loadMyRequests()]).then(() => searchProviders(1)).catch((error) => setProviderStatus(error.message, true));
