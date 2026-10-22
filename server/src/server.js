import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual, createHmac, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const app = express();
const port = Number(process.env.PORT || 5050);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(process.env.DATA_FILE || path.join(here, '../data/studio.json'));
const platformFile = path.resolve(process.env.PLATFORM_FILE || path.join(here, '../data/platform.json'));
const dataRoot = path.dirname(dataFile);
const clientDir = path.resolve(here, '../../client');
const sessionSecret = process.env.SESSION_SECRET || 'local-prototype-session-secret-change-before-deploy';
const scopeStorage = new AsyncLocalStorage();
const SLOT_STEP = 30;
const CURRENCY = 'INR';

app.disable('x-powered-by');
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '64kb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(clientDir));

const initialState = (overrides = {}) => {
  const factor = priceFactor(overrides.currency || CURRENCY);
  const price = (inr) => Math.max(1, Math.round(inr * factor));
  return ({
  settings: { businessName: 'FORME Barber Studio', branchName: 'Main branch', city: '', country: 'India', currency: CURRENCY, timeZone: 'Asia/Kolkata', locale: 'en-IN', openingTime: '10:00', closingTime: '20:00', openDays: [2, 3, 4, 5, 6, 0], pointsPerRupee: 0.1, redemptionValue: 0.5, ...overrides },
  services: [
    { id: 'classic-cut', name: 'Classic haircut', category: 'Hair', minutes: 30, price: price(299), description: 'A clean cut, finished to your style.', active: true },
    { id: 'beard-shape', name: 'Beard trim & shape', category: 'Beard', minutes: 25, price: price(199), description: 'Precise shaping and a neat finish.', active: true },
    { id: 'cut-beard', name: 'Haircut + beard', category: 'Combos', minutes: 50, price: price(449), description: 'A complete refresh in one visit.', active: true },
    { id: 'hair-wash', name: 'Hair wash & style', category: 'Care', minutes: 20, price: price(149), description: 'Wash, style, and get ready to go.', active: true },
    { id: 'premium-cut', name: 'Premium cut & finish', category: 'Hair', minutes: 45, price: price(499), description: 'Consultation, precision cut, wash, and styling.', active: true },
  ],
  staff: [
    { id: 'arjun', name: 'Arjun Mehta', role: 'Senior barber', active: true, days: [2, 3, 4, 5, 6, 0], start: '10:00', end: '20:00', color: '#9cae83' },
    { id: 'kabir', name: 'Kabir Singh', role: 'Barber', active: true, days: [2, 3, 4, 5, 6, 0], start: '10:00', end: '20:00', color: '#c9a77a' },
    { id: 'dev', name: 'Dev Sharma', role: 'Stylist', active: true, days: [2, 3, 4, 5, 6, 0], start: '11:00', end: '19:00', color: '#9b9ac1' },
  ],
  appointments: [], customers: [], orders: [], purchaseOrders: [], reviews: [], paymentRecords: [],
  products: [
    { id: 'clay', name: 'Matte styling clay', category: 'Styling', price: price(499), stock: 12, lowStockAt: 4, sku: 'FOR-CLY-01', active: true },
    { id: 'pomade', name: 'Classic pomade', category: 'Styling', price: price(399), stock: 8, lowStockAt: 3, sku: 'FOR-POM-01', active: true },
    { id: 'beard-oil', name: 'Beard conditioning oil', category: 'Beard care', price: price(349), stock: 9, lowStockAt: 3, sku: 'FOR-BRD-01', active: true },
    { id: 'shampoo', name: 'Daily care shampoo', category: 'Hair care', price: price(599), stock: 5, lowStockAt: 2, sku: 'FOR-SHP-01', active: true },
  ], movements: [],
  });
};

function pathForScope(scope) {
  if (!scope || scope.branch?.isDefault) return dataFile;
  return path.join(dataRoot, 'tenants', scope.tenant.id, `${scope.branch.id}.json`);
}

async function readStateFor(scope) {
  const file = pathForScope(scope);
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(stored)) return { ...initialState(scope?.branch ? { branchName: scope.branch.name, city: scope.branch.city, country: scope.branch.country, currency: scope.branch.currency, timeZone: scope.branch.timeZone, businessName: scope.tenant.name } : {}), appointments: stored };
    const base = initialState(scope?.branch ? { branchName: scope.branch.name, city: scope.branch.city, country: scope.branch.country, currency: scope.branch.currency, timeZone: scope.branch.timeZone, businessName: scope.tenant.name } : {});
    return { ...base, ...stored, settings: { ...base.settings, ...(stored.settings || {}) } };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = initialState(scope?.branch ? { branchName: scope.branch.name, city: scope.branch.city, country: scope.branch.country, currency: scope.branch.currency, timeZone: scope.branch.timeZone, businessName: scope.tenant.name } : {});
    await writeStateFor(scope, state);
    return state;
  }
}

function readState() { return readStateFor(scopeStorage.getStore()); }

