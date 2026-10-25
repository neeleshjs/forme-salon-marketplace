const API_BASE = window.BARBER_API_URL || window.location.origin;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let currentCurrency = 'INR'; let currentLocale = 'en-IN'; let currentTimeZone = 'Asia/Kolkata';
const money = (value) => { try { return new Intl.NumberFormat(currentLocale, { style: 'currency', currency: currentCurrency, maximumFractionDigits: 0 }).format(Number(value) || 0); } catch { return `${currentCurrency} ${Math.round(Number(value) || 0)}`; } };
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const localDate = () => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: currentTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return `${parts.find(x=>x.type==='year').value}-${parts.find(x=>x.type==='month').value}-${parts.find(x=>x.type==='day').value}`; };
const displayDate = (value) => { if (!value) return ''; const [year, month, day] = value.split('-').map(Number); return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12))); };
const displayTime = (value) => { if (!value || !/^\d{2}:\d{2}$/.test(value)) return value || ''; const [hour, minute] = value.split(':').map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'pm' : 'am'}`; };
const tokenKey = 'formeSessionToken';
const partnerChallengeKey = 'formePartnerRegistrationChallenge';
const customerChallengeKey = 'formeCustomerRegistrationChallenge';
const partnerResetChallengeKey = 'formePartnerPasswordResetChallenge';
const customerResetChallengeKey = 'formeCustomerPasswordResetChallenge';
let activeUser = null, activeWorkspace = null, organizations = [], pendingLoginToken = '', pendingPartnerChallengeId = '', pendingCustomerChallengeId = '', pendingPartnerResetChallengeId = '', pendingCustomerResetChallengeId = '', authMode = 'login', addingOrganization = false;
const directSalonLink = new URLSearchParams(location.search).has('salon');
let publicContext = { salon: new URLSearchParams(location.search).get('salon') || 'forme', branch: new URLSearchParams(location.search).get('branch') || '' };
let services = [];
let staff = [];
let availability = [];
let adminData = { products: [], customers: [], staff: [], services: [] };
let partnerCategories = [];
let partnerCategoryLoadPromise = null;
let cart = [];
let posType = 'all';
let appointmentCache = [];
let toastTimer;

function resolveRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(location.search);
  if (path === '/' && params.has('salon')) return { name: 'salon', slug: params.get('salon') };
  if (path === '/') return { name: 'home' };
  if (path === '/salons') return { name: 'salons' };
  if (path === '/account') return { name: 'account' };
  if (path === '/partner') return { name: 'partner' };
  if (path === '/partner/login') return { name: 'partner-login' };
  if (path === '/partner/signup') return { name: 'partner-signup' };
  if (path === '/manage-booking') return { name: 'manage' };
  if (path === '/not-found') return { name: 'not-found' };
  const salon = path.match(/^\/salon\/([^/]+)(?:\/(booking))?$/);
  if (salon) return { name: salon[2] ? 'booking' : 'salon', slug: decodeURIComponent(salon[1]) };
  const studio = path.match(/^\/studio(?:\/([^/]+))?$/);
  if (studio) {
    const view = studio[1] || 'overview';
    return Object.hasOwn(titles, view) ? { name: 'studio', view } : { name: 'not-found' };
  }
  return { name: 'not-found' };
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  renderRoute();
}

function renderRoute() {
  const route = resolveRoute();
  const publicChildren = new Set(({ home: ['platform', 'marketCategories', 'howItWorks', 'partner'], salons: ['salonDirectory', 'howItWorks'], account: ['customerAccountPage'], salon: ['salonExperience'], booking: ['salonExperience'], manage: ['salonExperience'], partner: ['partner', 'partnerHow'], 'not-found': ['notFound'] })[route.name] || []);
  $$('main#top > section').forEach(section => { section.hidden = !publicChildren.has(section.id); });
  const customerAccess = $('#customerAccess');
  if (customerAccess) {
    let bookingMount = $('#bookingCustomerMount');
    if (!bookingMount) { bookingMount = document.createElement('div'); bookingMount.id = 'bookingCustomerMount'; customerAccess.before(bookingMount); }
    (route.name === 'account' ? $('#accountAccessMount') : bookingMount).append(customerAccess);
  }
  const privatePage = ['partner-login', 'partner-signup', 'studio'].includes(route.name);
  $('#siteFooter').hidden = ['partner-login', 'partner-signup', 'studio', 'not-found'].includes(route.name);
  $('#adminShell').hidden = !privatePage;
  document.body.style.overflow = privatePage ? 'hidden' : '';
  $('#adminGate').hidden = route.name === 'studio' && Boolean(sessionStorage.getItem(tokenKey));
  $('#dashboard').hidden = route.name !== 'studio' || !sessionStorage.getItem(tokenKey);
  document.body.dataset.page = route.name;

  const salonPage = ['salon', 'booking', 'manage'].includes(route.name);
  $('#salonExperience').hidden = !salonPage;
  const salonSections = ['.salon-experience > .hero', '#services', '#experience', '#booking', '#manageBooking'];
  salonSections.forEach(selector => { const node = $(selector); if (node) node.hidden = true; });
  if (route.name === 'salon') ['.salon-experience > .hero', '#services', '#experience'].forEach(selector => { $(selector).hidden = false; });
  if (route.name === 'booking') $('#booking').hidden = false;
  if (route.name === 'manage') $('#manageBooking').hidden = false;

  if (route.slug) publicContext.salon = route.slug;
  const params = new URLSearchParams(location.search);
  if (params.has('salon')) publicContext.salon = params.get('salon') || publicContext.salon;
  if (params.has('branch')) publicContext.branch = params.get('branch') || '';
  else if (route.slug && !directSalonLink) publicContext.branch = '';

  if (route.name === 'home') document.title = 'Find a salon near you - FORME';
  else if (route.name === 'salons') {
    document.title = 'Find salons - FORME';
    $('#salonSearch').value = params.get('q') || '';
    $('#marketLocation').value = params.get('city') || '';
    loadSalonDirectory($('#salonSearch').value.trim());
  } else if (route.name === 'partner') document.title = 'For salon owners - FORME';
  else if (route.name === 'account') { document.title = 'My bookings - FORME'; $('#customerAuthPanel h3').textContent = 'Sign in to view your bookings'; }
  else if (['salon', 'booking'].includes(route.name)) $('#customerAuthPanel h3').textContent = 'Sign in to book';
  else if (route.name === 'salon' || route.name === 'booking') loadPublicData();
  else if (route.name === 'manage') document.title = 'Manage booking - FORME';
  else if (route.name === 'partner-login' || route.name === 'partner-signup') {
    document.title = route.name === 'partner-signup' ? 'Create a salon account - FORME' : 'Salon owner sign in - FORME';
    openAdmin(route.name === 'partner-signup');
    if (route.name === 'partner-signup') setAuthMode('register');
  } else if (route.name === 'studio') {
    document.title = 'Salon owner dashboard - FORME';
    if (sessionStorage.getItem(tokenKey)) showView(route.view);
    else setAuthMode('login');
  } else if (route.name === 'not-found') document.title = 'Page not found - FORME';
}

window.addEventListener('popstate', renderRoute);

const mobileMenuToggle = $('#mobileMenuToggle');
const mainNavigation = $('#mainNavigation');
function closeMobileNavigation() {
  if (!mobileMenuToggle || !mainNavigation) return;
  mobileMenuToggle.setAttribute('aria-expanded', 'false');
  mobileMenuToggle.setAttribute('aria-label', 'Open navigation');
  mainNavigation.classList.remove('is-open');
}
mobileMenuToggle?.addEventListener('click', () => {
  const isOpen = mobileMenuToggle.getAttribute('aria-expanded') === 'true';
  mobileMenuToggle.setAttribute('aria-expanded', String(!isOpen));
  mobileMenuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  mainNavigation.classList.toggle('is-open', !isOpen);
});
mainNavigation?.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMobileNavigation();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.nav')) closeMobileNavigation();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileNavigation();
});
window.addEventListener('resize', () => {
  if (window.matchMedia('(min-width: 761px)').matches) closeMobileNavigation();
});

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (path.startsWith('/api/admin/') || ['/api/auth/me', '/api/auth/switch-context', '/api/auth/create-organization'].includes(path)) headers['x-session-token'] = sessionStorage.getItem(tokenKey) || '';
  else if (!path.startsWith('/api/auth/') && !path.startsWith('/api/customer/login') && !path.startsWith('/api/customer/register') && path !== '/api/customer/verify-registration' && path !== '/api/public/salons' && path !== '/api/health') { headers['x-salon-slug'] = publicContext.salon; if (publicContext.branch) headers['x-branch-id'] = publicContext.branch; if (sessionStorage.getItem('salonCustomerToken')) headers['x-customer-token'] = sessionStorage.getItem('salonCustomerToken'); }
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, headers }); }
  catch { throw new Error('Could not connect. Check your internet connection and try again.'); }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorCopy = {
      'Enter a valid country, currency, time zone, and map pin.': 'Check your country, currency and time zone. You can add the map pin later.',
      'Enter a business name, location, country, and three-letter currency.': 'Enter your salon name, first location, country and currency. For India, choose INR.',
      'Enter the location name, country, and a three-letter currency.': 'Enter the location name, country and currency. For India, choose INR.',
      'Choose a supported currency and time zone.': 'Choose a supported currency and time zone. For India, use INR and Asia/Kolkata.',
      'Choose a service and valid date.': 'Choose a service and a valid visit date.',
      'Choose a valid service.': 'Choose one of the services shown in the list.',
      'Choose a valid date and time.': 'Choose an available visit date and time.',
      'Choose a future time.': 'Choose a date and time that have not passed.',
      'Enter times in HH:MM format.': 'Enter time in 24-hour format, for example 09:30.',
      'The code is invalid or expired. Request a new password reset code and try again.': 'That OTP is incorrect or expired. Request a new email OTP and try again.',
      'Email or password is incorrect.': 'That email and password do not match. Check them and try again, or reset your password.',
      'This account has no active salon workspace.': 'This email is not linked to an active salon yet. Check that you used the email from salon sign-up.',
      'Could not start online payment.': 'Online payment could not start. Please try again or contact the salon.'
    };
    const rawMessage = data?.error || 'We could not complete that request. Please try again.';
    throw new Error(errorCopy[rawMessage] || rawMessage);
  }
  return data;
}
function showMessage(node, text, error = false) { if (!node) return; node.textContent = text; node.classList.toggle('error', error); }
function installPasswordVisibilityToggles() {
  const eyeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5 10 6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const eyeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a16.3 16.3 0 0 1-4 4.4M6.2 6.3C3.5 8 2 12 2 12s3.5 6 10 6c1 0 1.9-.1 2.7-.4"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>';
  $$('input[type="password"]').forEach((input) => {
    if (input.dataset.visibilityToggle === 'ready') return;
    input.dataset.visibilityToggle = 'ready';
    const field = document.createElement('span');
    field.className = 'password-field';
    input.parentNode.insertBefore(field, input);
    field.append(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-visibility-toggle';
    button.setAttribute('aria-label', 'Show password');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Show password';
    button.innerHTML = eyeIcon;
    button.addEventListener('click', () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.innerHTML = visible ? eyeOffIcon : eyeIcon;
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(visible));
      button.title = visible ? 'Hide password' : 'Show password';
    });
    field.append(button);
  });
}
installPasswordVisibilityToggles();
function notify(text, error = false) { const node = $('#toast'); node.textContent = text; node.classList.toggle('error', error); node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3200); }
function statusLabel(status) { const labels = { 'in-service': 'Service in progress', 'no-show': 'Did not arrive', arrived: 'Customer arrived', deposit_due: 'Advance payment due', confirmed: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed' }; return labels[status] || String(status).replaceAll('-', ' ').replaceAll('_', ' '); }
function statusBadge(status) { return `<span class="status-pill ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`; }

