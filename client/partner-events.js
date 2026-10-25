(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const state = { occasions: [], packages: [], requests: [], staff: [] };
  const form = $('#eventPackageForm'); if (!form) return;

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'x-session-token': sessionStorage.getItem('formeSessionToken') || '', ...(options.headers || {}) };
    const response = await fetch(`${window.BARBER_API_URL || location.origin}${path}`, { ...options, headers, cache: 'no-store' });
    let data; try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function toast(message, error = false) {
    const box = $('#toast'); box.textContent = message; box.className = `toast show${error ? ' error' : ''}`;
    setTimeout(() => { box.className = 'toast'; }, 3200);
  }
  function showMessage(node, message, error = false) { node.textContent = message; node.className = `form-message${error ? ' error' : ''}`; }
  function money(value, currency = 'INR') {
    try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value || 0)); }
    catch { return `${currency} ${Math.round(Number(value || 0))}`; }
  }
  function dateText(value) { const [year, month, day] = String(value || '').slice(0, 10).split('-').map(Number); return year ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12))) : ''; }
  function timeText(value) { const [hour, minute] = String(value || '').slice(0, 5).split(':').map(Number); return Number.isInteger(hour) ? `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'pm' : 'am'}` : String(value || ''); }
  function parseItems(value) {
    return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name = '', participantRole = 'any', duration = '', price = ''] = line.split('|').map((part) => part.trim());
      return { name, participantRole: participantRole || 'any', durationMinutes: Number(duration), quantity: 1, included: true, price: Number(price) };
    });
  }
  async function load() {
    $('#eventPackageList').innerHTML = '<p class="loading">Loading your event packages…</p>';
    $('#partnerEventRequests').innerHTML = '<p class="loading">Loading customer requests…</p>';
    const [occasions, packages, requests, staff] = await Promise.all([
      api('/api/public/events/occasions'), api('/api/admin/event-packages'), api('/api/admin/events/requests'), api('/api/admin/staff'),
    ]);
    state.occasions = occasions; state.packages = packages; state.requests = requests; state.staff = staff;
    const select = $('#eventAdminOccasion'); const prior = select.value;
    select.innerHTML = '<option value="">Choose an event type</option>' + occasions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    if (occasions.some((item) => item.id === prior)) select.value = prior;
    renderPackages(); renderRequests();
  }
  function renderPackages() {
    $('#eventPackageList').innerHTML = `<div class="event-admin-list-heading"><span class="eyebrow">YOUR SAVED PACKAGES</span><strong>${state.packages.filter((item) => item.active).length} active</strong></div>` + (state.packages.length ? state.packages.map((item) => `<article class="event-admin-package-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.occasionName || state.occasions.find((row) => row.id === item.occasionId)?.name || 'Custom event')} · ${escapeHtml(item.fulfillmentModes.map((mode) => ({ business: 'At your location', home: 'At home', venue: 'At venue' }[mode])).join(' · '))}</small><small>Starting at ${escapeHtml(money(item.startingPrice, item.currency))} · ${item.items.length} service${item.items.length === 1 ? '' : 's'}</small></div><button class="action-button" data-toggle-event-package="${escapeHtml(item.id)}">${item.active ? 'Hide package' : 'Publish package'}</button></article>`).join('') : '<p class="empty-state">No event packages yet. Add your first package above.</p>');
  }
  function renderRequests() {
    const statusLabels = { quote_requested: 'New quote request', quote_sent: 'Quote sent', quote_accepted: 'Customer accepted · assign team', change_requested: 'Customer requested changes', awaiting_deposit: 'Deposit setup needed', confirmed: 'Confirmed', cancelled: 'Cancelled', rejected: 'Declined', expired: 'Expired' };
    $('#partnerEventRequests').innerHTML = state.requests.length ? state.requests.map((request) => {
      const quote = request.quote; const mayQuote = ['quote_requested', 'quote_sent', 'change_requested'].includes(request.status); const mayConfirm = request.status === 'quote_accepted' && Number(quote?.depositAmount || 0) === 0;
      const quoteSummary = quote ? `<div class="event-admin-quote-summary"><strong>Quote revision ${quote.revision}: ${escapeHtml(money(quote.total, quote.currency))}</strong><small>Advance ${escapeHtml(money(quote.depositAmount, quote.currency))} (${quote.depositPercent}%) · expires ${escapeHtml(new Date(quote.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}</small></div>` : '';
      return `<article class="event-admin-request-card"><div class="event-admin-request-top"><div><span class="eyebrow">${escapeHtml(request.reference)}</span><h3>${escapeHtml(request.occasionName)} · ${escapeHtml(request.packageName || 'Custom event')}</h3><p>${escapeHtml(request.customer?.name || 'Customer')} · ${escapeHtml(request.customer?.email || '')}${request.customer?.phone ? ` · ${escapeHtml(request.customer.phone)}` : ''}</p></div><span class="event-request-status">${escapeHtml(statusLabels[request.status] || request.status)}</span></div><div class="event-admin-request-details"><span><b>When</b>${escapeHtml(dateText(request.eventDate))}, ${escapeHtml(timeText(request.eventStartTime))} · ready by ${escapeHtml(timeText(request.readyByTime))}</span><span><b>Location</b>${escapeHtml({ business: 'At your location', home: 'Customer’s home', venue: 'Event venue' }[request.fulfillmentMode] || request.fulfillmentMode)} · ${escapeHtml(request.venueCity || '')}</span><span><b>People and team</b>${request.participantCount} participants · ${request.requiredProfessionals} professional${request.requiredProfessionals === 1 ? '' : 's'}</span>${request.venue?.address ? `<span><b>Private address</b>${escapeHtml(request.venue.address)}${request.venue.city ? `, ${escapeHtml(request.venue.city)}` : ''}</span>` : ''}</div><div class="event-admin-services">${request.participants.map((person) => `<span>${escapeHtml(person.role)}${person.displayName ? ` · ${escapeHtml(person.displayName)}` : ''}</span>`).join('')}${request.services.map((service) => `<span>${escapeHtml(service.name)}${service.quantity > 1 ? ` ×${service.quantity}` : ''}</span>`).join('')}</div>${request.requirements ? `<p class="event-admin-requirements">${escapeHtml(request.requirements)}</p>` : ''}${quoteSummary}<div class="event-admin-actions">${mayQuote ? `<button class="button button-dark" data-event-quote="${escapeHtml(request.id)}">${quote ? 'Send revised quote' : 'Prepare quote'}</button>` : ''}${mayConfirm ? `<button class="button button-dark" data-confirm-event="${escapeHtml(request.id)}">Assign team and confirm</button>` : ''}${request.status === 'awaiting_deposit' ? '<small>Do not confirm until deposit collection is connected and verified.</small>' : ''}${!['cancelled', 'rejected', 'expired'].includes(request.status) ? `<button class="button button-outline" data-cancel-event="${escapeHtml(request.id)}">Cancel request</button>` : ''}</div></article>`;
    }).join('') : '<p class="empty-state">Event quote requests from customers will appear here.</p>';
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const button = form.querySelector('[type="submit"]'); const values = Object.fromEntries(new FormData(form));
    const modes = $$('input[name="fulfillmentModes"]:checked', form).map((input) => input.value); const items = parseItems(values.itemsText);
    if (!modes.length) return showMessage($('#eventPackageMessage'), 'Choose at least one service location.', true);
    if (items.some((item) => item.name.length < 2 || !Number.isInteger(item.durationMinutes) || item.durationMinutes < 5 || !Number.isFinite(item.price) || item.price < 0)) return showMessage($('#eventPackageMessage'), 'Each service line needs a name, role, duration and price separated with |.', true);
    const payload = { name: values.name, description: values.description, occasionId: values.occasionId, fulfillmentModes: modes, items, maxDistanceKm: values.maxDistanceKm, travelBaseFee: Number(values.travelBaseFee), travelFeePerKm: Number(values.travelFeePerKm), travelBufferMinutes: Number(values.travelBufferMinutes), minNoticeHours: Number(values.minNoticeHours), portfolioUrls: values.portfolioUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean) };
    button.disabled = true; button.textContent = 'Saving package…';
    try { await api('/api/admin/event-packages', { method: 'POST', body: JSON.stringify(payload) }); form.reset(); form.elements.travelBaseFee.value = '0'; form.elements.travelFeePerKm.value = '0'; form.elements.travelBufferMinutes.value = '0'; form.elements.minNoticeHours.value = '24'; $$('input[name="fulfillmentModes"]', form).forEach((input) => { input.checked = input.value === 'business'; }); showMessage($('#eventPackageMessage'), 'Package saved. Customers can find it only when your business listing is approved.'); await load(); }
    catch (error) { showMessage($('#eventPackageMessage'), error.message, true); }
    finally { button.disabled = false; button.textContent = 'Save event package'; }
  });
  $('#eventPackageList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-toggle-event-package]'); if (!button) return;
    const item = state.packages.find((row) => row.id === button.dataset.toggleEventPackage); if (!item) return;
    button.disabled = true;
    try { await api(`/api/admin/event-packages/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ name: item.name, description: item.description, occasionId: item.occasionId, fulfillmentModes: item.fulfillmentModes, items: item.items, maxDistanceKm: item.maxDistanceKm, travelBaseFee: item.travelBaseFee, travelFeePerKm: item.travelFeePerKm, travelBufferMinutes: item.travelBufferMinutes, minNoticeHours: item.minNoticeHours, portfolioUrls: item.portfolioUrls, active: !item.active }) }); toast(item.active ? 'Event package hidden.' : 'Event package published.'); await load(); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
  function openQuote(request) {
    const quoteForm = $('#partnerQuoteForm'); quoteForm.reset(); quoteForm.elements.requestId.value = request.id;
    quoteForm.elements.quoteItems.value = request.services.map((service) => `${service.name} | ${service.quantity || 1} | 0 | 0`).join('\n');
    quoteForm.elements.expiryHours.value = '72'; quoteForm.elements.depositPercent.value = '0'; quoteForm.elements.taxes.value = '0';
    $('#partnerQuoteRequestSummary').textContent = `${request.reference} · ${request.customer?.name || 'Customer'} · ${dateText(request.eventDate)} · ${request.participantCount} participant${request.participantCount === 1 ? '' : 's'}`;
    showMessage($('#partnerQuoteMessage'), ''); $('#partnerQuoteDialog').showModal();
  }
  function openConfirmation(request) {
    const confirmForm = $('#partnerConfirmForm'); confirmForm.reset(); confirmForm.elements.requestId.value = request.id;
    $('#partnerConfirmSummary').textContent = `${request.reference} · ${dateText(request.eventDate)} · assign at least ${request.requiredProfessionals} professional${request.requiredProfessionals === 1 ? '' : 's'}.`;
    $('#partnerConfirmStaff').innerHTML = state.staff.filter((member) => member.active).map((member) => `<label class="event-package-choice"><input type="checkbox" name="staffIds" value="${escapeHtml(member.id)}"><span>${escapeHtml(member.name)}</span><small>${escapeHtml(member.role || 'Team member')}</small></label>`).join('') || '<p class="empty-state">Add active staff members in Team and hours before confirming an event.</p>';
    showMessage($('#partnerConfirmMessage'), ''); $('#partnerConfirmDialog').showModal();
  }
  $('#partnerEventRequests').addEventListener('click', async (event) => {
    const quoteButton = event.target.closest('[data-event-quote]'); const confirmButton = event.target.closest('[data-confirm-event]'); const cancelButton = event.target.closest('[data-cancel-event]');
    if (quoteButton) { const request = state.requests.find((item) => item.id === quoteButton.dataset.eventQuote); if (request) openQuote(request); }
    else if (confirmButton) { const request = state.requests.find((item) => item.id === confirmButton.dataset.confirmEvent); if (request) openConfirmation(request); }
    else if (cancelButton) { if (!confirm('Cancel this event request?')) return; cancelButton.disabled = true; try { await api(`/api/admin/events/requests/${encodeURIComponent(cancelButton.dataset.cancelEvent)}/cancel`, { method: 'POST', body: '{}' }); toast('Event request cancelled.'); await load(); } catch (error) { toast(error.message, true); cancelButton.disabled = false; } }
  });
  $('#refreshPartnerEvents').addEventListener('click', () => load().catch((error) => toast(error.message, true)));
  $('#partnerQuoteForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const quoteForm = event.currentTarget; const button = quoteForm.querySelector('[type="submit"]');
    const items = quoteForm.elements.quoteItems.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const [description = '', quantity = '', durationMinutes = '', unitPrice = ''] = line.split('|').map((part) => part.trim()); return { description, quantity: Number(quantity), durationMinutes: Number(durationMinutes), unitPrice: Number(unitPrice) }; });
    if (items.some((item) => item.description.length < 2 || !Number.isInteger(item.quantity) || item.quantity < 1 || !Number.isInteger(item.durationMinutes) || item.durationMinutes < 0 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0)) return showMessage($('#partnerQuoteMessage'), 'Each line must be description | quantity | minutes | unit price.', true);
    button.disabled = true;
    try { await api(`/api/admin/events/requests/${encodeURIComponent(quoteForm.elements.requestId.value)}/quote`, { method: 'POST', body: JSON.stringify({ items, taxes: Number(quoteForm.elements.taxes.value), depositPercent: Number(quoteForm.elements.depositPercent.value), expiryHours: Number(quoteForm.elements.expiryHours.value), terms: quoteForm.elements.terms.value }) }); $('#partnerQuoteDialog').close(); toast('Itemized quote sent to the customer.'); await load(); }
    catch (error) { showMessage($('#partnerQuoteMessage'), error.message, true); }
    finally { button.disabled = false; }
  });
  $('#partnerConfirmForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const confirmForm = event.currentTarget; const button = confirmForm.querySelector('[type="submit"]'); const request = state.requests.find((item) => item.id === confirmForm.elements.requestId.value); const staffIds = $$('input[name="staffIds"]:checked', confirmForm).map((input) => input.value);
    if (staffIds.length < Number(request?.requiredProfessionals || 1)) return showMessage($('#partnerConfirmMessage'), `Select at least ${request?.requiredProfessionals || 1} team member(s).`, true);
    button.disabled = true;
    try { await api(`/api/admin/events/requests/${encodeURIComponent(confirmForm.elements.requestId.value)}/confirm`, { method: 'POST', body: JSON.stringify({ staffIds }) }); $('#partnerConfirmDialog').close(); toast('Team assigned and event confirmed.'); await load(); }
    catch (error) { showMessage($('#partnerConfirmMessage'), error.message, true); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-close-partner-event]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  window.loadPartnerEventWorkspace = load;
})();