async function writeStateFor(scope, state) {
  const file = pathForScope(scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function writeState(state) { return writeStateFor(scopeStorage.getStore(), state); }

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(password, user) {
  const actual = scryptSync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function signToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function verifyToken(token) {
  try {
    const [encoded, signature] = String(token || '').split('.');
    if (!encoded || !signature) return null;
    const expected = createHmac('sha256', sessionSecret).update(encoded).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function slugify(value) { return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'salon'; }
async function writePlatform(platform) {
  await fs.mkdir(path.dirname(platformFile), { recursive: true });
  const temp = `${platformFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(platform, null, 2), 'utf8');
  await fs.rename(temp, platformFile);
}
async function readPlatform() {
  try { const platform = JSON.parse(await fs.readFile(platformFile, 'utf8')); platform.customerUsers ||= []; return platform; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const email = normalizeEmail(process.env.DEMO_OWNER_EMAIL || 'owner@forme.studio');
    const password = process.env.DEMO_OWNER_PASSWORD || 'forme-demo-2026';
    const credentials = hashPassword(password);
    const owner = { id: randomUUID(), name: 'FORME Owner', email, passwordSalt: credentials.salt, passwordHash: credentials.hash, tenantIds: ['forme-tenant'], createdAt: new Date().toISOString() };
    const defaultPlatform = {
      users: [owner], customerUsers: [],
      tenants: [{ id: 'forme-tenant', slug: 'forme', name: 'FORME Barber Studio', ownerUserId: owner.id, userIds: [owner.id], createdAt: new Date().toISOString(), active: true, branches: [{ id: 'main', name: 'Main Studio', slug: 'forme-main', city: '', country: 'India', countryCode: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', locale: 'en-IN', latitude: null, longitude: null, isDefault: true, active: true }] }],
    };
    await writePlatform(defaultPlatform);
    return defaultPlatform;
  }
}
function tenantChoices(platform, user) {
  return platform.tenants.filter((tenant) => tenant.active && user.tenantIds.includes(tenant.id)).map((tenant) => ({ id: tenant.id, slug: tenant.slug, name: tenant.name, branches: tenant.branches.filter((branch) => branch.active).map(({ id, name, slug, city, country, currency, timeZone }) => ({ id, name, slug, city, country, currency, timeZone })) }));
}
function makeSession(user, tenant, branch) {
  return signToken({ type: 'session', userId: user.id, email: user.email, tenantId: tenant.id, branchId: branch.id, role: tenant.ownerUserId === user.id ? 'owner' : 'manager', exp: Date.now() + 12 * 60 * 60 * 1000 });
}
function makeCustomerSession(user) { return signToken({ type: 'customer', customerUserId: user.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); }
function customerFromRequest(req, platform = scopeStorage.getStore()?.platform) {
  const auth = verifyToken(req.get('x-customer-token'));
  if (auth?.type !== 'customer' || !platform) return null;
  return platform.customerUsers?.find((user) => user.id === auth.customerUserId && user.active !== false) || null;
}
function parseCoordinates(details) {
  const latitude = details.latitude === '' || details.latitude === null || details.latitude === undefined ? null : Number(details.latitude);
  const longitude = details.longitude === '' || details.longitude === null || details.longitude === undefined ? null : Number(details.longitude);
  if ((latitude === null) !== (longitude === null) || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180))) throw new Error('Enter both valid map coordinates, or leave both blank.');
  return { latitude, longitude };
}
function distanceKm(fromLat, fromLon, toLat, toLon) {
  const rad = (n) => n * Math.PI / 180; const dLat = rad(toLat - fromLat); const dLon = rad(toLon - fromLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(fromLat)) * Math.cos(rad(toLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function createTenantForUser(platform, user, details) {
  const businessName = String(details.businessName || '').trim().slice(0, 80);
  const branchName = String(details.branchName || 'Main branch').trim().slice(0, 80);
  const city = String(details.city || '').trim().slice(0, 80);
  const country = String(details.country || '').trim().slice(0, 80);
  const countryCode = String(details.countryCode || '').trim().toUpperCase().slice(0, 2);
  const currency = String(details.currency || 'USD').trim().toUpperCase();
  const timeZone = String(details.timeZone || 'Etc/UTC').trim();
  if (businessName.length < 2 || branchName.length < 2 || !country || !/^[A-Z]{3}$/.test(currency)) throw new Error('Enter a business name, location, country, and three-letter currency.');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new Error('Choose a valid time zone.'); }
  try { new Intl.NumberFormat('en', { style: 'currency', currency }).format(1); } catch { throw new Error('Choose a supported currency.'); }
  const baseSlug = slugify(businessName);
  const slug = platform.tenants.some((t) => t.slug === baseSlug) ? `${baseSlug}-${randomBytes(2).toString('hex')}` : baseSlug;
  const tenant = { id: randomUUID(), slug, name: businessName, ownerUserId: user.id, userIds: [user.id], createdAt: new Date().toISOString(), active: true, branches: [] };
  const coordinates = parseCoordinates(details);
  const branch = { id: randomUUID(), name: branchName, slug: slugify(`${branchName}-${city || country}`), city, country, countryCode, currency, timeZone, locale: String(details.locale || 'en'), ...coordinates, isDefault: false, active: true };
  tenant.branches.push(branch);
  platform.tenants.push(tenant);
  user.tenantIds.push(tenant.id);
  const overrides = { businessName, branchName, city, country, currency, timeZone, locale: branch.locale };
  await writeStateFor({ tenant, branch }, initialState(overrides));
  return { tenant, branch };
}

function requireAdmin(req, res, next) {
  const scope = scopeStorage.getStore();
  if (!scope?.session || !['owner', 'manager'].includes(scope.session.role)) return res.status(401).json({ error: 'Please sign in to a salon workspace.' });
  next();
}

function minutes(value) { const [h, m] = String(value || '').split(':').map(Number); return h * 60 + m; }
function priceFactor(currency) { return ({ INR: 1, USD: 0.12, EUR: 0.11, GBP: 0.095, AED: 0.44, SGD: 0.16, CAD: 0.17, AUD: 0.18 })[currency] || 0.1; }
function dateKeyInZone(value = new Date(), timeZone = 'Etc/UTC') { const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value); const p = Object.fromEntries(parts.map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
function wallTimeInZone(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number); const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute); let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += target - observed;
  }
  return new Date(guess);
}
function todayInZone(timeZone) { return dateKeyInZone(new Date(), timeZone); }
function weekdayFromDate(date) { const [year, month, day] = date.split('-').map(Number); return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay(); }
function validPhone(phone) { return typeof phone === 'string' && /^[+\d][\d\s()-]{7,18}$/.test(phone.trim()); }
function byStart(a, b) { return `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`); }
function getService(state, id) { return state.services.find((item) => item.id === id && item.active); }
function getStaff(state, id) { return id ? state.staff.find((item) => item.id === id && item.active) : null; }
function findCustomer(state, phone) { return state.customers.find((item) => item.phone === phone); }
function ensureCustomer(state, { name, phone, notes = '' }) {
  let customer = findCustomer(state, phone);
  if (!customer) {
    customer = { id: randomUUID(), name, phone, notes, visits: 0, points: 0, createdAt: new Date().toISOString() };
    state.customers.push(customer);
  } else {
    customer.name = name;
    if (notes) customer.notes = notes;
    customer.updatedAt = new Date().toISOString();
  }
  return customer;
}
function slotAvailable(state, date, time, service, staffId, excludeId = null) {
  const weekday = weekdayFromDate(date);
  const staffList = staffId ? [getStaff(state, staffId)].filter(Boolean) : state.staff.filter((s) => s.active);
  return staffList.some((staff) => {
    const start = minutes(time);
    const end = start + service.minutes;
    if (!state.settings.openDays.includes(weekday) || start < minutes(state.settings.openingTime) || end > minutes(state.settings.closingTime) || !staff.days.includes(weekday) || start < minutes(staff.start) || end > minutes(staff.end)) return false;
    return !state.appointments.some((item) => {
      if (item.id === excludeId || item.status === 'cancelled' || (item.status === 'awaiting-payment' && item.paymentExpiresAt && new Date(item.paymentExpiresAt) < new Date()) || item.staffId !== staff.id || item.date !== date) return false;
      const otherStart = minutes(item.time);
      const otherEnd = otherStart + Number(item.minutes || 30);
      return start < otherEnd && otherStart < end;
    });
  });
}
function assignStaff(state, date, time, service, preferredId, excludeId = null) {
  const candidates = preferredId ? [getStaff(state, preferredId)].filter(Boolean) : state.staff.filter((s) => s.active);
  return candidates.find((staff) => slotAvailable(state, date, time, service, staff.id, excludeId)) || null;
}
function makeReference() { return randomBytes(4).toString('hex').toUpperCase(); }

app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'FORME Salon Cloud' }));
app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET; if (!secret) return res.status(503).json({ error: 'Payment webhook secret is not configured.' });
    const signature = Buffer.from(String(req.get('x-razorpay-signature') || ''), 'hex'); const expected = createHmac('sha256', secret).update(req.rawBody || '').digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return res.status(400).json({ error: 'Invalid webhook signature.' });
    if (req.body?.event !== 'payment.captured') return res.json({ received: true });
    const entity = req.body?.payload?.payment?.entity; if (!entity?.order_id || !entity?.id) return res.status(400).json({ error: 'Payment event is missing its order or payment ID.' });
    const platform = await readPlatform();
    for (const tenant of platform.tenants) for (const branch of tenant.branches || []) {
      const scope = { tenant, branch }; const state = await readStateFor(scope); const record = (state.paymentRecords || []).find((item) => item.orderId === entity.order_id);
      if (!record) continue; if (entity.amount !== record.amountMinor || entity.currency !== record.currency) return res.status(400).json({ error: 'Captured payment amount does not match the booking deposit.' }); const appointment = state.appointments.find((item) => item.id === record.appointmentId); if (!appointment) return res.status(404).json({ error: 'Payment booking was not found.' });
      record.status = 'captured'; record.paymentId = entity.id; appointment.status = 'confirmed'; appointment.paymentStatus = 'deposit-paid'; appointment.depositPaid = appointment.depositAmount; appointment.paymentId = entity.id; appointment.paidAt = new Date().toISOString(); await writeStateFor(scope, state); return res.json({ received: true });
    }
    res.status(404).json({ error: 'No booking matches this payment order.' });
  } catch (e) { next(e); }
});
app.get('/api/public/salons', async (req, res, next) => {
  try {
    const platform = await readPlatform(); const q = String(req.query.q || '').toLowerCase(); const city = String(req.query.city || '').toLowerCase(); const country = String(req.query.country || '').toLowerCase();
    const userLatitude = Number(req.query.lat); const userLongitude = Number(req.query.lng); const hasLocation = Number.isFinite(userLatitude) && userLatitude >= -90 && userLatitude <= 90 && Number.isFinite(userLongitude) && userLongitude >= -180 && userLongitude <= 180;
    const locations = platform.tenants.filter((t) => t.active && (!q || `${t.name} ${t.branches.map((b) => `${b.city} ${b.country}`).join(' ')}`.toLowerCase().includes(q))).flatMap((t) => t.branches.filter((b) => b.active && (!city || b.city.toLowerCase().includes(city)) && (!country || b.country.toLowerCase() === country)).map((b) => ({ tenant: t, branch: b })));
    const salons = await Promise.all(locations.map(async ({ tenant, branch }) => { const state = await readStateFor({ tenant, branch }); const reviews = state.reviews || []; const ratingCount = reviews.length; return { name: tenant.name, slug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone, latitude: branch.latitude ?? null, longitude: branch.longitude ?? null, averageRating: ratingCount ? Math.round(reviews.reduce((sum, review) => sum + review.rating, 0) / ratingCount * 10) / 10 : null, ratingCount, distanceKm: hasLocation && Number.isFinite(branch.latitude) && Number.isFinite(branch.longitude) ? Math.round(distanceKm(userLatitude, userLongitude, branch.latitude, branch.longitude) * 10) / 10 : null }; }));
    if (hasLocation) salons.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    res.json(salons);
  } catch (e) { next(e); }
});
app.post('/api/customer/register', async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body || {}; const normalized = normalizeEmail(email);
    if (typeof name !== 'string' || name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(normalized) || !validPhone(String(phone || '')) || typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Enter your name, valid email, phone, and a password with at least 8 characters.' });
    const platform = await readPlatform(); if (platform.customerUsers.some((user) => user.email === normalized)) return res.status(409).json({ error: 'An account already exists for this email. Please sign in.' });
    const credentials = hashPassword(password); const user = { id: randomUUID(), name: name.trim().slice(0, 80), email: normalized, phone: String(phone).trim().slice(0, 24), passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString(), active: true };
    platform.customerUsers.push(user); await writePlatform(platform); res.status(201).json({ customerToken: makeCustomerSession(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (e) { next(e); }
});
app.post('/api/customer/login', async (req, res, next) => {
  try {
    const platform = await readPlatform(); const user = platform.customerUsers.find((item) => item.email === normalizeEmail(req.body?.email) && item.active !== false);
    if (!user || !passwordMatches(String(req.body?.password || ''), user)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    res.json({ customerToken: makeCustomerSession(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (e) { next(e); }
});
app.get('/api/customer/me', async (req, res, next) => {
  try { const platform = await readPlatform(); const user = customerFromRequest(req, platform); if (!user) return res.status(401).json({ error: 'Sign in to continue.' }); res.json({ customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } }); } catch (e) { next(e); }
});
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(normalizeEmail(email)) || typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email, and a password with at least 8 characters.' });
    const platform = await readPlatform(); const normalized = normalizeEmail(email); let user = platform.users.find((u) => u.email === normalized);
    if (user && !passwordMatches(password, user)) return res.status(409).json({ error: 'This email already has an account. Sign in with its password to add another salon.' });
    if (!user) { const credentials = hashPassword(password); user = { id: randomUUID(), name: name.trim().slice(0, 80), email: normalized, passwordSalt: credentials.salt, passwordHash: credentials.hash, tenantIds: [], createdAt: new Date().toISOString() }; platform.users.push(user); }
    user.tenantIds ||= [];
    const { tenant, branch } = await createTenantForUser(platform, user, req.body || {});
    await writePlatform(platform);
    res.status(201).json({ sessionToken: makeSession(user, tenant, branch), user: { id: user.id, name: user.name, email: user.email }, workspace: { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone }, organizations: tenantChoices(platform, user) });
  } catch (e) { if (e.message.startsWith('Enter a business') || e.message.startsWith('Choose a') || e.message.startsWith('Enter both valid map coordinates')) return res.status(400).json({ error: e.message }); next(e); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const platform = await readPlatform(); const user = platform.users.find((u) => u.email === normalizeEmail(req.body?.email));
    if (!user || !passwordMatches(String(req.body?.password || ''), user)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const organizations = tenantChoices(platform, user);
    if (!organizations.length) return res.status(403).json({ error: 'This account has no active salon workspace.' });
    res.json({ loginToken: signToken({ type: 'login', userId: user.id, exp: Date.now() + 10 * 60 * 1000 }), user: { id: user.id, name: user.name, email: user.email }, organizations });
  } catch (e) { next(e); }
});
app.post('/api/auth/select', async (req, res, next) => {
  try {
    const auth = verifyToken(req.body?.loginToken); if (auth?.type !== 'login') return res.status(401).json({ error: 'Your sign-in session expired. Please sign in again.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId); const tenant = platform.tenants.find((t) => t.id === req.body?.tenantId && t.active && t.userIds.includes(user?.id)); const branch = tenant?.branches.find((b) => b.id === req.body?.branchId && b.active);
    if (!user || !tenant || !branch) return res.status(403).json({ error: 'You do not have access to this salon location.' });
    res.json({ sessionToken: makeSession(user, tenant, branch), user: { id: user.id, name: user.name, email: user.email }, workspace: { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone }, organizations: tenantChoices(platform, user) });
  } catch (e) { next(e); }
});
app.get('/api/auth/me', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId); const tenant = platform.tenants.find((t) => t.id === auth.tenantId && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === auth.branchId);
    if (!user || !tenant || !branch) return res.status(401).json({ error: 'This workspace is no longer available.' });
    res.json({ user: { id: user.id, name: user.name, email: user.email }, workspace: { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone }, organizations: tenantChoices(platform, user) });
  } catch (e) { next(e); }
});
app.post('/api/auth/switch-context', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId); const tenant = platform.tenants.find((t) => t.id === req.body?.tenantId && t.active && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === req.body?.branchId && b.active);
    if (!user || !tenant || !branch) return res.status(403).json({ error: 'You do not have access to this salon location.' });
    res.json({ sessionToken: makeSession(user, tenant, branch), workspace: { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone } });
  } catch (e) { next(e); }
});
app.post('/api/auth/create-organization', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId); if (!user) return res.status(401).json({ error: 'Account not found.' });
    const { tenant, branch } = await createTenantForUser(platform, user, req.body || {}); await writePlatform(platform);
    res.status(201).json({ sessionToken: makeSession(user, tenant, branch), workspace: { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone } });
  } catch (e) { if (e.message.startsWith('Enter a business') || e.message.startsWith('Choose a')) return res.status(400).json({ error: e.message }); next(e); }
});
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/') || req.path === '/public/salons') return next();
  try {
    const platform = await readPlatform();
    if (req.path.startsWith('/admin/')) {
      const auth = verifyToken(req.get('x-session-token'));
      if (auth?.type !== 'session') return res.status(401).json({ error: 'Please sign in to a salon workspace.' });
      const user = platform.users.find((u) => u.id === auth.userId); const tenant = platform.tenants.find((t) => t.id === auth.tenantId && t.active && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === auth.branchId && b.active);
      if (!user || !tenant || !branch) return res.status(401).json({ error: 'This workspace session is no longer valid.' });
      return scopeStorage.run({ platform, user, tenant, branch, session: auth }, next);
    }
    const slug = String(req.get('x-salon-slug') || req.query.salon || 'forme').toLowerCase(); const tenant = platform.tenants.find((t) => t.slug === slug && t.active);
    const requestedBranch = req.get('x-branch-id') || req.query.branch; const branch = tenant?.branches.find((b) => b.active && (!requestedBranch || b.id === requestedBranch || b.slug === requestedBranch)) || (!requestedBranch ? tenant?.branches.find((b) => b.active) : null);
    if (!tenant || !branch) return res.status(404).json({ error: 'Salon location not found.' });
    return scopeStorage.run({ platform, tenant, branch }, next);
  } catch (e) { next(e); }
});
app.get('/api/salon/profile', async (_req, res, next) => {
  try { const scope = scopeStorage.getStore(); const state = await readState(); res.json({ tenantName: scope.tenant.name, tenantSlug: scope.tenant.slug, branch: scope.branch, settings: state.settings }); } catch (e) { next(e); }
});
app.get('/api/reviews', async (_req, res, next) => {
  try { const reviews = (await readState()).reviews || []; const averageRating = reviews.length ? Math.round(reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length * 10) / 10 : null; res.json({ averageRating, ratingCount: reviews.length, reviews: reviews.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(({ rating, comment, customerName, createdAt }) => ({ rating, comment, customerName, createdAt })) }); } catch (e) { next(e); }
});
app.post('/api/reviews', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to review this salon.' });
    const rating = Number(req.body?.rating); const reference = String(req.body?.reference || '').trim().toUpperCase(); const comment = String(req.body?.comment || '').trim().slice(0, 500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars.' });
    const state = await readState(); const appointment = state.appointments.find((item) => item.reference === reference && item.customerUserId === user.id);
    if (!appointment || appointment.status !== 'completed') return res.status(403).json({ error: 'You can rate a salon after your completed visit.' });
    state.reviews ||= []; if (state.reviews.some((item) => item.appointmentId === appointment.id)) return res.status(409).json({ error: 'This visit already has a review.' });
    const review = { id: randomUUID(), appointmentId: appointment.id, rating, comment, customerName: user.name.split(' ')[0], createdAt: new Date().toISOString() }; state.reviews.push(review); await writeState(state); res.status(201).json({ review });
  } catch (e) { next(e); }
});
app.get('/api/customer/bookings', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope?.platform);
    if (!user) return res.status(401).json({ error: 'Sign in to see your bookings.' });
    const branches = scope.platform.tenants.flatMap((tenant) => (tenant.branches || []).map((branch) => ({ tenant, branch })));
    const bookings = (await Promise.all(branches.map(async ({ tenant, branch }) => {
      const state = await readStateFor({ tenant, branch });
      return state.appointments.filter((item) => item.customerUserId === user.id).map((item) => ({ reference: item.reference, serviceName: item.serviceName, staffName: item.staffName, date: item.date, time: item.time, status: item.status, paymentStatus: item.paymentStatus, depositAmount: item.depositAmount, depositCurrency: item.depositCurrency, depositForfeited: item.depositForfeited, salonName: tenant.name, salonSlug: tenant.slug, branchName: branch.name, branchId: branch.id }));
    }))).flat();
    bookings.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
    res.json(bookings);
  } catch (e) { next(e); }
});
app.get('/api/services', async (_req, res, next) => { try { res.json((await readState()).services.filter((s) => s.active)); } catch (e) { next(e); } });
app.get('/api/staff', async (_req, res, next) => { try { res.json((await readState()).staff.filter((s) => s.active).map(({ id, name, role, color }) => ({ id, name, role, color }))); } catch (e) { next(e); } });
app.get('/api/availability', async (req, res, next) => {
  try {
    const state = await readState();
    const service = getService(state, req.query.serviceId);
    const date = String(req.query.date || '');
    if (!service || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a service and valid date.' });
    const weekday = weekdayFromDate(date);
    const slots = [];
    const open = minutes(state.settings.openingTime);
    const close = minutes(state.settings.closingTime);
    for (let start = open; start < close; start += SLOT_STEP) {
      const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      if (wallTimeInZone(date, time, state.settings.timeZone || scopeStorage.getStore()?.branch.timeZone || 'Etc/UTC') <= new Date()) continue;
      const staff = state.settings.openDays.includes(weekday) ? state.staff.filter((s) => s.active && s.days.includes(weekday) && start >= minutes(s.start) && start + service.minutes <= minutes(s.end) && slotAvailable(state, date, time, service, s.id)) : [];
      if (staff.length) slots.push({ time, staff: staff.map(({ id, name, role, color }) => ({ id, name, role, color })) });
    }
    res.json({ date, service, slots });
  } catch (e) { next(e); }
});

app.post('/api/appointments', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const customerUser = customerFromRequest(req, scope.platform);
    if (!customerUser) return res.status(401).json({ error: 'Create an account or sign in before booking.' });
    if (req.body?.depositPolicyAccepted !== true) return res.status(400).json({ error: 'Please accept the booking advance and no-show policy.' });
    const { serviceId, staffId, date, time, notes = '' } = req.body || {}; const { name, phone } = customerUser;
    const state = await readState(); const service = getService(state, serviceId);
    if (!service) return res.status(400).json({ error: 'Choose a valid service.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return res.status(400).json({ error: 'Choose a valid date and time.' });
    if (wallTimeInZone(date, time, state.settings.timeZone || scope.branch.timeZone || 'Etc/UTC') <= new Date()) return res.status(400).json({ error: 'Choose a future time.' });
    const staff = assignStaff(state, date, time, service, staffId); if (!staff) return res.status(409).json({ error: 'That time just filled up. Please choose another slot.' });
    const customer = ensureCustomer(state, { name, phone, notes: typeof notes === 'string' ? notes.trim().slice(0, 300) : '' });
    const depositPercent = 25; const depositAmount = Math.max(1, Math.round(service.price * depositPercent / 100));
    const appointment = { id: randomUUID(), reference: makeReference(), customerId: customer.id, customerUserId: customerUser.id, customerEmail: customerUser.email, name, phone, serviceId, serviceName: service.name, minutes: service.minutes, price: service.price, staffId: staff.id, staffName: staff.name, date, time, notes: typeof notes === 'string' ? notes.trim().slice(0, 300) : '', status: 'awaiting-payment', paymentStatus: 'deposit_due', depositAmount, depositCurrency: scope.branch.currency || state.settings.currency || 'INR', depositPercent, depositForfeited: false, paymentExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), createdAt: new Date().toISOString() };
    state.appointments.push(appointment); await writeState(state);
    res.status(201).json({ appointment: { reference: appointment.reference, name, serviceName: service.name, staffName: staff.name, date, time, minutes: service.minutes, price: service.price, status: appointment.status, depositAmount, depositCurrency: appointment.depositCurrency, depositPercent } });
  } catch (e) { next(e); }
});

app.post('/api/payments/order', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to pay your booking deposit.' });
    const state = await readState(); const appointment = state.appointments.find((item) => item.reference === String(req.body?.reference || '').toUpperCase() && item.customerUserId === user.id);
    if (!appointment || appointment.status !== 'awaiting-payment' || new Date(appointment.paymentExpiresAt) < new Date()) return res.status(409).json({ error: 'This booking hold expired. Please choose a time again.' });
    const currency = appointment.depositCurrency; const amountMinor = Math.round(appointment.depositAmount * (['JPY','KRW','VND','CLP'].includes(currency) ? 1 : 100));
    const keyId = process.env.RAZORPAY_KEY_ID; const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return res.json({ mode: 'demo', reference: appointment.reference, amount: appointment.depositAmount, currency, message: 'Demo payment only. No money will be charged.' });
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amountMinor, currency, receipt: appointment.reference, notes: { salon: scope.tenant.name, branch: scope.branch.name, appointment: appointment.reference } }) });
    const order = await response.json(); if (!response.ok) return res.status(502).json({ error: order.error?.description || 'Could not start online payment.' });
    state.paymentRecords ||= []; state.paymentRecords.push({ id: randomUUID(), appointmentId: appointment.id, customerUserId: user.id, provider: 'razorpay', orderId: order.id, amount: appointment.depositAmount, amountMinor, currency, status: 'created', createdAt: new Date().toISOString() }); await writeState(state);
    res.json({ mode: 'razorpay', keyId, orderId: order.id, amount: amountMinor, currency, name: scope.tenant.name, description: `${appointment.depositPercent}% booking advance · ${appointment.reference}`, prefill: { name: user.name, email: user.email, contact: user.phone } });
  } catch (e) { next(e); }
});
app.post('/api/payments/demo-confirm', async (req, res, next) => {
  try {
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return res.status(403).json({ error: 'Demo payments are disabled while Razorpay is configured.' });
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to confirm this payment.' });
    const state = await readState(); const appointment = state.appointments.find((item) => item.reference === String(req.body?.reference || '').toUpperCase() && item.customerUserId === user.id && item.status === 'awaiting-payment');
    if (!appointment || new Date(appointment.paymentExpiresAt) < new Date()) return res.status(409).json({ error: 'The booking hold expired. Choose another time.' });
    appointment.status = 'confirmed'; appointment.paymentStatus = 'demo-paid'; appointment.depositPaid = appointment.depositAmount; appointment.paidAt = new Date().toISOString(); state.paymentRecords ||= []; state.paymentRecords.push({ id: randomUUID(), appointmentId: appointment.id, customerUserId: user.id, provider: 'demo', amount: appointment.depositAmount, currency: appointment.depositCurrency, status: 'demo-paid', createdAt: new Date().toISOString() }); await writeState(state); res.json({ reference: appointment.reference, status: appointment.status, paymentStatus: appointment.paymentStatus, depositAmount: appointment.depositAmount, currency: appointment.depositCurrency, demo: true });
  } catch (e) { next(e); }
});
app.post('/api/payments/verify', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to confirm payment.' });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {}; const state = await readState(); const record = (state.paymentRecords || []).find((item) => item.orderId === orderId && item.customerUserId === user.id);
    if (!record || !paymentId || !signature) return res.status(400).json({ error: 'Payment details do not match a booking.' });
    const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest(); const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return res.status(400).json({ error: 'Payment signature verification failed.' });
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64'); const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${auth}` } }); const payment = await response.json();
    if (!response.ok || payment.order_id !== orderId || payment.status !== 'captured' || payment.amount !== record.amountMinor || payment.currency !== record.currency) return res.status(409).json({ error: 'Payment is not captured for the expected deposit. Check status or try again.' });
    const appointment = state.appointments.find((item) => item.id === record.appointmentId); if (!appointment) return res.status(404).json({ error: 'Booking not found.' });
    appointment.status = 'confirmed'; appointment.paymentStatus = 'deposit-paid'; appointment.depositPaid = appointment.depositAmount; appointment.paymentId = paymentId; appointment.paidAt = new Date().toISOString(); record.status = 'captured'; record.paymentId = paymentId; await writeState(state);
    res.json({ reference: appointment.reference, status: appointment.status, paymentStatus: appointment.paymentStatus, depositAmount: appointment.depositAmount, currency: appointment.depositCurrency });
  } catch (e) { next(e); }
});