function setDateMin(input) { if (input) input.min = localDate(); }
async function loadPublicData() {
  try {
    const [profile, serviceList, staffList, ratingData] = await Promise.all([api('/api/salon/profile'), api('/api/services'), api('/api/staff'), api('/api/reviews')]);
    if (!['salon', 'booking'].includes(resolveRoute().name)) return;
    currentCurrency = profile.branch.currency || 'INR'; currentLocale = profile.branch.locale || 'en-IN'; currentTimeZone = profile.branch.timeZone || 'Asia/Kolkata'; services = serviceList; staff = staffList; $('#salonRatingSummary').textContent = ratingData.ratingCount ? `★ ${ratingData.averageRating} · ${ratingData.ratingCount} verified review${ratingData.ratingCount===1?'':'s'}` : 'New salon · be the first to rate';
    $('#salonExperience').hidden = false; document.title = `${profile.tenantName} - ${profile.branch.name} - FORME`; $('#manageBookingLink').href = `/manage-booking?salon=${encodeURIComponent(publicContext.salon)}&branch=${encodeURIComponent(profile.branch.id)}`; $('.hero-copy .button').href = `/salon/${encodeURIComponent(publicContext.salon)}/booking?branch=${encodeURIComponent(profile.branch.id)}`;
    $('#dateInput').value = localDate(); $('#manageDate').value = localDate();
    $('#serviceGrid').innerHTML = services.map((s, i) => `<article class="service-card"><span class="service-number">0${i + 1} / ${s.minutes} MIN</span><h3>${escapeHtml(s.name)}</h3><p>${escapeHtml(s.description)}</p><div class="service-bottom"><strong>${money(s.price)}</strong><span>${escapeHtml(s.category)}</span></div></article>`).join('');
    $('#serviceSelect').innerHTML = '<option value="">Choose a service</option>' + services.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${s.minutes} min · ${money(s.price)}</option>`).join('');
    $('#staffSelect').innerHTML = '<option value="">Any available barber</option>' + staff.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} · ${escapeHtml(s.role)}</option>`).join('');
  } catch (error) {
    if (error.message === 'Salon location not found.') { navigate('/not-found', { replace: true }); return; }
    $('#serviceGrid').innerHTML = `<p class="loading">${escapeHtml(error.message)}</p>`;
  }
}

async function refreshAvailableTimes({ preserve = false } = {}) {
  const serviceId = $('#serviceSelect').value;
  const date = $('#dateInput').value;
  const partySize = Number($('#partySizeSelect').value || 1);
  const select = $('#timeSelect');
  const previous = preserve ? select.value : '';
  if (!serviceId || !date) { select.innerHTML = '<option value="">Choose service and date first</option>'; availability = []; return; }
  select.innerHTML = '<option value="">Checking the schedule…</option>';
  select.disabled = true;
  try {
    const result = await api(`/api/availability?serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}&partySize=${partySize}&staffId=${encodeURIComponent($('#staffSelect').value)}`);
    availability = result.slots;
    const barberId = $('#staffSelect').value;
    const choices = availability.filter((slot) => !barberId || slot.staff.some((person) => person.id === barberId));
    select.innerHTML = choices.length ? '<option value="">Select an available time</option>' + choices.map((slot) => `<option value="${slot.time}">${displayTime(slot.time)} - ${slot.staff.length} team member${slot.staff.length === 1 ? '' : 's'} available</option>`).join('') : `<option value="">No time has ${partySize} available team member${partySize === 1 ? '' : 's'}. Try another date.</option>`;
    if (choices.some((slot) => slot.time === previous)) select.value = previous;
  } catch (error) { select.innerHTML = `<option value="">${escapeHtml(error.message)}</option>`; }
  finally { select.disabled = false; }
}

$('#dateInput').value = localDate();
$('#manageDate').value = localDate();
setDateMin($('#dateInput')); setDateMin($('#manageDate'));
$('#serviceSelect').addEventListener('change', () => refreshAvailableTimes());
$('#dateInput').addEventListener('change', () => refreshAvailableTimes());
$('#staffSelect').addEventListener('change', () => refreshAvailableTimes());
$('#partySizeSelect').addEventListener('change', () => refreshAvailableTimes());

let pendingDeposit = null;
$('#bookingForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!sessionStorage.getItem('salonCustomerToken')) { showMessage($('#customerAuthMessage'), 'Sign in or create an account before booking.', true); $('#customerAuthPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const data = Object.fromEntries(new FormData(form)); data.depositPolicyAccepted = data.depositPolicyAccepted === 'on';
  showMessage($('#bookingMessage'), 'Holding your selected time. Please wait...');
  try {
    const result = await api('/api/appointments', { method: 'POST', body: JSON.stringify(data) }); const appointment = result.appointment;
    const payment = await api('/api/payments/order', { method: 'POST', body: JSON.stringify({ reference: appointment.reference }) }); pendingDeposit = { ...payment, partySize: result.partySize || 1 };
    $('#depositCheckout').hidden = false; $('#depositAmountLabel').textContent = money(appointment.depositAmount); $('#depositModeNote').textContent = payment.mode === 'demo' ? 'Test payment only. No real money will be taken.' : 'Online payment secured by Razorpay.'; $('#payDepositButton').textContent = payment.mode === 'demo' ? 'Complete demo payment' : 'Pay advance online';
    const people = result.partySize || 1; const assignedNames = (result.appointments || []).map((person) => person.staffName).join(', '); const groupCopy = people > 1 ? ` for ${people} people, with a different team member assigned to each${assignedNames ? ` (${assignedNames})` : ''}` : ` with ${appointment.staffName}`; const references = (result.appointments || []).map((person) => person.reference).join(', ');
    showMessage($('#bookingMessage'), `Your time is held for 15 minutes: ${appointment.serviceName}${groupCopy} on ${displayDate(appointment.date)} at ${displayTime(appointment.time)}. Pay the total ${appointment.depositPercent}% booking advance to confirm. ${people > 1 ? `Booking references: ${references}.` : `Reference: ${appointment.reference}.`}`);
    loadMyBookings().catch(()=>{});
  } catch (error) { showMessage($('#bookingMessage'), error.message, true); }
});
$('#payDepositButton').addEventListener('click', async () => {
  if (!pendingDeposit) return;
  try {
    if (pendingDeposit.mode === 'demo') {
      const result = await api('/api/payments/demo-confirm', { method: 'POST', body: JSON.stringify({ reference: pendingDeposit.reference }) });
      showMessage($('#bookingMessage'), `Demo payment complete - no charge was made. ${result.partySize > 1 ? `The booking for ${result.partySize} people is` : 'Appointment'} confirmed.`); $('#depositCheckout').hidden = true; pendingDeposit = null; await loadMyBookings(); return;
    }
    if (!window.Razorpay) await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
    const checkout = new window.Razorpay({ key: pendingDeposit.keyId, amount: pendingDeposit.amount, currency: pendingDeposit.currency, name: pendingDeposit.name, description: pendingDeposit.description, order_id: pendingDeposit.orderId, prefill: pendingDeposit.prefill, handler: async response => { try { const confirmed = await api('/api/payments/verify', { method: 'POST', body: JSON.stringify(response) }); showMessage($('#bookingMessage'), `Booking advance received. ${confirmed.partySize > 1 ? `Bookings for ${confirmed.partySize} people are` : 'Appointment is'} confirmed.`); $('#depositCheckout').hidden = true; pendingDeposit = null; await loadMyBookings(); } catch (error) { showMessage($('#bookingMessage'), error.message, true); } }, modal: { ondismiss: () => showMessage($('#bookingMessage'), 'Payment window closed. Your time is held for 15 minutes; you can retry the deposit.') } }); checkout.open();
  } catch (error) { showMessage($('#bookingMessage'), error.message || 'The payment page did not open. Please try again.', true); }
});

$('#manageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const action = event.submitter?.value || 'reschedule';
  showMessage($('#manageMessage'), 'Finding your booking...');
  try {
    const booking = await api('/api/booking/lookup', { method: 'POST', body: JSON.stringify({ reference: data.reference.trim(), phone: data.phone.trim() }) });
    if (action === 'reschedule') {
      if (!data.date || !data.time) throw new Error('Choose a new date and available time first.');
      const open = await api(`/api/availability?serviceId=${encodeURIComponent(booking.serviceId)}&date=${encodeURIComponent(data.date)}&partySize=${booking.partySize || 1}`);
      const slot = open.slots.find((s) => s.time === data.time);
      if (!slot) throw new Error('That time is no longer available. Choose another time.');
      const updated = await api(`/api/booking/${encodeURIComponent(booking.reference)}`, { method: 'PATCH', body: JSON.stringify({ action, phone: data.phone.trim(), date: data.date, time: data.time, staffId: slot.staff[0]?.id }) });
      showMessage($('#manageMessage'), `Booking${updated.partySize > 1 ? ` for ${updated.partySize} people` : ''} is now on ${displayDate(updated.date)} at ${displayTime(updated.time)}${updated.staffNames?.length ? ` with ${updated.staffNames.join(', ')}` : ` with ${updated.staffName}`}.`);
    } else {
      const updated = await api(`/api/booking/${encodeURIComponent(booking.reference)}`, { method: 'PATCH', body: JSON.stringify({ action, phone: data.phone.trim() }) });
      showMessage($('#manageMessage'), `Booking${updated.partySize > 1 ? ` for ${updated.partySize} people` : ''} has been cancelled.`);
    }
  } catch (error) { showMessage($('#manageMessage'), error.message, true); }
});

$('#manageDate').addEventListener('change', async () => {
  const reference = $('#manageForm [name="reference"]').value.trim(); const phone = $('#manageForm [name="phone"]').value.trim();
  if (!reference || !phone) { $('#manageTime').innerHTML = '<option value="">Enter reference and phone first</option>'; return; }
  try {
    const booking = await api('/api/booking/lookup', { method: 'POST', body: JSON.stringify({ reference, phone }) });
    const data = await api(`/api/availability?serviceId=${encodeURIComponent(booking.serviceId)}&date=${encodeURIComponent($('#manageDate').value)}&partySize=${booking.partySize || 1}`);
    $('#manageTime').innerHTML = data.slots.length ? data.slots.map((slot) => `<option value="${slot.time}">${displayTime(slot.time)} - ${slot.staff.length} team members available</option>`).join('') : '<option value="">No open time on this date</option>';
  } catch (error) { $('#manageTime').innerHTML = `<option value="">${escapeHtml(error.message)}</option>`; }
});

function ensurePartnerCategoryFields() {
  if ($('#partnerBusinessCategory')) return;
  const fields = $('#authCreateFields');
  const businessName = $('#adminLogin [name="businessName"]')?.closest('label');
  if (!fields || !businessName) return;
  const categoryLabel = document.createElement('label');
  categoryLabel.textContent = 'Business category';
  const categorySelect = document.createElement('select');
  categorySelect.id = 'partnerBusinessCategory';
  categorySelect.name = 'categoryId';
  categorySelect.required = true;
  categorySelect.setAttribute('aria-label', 'Business category');
  categoryLabel.append(categorySelect);
  const categoryHelp = document.createElement('small');
  categoryHelp.className = 'field-help';
  categoryHelp.textContent = 'Choose the closest match. Some categories may need additional verification.';
  categoryLabel.append(categoryHelp);

  const subcategoryLabel = document.createElement('label');
  subcategoryLabel.textContent = 'Business type';
  const subcategorySelect = document.createElement('select');
  subcategorySelect.id = 'partnerBusinessSubcategory';
  subcategorySelect.name = 'subcategoryId';
  subcategorySelect.required = true;
  subcategorySelect.setAttribute('aria-label', 'Business type');
  subcategoryLabel.append(subcategorySelect);
  fields.insertBefore(categoryLabel, businessName);
  fields.insertBefore(subcategoryLabel, businessName);
  categorySelect.addEventListener('change', renderPartnerSubcategories);
}

function renderPartnerSubcategories() {
  const categorySelect = $('#partnerBusinessCategory');
  const subcategorySelect = $('#partnerBusinessSubcategory');
  if (!categorySelect || !subcategorySelect) return;
  const selectedCategory = partnerCategories.find((category) => category.id === categorySelect.value);
  const subcategories = selectedCategory?.subcategories || [];
  subcategorySelect.replaceChildren(new Option(subcategories.length ? 'Choose a business type' : 'No separate type available', ''));
  for (const subcategory of subcategories) subcategorySelect.add(new Option(subcategory.name, subcategory.id));
  subcategorySelect.disabled = !subcategories.length;
  subcategorySelect.required = subcategories.length > 0 && authMode === 'register';
}

async function loadPartnerCategories() {
  ensurePartnerCategoryFields();
  if (partnerCategoryLoadPromise) return partnerCategoryLoadPromise;
  partnerCategoryLoadPromise = (async () => {
    const categories = await api('/api/public/categories');
    if (!Array.isArray(categories)) throw new Error('Business categories could not be loaded. Refresh the page and try again.');
    partnerCategories = categories;
    const categorySelect = $('#partnerBusinessCategory');
    if (!categorySelect) return;
    const selected = categorySelect.value;
    categorySelect.replaceChildren(new Option('Choose a business category', ''));
    for (const category of partnerCategories) categorySelect.add(new Option(category.name, category.id));
    categorySelect.value = partnerCategories.some((category) => category.id === selected) ? selected : '';
    renderPartnerSubcategories();
  })().catch((error) => { partnerCategoryLoadPromise = null; throw error; });
  return partnerCategoryLoadPromise;
}

function openAdmin(create = false) { $('#adminShell').hidden = false; document.body.style.overflow = 'hidden'; addingOrganization = Boolean(create && sessionStorage.getItem(tokenKey)); ensurePartnerCategoryFields(); setAuthMode(create ? 'register' : 'login'); const categorySelect = $('#partnerBusinessCategory'); if (categorySelect) categorySelect.required = authMode === 'register'; renderPartnerSubcategories(); if (create) loadPartnerCategories().catch((error) => showMessage($('#adminMessage'), error.message, true)); if (sessionStorage.getItem(tokenKey) && !addingOrganization) resumeSession(); }
function closeAdmin() { document.body.style.overflow = ''; navigate('/'); }
function setAuthMode(mode) {
  authMode = mode;
  pendingPartnerChallengeId = '';
  if (mode !== 'register') sessionStorage.removeItem(partnerChallengeKey);
  $('#partnerPasswordResetPanel').hidden = true;
  $('#adminLogin').hidden = false;
  $('#partnerForgotPasswordButton').hidden = mode === 'register' || addingOrganization;
  $('#partnerVerifyPanel').hidden = true;
  $('#authSubmit').hidden = false;

  const creating = mode === 'register';
  $('#authEyebrow').textContent = addingOrganization ? 'ADD A SALON WORKSPACE' : creating ? 'SALON OWNER SIGNUP' : 'FORME PARTNER PORTAL';
  $('#authTitle').textContent = addingOrganization ? 'Add another salon.' : creating ? 'Create your salon account.' : 'Welcome back.';
  $('#authIntro').textContent = addingOrganization
    ? 'Add another salon and its first location to your owner account.'
    : creating
      ? 'Use an email you can open. We will send a 6-digit verification code there. Your mobile number is for salon contact.'
      : 'Sign in with your registered email and password. OTP is only needed to verify a new account or reset your password.';
  $('#authCreateFields').hidden = !creating;
  $('#ownerNameLabel').hidden = addingOrganization;
  $('#partnerPhoneLabel').hidden = addingOrganization;
  $('#adminLogin').querySelector('[name="name"]').required = creating && !addingOrganization;
  $('#adminLogin').querySelector('[name="phone"]').required = creating && !addingOrganization;
  $('#authToggle').hidden = addingOrganization;
  $('#adminLogin [name="email"]').required = !addingOrganization;
  $('#adminLogin [name="password"]').required = !addingOrganization;
  $('#adminLogin [name="password"]').minLength = addingOrganization ? 0 : 8;
  $('#adminLogin [name="email"]').closest('label').hidden = addingOrganization;
  $('#adminLogin [name="password"]').closest('label').hidden = addingOrganization;
  $('#authToggle').textContent = creating ? 'Already have an account? Sign in' : 'New to FORME? Create a salon account';
  $('#authSubmit').textContent = addingOrganization ? 'Add another salon' : creating ? 'Create partner account' : 'Sign in to dashboard';
  $('#workspaceChooser').hidden = true;
  $('#adminLogin').querySelector('[name="country"]').required = creating;
  $('#adminLogin').querySelector('[name="timeZone"]').required = creating;
  $('#adminLogin').querySelector('[name="businessName"]').required = creating;
  $('#adminLogin').querySelector('[name="branchName"]').required = creating;
  showMessage($('#adminMessage'), '');
}
async function resumeSession() { try { const info = await api('/api/auth/me'); activeUser=info.user; activeWorkspace=info.workspace; organizations=info.organizations; await finishWorkspace(); } catch { sessionStorage.removeItem(tokenKey); } }
async function finishWorkspace() { $('#adminGate').hidden = true; $('#dashboard').hidden = false; $('#userAvatar').textContent = (activeUser?.name || 'F')[0].toUpperCase(); renderWorkspaceSelectors(); applyWorkspaceLocale(); const bookingUrl=`/salon/${encodeURIComponent(activeWorkspace.tenantSlug)}/booking?branch=${encodeURIComponent(activeWorkspace.branchId)}`; $('#studioBookingLink').href=bookingUrl; $('#studioNewBookingLink').href=bookingUrl; const route=resolveRoute(); if(route.name!=='studio') navigate('/studio/overview'); else enterDashboard(); }
function applyWorkspaceLocale() { const org=organizations.find(o=>o.id===activeWorkspace?.tenantId); const branch=org?.branches.find(b=>b.id===activeWorkspace?.branchId); if(!branch)return; currentCurrency=branch.currency||'INR';currentTimeZone=branch.timeZone||'Etc/UTC';currentLocale=({INR:'en-IN',USD:'en-US',GBP:'en-GB',EUR:'en-IE',AED:'en-AE',SGD:'en-SG',CAD:'en-CA',AUD:'en-AU'})[currentCurrency]||'en'; $('#dateInput').value=localDate();$('#manageDate').value=localDate(); }
function renderWorkspaceSelectors() { const org=$('#orgSelector'), branch=$('#branchSelector'); if (!org || !branch || !activeWorkspace) return; org.innerHTML=organizations.map(o=>`<option value="${escapeHtml(o.id)}" ${o.id===activeWorkspace.tenantId?'selected':''}>${escapeHtml(o.name)}</option>`).join(''); const selected=organizations.find(o=>o.id===activeWorkspace.tenantId); branch.innerHTML=(selected?.branches||[]).map(b=>`<option value="${escapeHtml(b.id)}" ${b.id===activeWorkspace.branchId?'selected':''}>${escapeHtml(b.name)}${b.city?` · ${escapeHtml(b.city)}`:''}</option>`).join(''); }
async function changeWorkspace(tenantId, branchId) { const org=organizations.find(o=>o.id===tenantId); const branch=(org?.branches||[]).find(b=>b.id===branchId); if(!branch)return; try { const result=await api('/api/auth/switch-context',{method:'POST',body:JSON.stringify({tenantId,branchId})}); sessionStorage.setItem(tokenKey,result.sessionToken); activeWorkspace=result.workspace; await resumeSession(); notify(`Switched to ${branch.name}.`); } catch(e){ notify(e.message,true); renderWorkspaceSelectors(); } }