app.post('/api/booking/lookup', async (req, res, next) => {
  try {
    const state = await readState();
    const item = state.appointments.find((a) => a.reference === String(req.body?.reference || '').toUpperCase() && a.phone === String(req.body?.phone || '').trim());
    if (!item) return res.status(404).json({ error: 'Booking reference or phone number does not match.' });
    res.json({ reference: item.reference, name: item.name, serviceId: item.serviceId, serviceName: item.serviceName, staffId: item.staffId, staffName: item.staffName, date: item.date, time: item.time, minutes: item.minutes, price: item.price, status: item.status });
  } catch (e) { next(e); }
});
app.patch('/api/booking/:reference', async (req, res, next) => {
  try {
    const state = await readState();
    const item = state.appointments.find((a) => a.reference === req.params.reference.toUpperCase());
    if (!item || item.phone !== String(req.body?.phone || '').trim()) return res.status(404).json({ error: 'Booking reference or phone number does not match.' });
    if (req.body.action === 'cancel') {
      if (item.status === 'completed') return res.status(409).json({ error: 'Completed visits cannot be cancelled.' });
      item.status = 'cancelled';
    } else if (req.body.action === 'reschedule') {
      const service = getService(state, item.serviceId);
      const staff = assignStaff(state, req.body.date, req.body.time, service, req.body.staffId || item.staffId, item.id) || assignStaff(state, req.body.date, req.body.time, service, null, item.id);
      if (!staff || wallTimeInZone(req.body.date, req.body.time, state.settings.timeZone || scopeStorage.getStore()?.branch.timeZone || 'Etc/UTC') <= new Date()) return res.status(409).json({ error: 'That time is not available. Choose another slot.' });
      item.date = req.body.date; item.time = req.body.time; item.staffId = staff.id; item.staffName = staff.name; item.status = 'confirmed';
    } else return res.status(400).json({ error: 'Choose reschedule or cancel.' });
    item.updatedAt = new Date().toISOString();
    await writeState(state);
    res.json({ reference: item.reference, status: item.status, date: item.date, time: item.time, staffName: item.staffName });
  } catch (e) { next(e); }
});