$('#adminClose').addEventListener('click', closeAdmin); $('#adminShell').addEventListener('click', (e) => { if (e.target === $('#adminShell')) closeAdmin(); });
$('#authToggle').addEventListener('click', () => navigate(authMode === 'login' ? '/partner/signup' : '/partner/login'));
$('#partnerForgotPasswordButton').addEventListener('click', () => {
  pendingPartnerResetChallengeId = ''; sessionStorage.removeItem(partnerResetChallengeKey);
  const email = $('#adminLogin [name="email"]').value.trim(); if (email) $('#partnerResetEmail').value = email;
  $('#adminLogin').hidden = true; $('#authToggle').hidden = true; $('#workspaceChooser').hidden = true; $('#partnerPasswordResetPanel').hidden = false;
  $('#partnerResetRequestPane').hidden = false; $('#partnerResetCompletePane').hidden = true; $('#authEyebrow').textContent = 'ACCOUNT RECOVERY'; $('#authTitle').textContent = 'Reset your password.'; $('#authIntro').textContent = 'Enter the email you use to sign in. We will send a 6-digit code if an account matches.'; showMessage($('#partnerResetMessage'), '');
});
$('#partnerResetRequestButton').addEventListener('click', async () => {
  const button = $('#partnerResetRequestButton'); button.disabled = true;
  try {
    const email = $('#partnerResetEmail').value.trim(); const result = await api('/api/auth/password-reset/start', { method: 'POST', body: JSON.stringify({ email }) });
    pendingPartnerResetChallengeId = result.challengeId; sessionStorage.setItem(partnerResetChallengeKey, JSON.stringify({ challengeId: result.challengeId, email, expiresAt: Date.now() + result.expiresInSeconds * 1000 }));
    $('#partnerResetRequestPane').hidden = true; $('#partnerResetCompletePane').hidden = false; showMessage($('#partnerResetMessage'), 'If the account exists, a code was sent to its email. Check your inbox and spam folder.');
  } catch (error) { showMessage($('#partnerResetMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('#partnerResetCompleteButton').addEventListener('click', async () => {
  const code = $('#partnerResetCode').value.trim(); const password = $('#partnerResetPassword').value; const confirmation = $('#partnerResetPasswordConfirm').value;
  if (!/^\d{6}$/.test(code)) return showMessage($('#partnerResetMessage'), 'Enter the 6-digit OTP sent to your email.', true);
  if (password.length < 8 || password.length > 128) return showMessage($('#partnerResetMessage'), 'Use a password with at least 8 characters.', true);
  if (password !== confirmation) return showMessage($('#partnerResetMessage'), 'The passwords do not match.', true);
  const button = $('#partnerResetCompleteButton'); button.disabled = true;
  try {
    await api('/api/auth/password-reset/complete', { method: 'POST', body: JSON.stringify({ challengeId: pendingPartnerResetChallengeId, emailCode: code, password }) });
    sessionStorage.removeItem(partnerResetChallengeKey); pendingPartnerResetChallengeId = ''; $('#adminLogin [name="email"]').value = $('#partnerResetEmail').value.trim(); $('#adminLogin [name="password"]').value = ''; $('#partnerResetCode').value = ''; $('#partnerResetPassword').value = ''; $('#partnerResetPasswordConfirm').value = '';
    $('#partnerPasswordResetPanel').hidden = true; $('#adminLogin').hidden = false; setAuthMode('login'); showMessage($('#adminMessage'), 'Password updated. Sign in with your new password.');
  } catch (error) { showMessage($('#partnerResetMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('#partnerResetBackButton').addEventListener('click', () => { sessionStorage.removeItem(partnerResetChallengeKey); pendingPartnerResetChallengeId = ''; $('#partnerPasswordResetPanel').hidden = true; $('#adminLogin').hidden = false; setAuthMode('login'); });
$('#adminLogout').addEventListener('click', () => { sessionStorage.removeItem(tokenKey); activeUser=null;activeWorkspace=null; $('#dashboard').hidden=true;$('#adminGate').hidden=false;$('#adminLogin').reset();setAuthMode('login');showMessage($('#adminMessage'),'You’re signed out.'); });
$('#adminLogin').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form));
  const submitButton = $('#authSubmit'); const originalLabel = submitButton.textContent;
  submitButton.disabled = true; submitButton.setAttribute('aria-busy', 'true');
  submitButton.textContent = authMode === 'register' ? 'Sending verification code…' : 'Signing in…';
  showMessage($('#adminMessage'), authMode === 'register' ? 'Sending an email verification code…' : 'Checking your sign-in details…');
  try {
    if (authMode === 'register') {
      if (addingOrganization) {
        const result = await api('/api/auth/create-organization', { method: 'POST', body: JSON.stringify(payload) });
        sessionStorage.setItem(tokenKey, result.sessionToken); activeWorkspace = result.workspace;
        const info = await api('/api/auth/me'); activeUser = info.user; organizations = info.organizations; addingOrganization = false; await finishWorkspace(); return;
      }
      const challenge = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
      pendingPartnerChallengeId = challenge.challengeId; $('#partnerOtpDestinations').textContent = challenge.emailHint;
      sessionStorage.setItem(partnerChallengeKey, JSON.stringify({ challengeId: challenge.challengeId, emailHint: challenge.emailHint, expiresAt: Date.now() + challenge.expiresInSeconds * 1000 }));
      $('#authCreateFields').hidden = true; $('#authSubmit').hidden = true; $('#authToggle').hidden = true; $('#partnerVerifyPanel').hidden = false;
      showMessage($('#adminMessage'), 'Email OTP sent. Enter it to verify your owner account.'); return;
    }
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: payload.email, password: payload.password }) });
    activeUser = result.user; organizations = result.organizations; pendingLoginToken = result.loginToken;
    const choices = organizations.flatMap(o => o.branches.map(b => ({ tenantId: o.id, branchId: b.id, label: `${o.name} — ${b.name}${b.city ? `, ${b.city}` : ''}` })));
    if (choices.length === 1) {
      const selected = await api('/api/auth/select', { method: 'POST', body: JSON.stringify({ loginToken: pendingLoginToken, ...choices[0] }) });
      sessionStorage.setItem(tokenKey, selected.sessionToken); activeWorkspace = selected.workspace; organizations = selected.organizations; await finishWorkspace();
    } else {
      $('#workspaceChoice').innerHTML = choices.map((choice, index) => `<option value="${index}">${escapeHtml(choice.label)}</option>`).join('');
      $('#workspaceChoice').dataset.choices = JSON.stringify(choices);
      $('#adminLogin').hidden = true;
      $('#authToggle').hidden = true;
      $('#authEyebrow').textContent = 'SELECT A WORKSPACE';
      $('#authTitle').textContent = 'Choose a salon';
      $('#authIntro').textContent = 'Select the salon and location you want to manage.';
      $('#workspaceChooser').hidden = false;
      showMessage($('#workspaceMessage'), '');
    }
  } catch (error) { showMessage($('#adminMessage'), error.message, true); }
  finally { submitButton.disabled = false; submitButton.removeAttribute('aria-busy'); submitButton.textContent = originalLabel; }
});
$('#partnerVerifyButton').addEventListener('click', async () => {
  const emailCode = $('#partnerEmailCode').value.trim();
  if (!/^\d{6}$/.test(emailCode)) return showMessage($('#adminMessage'), 'Enter the 6-digit OTP from your email.', true);
  $('#partnerVerifyButton').disabled = true; showMessage($('#adminMessage'), 'Verifying your email OTP...');
  try {
    const result = await api('/api/auth/verify-registration', { method: 'POST', body: JSON.stringify({ challengeId: pendingPartnerChallengeId, emailCode }) });
    sessionStorage.removeItem(partnerChallengeKey); sessionStorage.setItem(tokenKey, result.sessionToken); activeUser = result.user; activeWorkspace = result.workspace; organizations = result.organizations; pendingPartnerChallengeId = ''; await finishWorkspace();
  } catch (error) { $('#partnerVerifyButton').disabled = false; showMessage($('#adminMessage'), error.message, true); }
});
$('#partnerRestartButton').addEventListener('click', () => { sessionStorage.removeItem(partnerChallengeKey); pendingPartnerChallengeId = ''; $('#partnerVerifyPanel').hidden = true; $('#authCreateFields').hidden = false; $('#authSubmit').hidden = false; $('#authToggle').hidden = false; $('#partnerEmailCode').value = ''; $('#partnerVerifyButton').disabled = false; showMessage($('#adminMessage'), 'Check your details, then request a fresh email OTP.'); });
$('#workspaceContinue').addEventListener('click', async () => {
  const button = $('#workspaceContinue');
  button.disabled = true;
  showMessage($('#workspaceMessage'), 'Opening your salon dashboard…');
  try {
    const choices = JSON.parse($('#workspaceChoice').dataset.choices || '[]');
    const choice = choices[Number($('#workspaceChoice').value)];
    if (!choice) throw new Error('Choose a salon location to continue.');
    const result = await api('/api/auth/select', { method: 'POST', body: JSON.stringify({ loginToken: pendingLoginToken, tenantId: choice.tenantId, branchId: choice.branchId }) });
    sessionStorage.setItem(tokenKey, result.sessionToken);
    activeWorkspace = result.workspace;
    organizations = result.organizations;
    await finishWorkspace();
  } catch (error) {
    showMessage($('#workspaceMessage'), error.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#workspaceBack').addEventListener('click', () => {
  pendingLoginToken = '';
  $('#workspaceChooser').hidden = true;
  $('#adminLogin').reset();
  setAuthMode('login');
});
$('#orgSelector').addEventListener('change',()=>{const org=organizations.find(o=>o.id===$('#orgSelector').value);if(org?.branches[0])changeWorkspace(org.id,org.branches[0].id);});$('#branchSelector').addEventListener('change',()=>changeWorkspace($('#orgSelector').value,$('#branchSelector').value));
$('#addOrganization').addEventListener('click',()=>openAdmin(true));
function enterDashboard() { $('#adminGate').hidden = true; $('#dashboard').hidden = false; showView('overview'); }
const titles = { overview: "Today\u0027s overview", appointments: 'Appointments', pos: 'Billing', customers: 'Customers', inventory: 'Products and stock', reports: 'Sales reports', team: 'Team and working hours', settings: 'Salon settings' };
function showView(view) {
  $$('.dash-view').forEach((node) => { node.hidden = node.id !== `view-${view}`; });
  $$('.dash-nav button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#viewTitle').textContent = titles[view] || 'Salon dashboard';
  const loaders = { overview: loadOverview, appointments: loadAppointments, pos: loadPos, customers: loadCustomers, inventory: loadInventory, reports: loadReports, team: loadTeam, settings: loadSettings };
  loaders[view]?.().catch((error) => notify(error.message, true));
}
$$('.dash-nav button').forEach((button) => button.addEventListener('click', () => navigate(`/studio/${button.dataset.view}`)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(`/studio/${button.dataset.go}`)));

async function loadOverview() {
  const [overview, products] = await Promise.all([api('/api/admin/overview'), api('/api/admin/products')]);
  $('#overviewMetrics').innerHTML = metric('Appointments today', overview.today, `${overview.upcoming} more appointments coming up`) + metric('Sales this month', money(overview.monthRevenue), 'Total payments recorded') + metric('Customers', overview.customers, 'Customer profiles') + metric('Low stock items', overview.lowStock, 'Items to reorder');
  const list = overview.appointments.slice().sort((a, b) => a.time.localeCompare(b.time));
  $('#todayList').innerHTML = list.length ? list.map((a) => `<div class="today-row"><span class="today-time">${escapeHtml(displayTime(a.time))}</span><div class="today-main"><strong>${escapeHtml(a.name)} · ${escapeHtml(a.serviceName)}</strong><small>${escapeHtml(a.staffName || 'Any stylist')} · ${escapeHtml(a.phone)}</small></div>${statusBadge(a.status)}</div>`).join('') : '<p class="empty-state">No appointments yet for today.</p>';
  const low = products.filter((p) => p.stock <= p.lowStockAt);
  $('#lowStockList').innerHTML = low.length ? low.map((p) => `<div class="stock-row"><div class="stock-main"><strong>${escapeHtml(p.name)}</strong><small>Reorder at ${p.lowStockAt} units</small></div><span class="stock-count">${p.stock} left</span></div>`).join('') : '<p class="empty-state">No products need reordering right now.</p>';
}
function metric(label, value, note) { return `<article class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-note">${escapeHtml(note)}</div></article>`; }

$('#appointmentDate').value = localDate();
$('#appointmentDate').addEventListener('change', () => loadAppointments().catch((e) => notify(e.message, true)));
$('#appointmentFilter').addEventListener('change', () => renderAppointments());
async function loadAppointments() {
  appointmentCache = await api(`/api/admin/appointments?date=${encodeURIComponent($('#appointmentDate').value || '')}`);
  renderAppointments();
}
function renderAppointments() {
  const filter = $('#appointmentFilter').value;
  const rows = appointmentCache.filter((a) => filter === 'all' || a.status === filter);
  $('#appointmentCount').textContent = `${rows.length} appointment${rows.length === 1 ? '' : 's'}`;
  $('#appointmentRows').innerHTML = rows.length ? rows.map((a) => `<tr><td><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.phone)} · Ref ${escapeHtml(a.reference)}${a.partySize > 1 ? `<br>Group guest ${a.groupIndex} of ${a.partySize}` : ''}${a.depositAmount?`<br>Advance ${moneyFor(a.depositAmount,a.depositCurrency)} · ${escapeHtml(a.paymentStatus||'due')}`:''}${a.depositForfeited?'<br>Booking advance not refunded (customer missed visit)':''}</small></td><td>${escapeHtml(a.serviceName)}<small>${money(a.price)} · ${a.minutes} min</small></td><td>${escapeHtml(a.staffName || 'No stylist selected')}</td><td>${escapeHtml(displayDate(a.date))}<small>${escapeHtml(displayTime(a.time))}</small></td><td>${statusBadge(a.status)}</td><td><select data-appointment-status="${escapeHtml(a.id)}"><option value="confirmed" ${a.status === 'confirmed' ? 'selected' : ''}>Confirmed</option><option value="arrived" ${a.status === 'arrived' ? 'selected' : ''}>Customer arrived</option><option value="in-service" ${a.status === 'in-service' ? 'selected' : ''}>Service in progress</option><option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completed</option><option value="no-show" ${a.status === 'no-show' ? 'selected' : ''}>Did not arrive</option><option value="cancelled" ${a.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select><button class="action-button" data-download-appointment="${escapeHtml(a.id)}">Calendar file</button></td></tr>`).join('') : '<tr><td colspan="6"><p class="empty-state">No appointments match this date and filter. Try another date or filter.</p></td></tr>';
  $$('[data-appointment-status]').forEach((select) => select.addEventListener('change', async () => { try { await api(`/api/admin/appointments/${encodeURIComponent(select.dataset.appointmentStatus)}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); notify('Appointment status saved.'); await loadAppointments(); } catch (e) { notify(e.message, true); } }));
  $$('[data-download-appointment]').forEach((button) => button.addEventListener('click', () => { const item = rows.find((a) => a.id === button.dataset.downloadAppointment); if (item) downloadICS([item], `booking-${item.reference}.ics`); }));
}
function downloadICS(appointments, filename) {
  const entries = appointments.filter((a) => a.status !== 'cancelled').map((a) => { const start = `${a.date.replaceAll('-', '')}T${a.time.replace(':', '')}00`; const endMins = Number(a.time.slice(0, 2)) * 60 + Number(a.time.slice(3)) + (a.minutes || 30); const end = `${a.date.replaceAll('-', '')}T${String(Math.floor(endMins / 60)).padStart(2, '0')}${String(endMins % 60).padStart(2, '0')}00`; return `BEGIN:VEVENT\r\nUID:${a.id}@forme.local\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${a.serviceName} — ${a.name}\r\nDESCRIPTION:Booking ${a.reference} with ${a.staffName}\r\nEND:VEVENT`; });
  const blob = new Blob([`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FORME//Barber Studio//EN\r\n${entries.join('\r\n')}\r\nEND:VCALENDAR`], { type: 'text/calendar' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}
$('#exportCalendar').addEventListener('click', () => downloadICS(appointmentCache, `forme-${$('#appointmentDate').value}.ics`));

async function loadPos() {
  const [serviceList, products, customers] = await Promise.all([api('/api/admin/services'), api('/api/admin/products'), api('/api/admin/customers')]);
  adminData.services = serviceList.filter((s) => s.active); adminData.products = products.filter((p) => p.active); adminData.customers = customers;
  $('#posCustomer').innerHTML = '<option value="">Walk-in customer (not selected)</option>' + customers.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} · ${escapeHtml(c.phone)} (${c.points || 0} points)</option>`).join('');
  renderPosItems(); renderCart();
}
function posCatalog() { return [...adminData.services.map((s) => ({ ...s, type: 'service' })), ...adminData.products.map((p) => ({ ...p, type: 'product', minutes: null }))]; }
function renderPosItems() {
  const query = $('#posSearch').value.trim().toLowerCase();
  const items = posCatalog().filter((item) => (posType === 'all' || item.type === posType) && (!query || `${item.name} ${item.category} ${item.sku || ''}`.toLowerCase().includes(query)) && (item.type !== 'product' || item.stock > 0));
  $('#posItems').innerHTML = items.length ? items.map((item) => `<button class="pos-item" data-pos-type-item="${item.type}" data-pos-id="${escapeHtml(item.id)}"><span class="eyebrow">${escapeHtml(item.type === 'service' ? `${item.minutes} MIN · ${item.category}` : `${item.category} · ${item.stock} in stock`)}</span><strong>${escapeHtml(item.name)}</strong><small>${money(item.price)} · Add to bill</small></button>`).join('') : '<p class="empty-state">No services or products match your search.</p>';
  $$('.pos-item').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.posTypeItem, button.dataset.posId)));
}
function addToCart(type, id) { const item = posCatalog().find((x) => x.type === type && x.id === id); if (!item) return; const line = cart.find((x) => x.type === type && x.id === id); if (line) line.quantity += 1; else cart.push({ type, id, name: item.name, price: item.price, quantity: 1, stock: item.stock }); renderCart(); }
function renderCart() {
  $('#cartItems').innerHTML = cart.length ? cart.map((line, i) => `<div class="cart-line"><div><strong>${escapeHtml(line.name)}</strong><small>${money(line.price)} × ${line.quantity} · ${line.type}</small></div><div class="cart-line-actions"><button data-cart-minus="${i}" aria-label="Remove one">−</button><button data-cart-plus="${i}" aria-label="Add one">+</button></div></div>`).join('') : '<p class="empty-state">Select a service or product to add it to this bill.</p>';
  const subtotal = cart.reduce((n, line) => n + line.price * line.quantity, 0);
  const customer = adminData.customers.find((c) => c.id === $('#posCustomer').value);
  const points = Number($('#redeemPoints').value) || 0;
  const discount = Math.min(subtotal, (Number($('#posDiscount').value) || 0) + points * 0.5);
  $('#cartTotal').textContent = money(Math.max(0, subtotal - discount));
  $('#loyaltyHint').textContent = customer ? `${customer.points || 0} points available. Every 100 points gives ${money(50)} off.` : `Select a customer to see their points. Every 100 points gives ${money(50)} off.`;
  $('#redeemPoints').max = customer?.points || 0;
  $$('[data-cart-minus]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.cartMinus); cart[i].quantity -= 1; if (cart[i].quantity <= 0) cart.splice(i, 1); renderCart(); }));
  $$('[data-cart-plus]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.cartPlus); cart[i].quantity += 1; renderCart(); }));
}
$('#posSearch').addEventListener('input', renderPosItems);
$('#posSearch').addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; const sku = $('#posSearch').value.trim().toLowerCase(); const product = adminData.products.find((p) => p.active && p.stock > 0 && p.sku && p.sku.toLowerCase() === sku); if (!product) return; event.preventDefault(); addToCart('product', product.id); $('#posSearch').value = ''; renderPosItems(); notify(`${product.name} added to the bill.`); });
$$('[data-pos-type]').forEach((button) => button.addEventListener('click', () => { posType = button.dataset.posType; $$('[data-pos-type]').forEach((b) => b.classList.toggle('active', b === button)); renderPosItems(); }));
$('#posCustomer').addEventListener('change', () => { $('#redeemPoints').value = 0; renderCart(); });
$('#posDiscount').addEventListener('input', renderCart); $('#redeemPoints').addEventListener('input', renderCart);
$('#clearCart').addEventListener('click', () => { cart = []; renderCart(); showMessage($('#posMessage'), ''); });
function createReceiptMarkup(order) {
  const workspace = activeWorkspace || {}; const branch = [workspace.branchName, workspace.city, workspace.country].filter(Boolean).join(', ');
  const issuedAt = new Date(order.createdAt).toLocaleString(currentLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: currentTimeZone });
  const rows = (order.items || []).map((item) => `<tr><td class="receipt-item"><strong>${escapeHtml(item.name)}</strong><small>${item.type === 'product' ? 'Retail product' : 'Salon service'}</small></td><td class="receipt-number">${Number(item.quantity) || 0}</td><td class="receipt-number">${money(item.unitPrice)}</td><td class="receipt-number">${money(item.lineTotal)}</td></tr>`).join('');
  return `<article class="salon-receipt"><header class="salon-receipt-header"><span class="receipt-brand">FORME</span><h2>${escapeHtml(workspace.tenantName || 'Salon')}</h2>${branch ? `<p>${escapeHtml(branch)}</p>` : ''}<strong class="receipt-title">PAYMENT RECEIPT</strong></header><div class="receipt-meta"><div><span>Bill number</span><strong>${escapeHtml(order.receipt)}</strong></div><div><span>Date and time</span><strong>${escapeHtml(issuedAt)}</strong></div><div><span>Customer</span><strong>${escapeHtml(order.customerName || 'Walk-in')}</strong></div>${order.phone ? `<div><span>Mobile</span><strong>${escapeHtml(order.phone)}</strong></div>` : ''}${order.appointmentReference ? `<div><span>Booking reference</span><strong>${escapeHtml(order.appointmentReference)}</strong></div>` : ''}</div><table class="salon-receipt-items"><thead><tr><th>ITEM</th><th>QTY</th><th>RATE</th><th>AMOUNT</th></tr></thead><tbody>${rows}</tbody></table><div class="receipt-totals"><div><span>Subtotal</span><strong>${money(order.subtotal)}</strong></div>${Number(order.discount) > 0 ? `<div><span>Discount / points</span><strong>−${money(order.discount)}</strong></div>` : ''}${Number(order.depositCredit) > 0 ? `<div><span>Booking advance used</span><strong>−${money(order.depositCredit)}</strong></div>` : ''}<div class="receipt-grand-total"><span>Total paid</span><strong>${money(order.total)}</strong></div></div><div class="receipt-payment"><span>Payment method</span><strong>${escapeHtml(String(order.paymentMethod || '').toUpperCase())} · PAID</strong></div>${Number(order.pointsEarned) > 0 ? `<p class="receipt-loyalty">${Number(order.pointsEarned)} loyalty points earned. Thank you!</p>` : ''}<footer class="salon-receipt-footer">Thank you for visiting. We look forward to seeing you again.</footer></article>`;
}
$('#checkoutButton').addEventListener('click', async () => {
  if (!cart.length) { showMessage($('#posMessage'), 'Add a service or product before recording payment.', true); return; }
  const button = $('#checkoutButton'); button.disabled = true;
  const customer = adminData.customers.find((c) => c.id === $('#posCustomer').value);
  showMessage($('#posMessage'), 'Recording payment...');
  try {
    const order = await api('/api/admin/orders', { method: 'POST', body: JSON.stringify({ items: cart.map((line) => ({ type: line.type, id: line.id, quantity: line.quantity })), phone: customer?.phone || '', customerName: customer?.name || '', appointmentReference: $('#posAppointmentReference').value.trim(), paymentMethod: $('#paymentMethod').value, discount: Number($('#posDiscount').value) || 0, redeemPoints: Number($('#redeemPoints').value) || 0 }) });
    $('#receiptPanel').hidden = false;
    const receiptMarkup = createReceiptMarkup(order); const printNode = $('#printReceipt'); printNode.innerHTML = receiptMarkup;
    $('#receiptPanel').innerHTML = `<div class="receipt-preview-head"><div><span class="eyebrow">PAYMENT SAVED</span><h2>Bill is ready</h2><p>Receipt ${escapeHtml(order.receipt)} · ${money(order.total)} paid</p></div><button class="button button-dark" id="printReceiptButton" type="button">Print bill</button></div><div class="receipt-preview-paper">${receiptMarkup}</div>`;
    $('#printReceiptButton').addEventListener('click', () => { printNode.hidden = false; window.addEventListener('afterprint', () => { printNode.hidden = true; }, { once: true }); window.print(); });
    cart = []; $('#posDiscount').value = 0; $('#redeemPoints').value = 0; $('#posAppointmentReference').value = ''; showMessage($('#posMessage'), `Payment recorded. Stock and customer points updated.${order.depositCredit ? ` ${money(order.depositCredit)} booking advance applied.` : ''}`); await loadPos();
  } catch (error) { showMessage($('#posMessage'), error.message, true); }
  finally { button.disabled = false; }
});

$('#customerSearch').addEventListener('input', () => loadCustomers().catch((e) => notify(e.message, true)));
async function loadCustomers() {
  const customers = await api(`/api/admin/customers?q=${encodeURIComponent($('#customerSearch').value || '')}`);
  adminData.customers = customers;
  $('#customerRows').innerHTML = customers.length ? customers.map((c) => `<tr><td><strong>${escapeHtml(c.name)}</strong></td><td>${escapeHtml(c.phone)}</td><td>${c.visits || 0}</td><td>${c.points || 0} pts</td><td>${escapeHtml(c.lastVisit || '—')}</td><td>${money(c.lifetimeSpend)}</td><td><button class="action-button" data-customer-notes="${escapeHtml(c.id)}">${c.notes ? 'View / edit' : 'Add note'}</button></td></tr>`).join('') : '<tr><td colspan="7"><p class="empty-state">Customers are added automatically when they book or check out.</p></td></tr>';
  $$('[data-customer-notes]').forEach((button) => button.addEventListener('click', async () => { const customer = customers.find((c) => c.id === button.dataset.customerNotes); const notes = prompt(`Staff-only note about ${customer.name}:`, customer.notes || ''); if (notes === null) return; try { await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, { method: 'PATCH', body: JSON.stringify({ notes }) }); notify('Customer note saved.'); await loadCustomers(); } catch (e) { notify(e.message, true); } }));
}

function productStockStatus(product) {
  const stock = Number(product.stock) || 0; const reorderAt = Number(product.lowStockAt) || 0;
  if (stock <= 0) return { key: 'out', label: 'Out of stock', className: 'out' };
  if (stock <= reorderAt) return { key: 'low', label: 'Needs reorder', className: 'low' };
  return { key: 'available', label: 'In stock', className: 'available' };
}
function productStockMarkup(product) {
  const stock = Number(product.stock) || 0; const reorderAt = Number(product.lowStockAt) || 0; const status = productStockStatus(product);
  const width = reorderAt > 0 ? Math.min(100, Math.round(stock / reorderAt * 100)) : (stock > 0 ? 100 : 0);
  return `<span class="stock-status-pill ${status.className}">${status.label}</span><div class="stock-level-line"><div class="stock-bar ${status.className}"><span style="width:${width}%"></span></div><small>Alert at ${reorderAt} units</small></div>`;
}
function renderInventoryProducts() {
  const products = adminData.products;
  const query = ($('#inventorySearch').value || '').trim().toLocaleLowerCase('en-IN');
  const filter = $('#inventoryFilter').value;
  const filtered = products.filter((product) => {
    const status = productStockStatus(product).key;
    const matchesFilter = filter === 'all' || (filter === 'low' && status !== 'available') || status === filter;
    const searchable = `${product.name || ''} ${product.category || ''} ${product.sku || ''}`.toLocaleLowerCase('en-IN');
    return matchesFilter && (!query || searchable.includes(query));
  });
  $('#inventoryResultCount').textContent = `Showing ${filtered.length} of ${products.length} ${products.length === 1 ? 'product' : 'products'}`;
  if (!filtered.length) {
    const message = products.length ? 'No products match this search or stock filter.' : 'No products added yet. Add your first product to start tracking stock.';
    $('#productRows').innerHTML = `<tr><td colspan="7"><p class="empty-state">${message}</p></td></tr>`;
    $('#productCards').innerHTML = `<div class="inventory-empty"><span class="inventory-empty-icon">▤</span><strong>${message}</strong>${products.length ? '' : '<button class="button button-dark" data-open-product type="button">+ Add your first product</button>'}</div>`;
    return;
  }
  $('#productRows').innerHTML = filtered.map((p) => `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td>${escapeHtml(p.category || 'General')}</td><td>${escapeHtml(p.sku || '—')}</td><td>${money(p.price)}</td><td><strong class="inventory-quantity">${Number(p.stock) || 0}</strong></td><td>${productStockMarkup(p)}</td><td><button class="action-button" data-receive-stock="${escapeHtml(p.id)}">Receive stock</button></td></tr>`).join('');
  $('#productCards').innerHTML = filtered.map((p) => `<article class="inventory-product-card"><div class="inventory-product-card-head"><div><span class="eyebrow">${escapeHtml(p.category || 'General')}</span><h3>${escapeHtml(p.name)}</h3></div><strong class="inventory-card-price">${money(p.price)}</strong></div><div class="inventory-card-meta"><span>${p.sku ? `Code: ${escapeHtml(p.sku)}` : 'No product code'}</span><span><strong>${Number(p.stock) || 0}</strong> units on hand</span></div><div class="inventory-card-stock">${productStockMarkup(p)}</div><button class="button button-outline" data-receive-stock="${escapeHtml(p.id)}" type="button">+ Receive stock</button></article>`).join('');
  $$('[data-receive-stock]').forEach((button) => button.addEventListener('click', () => openReceiveDialog(button.dataset.receiveStock)));
}
function openProductDialog() {
  const form = $('#productForm'); form.reset(); showMessage($('#productMessage'), ''); $('#productDialog').showModal(); form.elements.name.focus();
}
function openReceiveDialog(productId) {
  const product = adminData.products.find((item) => item.id === productId); if (!product) return;
  const form = $('#receiveForm'); form.reset(); form.elements.productId.value = product.id; form.elements.quantity.value = 1;
  $('#receiveProductName').textContent = product.name; $('#receiveProductStock').textContent = Number(product.stock) || 0; showMessage($('#receiveMessage'), '');
  $('#receiveDialog').showModal(); form.elements.quantity.focus();
}
async function loadInventory() {
  const [products, movements, purchases] = await Promise.all([api('/api/admin/products'), api('/api/admin/movements'), api('/api/admin/purchases')]);
  adminData.products = products;
  const stockValue = products.reduce((n, p) => n + (Number(p.stock) || 0) * (Number(p.price) || 0), 0);
  const alerts = products.filter((p) => (Number(p.stock) || 0) <= (Number(p.lowStockAt) || 0)).length;
  $('#inventoryMetrics').innerHTML = metric('Products', products.length, 'Retail items in this salon') + metric('Retail stock value', money(stockValue), 'Uses listed selling prices') + metric('Needs reorder', alerts, 'Includes products at zero') + metric('Stock updates', movements.length, 'Sales, deliveries and opening stock');
  const activeProducts = products.filter((p) => p.active);
  $('#purchaseProduct').innerHTML = activeProducts.length ? '<option value="" disabled selected>Choose a product</option>' + activeProducts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${Number(p.stock) || 0} in stock</option>`).join('') : '<option value="">Add a product first</option>';
  $('#purchaseSubmit').disabled = activeProducts.length === 0;
  renderInventoryProducts();
  $('#movementRows').innerHTML = movements.length ? movements.slice(0, 20).map((m) => { const movementLabels = { initial: 'Opening stock', received: 'Stock received', purchase: 'Supplier delivery', sold: 'Sale' }; return `<div class="movement-row"><span><strong>${escapeHtml(m.productName)}</strong><small>${escapeHtml(m.note || 'Stock updated')} · ${new Date(m.createdAt).toLocaleString()}</small></span><span class="movement-quantity ${m.quantity < 0 ? 'negative' : ''}">${m.quantity > 0 ? '+' : ''}${Number(m.quantity) || 0}</span><span class="movement-type">${movementLabels[m.type] || escapeHtml(m.type)}</span></div>`; }).join('') : '<p class="empty-state">Stock activity will appear here after a product is added or sold.</p>';
  $('#purchaseRows').innerHTML = purchases.length ? purchases.map((p) => `<tr><td><strong>${escapeHtml(p.reference)}</strong></td><td>${escapeHtml(p.supplier)}</td><td>${escapeHtml(p.productName)}</td><td>${Number(p.quantity) || 0}</td><td>${money(p.total)}</td><td>${statusBadge(p.status)}</td><td>${p.status === 'ordered' ? `<button class="action-button" data-receive-purchase="${escapeHtml(p.id)}">Receive delivery</button>` : 'Stock received'}</td></tr>`).join('') : `<tr><td colspan="7"><p class="empty-state">${activeProducts.length ? 'Record a supplier order above. The stock count changes after you receive the delivery.' : 'Add a product before recording a supplier order.'}</p></td></tr>`;
  $$('[data-receive-purchase]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await api(`/api/admin/purchases/${encodeURIComponent(button.dataset.receivePurchase)}/receive`, { method: 'PATCH', body: '{}' }); notify('Delivery received and stock updated.'); await loadInventory(); } catch (e) { button.disabled = false; notify(e.message, true); } }));
}
$('#inventorySearch').addEventListener('input', renderInventoryProducts);
$('#inventoryFilter').addEventListener('change', renderInventoryProducts);
$('#addProduct').addEventListener('click', openProductDialog);
document.addEventListener('click', (event) => { const button = event.target.closest('[data-open-product]'); if (button) openProductDialog(); });
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('#productForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); const values = Object.fromEntries(new FormData(form));
  const payload = { ...values, price: Number(values.price), stock: Number(values.stock), lowStockAt: Number(values.lowStockAt) };
  button.disabled = true; button.textContent = 'Saving…';
  try { await api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) }); $('#productDialog').close(); notify('Product added to your stock list.'); await loadInventory(); }
  catch (error) { showMessage($('#productMessage'), error.message, true); }
  finally { button.disabled = false; button.textContent = 'Save product'; }
});
$('#receiveForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); const values = Object.fromEntries(new FormData(form));
  button.disabled = true; button.textContent = 'Updating…';
  try { await api(`/api/admin/products/${encodeURIComponent(values.productId)}/receive`, { method: 'POST', body: JSON.stringify({ quantity: Number(values.quantity), note: values.note || 'Supplier delivery' }) }); $('#receiveDialog').close(); notify('Received units added to stock.'); await loadInventory(); }
  catch (error) { showMessage($('#receiveMessage'), error.message, true); }
  finally { button.disabled = false; button.textContent = 'Add received units'; }
});
$('#purchaseForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const button = $('#purchaseSubmit'); button.disabled = true; button.textContent = 'Recording…'; try { await api('/api/admin/purchases', { method: 'POST', body: JSON.stringify(data) }); showMessage($('#purchaseMessage'), 'Order recorded. When it arrives, choose “Receive delivery” to add the units to stock.'); form.reset(); await loadInventory(); } catch (e) { showMessage($('#purchaseMessage'), e.message, true); } finally { button.disabled = adminData.products.filter((p) => p.active).length === 0; button.textContent = 'Record supplier order'; } });

async function loadReports() {
  const [report, orders, overview] = await Promise.all([api('/api/admin/analytics'), api('/api/admin/orders'), api('/api/admin/overview')]);
  $('#reportMetrics').innerHTML = metric('Sales this month', money(report.monthRevenue), `${report.monthOrders} bills paid`) + metric('Average bill', money(report.averageTicket), 'Per completed bill') + metric('Customers', report.totalCustomers, 'From bookings and bills') + metric('Upcoming visits', overview.upcoming, 'Confirmed on the schedule');
  const max = Math.max(1, ...report.daily.map((d) => d.revenue));
  $('#revenueChart').innerHTML = report.daily.map((d) => `<div class="bar-column"><div class="bar-track"><span class="bar-value">${d.revenue ? money(d.revenue) : ''}</span><div class="bar-fill" style="height:${Math.max(2, d.revenue / max * 100)}%"></div></div><span class="bar-label">${new Date(`${d.date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}</span></div>`).join('');
  $('#serviceReport').innerHTML = report.serviceSales.length ? report.serviceSales.slice(0, 7).map((r) => `<div class="report-row"><span>${escapeHtml(r.name)}</span><strong>${money(r.revenue)}</strong></div>`).join('') : '<p class="empty-state">Service sales appear here after a bill is recorded.</p>';
  $('#orderRows').innerHTML = orders.length ? orders.slice(0, 20).map((o) => `<tr><td><strong>${escapeHtml(o.receipt)}</strong></td><td>${escapeHtml(o.customerName)}</td><td>${o.items.map((item) => `${escapeHtml(item.name)} ×${item.quantity}`).join(', ')}</td><td>${escapeHtml(o.paymentMethod.toUpperCase())}</td><td><strong>${money(o.total)}</strong></td><td>${new Date(o.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: currentTimeZone })}</td></tr>`).join('') : '<tr><td colspan="6"><p class="empty-state">Receipts appear here after you record a bill.</p></td></tr>';
}

async function loadTeam() {
  const members = await api('/api/admin/staff'); adminData.staff = members;
  $('#staffList').innerHTML = members.map((person) => `<div class="staff-card"><span class="staff-avatar">${escapeHtml(person.name.split(' ').map((p) => p[0]).join('').slice(0, 2))}</span><div><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.role)} · ${person.active ? 'Active' : 'Hidden'}</small></div><span class="staff-schedule">${escapeHtml(person.start)}–${escapeHtml(person.end)}<br>${person.days.length} days / week<br><button class="action-button" data-edit-staff="${escapeHtml(person.id)}">Edit hours</button></span></div>`).join('');
  if (!members.length) $('#staffList').innerHTML = '<p class="empty-state">No team members yet. Add your barbers and stylists so customers can choose a service provider.</p>';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#hoursSummary').innerHTML = days.map((day, i) => { const working = members.filter((m) => m.active && m.days.includes(i)); return `<div class="hours-row"><strong>${day}</strong><span>${working.length ? `${working.map((m) => `${m.start}–${m.end}`).join(' · ')} (${working.length} on team)` : 'Closed'}</span></div>`; }).join('');
  $$('[data-edit-staff]').forEach((button) => button.addEventListener('click', async () => { const member = members.find((m) => m.id === button.dataset.editStaff); const start = prompt(`Start time for ${member.name} (24-hour time, e.g. 09:30)`, member.start); if (start === null) return; const end = prompt('End time (24-hour time, e.g. 18:00)', member.end); if (end === null) return; try { await api(`/api/admin/staff/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: JSON.stringify({ start, end }) }); notify('Team hours updated.'); await loadTeam(); } catch (e) { notify(e.message, true); } }));
}
$('#addStaff').addEventListener('click', async () => { const name = prompt('Barber or stylist name'); if (!name) return; const role = prompt('Role (e.g. Barber or Stylist)', 'Barber') || 'Barber'; try { await api('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name, role }) }); notify('Team member added.'); await loadTeam(); } catch (e) { notify(e.message, true); } });

async function loadPortfolio(){const data=await api('/api/admin/portfolio');$('#portfolioMetrics').innerHTML=metric('Salon locations',data.branchCount,'Locations for this salon')+metric('Upcoming appointments',data.upcoming,'Bookings across all locations')+metric('Low stock items',data.lowStock,'Products to reorder across all locations');$('#portfolioBranches').innerHTML=data.branches.length?data.branches.map(b=>`<article class="branch-card"><div><strong>${escapeHtml(b.name)}</strong><span>${escapeHtml([b.city,b.country].filter(Boolean).join(', '))} · ${escapeHtml(b.currency)}</span></div><div><b>${b.upcoming}</b><small>appointments coming up</small></div><div><b>${moneyFor(b.monthRevenue,b.currency)}</b><small>sales this month</small></div><button class="text-button" data-pin-branch="${escapeHtml(b.id)}">${b.hasMapPin?'Update map pin':'Add map pin'}</button><button class="text-button" data-open-branch="${escapeHtml(b.id)}">Open dashboard</button></article>`).join(''):'<p class="empty-state">No locations added yet. Add a salon location above to manage its bookings and sales.</p>';$$('[data-open-branch]').forEach(button=>button.addEventListener('click',()=>changeWorkspace(activeWorkspace.tenantId,button.dataset.openBranch)));$$('[data-pin-branch]').forEach(button=>button.addEventListener('click',()=>captureBranchPin(button.dataset.pinBranch)));}
function captureBranchPin(branchId){if(!navigator.geolocation){notify('Location sharing is not available in this browser. Add the map pin manually.',true);return;}navigator.geolocation.getCurrentPosition(async position=>{try{await api(`/api/admin/branches/${encodeURIComponent(branchId)}/location`,{method:'PATCH',body:JSON.stringify({latitude:position.coords.latitude,longitude:position.coords.longitude})});notify('Salon location pin saved.');await loadPortfolio();}catch(e){notify(e.message,true);}},()=>notify('Could not get your location. Allow location access, or add the map pin manually.',true),{enableHighAccuracy:true,timeout:12000});}
function moneyFor(value,currency){try{return new Intl.NumberFormat(currency==='INR'?'en-IN':'en',{style:'currency',currency,maximumFractionDigits:0}).format(value||0)}catch{return `${currency} ${Math.round(value||0)}`}}
$('#branchForm').addEventListener('submit',async e=>{e.preventDefault();const payload=Object.fromEntries(new FormData(e.currentTarget));try{const branch=await api('/api/admin/branches',{method:'POST',body:JSON.stringify(payload)});const info=await api('/api/auth/me');organizations=info.organizations;renderWorkspaceSelectors();await changeWorkspace(activeWorkspace.tenantId,branch.id);e.currentTarget.reset();showMessage($('#branchMessage'),'Salon location added and opened.');}catch(error){showMessage($('#branchMessage'),error.message,true);}});
async function loadSettings() {
  const [settings, serviceList] = await Promise.all([api('/api/admin/settings'), api('/api/admin/services')]);
  loadPortfolio().catch(e=>notify(e.message,true));
  const form = $('#settingsForm'); form.elements.businessName.value = settings.businessName; form.elements.openingTime.value = settings.openingTime; form.elements.closingTime.value = settings.closingTime;
  $$('input[name="openDays"]', form).forEach((input) => { input.checked = settings.openDays.includes(Number(input.value)); });
  adminData.services = serviceList;
  $('#serviceRows').innerHTML = serviceList.map((s) => `<tr><td><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.description)}</small></td><td>${escapeHtml(s.category)}</td><td>${s.minutes} min</td><td>${money(s.price)}</td><td>${s.active ? 'Published' : 'Hidden'}</td><td><button class="action-button" data-edit-service="${escapeHtml(s.id)}">Edit</button> <button class="action-button" data-toggle-service="${escapeHtml(s.id)}">${s.active ? 'Hide' : 'Publish'}</button></td></tr>`).join('');
  $$('[data-edit-service]').forEach((button) => button.addEventListener('click', async () => { const service = serviceList.find((s) => s.id === button.dataset.editService); const name = prompt('Service name', service.name); if (!name) return; const price = Number(prompt('Price (₹)', service.price)); const duration = Number(prompt('Duration in minutes', service.minutes)); const category = prompt('Category (e.g. Hair, Beard, Skin)', service.category) || service.category; const description = prompt('Description', service.description) || ''; try { await api(`/api/admin/services/${encodeURIComponent(service.id)}`, { method: 'PATCH', body: JSON.stringify({ name, price, minutes: duration, category, description }) }); notify('Service updated.'); await loadSettings(); } catch (e) { notify(e.message, true); } }));
  $$('[data-toggle-service]').forEach((button) => button.addEventListener('click', async () => { const service = serviceList.find((s) => s.id === button.dataset.toggleService); try { await api(`/api/admin/services/${encodeURIComponent(service.id)}`, { method: 'PATCH', body: JSON.stringify({ active: !service.active }) }); notify('Service availability updated.'); await loadSettings(); } catch (e) { notify(e.message, true); } }));
}
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  const data = { businessName: form.elements.businessName.value, openingTime: form.elements.openingTime.value, closingTime: form.elements.closingTime.value, openDays: $$('input[name="openDays"]:checked', form).map((input) => Number(input.value)) };
  try { await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(data) }); showMessage($('#settingsMessage'), 'Salon hours and details saved.'); } catch (e) { showMessage($('#settingsMessage'), e.message, true); }
});
$('#addService').addEventListener('click', async () => { const name = prompt('Service name (e.g. haircut)'); if (!name) return; const price = Number(prompt('Price (₹)', '299')); const duration = Number(prompt('Service duration in minutes', '30')); const category = prompt('Category (e.g. Hair, Beard, Skin)', 'Hair') || 'Hair'; const description = prompt('Short description', '') || ''; try { await api('/api/admin/services', { method: 'POST', body: JSON.stringify({ name, price, minutes: duration, category, description }) }); notify('Service added and shown on your salon page.'); await loadSettings(); } catch (e) { notify(e.message, true); } });

let nearbyCoordinates = null;
async function loadSalonDirectory(query = '') {
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const city = $('#marketLocation')?.value.trim();
    if (city) params.set('city', city);
    if (nearbyCoordinates) { params.set('lat', nearbyCoordinates.latitude); params.set('lng', nearbyCoordinates.longitude); }
    const rows = await api(`/api/public/salons${params.size ? `?${params.toString()}` : ''}`);
    const sort = $('#salonSort')?.value;
    if (sort === 'rating') rows.sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0));
    if (sort === 'distance') rows.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    $('#salonGrid').innerHTML = rows.length ? rows.map(s => `<article class="salon-card"><span class="eyebrow">${escapeHtml(s.country || 'SALON')}${s.distanceKm !== null ? ` &middot; ${s.distanceKm} KM AWAY` : ''}</span><h3>${escapeHtml(s.name)}</h3><div class="salon-rating">${s.averageRating !== null ? `&#9733; ${s.averageRating} <span>(${s.ratingCount} review${s.ratingCount === 1 ? '' : 's'})</span>` : 'New &middot; no reviews yet'}</div><p>${escapeHtml(s.branchName)}${s.city ? ` &middot; ${escapeHtml(s.city)}` : ''}${s.country ? `, ${escapeHtml(s.country)}` : ''}</p><div><span>${escapeHtml(s.currency)}</span><a class="text-button" href="/salon/${encodeURIComponent(s.slug)}?branch=${encodeURIComponent(s.branchId)}">View &amp; book &rarr;</a></div></article>`).join('') : '<p class="empty-state">No listed locations match that search. Try another city or country.</p>';
  } catch (error) { $('#salonGrid').innerHTML = `<p class="loading">${escapeHtml(error.message)}</p>`; }
}
$('#useMyLocation').addEventListener('click',()=>{const status=$('#locationStatus');if(!navigator.geolocation){status.textContent='Location is not available in this browser. Search by city or country instead.';return;}status.textContent='Finding salons near you…';navigator.geolocation.getCurrentPosition(position=>{nearbyCoordinates={latitude:position.coords.latitude,longitude:position.coords.longitude};status.textContent='Nearby salons are sorted by distance from your current location.';loadSalonDirectory($('#salonSearch').value.trim());},error=>{status.textContent=error.code===1?'Location permission was declined. Search by city or country instead.':'Could not get your location. Search by city or country instead.';},{enableHighAccuracy:false,timeout:10000,maximumAge:300000});});
let salonSearchTimer;$('#salonSearch').addEventListener('input',e=>{clearTimeout(salonSearchTimer);salonSearchTimer=setTimeout(()=>loadSalonDirectory(e.target.value.trim()),220);});
$('#salonSort').addEventListener('change',()=>loadSalonDirectory($('#salonSearch').value.trim()));
$('#marketSearchForm').addEventListener('submit',event=>{event.preventDefault();const params=new URLSearchParams();const query=$('#marketQuery').value.trim();const city=$('#marketLocation').value.trim();if(query)params.set('q',query);if(city)params.set('city',city);navigate(`/salons${params.size?`?${params.toString()}`:''}`);});