app.use('/api/admin', requireAdmin);
app.get('/api/admin/branches', async (_req, res) => { const { tenant, branch } = scopeStorage.getStore(); res.json({ currentBranchId: branch.id, branches: tenant.branches.filter((b) => b.active) }); });
app.post('/api/admin/branches', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const details = req.body || {};
    const name = String(details.branchName || '').trim().slice(0, 80); const city = String(details.city || '').trim().slice(0, 80); const country = String(details.country || '').trim().slice(0, 80); const countryCode = String(details.countryCode || '').trim().toUpperCase().slice(0, 2); const currency = String(details.currency || '').trim().toUpperCase(); const timeZone = String(details.timeZone || '').trim();
    if (name.length < 2 || !country || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Enter the location name, country, and a three-letter currency.' });
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); new Intl.NumberFormat('en', { style: 'currency', currency }).format(1); } catch { return res.status(400).json({ error: 'Choose a supported currency and time zone.' }); }
    const coordinates = parseCoordinates(details);
    const branch = { id: randomUUID(), name, slug: slugify(`${name}-${city || country}`), city, country, countryCode, currency, timeZone, locale: String(details.locale || 'en'), ...coordinates, isDefault: false, active: true };
    if (scope.tenant.branches.some((b) => b.slug === branch.slug)) branch.slug = `${branch.slug}-${randomBytes(2).toString('hex')}`;
    scope.tenant.branches.push(branch); await writePlatform(scope.platform);
    const baseState = await readState();
    const branchState = initialState({ ...baseState.settings, businessName: scope.tenant.name, branchName: branch.name, city, country, currency, timeZone, locale: branch.locale });
    const conversion = priceFactor(currency) / priceFactor(baseState.settings.currency || 'INR');
    branchState.services = baseState.services.map((s) => ({ ...s, price: Math.max(1, Math.round(s.price * conversion)) }));
    branchState.staff = baseState.staff.map((s) => ({ ...s, id: randomUUID() }));
    branchState.products = baseState.products.map((p) => ({ ...p, price: Math.max(1, Math.round(p.price * conversion)), stock: 0, id: randomUUID() }));
    await writeStateFor({ tenant: scope.tenant, branch }, branchState);
    res.status(201).json(branch);
  } catch (e) { if (e.message.startsWith('Enter both valid map coordinates')) return res.status(400).json({ error: e.message }); next(e); }
});
app.patch('/api/admin/branches/:branchId/location', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const branch = scope.tenant.branches.find((item) => item.id === req.params.branchId && item.active);
    if (!branch) return res.status(404).json({ error: 'Salon location not found.' });
    const coordinates = parseCoordinates(req.body || {});
    if (coordinates.latitude === null) return res.status(400).json({ error: 'Enter map coordinates to pin this salon.' });
    Object.assign(branch, coordinates); await writePlatform(scope.platform); res.json({ id: branch.id, latitude: branch.latitude, longitude: branch.longitude });
  } catch (e) { if (e.message.startsWith('Enter both valid map coordinates')) return res.status(400).json({ error: e.message }); next(e); }
});
app.get('/api/admin/portfolio', async (_req, res, next) => {
  try {
    const { tenant } = scopeStorage.getStore(); const branches = [];
    for (const branch of tenant.branches.filter((b) => b.active)) {
      const state = await readStateFor({ tenant, branch }); const zone = state.settings.timeZone || branch.timeZone || 'Etc/UTC'; const today = todayInZone(zone); const month = today.slice(0, 7);
      const upcoming = state.appointments.filter((a) => a.date >= today && !['cancelled', 'completed', 'no-show'].includes(a.status)).length;
      const monthRevenue = state.orders.filter((o) => dateKeyInZone(o.createdAt, zone).startsWith(month)).reduce((sum, o) => sum + o.total, 0);
      const lowStock = state.products.filter((p) => p.active && p.stock <= p.lowStockAt).length;
      branches.push({ id: branch.id, name: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone, hasMapPin: Number.isFinite(branch.latitude) && Number.isFinite(branch.longitude), upcoming, monthRevenue, lowStock, customers: state.customers.length });
    }
    res.json({ branchCount: branches.length, upcoming: branches.reduce((n, b) => n + b.upcoming, 0), lowStock: branches.reduce((n, b) => n + b.lowStock, 0), branches });
  } catch (e) { next(e); }
});
app.get('/api/admin/overview', async (_req, res, next) => {
  try {
    const s = await readState();
    const today = todayInZone(s.settings.timeZone || scopeStorage.getStore()?.branch.timeZone || 'Etc/UTC');
    const todayAppointments = s.appointments.filter((a) => a.date === today && a.status !== 'cancelled');
    const month = today.slice(0, 7);
    const monthOrders = s.orders.filter((o) => o.createdAt.startsWith(month));
    const revenue = monthOrders.reduce((sum, o) => sum + o.total, 0);
    res.json({ today: todayAppointments.length, upcoming: s.appointments.filter((a) => a.date >= today && !['cancelled', 'completed', 'no-show'].includes(a.status)).length, customers: s.customers.length, monthRevenue: revenue, lowStock: s.products.filter((p) => p.active && p.stock <= p.lowStockAt).length, appointments: todayAppointments });
  } catch (e) { next(e); }
});
app.get('/api/admin/appointments', async (req, res, next) => {
  try { const s = await readState(); const date = req.query.date; res.json(s.appointments.filter((a) => !date || a.date === date).sort(byStart)); } catch (e) { next(e); }
});
app.patch('/api/admin/appointments/:id', async (req, res, next) => {
  try {
    const s = await readState();
    const item = s.appointments.find((a) => a.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Appointment not found.' });
    const { status, date, time, staffId } = req.body || {};
    if (status && !['confirmed', 'completed', 'cancelled', 'arrived', 'in-service', 'no-show'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (date || time || staffId) {
      const service = getService(s, item.serviceId);
      const newDate = date || item.date; const newTime = time || item.time;
      const staff = assignStaff(s, newDate, newTime, service, staffId || item.staffId, item.id);
      if (!staff) return res.status(409).json({ error: 'That chair is no longer available.' });
      item.date = newDate; item.time = newTime; item.staffId = staff.id; item.staffName = staff.name;
    }
    if (status) { item.status = status; if (status === 'no-show' && Number(item.depositPaid) > 0) { item.depositForfeited = true; item.paymentStatus = 'forfeited'; item.depositForfeitedAt = new Date().toISOString(); } }
    item.updatedAt = new Date().toISOString();
    await writeState(s); res.json(item);
  } catch (e) { next(e); }
});
app.get('/api/admin/staff', async (_req, res, next) => { try { res.json((await readState()).staff); } catch (e) { next(e); } });
app.post('/api/admin/staff', async (req, res, next) => {
  try {
    const { name, role = 'Barber', start = '10:00', end = '20:00', days = [2, 3, 4, 5, 6, 0] } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || minutes(start) >= minutes(end)) return res.status(400).json({ error: 'Enter a name and valid working hours.' });
    const s = await readState(); const member = { id: randomUUID(), name: name.trim(), role: String(role).slice(0, 50), start, end, days: Array.isArray(days) ? days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [2, 3, 4, 5, 6, 0], active: true, color: '#9cae83' };
    s.staff.push(member); await writeState(s); res.status(201).json(member);
  } catch (e) { next(e); }
});
app.patch('/api/admin/staff/:id', async (req, res, next) => {
  try { const s = await readState(); const item = s.staff.find((x) => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Team member not found.' }); Object.assign(item, req.body, { id: item.id }); await writeState(s); res.json(item); } catch (e) { next(e); }
});
app.get('/api/admin/services', async (_req, res, next) => { try { res.json((await readState()).services); } catch (e) { next(e); } });
app.post('/api/admin/services', async (req, res, next) => {
  try { const { name, category = 'Hair', minutes: duration, price, description = '' } = req.body || {}; if (typeof name !== 'string' || name.trim().length < 2 || !Number.isInteger(Number(duration)) || Number(duration) < 10 || Number(duration) > 240 || !Number.isFinite(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'Enter a service name, duration, and price.' }); const s = await readState(); const item = { id: randomUUID(), name: name.trim(), category: String(category).slice(0, 50), minutes: Number(duration), price: Number(price), description: String(description).slice(0, 200), active: true }; s.services.push(item); await writeState(s); res.status(201).json(item); } catch (e) { next(e); }
});
app.patch('/api/admin/services/:id', async (req, res, next) => {
  try { const s = await readState(); const item = s.services.find((x) => x.id === req.params.id); if (!item) return res.status(404).json({ error: 'Service not found.' }); const { name, category, minutes: duration, price, description, active } = req.body || {}; if (name !== undefined && String(name).trim().length < 2 || duration !== undefined && (!Number.isInteger(Number(duration)) || Number(duration) < 10) || price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) return res.status(400).json({ error: 'Invalid service details.' }); if (name !== undefined) item.name = String(name).trim(); if (category !== undefined) item.category = String(category).slice(0, 50); if (duration !== undefined) item.minutes = Number(duration); if (price !== undefined) item.price = Number(price); if (description !== undefined) item.description = String(description).slice(0, 200); if (active !== undefined) item.active = Boolean(active); await writeState(s); res.json(item); } catch (e) { next(e); }
});
app.get('/api/admin/customers', async (req, res, next) => {
  try { const s = await readState(); const q = String(req.query.q || '').toLowerCase(); res.json(s.customers.filter((c) => !q || `${c.name} ${c.phone}`.toLowerCase().includes(q)).map((c) => ({ ...c, lastVisit: s.appointments.filter((a) => a.customerId === c.id).sort(byStart).at(-1)?.date || null, lifetimeSpend: s.orders.filter((o) => o.customerId === c.id).reduce((n, o) => n + o.total, 0) }))); } catch (e) { next(e); }
});
app.patch('/api/admin/customers/:id', async (req, res, next) => {
  try { const s = await readState(); const c = s.customers.find((x) => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' }); if (typeof req.body.notes === 'string') c.notes = req.body.notes.slice(0, 500); await writeState(s); res.json(c); } catch (e) { next(e); }
});
app.get('/api/admin/products', async (_req, res, next) => { try { res.json((await readState()).products); } catch (e) { next(e); } });
app.post('/api/admin/products', async (req, res, next) => {
  try { const { name, category = 'General', price, stock = 0, lowStockAt = 3, sku = '' } = req.body || {}; if (typeof name !== 'string' || !name.trim() || !Number.isFinite(Number(price)) || Number(price) < 0 || !Number.isInteger(Number(stock)) || Number(stock) < 0) return res.status(400).json({ error: 'Enter a product name, price, and stock quantity.' }); const s = await readState(); const item = { id: randomUUID(), name: name.trim(), category: String(category).slice(0, 60), price: Number(price), stock: Number(stock), lowStockAt: Number(lowStockAt) || 0, sku: String(sku).slice(0, 40), active: true }; s.products.push(item); if (item.stock) s.movements.push({ id: randomUUID(), productId: item.id, productName: item.name, quantity: item.stock, type: 'initial', note: 'Opening stock', createdAt: new Date().toISOString() }); await writeState(s); res.status(201).json(item); } catch (e) { next(e); }
});
app.post('/api/admin/products/:id/receive', async (req, res, next) => {
  try { const quantity = Number(req.body?.quantity); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return res.status(400).json({ error: 'Enter a positive whole-number quantity.' }); const s = await readState(); const p = s.products.find((x) => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Product not found.' }); p.stock += quantity; s.movements.push({ id: randomUUID(), productId: p.id, productName: p.name, quantity, type: 'received', note: String(req.body?.note || 'Stock received').slice(0, 100), createdAt: new Date().toISOString() }); await writeState(s); res.json(p); } catch (e) { next(e); }
});
app.get('/api/admin/purchases', async (_req, res, next) => { try { res.json((await readState()).purchaseOrders.slice().reverse()); } catch (e) { next(e); } });
app.post('/api/admin/purchases', async (req, res, next) => {
  try {
    const { supplier, productId, quantity } = req.body || {}; const qty = Number(quantity);
    if (typeof supplier !== 'string' || supplier.trim().length < 2 || !Number.isInteger(qty) || qty < 1 || qty > 10000) return res.status(400).json({ error: 'Enter a supplier and valid quantity.' });
    const s = await readState(); const p = s.products.find((x) => x.id === productId && x.active);
    if (!p) return res.status(404).json({ error: 'Choose an active product.' });
    const order = { id: randomUUID(), reference: `PO-${Date.now().toString().slice(-8)}`, supplier: supplier.trim().slice(0, 100), productId: p.id, productName: p.name, quantity: qty, unitCost: Number(p.cost || p.price), total: qty * Number(p.cost || p.price), status: 'ordered', createdAt: new Date().toISOString() };
    s.purchaseOrders.push(order); await writeState(s); res.status(201).json(order);
  } catch (e) { next(e); }
});
app.patch('/api/admin/purchases/:id/receive', async (req, res, next) => {
  try {
    const s = await readState(); const order = s.purchaseOrders.find((x) => x.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Purchase order not found.' });
    if (order.status === 'received') return res.status(409).json({ error: 'This purchase order was already received.' });
    const p = s.products.find((x) => x.id === order.productId);
    if (!p) return res.status(404).json({ error: 'The ordered product no longer exists.' });
    p.stock += order.quantity; order.status = 'received'; order.receivedAt = new Date().toISOString();
    s.movements.push({ id: randomUUID(), productId: p.id, productName: p.name, quantity: order.quantity, type: 'purchase', note: `${order.reference} · ${order.supplier}`, createdAt: order.receivedAt });
    await writeState(s); res.json(order);
  } catch (e) { next(e); }
});
app.get('/api/admin/orders', async (_req, res, next) => { try { res.json((await readState()).orders.slice().reverse()); } catch (e) { next(e); } });
app.post('/api/admin/orders', async (req, res, next) => {
  try {
    const { items = [], phone = '', customerName = '', paymentMethod = 'cash', discount = 0, redeemPoints = 0, appointmentReference = '' } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item to the checkout.' });
    if (!['cash', 'card', 'upi'].includes(paymentMethod)) return res.status(400).json({ error: 'Choose cash, card, or UPI.' });
    const s = await readState(); const lines = [];
    for (const raw of items) {
      const qty = Number(raw.quantity || 1);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Invalid item quantity.' });
      const item = raw.type === 'product' ? s.products.find((x) => x.id === raw.id && x.active) : s.services.find((x) => x.id === raw.id && x.active);
      if (!item) return res.status(400).json({ error: 'One of the selected items is unavailable.' });
      if (raw.type === 'product' && item.stock < qty) return res.status(409).json({ error: `${item.name} has only ${item.stock} in stock.` });
      lines.push({ type: raw.type === 'product' ? 'product' : 'service', itemId: item.id, name: item.name, quantity: qty, unitPrice: item.price, lineTotal: item.price * qty });
    }
    const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
    const customer = phone && validPhone(phone) ? ensureCustomer(s, { name: String(customerName || 'Studio customer').trim(), phone: phone.trim() }) : null;
    const pointsToUse = Math.max(0, Math.floor(Number(redeemPoints) || 0));
    if (pointsToUse && (!customer || customer.points < pointsToUse)) return res.status(400).json({ error: 'Customer does not have enough loyalty points.' });
    const pointsDiscount = pointsToUse * Number(s.settings.redemptionValue || 0.5);
    const appliedDiscount = Math.min(subtotal, Math.max(0, Math.min(Number(discount) || 0, subtotal)) + pointsDiscount);
    const beforeAdvance = Math.max(0, subtotal - appliedDiscount); let depositCredit = 0; let linkedAppointment = null;
    if (appointmentReference) {
      linkedAppointment = s.appointments.find((item) => item.reference === String(appointmentReference).toUpperCase() && item.phone === String(phone).trim());
      if (!linkedAppointment || !['arrived', 'in-service', 'completed'].includes(linkedAppointment.status) || Number(linkedAppointment.depositPaid) <= 0 || linkedAppointment.depositApplied || linkedAppointment.depositForfeited) return res.status(400).json({ error: 'Booking reference has no available deposit to apply. Confirm the customer and booking status.' });
      depositCredit = Math.min(beforeAdvance, Number(linkedAppointment.depositPaid)); linkedAppointment.depositApplied = depositCredit; linkedAppointment.depositAppliedAt = new Date().toISOString(); linkedAppointment.status = 'completed'; linkedAppointment.paymentStatus = linkedAppointment.paymentStatus === 'demo-paid' ? 'demo-applied' : 'applied';
    }
    const total = Math.max(0, beforeAdvance - depositCredit);
    const order = { id: randomUUID(), receipt: `FM-${Date.now().toString().slice(-8)}`, customerId: customer?.id || null, customerName: customer?.name || 'Walk-in', phone: customer?.phone || '', appointmentReference: linkedAppointment?.reference || null, depositCredit, items: lines, subtotal, discount: appliedDiscount, total, paymentMethod, paymentStatus: 'paid', pointsRedeemed: pointsToUse, pointsEarned: customer ? Math.floor(total * Number(s.settings.pointsPerRupee || 0.1)) : 0, createdAt: new Date().toISOString() };
    for (const line of lines) if (line.type === 'product') { const p = s.products.find((x) => x.id === line.itemId); p.stock -= line.quantity; s.movements.push({ id: randomUUID(), productId: p.id, productName: p.name, quantity: -line.quantity, type: 'sold', note: `Receipt ${order.receipt}`, createdAt: order.createdAt }); }
    if (customer) { customer.points = customer.points - pointsToUse + order.pointsEarned; customer.visits += lines.some((l) => l.type === 'service') ? 1 : 0; }
    s.orders.push(order); await writeState(s); res.status(201).json(order);
  } catch (e) { next(e); }
});
app.get('/api/admin/analytics', async (_req, res, next) => {
  try {
    const s = await readState(); const zone = s.settings.timeZone || scopeStorage.getStore()?.branch.timeZone || 'Etc/UTC'; const month = todayInZone(zone).slice(0, 7); const orders = s.orders.filter((o) => dateKeyInZone(o.createdAt, zone).startsWith(month));
    const daily = Array.from({ length: 7 }, (_, i) => { const d = wallTimeInZone(todayInZone(zone), '12:00', zone); d.setUTCDate(d.getUTCDate() - (6 - i)); const key = dateKeyInZone(d, zone); return { date: key, revenue: s.orders.filter((o) => dateKeyInZone(o.createdAt, zone) === key).reduce((n, o) => n + o.total, 0), orders: s.orders.filter((o) => dateKeyInZone(o.createdAt, zone) === key).length }; });
    const serviceSales = {}; for (const o of s.orders) for (const l of o.items) if (l.type === 'service') serviceSales[l.name] = (serviceSales[l.name] || 0) + l.lineTotal;
    res.json({ monthRevenue: orders.reduce((n, o) => n + o.total, 0), monthOrders: orders.length, averageTicket: orders.length ? Math.round(orders.reduce((n, o) => n + o.total, 0) / orders.length) : 0, totalCustomers: s.customers.length, daily, serviceSales: Object.entries(serviceSales).map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue), movements: s.movements.slice(-10).reverse() });
  } catch (e) { next(e); }
});
app.get('/api/admin/settings', async (_req, res, next) => { try { res.json((await readState()).settings); } catch (e) { next(e); } });
app.patch('/api/admin/settings', async (req, res, next) => {
  try { const s = await readState(); const { openingTime, closingTime, openDays, businessName } = req.body || {}; if (openingTime && !/^\d{2}:\d{2}$/.test(openingTime) || closingTime && !/^\d{2}:\d{2}$/.test(closingTime)) return res.status(400).json({ error: 'Enter times in HH:MM format.' }); if (openingTime) s.settings.openingTime = openingTime; if (closingTime) s.settings.closingTime = closingTime; if (Array.isArray(openDays)) s.settings.openDays = openDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6); if (typeof businessName === 'string' && businessName.trim()) s.settings.businessName = businessName.trim().slice(0, 80); await writeState(s); res.json(s.settings); } catch (e) { next(e); }
});
app.get('/api/admin/movements', async (_req, res, next) => { try { res.json((await readState()).movements.slice().reverse()); } catch (e) { next(e); } });
app.get('/api/admin/ics/:id', async (req, res, next) => {
  try { const s = await readState(); const a = s.appointments.find((x) => x.id === req.params.id); if (!a) return res.status(404).end(); const date = a.date.replaceAll('-', ''); const time = a.time.replace(':', '') + '00'; const end = minutes(a.time) + a.minutes; const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}${String(end % 60).padStart(2, '0')}00`; res.type('text/calendar').attachment(`booking-${a.reference}.ics`).send(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FORME//Barber Studio//EN\r\nBEGIN:VEVENT\r\nUID:${a.id}@forme.local\r\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}\r\nDTSTART:${date}T${time}\r\nDTEND:${date}T${endTime}\r\nSUMMARY:${a.serviceName} at FORME\r\nDESCRIPTION:Booking ${a.reference} with ${a.staffName}\r\nEND:VEVENT\r\nEND:VCALENDAR`); } catch (e) { next(e); }
});

app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' }); if (path.extname(req.path)) return next(); if (req.accepts('html')) return res.sendFile(path.join(clientDir, 'index.html')); next(); });

app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
app.listen(port, () => console.log(`FORME Barber Studio listening on port ${port}`));