function captureSalonLocation(formSelector){const form=$(formSelector);if(!navigator.geolocation){notify('Location sharing is not available in this browser. Add the map pin manually.',true);return;}navigator.geolocation.getCurrentPosition(position=>{form.elements.latitude.value=position.coords.latitude.toFixed(6);form.elements.longitude.value=position.coords.longitude.toFixed(6);notify('Salon map pin added.');},()=>notify('Could not get your location. Enter the map pin coordinates manually.',true),{enableHighAccuracy:true,timeout:12000});}
$('#captureSignupLocation').addEventListener('click',()=>captureSalonLocation('#adminLogin'));$('#captureBranchLocation').addEventListener('click',()=>captureSalonLocation('#branchForm'));
let customerAuthMode = 'login';
$$('[data-customer-mode]').forEach(button=>button.addEventListener('click',()=>{if(pendingCustomerChallengeId)return;customerAuthMode=button.dataset.customerMode;$('#customerLoginPane').hidden=customerAuthMode!=='login';$('#customerSignupPane').hidden=customerAuthMode!=='signup';$('#customerVerifyPane').hidden=true;$$('[data-customer-mode]').forEach(tab=>tab.classList.toggle('active',tab===button));const accountPage=resolveRoute().name==='account';$('#customerAuthPanel h3').textContent=customerAuthMode==='login'?(accountPage?'Sign in to view your bookings':'Sign in to book'):(accountPage?'Create an account to view your bookings':'Create an account to book');$('#customerAuthHelp').textContent=customerAuthMode==='login'?'Your account keeps bookings from different salons together.':'Enter an email address you can access. We will send an OTP there; your mobile number is collected for contact.';showMessage($('#customerAuthMessage'),'');}));
function setCustomerSession(customer){sessionStorage.setItem('salonCustomerToken',customer.customerToken||sessionStorage.getItem('salonCustomerToken'));$('#customerSignupButton').disabled=false;$('#customerVerifyButton').disabled=false;$('#customerAuthPanel').hidden=true;$('#customerSessionPanel').hidden=false;$('#customerGreeting').textContent=`Welcome, ${customer.name}`;$('#bookingForm').elements.name.value=customer.name;$('#bookingForm').elements.phone.value=customer.phone;showMessage($('#customerAuthMessage'),'');loadMyBookings().catch(error=>notify(error.message,true));}
async function restoreCustomerSession(){if(!sessionStorage.getItem('salonCustomerToken'))return;try{const result=await api('/api/customer/me');setCustomerSession(result.customer);}catch{sessionStorage.removeItem('salonCustomerToken');}}
$('#customerLoginButton').addEventListener('click',async()=>{try{const result=await api('/api/customer/login',{method:'POST',body:JSON.stringify({email:$('#customerLoginEmail').value,password:$('#customerLoginPassword').value})});sessionStorage.setItem('salonCustomerToken',result.customerToken);setCustomerSession(result.customer);}catch(error){showMessage($('#customerAuthMessage'),error.message,true);}});
$('#customerForgotPasswordButton').addEventListener('click', () => {
  pendingCustomerResetChallengeId = ''; sessionStorage.removeItem(customerResetChallengeKey);
  if ($('#customerLoginEmail').value.trim()) $('#customerResetEmail').value = $('#customerLoginEmail').value.trim();
  $('#customerAuthPanel').hidden = true; $('#customerPasswordResetPane').hidden = false; $('#customerResetRequestPane').hidden = false; $('#customerResetCompletePane').hidden = true; showMessage($('#customerResetMessage'), '');
});
$('#customerResetRequestButton').addEventListener('click', async () => {
  const button = $('#customerResetRequestButton'); button.disabled = true;
  try {
    const email = $('#customerResetEmail').value.trim(); const result = await api('/api/customer/password-reset/start', { method: 'POST', body: JSON.stringify({ email }) });
    pendingCustomerResetChallengeId = result.challengeId; sessionStorage.setItem(customerResetChallengeKey, JSON.stringify({ challengeId: result.challengeId, email, expiresAt: Date.now() + result.expiresInSeconds * 1000 }));
    $('#customerResetRequestPane').hidden = true; $('#customerResetCompletePane').hidden = false; showMessage($('#customerResetMessage'), 'If the account exists, a code was sent to its email. Check your inbox and spam folder.');
  } catch (error) { showMessage($('#customerResetMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('#customerResetCompleteButton').addEventListener('click', async () => {
  const code = $('#customerResetCode').value.trim(); const password = $('#customerResetPassword').value; const confirmation = $('#customerResetPasswordConfirm').value;
  if (!/^\d{6}$/.test(code)) return showMessage($('#customerResetMessage'), 'Enter the 6-digit OTP sent to your email.', true);
  if (password.length < 8 || password.length > 128) return showMessage($('#customerResetMessage'), 'Use a password with at least 8 characters.', true);
  if (password !== confirmation) return showMessage($('#customerResetMessage'), 'The passwords do not match.', true);
  const button = $('#customerResetCompleteButton'); button.disabled = true;
  try {
    await api('/api/customer/password-reset/complete', { method: 'POST', body: JSON.stringify({ challengeId: pendingCustomerResetChallengeId, emailCode: code, password }) });
    sessionStorage.removeItem(customerResetChallengeKey); pendingCustomerResetChallengeId = ''; $('#customerLoginEmail').value = $('#customerResetEmail').value.trim(); $('#customerLoginPassword').value = ''; $('#customerResetCode').value = ''; $('#customerResetPassword').value = ''; $('#customerResetPasswordConfirm').value = '';
    $('#customerPasswordResetPane').hidden = true; $('#customerAuthPanel').hidden = false; $('#customerLoginPane').hidden = false; $('#customerSignupPane').hidden = true; $('#customerVerifyPane').hidden = true; customerAuthMode = 'login'; $$('[data-customer-mode]').forEach(tab => { tab.disabled = false; tab.classList.toggle('active', tab.dataset.customerMode === 'login'); }); showMessage($('#customerAuthMessage'), 'Password updated. Sign in with your new password.');
  } catch (error) { showMessage($('#customerResetMessage'), error.message, true); }
  finally { button.disabled = false; }
});
$('#customerResetBackButton').addEventListener('click', () => {
  sessionStorage.removeItem(customerResetChallengeKey); pendingCustomerResetChallengeId = ''; $('#customerPasswordResetPane').hidden = true; $('#customerAuthPanel').hidden = false; $('#customerLoginPane').hidden = false; $('#customerSignupPane').hidden = true; $('#customerVerifyPane').hidden = true; customerAuthMode = 'login'; $$('[data-customer-mode]').forEach(tab => { tab.disabled = false; tab.classList.toggle('active', tab.dataset.customerMode === 'login'); }); showMessage($('#customerAuthMessage'), '');
});
$('#customerSignupButton').addEventListener('click', async () => {
  $('#customerSignupButton').disabled = true;
  try {
    const challenge = await api('/api/customer/register', { method: 'POST', body: JSON.stringify({ name: $('#customerSignupName').value, email: $('#customerSignupEmail').value, phone: $('#customerSignupPhone').value, password: $('#customerSignupPassword').value }) });
    pendingCustomerChallengeId = challenge.challengeId; $('#customerOtpDestinations').textContent = challenge.emailHint; sessionStorage.setItem(customerChallengeKey, JSON.stringify({ challengeId: challenge.challengeId, emailHint: challenge.emailHint, expiresAt: Date.now() + challenge.expiresInSeconds * 1000 })); $$('[data-customer-mode]').forEach(tab=>{tab.disabled=true;});
    $('#customerSignupPane').hidden = true; $('#customerVerifyPane').hidden = false; $('#customerEmailCode').focus();
    showMessage($('#customerAuthMessage'), 'Email OTP sent. Enter it to verify your account.');
  } catch (error) { $('#customerSignupButton').disabled = false; showMessage($('#customerAuthMessage'), error.message, true); }
});
$('#customerVerifyButton').addEventListener('click', async () => {
  const emailCode = $('#customerEmailCode').value.trim();
  if (!/^\d{6}$/.test(emailCode)) return showMessage($('#customerAuthMessage'), 'Enter the 6-digit OTP from your email.', true);
  $('#customerVerifyButton').disabled = true;
  try {
    const result = await api('/api/customer/verify-registration', { method: 'POST', body: JSON.stringify({ challengeId: pendingCustomerChallengeId, emailCode }) });
    sessionStorage.removeItem(customerChallengeKey); pendingCustomerChallengeId = ''; sessionStorage.setItem('salonCustomerToken', result.customerToken); setCustomerSession(result.customer);
  } catch (error) { $('#customerVerifyButton').disabled = false; showMessage($('#customerAuthMessage'), error.message, true); }
});
$('#customerRestartButton').addEventListener('click', () => { sessionStorage.removeItem(customerChallengeKey); pendingCustomerChallengeId = ''; $('#customerVerifyPane').hidden = true; $('#customerSignupPane').hidden = false; $('#customerEmailCode').value = ''; $('#customerVerifyButton').disabled = false; $('#customerSignupButton').disabled = false; $$('[data-customer-mode]').forEach(tab=>{tab.disabled=false;}); showMessage($('#customerAuthMessage'), 'Check your details, then request a fresh email OTP.'); });
$('#customerLogout').addEventListener('click',()=>{sessionStorage.removeItem('salonCustomerToken');sessionStorage.removeItem(customerChallengeKey);pendingCustomerChallengeId='';$('#customerSessionPanel').hidden=true;$('#customerAuthPanel').hidden=false;$('#customerVerifyPane').hidden=true;$('#customerSignupPane').hidden=true;$('#customerLoginPane').hidden=false;$$('[data-customer-mode]').forEach(tab=>{tab.disabled=false;tab.classList.toggle('active',tab.dataset.customerMode==='login');});customerAuthMode='login';$('#myBookings').innerHTML='';$('#bookingForm').elements.name.value='';$('#bookingForm').elements.phone.value='';showMessage($('#customerAuthMessage'),'You have signed out.');});
async function loadMyBookings(){if(!sessionStorage.getItem('salonCustomerToken'))return;const bookings=await api('/api/customer/bookings');$('#myBookings').innerHTML=bookings.length?`<span class="eyebrow">YOUR BOOKINGS</span>`+bookings.map(b=>`<article class="my-booking-row"><div><strong>${escapeHtml(b.salonName)} · ${escapeHtml(b.branchName)}</strong><small>${escapeHtml(b.serviceName)} with ${escapeHtml(b.staffName)}${b.partySize > 1 ? ` - Person ${b.groupIndex} of ${b.partySize}` : ''}</small><small>${escapeHtml(displayDate(b.date))} · ${escapeHtml(displayTime(b.time))} · ${escapeHtml(statusLabel(b.status))}</small></div><small>${b.depositForfeited?'Advance not refunded (missed appointment)':b.paymentStatus==='deposit_due'?'Advance payment due':b.depositAmount?`Advance: ${moneyFor(b.depositAmount,b.depositCurrency)}`:'No advance paid'}</small>${b.status==='completed'?`<button class="text-button" data-rate-reference="${escapeHtml(b.reference)}" data-salon-slug="${escapeHtml(b.salonSlug)}" data-branch-id="${escapeHtml(b.branchId)}">Rate visit</button>`:''}</article>`).join(''):'<p class="empty-state">Your salon bookings will appear here.</p>';
  $$('[data-rate-reference]').forEach(button=>button.addEventListener('click',async()=>{const rating=Number(prompt('Rate your visit: enter a whole number from 1 to 5 stars'));if(!Number.isInteger(rating)||rating<1||rating>5)return;const comment=prompt('Share a short review (optional)')||'';const previous={salon:publicContext.salon,branch:publicContext.branch};publicContext.salon=button.dataset.salonSlug;publicContext.branch=button.dataset.branchId;try{await api('/api/reviews',{method:'POST',body:JSON.stringify({reference:button.dataset.rateReference,rating,comment})});notify('Thanks for reviewing this salon.');await loadMyBookings();}catch(error){notify(error.message,true);}finally{publicContext=previous;}}));}
restoreCustomerSession();
renderRoute();
function restoreRegistrationChallenges() {
  const route = resolveRoute();
  try {
    const partnerReset = JSON.parse(sessionStorage.getItem(partnerResetChallengeKey) || 'null');
    if (partnerReset && partnerReset.expiresAt > Date.now() && route.name === 'partner-login') {
      pendingPartnerResetChallengeId = partnerReset.challengeId; $('#partnerResetEmail').value = partnerReset.email || ''; $('#adminLogin').hidden = true; $('#authToggle').hidden = true; $('#workspaceChooser').hidden = true; $('#partnerPasswordResetPanel').hidden = false; $('#partnerResetRequestPane').hidden = true; $('#partnerResetCompletePane').hidden = false; $('#authEyebrow').textContent = 'ACCOUNT RECOVERY'; $('#authTitle').textContent = 'Reset your password.'; $('#authIntro').textContent = 'Enter the email you use to sign in. We will send a 6-digit code if an account matches.'; showMessage($('#partnerResetMessage'), 'Enter the code from your email to continue.');
    } else if (partnerReset && partnerReset.expiresAt <= Date.now()) sessionStorage.removeItem(partnerResetChallengeKey);
    const customerReset = JSON.parse(sessionStorage.getItem(customerResetChallengeKey) || 'null');
    if (customerReset && customerReset.expiresAt > Date.now() && ['home', 'account', 'booking', 'salon'].includes(route.name)) {
      pendingCustomerResetChallengeId = customerReset.challengeId; $('#customerResetEmail').value = customerReset.email || ''; $('#customerAuthPanel').hidden = true; $('#customerPasswordResetPane').hidden = false; $('#customerResetRequestPane').hidden = true; $('#customerResetCompletePane').hidden = false; showMessage($('#customerResetMessage'), 'Enter the code from your email to continue.');
    } else if (customerReset && customerReset.expiresAt <= Date.now()) sessionStorage.removeItem(customerResetChallengeKey);
    const partner = JSON.parse(sessionStorage.getItem(partnerChallengeKey) || 'null');
    if (partner && partner.expiresAt > Date.now() && route.name === 'partner-signup') {
      pendingPartnerChallengeId = partner.challengeId; $('#partnerOtpDestinations').textContent = `${partner.emailHint}`; $('#authCreateFields').hidden = true; $('#authSubmit').hidden = true; $('#authToggle').hidden = true; $('#partnerVerifyPanel').hidden = false; showMessage($('#adminMessage'), 'Enter the email OTP to finish setting up your salon account.');
    } else if (partner && partner.expiresAt <= Date.now()) sessionStorage.removeItem(partnerChallengeKey);
    const customer = JSON.parse(sessionStorage.getItem(customerChallengeKey) || 'null');
    if (customer && customer.expiresAt > Date.now() && ['account', 'booking'].includes(route.name)) {
      pendingCustomerChallengeId = customer.challengeId; $('#customerOtpDestinations').textContent = `${customer.emailHint}`; $('#customerLoginPane').hidden = true; $('#customerSignupPane').hidden = true; $('#customerVerifyPane').hidden = false; $$('[data-customer-mode]').forEach(tab=>{tab.disabled=true;tab.classList.toggle('active',tab.dataset.customerMode==='signup');}); customerAuthMode = 'signup'; showMessage($('#customerAuthMessage'), 'Enter the email OTP to finish setting up your FORME account.');
    } else if (customer && customer.expiresAt <= Date.now()) sessionStorage.removeItem(customerChallengeKey);
  } catch { sessionStorage.removeItem(partnerChallengeKey); sessionStorage.removeItem(customerChallengeKey); sessionStorage.removeItem(partnerResetChallengeKey); sessionStorage.removeItem(customerResetChallengeKey); }
}
restoreRegistrationChallenges();
if(sessionStorage.getItem(tokenKey)&&resolveRoute().name==='studio')resumeSession();
