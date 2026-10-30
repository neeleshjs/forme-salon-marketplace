import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import nodemailer from 'nodemailer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, randomInt, timingSafeEqual, createHmac, scrypt as scryptCallback } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import { registerPlatformAdminRoutes } from './platform-admin.js';
import { registerEventMarketplaceRoutes } from './event-marketplace.js';

const app = express();
const port = Number(process.env.PORT || 5050);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(process.env.DATA_FILE || path.join(here, '../data/studio.json'));
const platformFile = path.resolve(process.env.PLATFORM_FILE || path.join(here, '../data/platform.json'));
const dataRoot = path.dirname(dataFile);
const migrationDir = path.resolve(here, '../migrations');
const businessCategoriesFile = path.resolve(here, '../config/business-categories.json');
const { Pool } = pg;
const scryptAsync = promisify(scryptCallback);
const databasePool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true }) : null;
let databaseSetup;
const clientDir = path.resolve(here, '../../client');
const defaultSessionSecret = 'local-prototype-session-secret-change-before-deploy';
const sessionSecret = process.env.SESSION_SECRET || defaultSessionSecret;
if (process.env.NODE_ENV === 'production' && (sessionSecret === defaultSessionSecret || sessionSecret.length < 32)) {
  throw new Error('Production requires a private SESSION_SECRET with at least 32 characters.');
}
const scopeStorage = new AsyncLocalStorage();
const SLOT_STEP = 30;
const CURRENCY = 'INR';
const rateLimitBuckets = new Map();

function requestRateLimit(name, maxRequests, windowMs, identity = (req) => req.ip || req.socket?.remoteAddress || 'unknown') {
  return (req, res, next) => {
    const bucketKey = createHmac('sha256', sessionSecret).update(`${name}:${identity(req) || 'unknown'}`).digest('hex');
    const now = Date.now();
    let bucket = rateLimitBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: `Too many requests. Try again in ${retryAfter} seconds.` });
    }
    if (rateLimitBuckets.size > 10000) {
      for (const [key, entry] of rateLimitBuckets) {
        if (entry.resetAt <= now || rateLimitBuckets.size > 10000) rateLimitBuckets.delete(key);
        if (rateLimitBuckets.size <= 8000) break;
      }
    }
    next();
  };
}

const loginNetworkRateLimit = requestRateLimit('login-network', 100, 15 * 60 * 1000);
const partnerLoginRateLimit = requestRateLimit('partner-login', 10, 15 * 60 * 1000, (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${normalizeEmail(req.body?.email)}`);
const customerLoginRateLimit = requestRateLimit('customer-login', 10, 15 * 60 * 1000, (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${normalizeEmail(req.body?.email)}`);
const registrationRateLimit = requestRateLimit('registration', 8, 15 * 60 * 1000);
const registrationVerifyRateLimit = requestRateLimit('registration-verify', 20, 15 * 60 * 1000);
const passwordResetRateLimit = requestRateLimit('password-reset', 10, 15 * 60 * 1000);
const passwordResetVerifyRateLimit = requestRateLimit('password-reset-verify', 20, 15 * 60 * 1000);
const bookingLookupRateLimit = requestRateLimit('booking-lookup', 20, 15 * 60 * 1000);
const bookingManageRateLimit = requestRateLimit('booking-manage', 20, 15 * 60 * 1000);
const bookingCreateRateLimit = requestRateLimit('booking-create', 20, 15 * 60 * 1000);
const paymentRateLimit = requestRateLimit('payment', 20, 15 * 60 * 1000);
const reviewRateLimit = requestRateLimit('review', 30, 15 * 60 * 1000);
const eventRequestRateLimit = requestRateLimit('event-request', 10, 15 * 60 * 1000);
const eventActionRateLimit = requestRateLimit('event-action', 20, 15 * 60 * 1000);
const platformAdminLoginRateLimit = requestRateLimit('platform-admin-login', 20, 15 * 60 * 1000);
const platformAdminBootstrapRateLimit = requestRateLimit('platform-admin-bootstrap', 5, 15 * 60 * 1000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean));
app.use(cors({ origin: (origin, callback) => callback(null, Boolean(origin && allowedOrigins.has(origin))) }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '64kb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use(express.static(clientDir));

const initialState = (overrides = {}) => {
  return ({
  settings: { businessName: '', branchName: 'Main branch', city: '', country: 'India', currency: CURRENCY, timeZone: 'Asia/Kolkata', locale: 'en-IN', openingTime: '10:00', closingTime: '20:00', openDays: [2, 3, 4, 5, 6, 0], pointsPerRupee: 0.1, redemptionValue: 0.5, ...overrides },
  services: [], staff: [],
  appointments: [], eventReservations: [], customers: [], orders: [], purchaseOrders: [], reviews: [], paymentRecords: [],
  products: [], movements: [],
  });
};

function stateDocumentKey(scope) {
  if (!scope || scope.branch?.isDefault) return 'studio:default';
  return `studio:${scope.tenant.id}:${scope.branch.id}`;
}

async function ensureDatabase() {
  if (!databasePool) return;
  databaseSetup ||= (async () => {
    await databasePool.query(`
      CREATE TABLE IF NOT EXISTS forme_documents (
        document_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await databasePool.query(`
      CREATE TABLE IF NOT EXISTS forme_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const migrationFiles = (await fs.readdir(migrationDir)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
    for (const file of migrationFiles) {
      const version = Number(file.match(/^(\d+)_/)[1]);
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [784215903]);
        const applied = await client.query('SELECT 1 FROM forme_schema_migrations WHERE version = $1', [version]);
        if (!applied.rowCount) {
          await client.query(await fs.readFile(path.join(migrationDir, file), 'utf8'));
          await client.query('INSERT INTO forme_schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    const categories = JSON.parse(await fs.readFile(businessCategoriesFile, 'utf8'));
    for (const category of categories) {
      await databasePool.query(`
        INSERT INTO marketplace_categories (id, slug, name, description, sort_order)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING
      `, [category.id, category.slug, category.name, category.description || '', category.sortOrder || 0]);
      for (const subcategory of category.subcategories || []) {
        await databasePool.query(`
          INSERT INTO marketplace_subcategories (id, category_id, slug, name, sort_order)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING
        `, [subcategory.id, category.id, subcategory.slug, subcategory.name, subcategory.sortOrder || 0]);
      }
    }
  })().catch((error) => { databaseSetup = null; throw error; });
  await databaseSetup;
}

async function getMarketplaceCategories() {
  if (!databasePool) return JSON.parse(await fs.readFile(businessCategoriesFile, 'utf8'));
  await ensureDatabase();
  const { rows: categories } = await databasePool.query('SELECT id, slug, name, description, sort_order AS "sortOrder" FROM marketplace_categories WHERE active = TRUE ORDER BY sort_order, name');
  const { rows: subcategories } = await databasePool.query('SELECT id, category_id AS "categoryId", slug, name, sort_order AS "sortOrder" FROM marketplace_subcategories WHERE active = TRUE ORDER BY sort_order, name');
  const subcategoriesByCategory = new Map();
  for (const subcategory of subcategories) {
    const items = subcategoriesByCategory.get(subcategory.categoryId) || [];
    items.push({ id: subcategory.id, slug: subcategory.slug, name: subcategory.name, sortOrder: subcategory.sortOrder });
    subcategoriesByCategory.set(subcategory.categoryId, items);
  }
  return categories.map((category) => ({ ...category, subcategories: subcategoriesByCategory.get(category.id) || [] }));
}

async function resolveBusinessCategory(categoryId = 'hair-salon', subcategoryId = '') {
  const categories = await getMarketplaceCategories();
  const category = categories.find((item) => item.id === String(categoryId || ''));
  if (!category) throw new Error('Choose an active business category.');
  const subcategory = subcategoryId ? category.subcategories.find((item) => item.id === String(subcategoryId)) : null;
  if (subcategoryId && !subcategory) throw new Error('Choose a subcategory from the selected category.');
  if (category.subcategories.length && !subcategory) throw new Error('Choose a subcategory for this business category.');
  return { categoryId: category.id, categorySlug: category.slug, categoryName: category.name, subcategoryId: subcategory?.id || null, subcategorySlug: subcategory?.slug || null, subcategoryName: subcategory?.name || null };
}

async function readDocument(key) {
  await ensureDatabase();
  const { rows } = await databasePool.query('SELECT payload FROM forme_documents WHERE document_key = $1', [key]);
  return rows[0]?.payload ?? null;
}

async function createDocumentIfMissing(key, value) {
  await ensureDatabase();
  await databasePool.query('INSERT INTO forme_documents (document_key, payload) VALUES ($1, $2::jsonb) ON CONFLICT (document_key) DO NOTHING', [key, JSON.stringify(value)]);
  return readDocument(key);
}

async function writeDocument(key, value) {
  await ensureDatabase();
  await databasePool.query(`
    INSERT INTO forme_documents (document_key, payload) VALUES ($1, $2::jsonb)
    ON CONFLICT (document_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

function pathForScope(scope) {
  if (!scope || scope.branch?.isDefault) return dataFile;
  return path.join(dataRoot, 'tenants', scope.tenant.id, `${scope.branch.id}.json`);
}

async function readStateFor(scope) {
  const overrides = scope?.branch ? { branchName: scope.branch.name, city: scope.branch.city, country: scope.branch.country, currency: scope.branch.currency, timeZone: scope.branch.timeZone, businessName: scope.tenant.name } : {};
  const key = stateDocumentKey(scope);
  if (databasePool) {
    const stored = await readDocument(key) ?? await createDocumentIfMissing(key, initialState(overrides));
    if (Array.isArray(stored)) return { ...initialState(overrides), appointments: stored };
    const base = initialState(overrides);
    return { ...base, ...stored, settings: { ...base.settings, ...(stored.settings || {}) } };
  }
  const file = pathForScope(scope);
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(stored)) return { ...initialState(overrides), appointments: stored };
    const base = initialState(overrides);
    return { ...base, ...stored, settings: { ...base.settings, ...(stored.settings || {}) } };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = initialState(overrides);
    await writeStateFor(scope, state);
    return state;
  }
}

function readState() { return readStateFor(scopeStorage.getStore()); }

async function writeStateFor(scope, state) {
  if (databasePool) return writeDocument(stateDocumentKey(scope), state);
  const file = pathForScope(scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, file);
}

const stateMutationQueues = new Map();
async function mutateStateSafely(mutator, scope = scopeStorage.getStore()) {
  const key = stateDocumentKey(scope);
  const overrides = scope?.branch ? { branchName: scope.branch.name, city: scope.branch.city, country: scope.branch.country, currency: scope.branch.currency, timeZone: scope.branch.timeZone, businessName: scope.tenant.name } : {};
  if (databasePool) {
    await ensureDatabase();
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const { rows } = await client.query('SELECT payload FROM forme_documents WHERE document_key = $1 FOR UPDATE', [key]);
      const stored = rows[0]?.payload;
      const base = initialState(overrides);
      const state = Array.isArray(stored) ? { ...base, appointments: stored } : { ...base, ...(stored || {}), settings: { ...base.settings, ...(stored?.settings || {}) } };
      const result = await mutator(state, { client, scope });
      if (result?.persist !== false) {
        await client.query(`INSERT INTO forme_documents (document_key, payload) VALUES ($1, $2::jsonb)
          ON CONFLICT (document_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [key, JSON.stringify(state)]);
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  const previous = stateMutationQueues.get(key) || Promise.resolve();
  let release;
  const lock = new Promise((resolve) => { release = resolve; });
  stateMutationQueues.set(key, lock);
  await previous;
  try {
    const state = await readStateFor(scope);
    const result = await mutator(state, { client: null, scope });
    if (result?.persist !== false) await writeStateFor(scope, state);
    return result;
  } finally {
    release();
    if (stateMutationQueues.get(key) === lock) stateMutationQueues.delete(key);
  }
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64, { maxmem: 64 * 1024 * 1024 });
  return { salt, hash: derived.toString('hex') };
}
async function passwordMatches(password, user) {
  const actual = await scryptAsync(password, user.passwordSalt, 64, { maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function performDummyPasswordCheck(password) {
  await scryptAsync(password, 'forme-public-auth-dummy-salt', 64, { maxmem: 64 * 1024 * 1024 });
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
let marketplaceRegistrySnapshot = '';
const platformSnapshots = new WeakMap();
let platformFileWriteTail = Promise.resolve();
function platformValuesEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function mergePlatformValue(base, local, latest, field = '') {
  if (platformValuesEqual(local, base)) return structuredClone(latest);
  if (platformValuesEqual(latest, base) || platformValuesEqual(local, latest)) return structuredClone(local);
  if (field === 'attempts' && [base, local, latest].every(Number.isSafeInteger)) return Math.max(0, base + (local - base) + (latest - base));
  if (Array.isArray(base) || Array.isArray(local) || Array.isArray(latest)) {
    const baseRows = Array.isArray(base) ? base : [];
    const localRows = Array.isArray(local) ? local : [];
    const latestRows = Array.isArray(latest) ? latest : [];
    const allRows = [...baseRows, ...localRows, ...latestRows];
    if (allRows.every((row) => row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string')) {
      const before = new Map(baseRows.map((row) => [row.id, row]));
      const ours = new Map(localRows.map((row) => [row.id, row]));
      const theirs = new Map(latestRows.map((row) => [row.id, row]));
      const ids = new Set([...before.keys(), ...ours.keys(), ...theirs.keys()]);
      const merged = [];
      for (const id of ids) {
        const oldRow = before.get(id); const localRow = ours.get(id); const latestRow = theirs.get(id);
        if (oldRow && (!localRow || !latestRow)) {
          if (!localRow && !latestRow) continue;
          if (!localRow && platformValuesEqual(latestRow, oldRow)) continue;
          if (!latestRow && platformValuesEqual(localRow, oldRow)) continue;
          // A delete always wins against an edit to the same one-time challenge.
          continue;
        }
        if (!oldRow) merged.push(structuredClone(localRow || latestRow));
        else merged.push(mergePlatformValue(oldRow, localRow, latestRow));
      }
      return merged;
    }
    // Primitive lists such as tenantIds and userIds merge additions and removals.
    const unique = (items) => [...new Set(items)];
    const oldSet = new Set(baseRows); const localSet = new Set(localRows); const latestSet = new Set(latestRows);
    return unique([...latestRows.filter((item) => !oldSet.has(item) || localSet.has(item)), ...localRows.filter((item) => !oldSet.has(item) && !latestSet.has(item))]);
  }
  if (base && local && latest && [base, local, latest].every((value) => typeof value === 'object')) {
    const merged = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(latest)])) {
      const oldValue = base[key]; const localValue = local[key]; const latestValue = latest[key];
      if (!(key in local) && !(key in latest)) continue;
      if (!(key in local)) { if (platformValuesEqual(latestValue, oldValue)) continue; merged[key] = structuredClone(latestValue); continue; }
      if (!(key in latest)) { if (platformValuesEqual(localValue, oldValue)) continue; merged[key] = structuredClone(localValue); continue; }
      merged[key] = mergePlatformValue(oldValue, localValue, latestValue, key);
    }
    return merged;
  }
  // For conflicting scalar edits, preserve the value already committed by the other writer.
  return structuredClone(latest);
}
function mergePlatformChanges(base, local, latest) {
  const merged = mergePlatformValue(base, local, latest);
  for (const key of ['users', 'customerUsers', 'tenants', 'registrationChallenges', 'passwordResetChallenges', 'otpSendHistory']) merged[key] ||= [];
  const uniqueAccounts = new Set();
  for (const [kind, accounts] of [['partner', merged.users], ['customer', merged.customerUsers]]) {
    for (const account of accounts) {
      const identity = `${kind}:${normalizeEmail(account.email)}`;
      if (!account.email || uniqueAccounts.has(identity)) throw Object.assign(new Error('An account already exists for this email. Please sign in.'), { statusCode: 409 });
      uniqueAccounts.add(identity);
    }
  }
  return merged;
}
function replacePlatformObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
function registrySnapshot(platform) {
  return JSON.stringify({
    users: (platform.users || []).map(({ id, email, name, phone, active }) => [id, email, name, phone, active]),
    customers: (platform.customerUsers || []).map(({ id, email, name, phone, active }) => [id, email, name, phone, active]),
    tenants: (platform.tenants || []).map((tenant) => [tenant.id, tenant.slug, tenant.name, tenant.categoryId, tenant.subcategoryId, tenant.ownerUserId, tenant.reviewStatus, tenant.active, tenant.userIds, (tenant.branches || []).map((branch) => [branch.id, branch.name, branch.slug, branch.city, branch.country, branch.countryCode, branch.currency, branch.timeZone, branch.latitude, branch.longitude, branch.active])]),
  });
}
async function syncMarketplaceRegistry(platform, transactionClient = null) {
  if (!databasePool) return;
  const currentSnapshot = registrySnapshot(platform);
  if (!transactionClient && currentSnapshot === marketplaceRegistrySnapshot) return;
  await ensureDatabase();
  const client = transactionClient || await databasePool.connect();
  try {
    if (!transactionClient) { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)', [784215904]); }
    for (const account of platform.users || []) {
      if (!account?.id || !account.email) continue;
      await client.query(`INSERT INTO marketplace_accounts (id,account_type,email,display_name,phone,active)
        VALUES ($1,'partner',$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,phone=EXCLUDED.phone,active=EXCLUDED.active,updated_at=NOW()`,
      [account.id, normalizeEmail(account.email), String(account.name || '').slice(0, 120), String(account.phone || ''), account.active !== false]);
    }
    for (const account of platform.customerUsers || []) {
      if (!account?.id || !account.email) continue;
      await client.query(`INSERT INTO marketplace_accounts (id,account_type,email,display_name,phone,active)
        VALUES ($1,'customer',$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,phone=EXCLUDED.phone,active=EXCLUDED.active,updated_at=NOW()`,
      [account.id, normalizeEmail(account.email), String(account.name || '').slice(0, 120), String(account.phone || ''), account.active !== false]);
    }
    for (const tenant of platform.tenants || []) {
      if (!tenant?.id || !tenant.slug || !tenant.name) continue;
      const categoryResult = await client.query('SELECT id FROM marketplace_categories WHERE id=$1', [tenant.categoryId || 'hair-salon']);
      const subcategoryResult = tenant.subcategoryId ? await client.query('SELECT id FROM marketplace_subcategories WHERE id=$1 AND category_id=$2', [tenant.subcategoryId, tenant.categoryId || 'hair-salon']) : { rowCount: 0 };
      await client.query(`INSERT INTO marketplace_businesses (id,slug,name,category_id,subcategory_id,owner_account_id,review_status,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,category_id=EXCLUDED.category_id,subcategory_id=EXCLUDED.subcategory_id,owner_account_id=EXCLUDED.owner_account_id,review_status=EXCLUDED.review_status,active=EXCLUDED.active,updated_at=NOW()`,
      [tenant.id, tenant.slug, tenant.name, categoryResult.rowCount ? tenant.categoryId || 'hair-salon' : null, subcategoryResult.rowCount ? tenant.subcategoryId : null, tenant.ownerUserId || null, tenant.reviewStatus || 'approved', tenant.active !== false]);
      for (const userId of tenant.userIds || []) {
        await client.query(`INSERT INTO marketplace_business_memberships (business_id,account_id,role,active)
          VALUES ($1,$2,$3,TRUE) ON CONFLICT (business_id,account_id) DO UPDATE SET role=EXCLUDED.role,active=TRUE`,
        [tenant.id, userId, tenant.ownerUserId === userId ? 'owner' : 'manager']);
      }
      for (const branch of tenant.branches || []) {
        if (!branch?.id || !branch.slug || !branch.name) continue;
        await client.query(`INSERT INTO marketplace_branches (id,business_id,name,slug,city,country,country_code,currency,time_zone,latitude,longitude,active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id,name=EXCLUDED.name,slug=EXCLUDED.slug,city=EXCLUDED.city,country=EXCLUDED.country,country_code=EXCLUDED.country_code,currency=EXCLUDED.currency,time_zone=EXCLUDED.time_zone,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,active=EXCLUDED.active,updated_at=NOW()`,
        [branch.id, tenant.id, branch.name, branch.slug, String(branch.city || ''), String(branch.country || ''), String(branch.countryCode || ''), /^[A-Z]{3}$/.test(branch.currency || '') ? branch.currency : 'INR', branch.timeZone || 'Asia/Kolkata', Number.isFinite(branch.latitude) ? branch.latitude : null, Number.isFinite(branch.longitude) ? branch.longitude : null, branch.active !== false]);
      }
    }
    if (!transactionClient) { await client.query('COMMIT'); marketplaceRegistrySnapshot = currentSnapshot; }
  } catch (error) {
    if (!transactionClient) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (!transactionClient) client.release(); }
}
async function writePlatform(platform) {
  const snapshot = platformSnapshots.get(platform) || { users: [], customerUsers: [], tenants: [], registrationChallenges: [], passwordResetChallenges: [], otpSendHistory: [] };
  if (databasePool) {
    await ensureDatabase(); const client = await databasePool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)', [784215903]);
      const { rows } = await client.query("SELECT payload FROM forme_documents WHERE document_key='platform' FOR UPDATE");
      const latest = rows[0]?.payload || { users: [], customerUsers: [], tenants: [], registrationChallenges: [], passwordResetChallenges: [], otpSendHistory: [] };
      const merged = mergePlatformChanges(snapshot, platform, latest);
      const latestTenants = new Map((latest.tenants || []).map((tenant) => [tenant.id, tenant]));
      for (const tenant of merged.tenants || []) {
        const latest = latestTenants.get(tenant.id);
        if (latest?.reviewDecisionAt && (!tenant.reviewDecisionAt || latest.reviewDecisionAt > tenant.reviewDecisionAt)) {
          tenant.reviewStatus = latest.reviewStatus; tenant.reviewNote = latest.reviewNote || ''; tenant.reviewDecisionAt = latest.reviewDecisionAt; tenant.reviewDecisionBy = latest.reviewDecisionBy;
        }
      }
      await client.query(`INSERT INTO forme_documents (document_key,payload) VALUES ('platform',$1::jsonb)
        ON CONFLICT (document_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()`, [JSON.stringify(merged)]);
      await syncMarketplaceRegistry(merged, client);
      await client.query('COMMIT');
      replacePlatformObject(platform, merged);
      platformSnapshots.set(platform, structuredClone(merged));
      marketplaceRegistrySnapshot = registrySnapshot(merged);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return;
  }
  const previous = platformFileWriteTail;
  let release;
  platformFileWriteTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    let latest;
    try { latest = JSON.parse(await fs.readFile(platformFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; latest = snapshot; }
    const merged = mergePlatformChanges(snapshot, platform, latest);
    await fs.mkdir(path.dirname(platformFile), { recursive: true });
    const temp = `${platformFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(merged, null, 2), 'utf8');
    await fs.rename(temp, platformFile);
    replacePlatformObject(platform, merged);
    platformSnapshots.set(platform, structuredClone(merged));
  } finally { release(); }
}
async function readPlatform() {
  if (databasePool) {
    const platform = await readDocument('platform') ?? await createDocumentIfMissing('platform', { users: [], customerUsers: [], tenants: [], registrationChallenges: [], passwordResetChallenges: [], otpSendHistory: [] });
    platform.users ||= []; platform.customerUsers ||= []; platform.tenants ||= []; platform.registrationChallenges ||= []; platform.passwordResetChallenges ||= []; platform.otpSendHistory ||= [];
    platform.otpSendHistory = platform.otpSendHistory.map((item) => item.id ? item : { ...item, id: randomUUID() });
    platformSnapshots.set(platform, structuredClone(platform));
    const now = Date.now(); const challengeCount = platform.registrationChallenges.length; const historyCount = platform.otpSendHistory.length;
    platform.registrationChallenges = platform.registrationChallenges.filter((item) => item.expiresAt > now);
    platform.otpSendHistory = platform.otpSendHistory.filter((item) => now - item.createdAt < 60 * 60 * 1000);
    if (challengeCount !== platform.registrationChallenges.length || historyCount !== platform.otpSendHistory.length) await writePlatform(platform);
    else await syncMarketplaceRegistry(platform);
    return platform;
  }
  try {
    const platform = JSON.parse(await fs.readFile(platformFile, 'utf8')); platform.users ||= []; platform.customerUsers ||= []; platform.tenants ||= []; platform.registrationChallenges ||= []; platform.passwordResetChallenges ||= []; platform.otpSendHistory ||= [];
    platform.otpSendHistory = platform.otpSendHistory.map((item) => item.id ? item : { ...item, id: randomUUID() });
    platformSnapshots.set(platform, structuredClone(platform));
    const now = Date.now(); const challengeCount = platform.registrationChallenges.length; const historyCount = platform.otpSendHistory.length;
    platform.registrationChallenges = platform.registrationChallenges.filter((item) => item.expiresAt > now);
    platform.otpSendHistory = platform.otpSendHistory.filter((item) => now - item.createdAt < 60 * 60 * 1000);
    if (challengeCount !== platform.registrationChallenges.length || historyCount !== platform.otpSendHistory.length) await writePlatform(platform);
    return platform;
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const emptyPlatform = { users: [], customerUsers: [], tenants: [], registrationChallenges: [], passwordResetChallenges: [], otpSendHistory: [] };
    platformSnapshots.set(emptyPlatform, structuredClone(emptyPlatform));
    await writePlatform(emptyPlatform);
    return emptyPlatform;
  }
}
function tenantChoices(platform, user) {
  if (!user || user.active === false) return [];
  return platform.tenants.filter((tenant) => tenant.active && user.tenantIds.includes(tenant.id)).map((tenant) => ({ id: tenant.id, slug: tenant.slug, name: tenant.name, categoryId: tenant.categoryId || 'hair-salon', categoryName: tenant.categoryName || 'Hair salon and unisex salon', subcategoryId: tenant.subcategoryId || null, subcategoryName: tenant.subcategoryName || null, reviewStatus: tenant.reviewStatus || 'approved', reviewNote: tenant.reviewNote || '', branches: tenant.branches.filter((branch) => branch.active).map(({ id, name, slug, city, country, currency, timeZone }) => ({ id, name, slug, city, country, currency, timeZone })) }));
}
function tenantWorkspace(tenant, branch) { return { tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country, currency: branch.currency, timeZone: branch.timeZone, reviewStatus: tenant.reviewStatus || 'approved', reviewNote: tenant.reviewNote || '' }; }
function makeSession(user, tenant, branch) {
  return signToken({ type: 'session', userId: user.id, authVersion: accountAuthVersion(user), email: user.email, tenantId: tenant.id, branchId: branch.id, role: tenant.ownerUserId === user.id ? 'owner' : 'manager', exp: Date.now() + 12 * 60 * 60 * 1000 });
}
function accountAuthVersion(user) { return Number.isSafeInteger(user?.authVersion) && user.authVersion >= 0 ? user.authVersion : 0; }
function authVersionMatches(auth, user) { return Number(auth?.authVersion || 0) === accountAuthVersion(user); }
function makeCustomerSession(user) { return signToken({ type: 'customer', customerUserId: user.id, authVersion: accountAuthVersion(user), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); }
function customerFromRequest(req, platform = scopeStorage.getStore()?.platform) {
  const auth = verifyToken(req.get('x-customer-token'));
  if (auth?.type !== 'customer' || !platform) return null;
  const user = platform.customerUsers?.find((item) => item.id === auth.customerUserId && item.active !== false);
  return user && authVersionMatches(auth, user) ? user : null;
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
  const category = await resolveBusinessCategory(details.categoryId || 'hair-salon', details.subcategoryId || '');
  const baseSlug = slugify(businessName);
  const slug = platform.tenants.some((t) => t.slug === baseSlug) ? `${baseSlug}-${randomBytes(2).toString('hex')}` : baseSlug;
  const tenant = { id: randomUUID(), slug, name: businessName, ...category, ownerUserId: user.id, userIds: [user.id], createdAt: new Date().toISOString(), active: true, reviewStatus: 'pending_review', reviewNote: '', branches: [] };
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
function validDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function escapeCalendarText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
function validTimeString(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour < 24 && minute < 60;
}
function validSlotStart(value, openingTime) {
  if (!validTimeString(value) || !validTimeString(openingTime)) return false;
  const offset = minutes(value) - minutes(openingTime);
  return offset >= 0 && offset % SLOT_STEP === 0;
}
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
function normalizePhoneNumber(value) {
  const raw = String(value || '').trim(); let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+') && digits.length === 10) digits = `${String(process.env.OTP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '')}${digits}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new Error('Enter a phone number with country code, for example +91 98765 43210.');
  return { e164: `+${digits}`, digits };
}
function emailDeliveryProvider() {
  if (process.env.GMAIL_APPS_SCRIPT_URL || process.env.GMAIL_APPS_SCRIPT_TOKEN) return 'gmail-apps-script';
  if (process.env.RESEND_API_KEY && process.env.OTP_EMAIL_FROM) return 'resend';
  if (process.env.GMAIL_SMTP_USER || process.env.GMAIL_SMTP_APP_PASSWORD) return 'gmail';
  return '';
}
function emailDeliveryReady() {
  const provider = emailDeliveryProvider();
  if (provider === 'gmail-apps-script') return Boolean(process.env.GMAIL_APPS_SCRIPT_URL && String(process.env.GMAIL_APPS_SCRIPT_TOKEN || '').trim().length >= 32);
  if (provider === 'gmail') return Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD);
  return provider === 'resend';
}
function emailDeliveryConfigurationError() {
  const provider = emailDeliveryProvider();
  if (provider === 'gmail-apps-script') return 'Gmail mail bridge is incomplete. Set its deployment URL and token in Render.';
  if (provider === 'gmail') return 'Gmail SMTP needs both GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD in Render.';
  return 'Email verification is not configured yet. Please contact the salon platform administrator.';
}
function emailOtpConfigurationReady() { return emailDeliveryReady(); }
function passwordResetEmailReady() { return emailDeliveryReady(); }
function maskedEmail(email) { const [name, domain] = email.split('@'); return `${name.slice(0, 1)}${'*'.repeat(Math.max(2, name.length - 1))}@${domain}`; }
function hashOtp(challengeId, channel, value) { return createHmac('sha256', sessionSecret).update(`${challengeId}:${channel}:${value}`).digest(); }
function otpMatches(challengeId, channel, value, expectedHex) {
  const actual = hashOtp(challengeId, channel, String(value || ''));
  let expected; try { expected = Buffer.from(expectedHex || '', 'hex'); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function sendEmail({ email, subject, html }) {
  if (emailDeliveryProvider() === 'gmail-apps-script') {
    let endpoint;
    try { endpoint = new URL(process.env.GMAIL_APPS_SCRIPT_URL || ''); } catch { throw Object.assign(new Error('Gmail mail bridge URL is invalid.'), { deliveryChannel: 'email', emailProvider: 'gmail-apps-script' }); }
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com' || String(process.env.GMAIL_APPS_SCRIPT_TOKEN || '').trim().length < 32) {
      throw Object.assign(new Error('Gmail mail bridge configuration is incomplete.'), { deliveryChannel: 'email', emailProvider: 'gmail-apps-script' });
    }
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: process.env.GMAIL_APPS_SCRIPT_TOKEN, to: email, subject, html }) });
    } catch {
      throw Object.assign(new Error('Gmail mail bridge is unavailable.'), { deliveryChannel: 'email', emailProvider: 'gmail-apps-script' });
    }
    if (!response.ok) throw Object.assign(new Error('Gmail mail bridge rejected the email.'), { deliveryChannel: 'email', emailProvider: 'gmail-apps-script', providerStatus: response.status });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!result?.ok) throw Object.assign(new Error('Gmail mail bridge did not accept the email.'), { deliveryChannel: 'email', emailProvider: 'gmail-apps-script', providerCode: result?.error || 'invalid-response' });
    return;
  }
  if (emailDeliveryProvider() === 'gmail') {
    const username = String(process.env.GMAIL_SMTP_USER || '').trim();
    const appPassword = String(process.env.GMAIL_SMTP_APP_PASSWORD || '').replace(/\s/g, '');
    if (!username || !appPassword) throw Object.assign(new Error('Gmail SMTP is not fully configured.'), { deliveryChannel: 'email', emailProvider: 'gmail' });
    const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: username, pass: appPassword }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try {
      await transporter.sendMail({ from: `FORME <${username}>`, to: email, subject, html });
    } catch (error) {
      throw Object.assign(new Error('Gmail SMTP could not send the email.'), { deliveryChannel: 'email', emailProvider: 'gmail', providerCode: error.code || null });
    } finally {
      transporter.close();
    }
    return;
  }
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.OTP_EMAIL_FROM, to: [email], subject, html }) });
  } catch {
    throw Object.assign(new Error('Email verification service is unavailable.'), { deliveryChannel: 'email', emailProvider: 'resend' });
  }
  if (!response.ok) throw Object.assign(new Error('Email provider rejected verification.'), { deliveryChannel: 'email', emailProvider: 'resend', providerStatus: response.status });
}
async function sendVerificationEmail(email, code) {
  await sendEmail({ email, subject: 'Your FORME verification code', html: `<div style="font-family:Arial,sans-serif;color:#17211c"><h2>Verify your FORME account</h2><p>Your email verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>` });
}
async function sendPasswordResetEmail(email, code) {
  await sendEmail({ email, subject: 'Reset your FORME password', html: `<div style="font-family:Arial,sans-serif;color:#17211c"><h2>Reset your FORME password</h2><p>Your password reset code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not request a password reset, you can ignore this email.</p></div>` });
}
function registrationDeliveryError(error) {
  if (error.emailProvider === 'gmail-apps-script') return 'Gmail mail bridge could not send the OTP. Check its deployment URL, token, and Google Apps Script mail quota.';
  if (error.emailProvider === 'gmail' && ['ETIMEDOUT', 'EHOSTUNREACH'].includes(error.providerCode)) return 'Gmail SMTP timed out. Render Free blocks SMTP ports; configure the Gmail Apps Script mail bridge to send OTPs over HTTPS.';
  if (error.emailProvider === 'gmail') return 'Gmail could not send the OTP. Check the Gmail address and App Password in Render; do not use your normal Gmail password.';
  if (error.deliveryChannel === 'email' && error.providerStatus === 403) return 'Email OTP was blocked by Resend. For testing, use the email address on the Resend account, or verify a sender domain and set OTP_EMAIL_FROM to an address on that domain.';
  if (error.deliveryChannel === 'email' && error.providerStatus === 401) return 'Email OTP could not be authorized. Check the Resend API key in Render.';
  return 'Email OTP could not be sent. Check Resend email settings and try again.';
}
async function startRegistrationVerification(platform, { purpose, email, phone, registration }) {
  if (!emailOtpConfigurationReady()) return { status: 503, error: emailDeliveryConfigurationError() };
  const now = Date.now(); platform.registrationChallenges ||= []; platform.otpSendHistory ||= [];
  platform.otpSendHistory = platform.otpSendHistory.filter((item) => now - item.createdAt < 60 * 60 * 1000);
  const recent = platform.otpSendHistory.filter((item) => item.flow !== 'password-reset' && (item.email === email || item.phone === phone));
  const latestAttemptAt = recent.reduce((latest, item) => Math.max(latest, Number(item.createdAt) || 0), 0);
  if (latestAttemptAt && now - latestAttemptAt < 60 * 1000) return { status: 429, error: 'Please wait one minute before requesting another code.' };
  const challengeId = randomUUID(); const emailCode = String(randomInt(100000, 1000000));
  platform.registrationChallenges = platform.registrationChallenges.filter((item) => !(item.purpose === purpose && item.email === email) && item.expiresAt > now);
  const challengeRecord = { id: challengeId, purpose, email, phone, emailOtpHash: hashOtp(challengeId, 'email', emailCode).toString('hex'), registration, attempts: 0, expiresAt: now + 10 * 60 * 1000, createdAt: now };
  const sendAttempt = { id: randomUUID(), email, phone, flow: 'signup', createdAt: now, delivered: false };
  platform.registrationChallenges.push(challengeRecord); platform.otpSendHistory.push(sendAttempt); await writePlatform(platform);
  try {
    await sendVerificationEmail(email, emailCode);
    const persistedAttempt = platform.otpSendHistory.find((item) => item.id === sendAttempt.id);
    if (persistedAttempt) persistedAttempt.delivered = true;
    await writePlatform(platform);
  } catch (error) {
    console.warn('Signup OTP delivery failed.', { channel: error.deliveryChannel || 'unknown', provider: error.emailProvider || null, providerStatus: error.providerStatus || null, providerCode: error.providerCode || null });
    platform.registrationChallenges = platform.registrationChallenges.filter((item) => item.id !== challengeId);
    await writePlatform(platform);
    return { status: 502, error: registrationDeliveryError(error) };
  }
  return { status: 200, challengeId, emailHint: maskedEmail(email), expiresInSeconds: 600 };
}
async function verifyRegistrationCodes(platform, { challengeId, purpose, emailCode }) {
  platform.registrationChallenges ||= []; const challenge = platform.registrationChallenges.find((item) => item.id === challengeId && item.purpose === purpose);
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.attempts >= 5) return { error: 'These codes are invalid or expired. Request new codes and try again.' };
  challenge.attempts += 1;
  const valid = otpMatches(challenge.id, 'email', emailCode, challenge.emailOtpHash);
  if (!valid) { await writePlatform(platform); return { error: 'The email code is incorrect.' }; }
  return { challenge };
}
async function startPasswordReset(platform, { accountType, email }) {
  if (!passwordResetEmailReady()) return { status: 503, error: emailDeliveryConfigurationError() };
  const purpose = `${accountType}-password-reset`; const now = Date.now();
  platform.passwordResetChallenges ||= []; platform.otpSendHistory ||= [];
  platform.passwordResetChallenges = platform.passwordResetChallenges.filter((item) => item.expiresAt > now);
  platform.otpSendHistory = platform.otpSendHistory.filter((item) => now - item.createdAt < 60 * 60 * 1000);
  const account = accountType === 'customer'
    ? platform.customerUsers.find((item) => item.email === email && item.active !== false)
    : platform.users.find((item) => item.email === email);
  const activeChallenge = platform.passwordResetChallenges.find((item) => item.purpose === purpose && item.email === email);
  const recent = platform.otpSendHistory.filter((item) => item.email === email && item.flow === 'password-reset');
  const coolingDown = recent.some((item) => now - item.createdAt < 60 * 1000);
  const rateLimited = coolingDown;
  if (rateLimited && activeChallenge) return { status: 202, challengeId: activeChallenge.id };

  const challengeId = randomUUID(); const code = String(randomInt(100000, 1000000));
  const canSend = Boolean(account) && !rateLimited;
  const challenge = { id: challengeId, purpose, accountType, email, userId: canSend ? account.id : null, emailOtpHash: hashOtp(challengeId, 'email', code).toString('hex'), attempts: 0, expiresAt: now + 10 * 60 * 1000, createdAt: now };
  platform.passwordResetChallenges = platform.passwordResetChallenges.filter((item) => !(item.purpose === purpose && item.email === email));
  platform.passwordResetChallenges.push(challenge);
  if (!rateLimited) platform.otpSendHistory.push({ email, phone: '', flow: 'password-reset', createdAt: now });
  await writePlatform(platform);
  return { status: 202, challengeId, emailCode: canSend ? code : null };
}
async function verifyPasswordReset(platform, { challengeId, accountType, emailCode }) {
  platform.passwordResetChallenges ||= [];
  const purpose = `${accountType}-password-reset`;
  const challenge = platform.passwordResetChallenges.find((item) => item.id === challengeId && item.purpose === purpose);
  const genericError = 'The code is invalid or expired. Request a new password reset code and try again.';
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.attempts >= 5) return { error: genericError };
  challenge.attempts += 1;
  const valid = otpMatches(challenge.id, 'email', emailCode, challenge.emailOtpHash);
  const user = challenge.userId && (accountType === 'customer' ? platform.customerUsers.find((item) => item.id === challenge.userId) : platform.users.find((item) => item.id === challenge.userId));
  if (!valid || !user || user.email !== challenge.email || user.active === false) { await writePlatform(platform); return { error: genericError }; }
  return { challenge, user };
}
async function completePasswordReset(platform, { challengeId, accountType, emailCode, password }) {
  const result = await verifyPasswordReset(platform, { challengeId, accountType, emailCode });
  if (result.error) return result;
  const { user } = result; const credentials = await hashPassword(password); const now = new Date().toISOString();
  user.passwordSalt = credentials.salt; user.passwordHash = credentials.hash; user.authVersion = accountAuthVersion(user) + 1; user.passwordUpdatedAt = now; user.emailVerifiedAt ||= now;
  platform.passwordResetChallenges = platform.passwordResetChallenges.filter((item) => !(item.accountType === accountType && item.email === user.email));
  await writePlatform(platform);
  return { user };
}
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
function availableStaffForSlot(state, date, time, service, excludeIds = []) {
  const weekday = weekdayFromDate(date);
  const start = minutes(time);
  const end = start + service.minutes;
  if (!state.settings.openDays.includes(weekday) || start < minutes(state.settings.openingTime) || end > minutes(state.settings.closingTime)) return [];
  return state.staff.filter((staff) => {
    if (!staff.active || !staff.days.includes(weekday) || start < minutes(staff.start) || end > minutes(staff.end)) return false;
    const appointmentConflict = state.appointments.some((item) => {
      if (excludeIds.includes(item.id) || item.status === 'cancelled' || (item.status === 'awaiting-payment' && item.paymentExpiresAt && new Date(item.paymentExpiresAt) < new Date()) || item.staffId !== staff.id || item.date !== date) return false;
      const otherStart = minutes(item.time);
      const otherEnd = otherStart + Number(item.minutes || 30);
      return start < otherEnd && otherStart < end;
    });
    if (appointmentConflict) return false;
    return !(state.eventReservations || []).some((item) => item.status !== 'released' && item.staffId === staff.id && item.date === date && start < minutes(item.endTime) && minutes(item.startTime) < end);
  });
}
function slotAvailable(state, date, time, service, staffId, excludeId = null) {
  const available = availableStaffForSlot(state, date, time, service, excludeId ? [excludeId] : []);
  return staffId ? available.some((staff) => staff.id === staffId) : available.length > 0;
}
function assignStaff(state, date, time, service, preferredId, excludeId = null) {
  const candidates = preferredId ? [getStaff(state, preferredId)].filter(Boolean) : state.staff.filter((s) => s.active);
  return candidates.find((staff) => slotAvailable(state, date, time, service, staff.id, excludeId)) || null;
}
function assignStaffForParty(state, date, time, service, partySize, preferredStaffId = '', excludeIds = []) {
  const available = availableStaffForSlot(state, date, time, service, excludeIds);
  let candidates = available;
  if (preferredStaffId) {
    const preferred = available.find((staff) => staff.id === preferredStaffId);
    if (!preferred) return [];
    candidates = [preferred, ...available.filter((staff) => staff.id !== preferredStaffId)];
  }
  return candidates.length >= partySize ? candidates.slice(0, partySize) : [];
}
function bookingGroupAppointments(state, appointment, customerUserId = appointment?.customerUserId) {
  if (!appointment) return [];
  if (!appointment.groupId) return [appointment];
  return state.appointments.filter((item) => item.groupId === appointment.groupId && item.customerUserId === customerUserId);
}
function confirmBookingGroup(appointments, { paymentStatus, paymentId = null } = {}) {
  const paidAt = new Date().toISOString();
  for (const appointment of appointments) {
    appointment.status = 'confirmed';
    appointment.paymentStatus = paymentStatus;
    appointment.depositPaid = appointment.depositAmount;
    appointment.paymentId = paymentId;
    appointment.paidAt = paidAt;
  }
}
function makeReference() { return randomBytes(8).toString('hex').toUpperCase(); }

app.get('/api/health', async (_req, res) => {
  try {
    if (databasePool) { await ensureDatabase(); await databasePool.query('SELECT 1'); }
    res.json({ status: 'ok', app: 'FORME Salon Cloud', storage: databasePool ? 'postgres' : 'file' });
  } catch {
    res.status(503).json({ status: 'unavailable', app: 'FORME Salon Cloud', storage: 'postgres' });
  }
});
app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET; if (!secret) return res.status(503).json({ error: 'Payment webhook secret is not configured.' });
    const signature = Buffer.from(String(req.get('x-razorpay-signature') || ''), 'hex'); const expected = createHmac('sha256', secret).update(req.rawBody || '').digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return res.status(400).json({ error: 'Invalid webhook signature.' });
    if (req.body?.event !== 'payment.captured') return res.json({ received: true });
    const entity = req.body?.payload?.payment?.entity; if (!entity?.order_id || !entity?.id) return res.status(400).json({ error: 'Payment event is missing its order or payment ID.' });
    if (entity.status && entity.status !== 'captured') return res.status(400).json({ error: 'Payment event is not captured.' });
    const platform = await readPlatform();
    for (const tenant of platform.tenants) for (const branch of tenant.branches || []) {
      const scope = { tenant, branch };
      const outcome = await mutateStateSafely((state) => {
        const record = (state.paymentRecords || []).find((item) => item.orderId === entity.order_id);
        if (!record) return { persist: false, found: false };
        if (entity.amount !== record.amountMinor || entity.currency !== record.currency) return { persist: false, found: true, invalidAmount: true };
        const appointmentIds = record.appointmentIds || [record.appointmentId];
        const appointments = state.appointments.filter((item) => appointmentIds.includes(item.id));
        if (!appointments.length || appointments.length !== appointmentIds.length) return { persist: false, found: true, missingAppointments: true };
        if (record.status === 'captured' && record.paymentId === entity.id) return { persist: false, found: true };
        const alreadyPaidByAnotherPayment = appointments.some((item) => item.paymentId && item.paymentId !== entity.id);
        const bookingNoLongerPayable = appointments.some((item) => item.status !== 'awaiting-payment' || (item.paymentExpiresAt && new Date(item.paymentExpiresAt) <= new Date()));
        if (record.status === 'captured' || alreadyPaidByAnotherPayment || bookingNoLongerPayable) {
          record.status = 'duplicate-captured'; record.paymentId = entity.id; record.requiresRefundReview = true; record.refundReviewReason = 'A captured payment arrived after this booking was already paid, changed, or expired.'; record.capturedAt = new Date().toISOString();
          return { found: true, duplicateCapture: true };
        }
        record.status = 'captured'; record.paymentId = entity.id;
        record.capturedAt = new Date().toISOString();
        confirmBookingGroup(appointments, { paymentStatus: 'deposit-paid', paymentId: entity.id });
        return { found: true };
      }, scope);
      if (!outcome.found) continue;
      if (outcome.invalidAmount) return res.status(400).json({ error: 'Captured payment amount does not match the booking deposit.' });
      if (outcome.missingAppointments) return res.status(404).json({ error: 'Payment booking was not found.' });
      if (outcome.duplicateCapture) return res.json({ received: true, reviewRequired: true });
      return res.json({ received: true });
    }
    res.status(404).json({ error: 'No booking matches this payment order.' });
  } catch (e) { next(e); }
});
app.get('/api/public/categories', async (_req, res, next) => {
  try { res.json(await getMarketplaceCategories()); } catch (e) { next(e); }
});
app.get('/api/public/salons', async (req, res, next) => {
  try {
    const platform = await readPlatform();
    const q = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
    const searchTerms = q.split(/[\s,]+/).map((term) => term.trim()).filter((term) => term.length > 1);
    const matchesSearch = (value) => searchTerms.some((term) => String(value || '').toLowerCase().includes(term));
    const city = String(req.query.city || '').trim().toLowerCase();
    const country = String(req.query.country || '').trim().toLowerCase();
    const categoryId = String(req.query.categoryId || '').trim();
    const priceFilter = (value, name) => {
      if (value === undefined || String(value).trim() === '') return null;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw Object.assign(new Error(`Enter a valid ${name} price.`), { statusCode: 400 });
      return amount;
    };
    const minPrice = priceFilter(req.query.minPrice, 'minimum');
    const maxPrice = priceFilter(req.query.maxPrice, 'maximum');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return res.status(400).json({ error: 'Minimum price must be less than or equal to maximum price.' });
    const userLatitude = Number(req.query.lat); const userLongitude = Number(req.query.lng); const hasLocation = Number.isFinite(userLatitude) && userLatitude >= -90 && userLatitude <= 90 && Number.isFinite(userLongitude) && userLongitude >= -180 && userLongitude <= 180;
    const sort = ['recommended', 'price_asc', 'price_desc', 'rating', 'distance'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'recommended';
    const categories = await getMarketplaceCategories();
    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const locations = platform.tenants.filter((tenant) => tenant.active && (tenant.reviewStatus || 'approved') === 'approved' && (!categoryId || tenant.categoryId === categoryId)).flatMap((tenant) => (tenant.branches || []).filter((branch) => branch.active && (!city || String(branch.city || '').toLowerCase().includes(city)) && (!country || String(branch.country || '').toLowerCase() === country)).map((branch) => ({ tenant, branch })));
    const salons = (await Promise.all(locations.map(async ({ tenant, branch }) => {
      const category = categoriesById.get(tenant.categoryId);
      const subcategory = category?.subcategories?.find((item) => item.id === tenant.subcategoryId);
      const categoryName = category?.name || tenant.categoryName || 'Beauty and wellness';
      const subcategoryName = subcategory?.name || tenant.subcategoryName || null;
      const state = await readStateFor({ tenant, branch });
      const activeServices = (state.services || []).filter((service) => service.active === true);
      const businessText = `${tenant.name} ${branch.name} ${branch.city || ''} ${branch.country || ''} ${categoryName} ${subcategoryName || ''}`.toLowerCase();
      const businessMatchesQuery = !q || matchesSearch(businessText);
      const priceServices = activeServices.filter((service) => Number.isFinite(Number(service.price)) && (minPrice === null || Number(service.price) >= minPrice) && (maxPrice === null || Number(service.price) <= maxPrice));
      const serviceMatches = q ? priceServices.filter((service) => matchesSearch(`${service.name || ''} ${service.category || ''} ${service.description || ''}`)) : priceServices;
      if (q && !businessMatchesQuery && !serviceMatches.length) return null;
      if ((minPrice !== null || maxPrice !== null) && !priceServices.length) return null;
      const resultServices = (serviceMatches.length ? serviceMatches : businessMatchesQuery ? priceServices : []).slice().sort((a, b) => Number(a.price) - Number(b.price));
      const selectedServices = resultServices.slice(0, 3);
      const reviews = state.reviews || [];
      const ratingCount = reviews.length;
      return {
        name: tenant.name, slug: tenant.slug, categoryId: tenant.categoryId || 'hair-salon', categoryName,
        subcategoryId: tenant.subcategoryId || null, subcategoryName,
        branchId: branch.id, branchName: branch.name, city: branch.city, country: branch.country,
        currency: branch.currency || 'INR', timeZone: branch.timeZone,
        latitude: branch.latitude ?? null, longitude: branch.longitude ?? null,
        averageRating: ratingCount ? Math.round(reviews.reduce((sum, review) => sum + review.rating, 0) / ratingCount * 10) / 10 : null,
        ratingCount,
        distanceKm: hasLocation && Number.isFinite(branch.latitude) && Number.isFinite(branch.longitude) ? Math.round(distanceKm(userLatitude, userLongitude, branch.latitude, branch.longitude) * 10) / 10 : null,
        startingPrice: resultServices.length ? Number(resultServices[0].price) : null,
        serviceCount: resultServices.length,
        services: selectedServices.map((service) => ({ name: service.name, category: service.category || '', price: Number(service.price), minutes: Number(service.minutes) || null })),
        _serviceMatch: Boolean(q && serviceMatches.length),
      };
    }))).filter(Boolean);
    if (sort === 'price_asc') salons.sort((a, b) => (a.startingPrice ?? Infinity) - (b.startingPrice ?? Infinity));
    else if (sort === 'price_desc') salons.sort((a, b) => (b.startingPrice ?? -Infinity) - (a.startingPrice ?? -Infinity));
    else if (sort === 'rating') salons.sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0));
    else if (sort === 'distance' || hasLocation) salons.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    else salons.sort((a, b) => Number(b._serviceMatch) - Number(a._serviceMatch) || (b.averageRating ?? -1) - (a.averageRating ?? -1));
    for (const salon of salons) delete salon._serviceMatch;
    res.json(salons);
  } catch (e) { next(e); }
});
app.post('/api/customer/register', registrationRateLimit, async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body || {}; const normalized = normalizeEmail(email);
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80 || normalized.length > 254 || !/^\S+@\S+\.\S+$/.test(normalized) || !validPhone(String(phone || '')) || typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter your name, valid email, phone, and a password between 8 and 128 characters.' });
    const platform = await readPlatform(); if (platform.customerUsers.some((user) => user.email === normalized)) return res.status(409).json({ error: 'An account already exists for this email. Please sign in.' });
    let contactPhone; try { contactPhone = normalizePhoneNumber(phone).e164; } catch (error) { return res.status(400).json({ error: error.message }); }
    const credentials = await hashPassword(password);
    const result = await startRegistrationVerification(platform, { purpose: 'customer', email: normalized, phone: contactPhone, registration: { name: name.trim().slice(0, 80), email: normalized, phone: contactPhone, passwordSalt: credentials.salt, passwordHash: credentials.hash } });
    if (result.error) return res.status(result.status).json({ error: result.error });
    const { status, ...challenge } = result; res.status(202).json(challenge);
  } catch (e) { next(e); }
});
app.post('/api/customer/verify-registration', registrationVerifyRateLimit, async (req, res, next) => {
  try {
    const platform = await readPlatform(); const result = await verifyRegistrationCodes(platform, { challengeId: String(req.body?.challengeId || ''), purpose: 'customer', emailCode: String(req.body?.emailCode || '') });
    if (result.error) return res.status(400).json({ error: result.error });
    const { challenge } = result; const data = challenge.registration;
    if (platform.customerUsers.some((user) => user.email === data.email)) return res.status(409).json({ error: 'An account already exists for this email. Please sign in.' });
    const verifiedAt = new Date().toISOString();
    const user = { id: randomUUID(), name: data.name, email: data.email, phone: data.phone, passwordSalt: data.passwordSalt, passwordHash: data.passwordHash, emailVerifiedAt: verifiedAt, phoneVerifiedAt: null, createdAt: verifiedAt, active: true };
    platform.customerUsers.push(user); platform.registrationChallenges = platform.registrationChallenges.filter((item) => item.id !== challenge.id); await writePlatform(platform);
    res.status(201).json({ customerToken: makeCustomerSession(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (e) { next(e); }
});
app.post('/api/customer/login', loginNetworkRateLimit, customerLoginRateLimit, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const email = normalizeEmail(req.body?.email);
    if (password.length > 128 || email.length > 254) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const platform = await readPlatform(); const user = platform.customerUsers.find((item) => item.email === email && item.active !== false);
    if (!user) await performDummyPasswordCheck(password);
    if (!user || !await passwordMatches(password, user)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    res.json({ customerToken: makeCustomerSession(user), customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (e) { next(e); }
});
app.post('/api/customer/password-reset/start', passwordResetRateLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const platform = await readPlatform(); const result = await startPasswordReset(platform, { accountType: 'customer', email });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(202).json({ challengeId: result.challengeId, expiresInSeconds: 600, message: 'If an account matches that email, a password reset code has been sent.' });
    if (result.emailCode) sendPasswordResetEmail(email, result.emailCode).catch(() => console.warn('Password reset email delivery failed.'));
  } catch (e) { next(e); }
});
app.post('/api/customer/password-reset/complete', passwordResetVerifyRateLimit, async (req, res, next) => {
  try {
    const { challengeId, emailCode, password } = req.body || {};
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Choose a password between 8 and 128 characters.' });
    if (!/^\d{6}$/.test(String(emailCode || ''))) return res.status(400).json({ error: 'The code is invalid or expired. Request a new password reset code and try again.' });
    const platform = await readPlatform(); const result = await completePasswordReset(platform, { challengeId: String(challengeId || ''), accountType: 'customer', emailCode: String(emailCode), password });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (e) { next(e); }
});
app.get('/api/customer/me', async (req, res, next) => {
  try { const platform = await readPlatform(); const user = customerFromRequest(req, platform); if (!user) return res.status(401).json({ error: 'Sign in to continue.' }); res.json({ customer: { id: user.id, name: user.name, email: user.email, phone: user.phone } }); } catch (e) { next(e); }
});
app.post('/api/auth/register', registrationRateLimit, async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body || {}; const normalized = normalizeEmail(email);
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80 || normalized.length > 254 || !/^\S+@\S+\.\S+$/.test(normalized) || !validPhone(String(phone || '')) || typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter your name, a valid email, phone number, and a password between 8 and 128 characters.' });
    const details = req.body || {}; const businessName = String(details.businessName || '').trim(); const branchName = String(details.branchName || 'Main branch').trim(); const country = String(details.country || '').trim(); const currency = String(details.currency || 'USD').trim().toUpperCase(); const timeZone = String(details.timeZone || 'Etc/UTC').trim();
    if (businessName.length < 2 || branchName.length < 2 || !country || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Enter a business name, location, country, and three-letter currency.' });
    let category; try { category = await resolveBusinessCategory(details.categoryId || 'hair-salon', details.subcategoryId || ''); } catch (error) { return res.status(400).json({ error: error.message }); }
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); new Intl.NumberFormat('en', { style: 'currency', currency }).format(1); parseCoordinates(details); }
    catch { return res.status(400).json({ error: 'Enter a valid country, currency, time zone, and map pin.' }); }
    let contactPhone; try { contactPhone = normalizePhoneNumber(phone).e164; } catch (error) { return res.status(400).json({ error: error.message }); }
    const platform = await readPlatform(); const existing = platform.users.find((user) => user.email === normalized);
    if (existing && !await passwordMatches(password, existing)) return res.status(409).json({ error: 'This email already has an account. Sign in with its password to add another salon.' });
    const credentials = existing ? { salt: existing.passwordSalt, hash: existing.passwordHash } : await hashPassword(password);
    const registration = { name: existing?.name || name.trim().slice(0, 80), email: normalized, phone: contactPhone, passwordSalt: credentials.salt, passwordHash: credentials.hash, existingUserId: existing?.id || null, tenantDetails: { businessName, branchName, city: details.city, country, countryCode: details.countryCode, currency, timeZone, locale: details.locale, latitude: details.latitude, longitude: details.longitude, categoryId: category.categoryId, subcategoryId: category.subcategoryId } };
    const result = await startRegistrationVerification(platform, { purpose: 'partner', email: normalized, phone: contactPhone, registration });
    if (result.error) return res.status(result.status).json({ error: result.error });
    const { status, ...challenge } = result; res.status(202).json(challenge);
  } catch (e) { next(e); }
});
app.post('/api/auth/verify-registration', registrationVerifyRateLimit, async (req, res, next) => {
  try {
    const platform = await readPlatform(); const result = await verifyRegistrationCodes(platform, { challengeId: String(req.body?.challengeId || ''), purpose: 'partner', emailCode: String(req.body?.emailCode || '') });
    if (result.error) return res.status(400).json({ error: result.error });
    const { challenge } = result; const data = challenge.registration; let user = data.existingUserId ? platform.users.find((item) => item.id === data.existingUserId) : null;
    if (data.existingUserId && !user) return res.status(409).json({ error: 'This owner account is no longer available. Please start signup again.' });
    const conflictingUser = platform.users.find((item) => item.email === data.email && item.id !== user?.id);
    if (conflictingUser) return res.status(409).json({ error: 'This email already has an account. Please sign in instead.' });
    if (!user) { user = { id: randomUUID(), name: data.name, email: data.email, phone: data.phone, passwordSalt: data.passwordSalt, passwordHash: data.passwordHash, tenantIds: [], emailVerifiedAt: new Date().toISOString(), phoneVerifiedAt: null, createdAt: new Date().toISOString() }; platform.users.push(user); }
    else { if (user.phone !== data.phone) user.phoneVerifiedAt = null; user.phone = data.phone; user.emailVerifiedAt ||= new Date().toISOString(); }
    user.tenantIds ||= []; const { tenant, branch } = await createTenantForUser(platform, user, data.tenantDetails);
    platform.registrationChallenges = platform.registrationChallenges.filter((item) => item.id !== challenge.id); await writePlatform(platform);
    res.status(201).json({ sessionToken: makeSession(user, tenant, branch), user: { id: user.id, name: user.name, email: user.email }, workspace: tenantWorkspace(tenant, branch), organizations: tenantChoices(platform, user) });
  } catch (e) { if (e.message.startsWith('Enter a business') || e.message.startsWith('Choose a') || e.message.startsWith('Enter both valid map coordinates')) return res.status(400).json({ error: e.message }); next(e); }
});
app.post('/api/auth/login', loginNetworkRateLimit, partnerLoginRateLimit, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const email = normalizeEmail(req.body?.email);
    if (password.length > 128 || email.length > 254) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.email === email && u.active !== false);
    if (!user) await performDummyPasswordCheck(password);
    if (!user || !await passwordMatches(password, user)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const organizations = tenantChoices(platform, user);
    if (!organizations.length) return res.status(403).json({ error: 'This account has no active salon workspace.' });
    res.json({ loginToken: signToken({ type: 'login', userId: user.id, authVersion: accountAuthVersion(user), exp: Date.now() + 10 * 60 * 1000 }), user: { id: user.id, name: user.name, email: user.email }, organizations });
  } catch (e) { next(e); }
});
app.post('/api/auth/password-reset/start', passwordResetRateLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const platform = await readPlatform(); const result = await startPasswordReset(platform, { accountType: 'partner', email });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(202).json({ challengeId: result.challengeId, expiresInSeconds: 600, message: 'If an account matches that email, a password reset code has been sent.' });
    if (result.emailCode) sendPasswordResetEmail(email, result.emailCode).catch(() => console.warn('Password reset email delivery failed.'));
  } catch (e) { next(e); }
});
app.post('/api/auth/password-reset/complete', passwordResetVerifyRateLimit, async (req, res, next) => {
  try {
    const { challengeId, emailCode, password } = req.body || {};
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Choose a password between 8 and 128 characters.' });
    if (!/^\d{6}$/.test(String(emailCode || ''))) return res.status(400).json({ error: 'The code is invalid or expired. Request a new password reset code and try again.' });
    const platform = await readPlatform(); const result = await completePasswordReset(platform, { challengeId: String(challengeId || ''), accountType: 'partner', emailCode: String(emailCode), password });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (e) { next(e); }
});
app.post('/api/auth/select', async (req, res, next) => {
  try {
    const auth = verifyToken(req.body?.loginToken); if (auth?.type !== 'login') return res.status(401).json({ error: 'Your sign-in session expired. Please sign in again.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId && u.active !== false); const tenant = platform.tenants.find((t) => t.id === req.body?.tenantId && t.active && t.userIds.includes(user?.id)); const branch = tenant?.branches.find((b) => b.id === req.body?.branchId && b.active);
    if (!user || !authVersionMatches(auth, user)) return res.status(401).json({ error: 'Your sign-in session expired. Please sign in again.' });
    if (!user || !tenant || !branch) return res.status(403).json({ error: 'You do not have access to this salon location.' });
    res.json({ sessionToken: makeSession(user, tenant, branch), user: { id: user.id, name: user.name, email: user.email }, workspace: tenantWorkspace(tenant, branch), organizations: tenantChoices(platform, user) });
  } catch (e) { next(e); }
});
app.get('/api/auth/me', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId && u.active !== false); const tenant = platform.tenants.find((t) => t.id === auth.tenantId && t.active && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === auth.branchId && b.active);
    if (!user || !authVersionMatches(auth, user)) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!tenant || !branch) return res.status(401).json({ error: 'This workspace is no longer available.' });
    res.json({ user: { id: user.id, name: user.name, email: user.email }, workspace: tenantWorkspace(tenant, branch), organizations: tenantChoices(platform, user) });
  } catch (e) { next(e); }
});
app.post('/api/auth/switch-context', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId && u.active !== false); const tenant = platform.tenants.find((t) => t.id === req.body?.tenantId && t.active && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === req.body?.branchId && b.active);
    if (!user || !authVersionMatches(auth, user)) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!tenant || !branch) return res.status(403).json({ error: 'You do not have access to this salon location.' });
    res.json({ sessionToken: makeSession(user, tenant, branch), workspace: tenantWorkspace(tenant, branch) });
  } catch (e) { next(e); }
});
app.post('/api/auth/create-organization', async (req, res, next) => {
  try {
    const auth = verifyToken(req.get('x-session-token')); if (auth?.type !== 'session') return res.status(401).json({ error: 'Sign in to continue.' });
    const platform = await readPlatform(); const user = platform.users.find((u) => u.id === auth.userId && u.active !== false); if (!user || !authVersionMatches(auth, user)) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    const { tenant, branch } = await createTenantForUser(platform, user, req.body || {}); await writePlatform(platform);
    res.status(201).json({ sessionToken: makeSession(user, tenant, branch), workspace: tenantWorkspace(tenant, branch) });
  } catch (e) { if (e.message.startsWith('Enter a business') || e.message.startsWith('Choose a')) return res.status(400).json({ error: e.message }); next(e); }
});
registerPlatformAdminRoutes(app, { databasePool, ensureDatabase, sessionSecret, readPlatform, sendEmail, platformAdminLoginRateLimit, platformAdminBootstrapRateLimit });
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  try {
    const platform = await readPlatform();
    if (req.path === '/public/salons') return scopeStorage.run({ platform }, next);
    if (req.path.startsWith('/public/events/') || req.path.startsWith('/events/') || req.path === '/customer/events') return scopeStorage.run({ platform }, next);
    if (req.path.startsWith('/admin/')) {
      const auth = verifyToken(req.get('x-session-token'));
      if (auth?.type !== 'session') return res.status(401).json({ error: 'Please sign in to a salon workspace.' });
      const user = platform.users.find((u) => u.id === auth.userId && u.active !== false); const tenant = platform.tenants.find((t) => t.id === auth.tenantId && t.active && t.userIds.includes(auth.userId)); const branch = tenant?.branches.find((b) => b.id === auth.branchId && b.active);
      if (!user || !authVersionMatches(auth, user) || !tenant || !branch) return res.status(401).json({ error: 'This workspace session is no longer valid. Please sign in again.' });
      return scopeStorage.run({ platform, user, tenant, branch, session: auth }, next);
    }
    const slug = String(req.get('x-salon-slug') || req.query.salon || 'forme').toLowerCase(); const tenant = platform.tenants.find((t) => t.slug === slug && t.active && (t.reviewStatus || 'approved') === 'approved');
    const requestedBranch = req.get('x-branch-id') || req.query.branch; const branch = tenant?.branches.find((b) => b.active && (!requestedBranch || b.id === requestedBranch || b.slug === requestedBranch)) || (!requestedBranch ? tenant?.branches.find((b) => b.active) : null);
    if (!tenant || !branch) return res.status(404).json({ error: 'Salon location not found.' });
    return scopeStorage.run({ platform, tenant, branch }, next);
  } catch (e) { next(e); }
});
app.get('/api/salon/profile', async (_req, res, next) => {
  try { const scope = scopeStorage.getStore(); const state = await readState(); res.json({ tenantName: scope.tenant.name, tenantSlug: scope.tenant.slug, categoryId: scope.tenant.categoryId || 'hair-salon', categoryName: scope.tenant.categoryName || 'Hair salon and unisex salon', subcategoryId: scope.tenant.subcategoryId || null, subcategoryName: scope.tenant.subcategoryName || null, branch: scope.branch, settings: state.settings }); } catch (e) { next(e); }
});
app.get('/api/reviews', async (_req, res, next) => {
  try { const reviews = (await readState()).reviews || []; const averageRating = reviews.length ? Math.round(reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length * 10) / 10 : null; res.json({ averageRating, ratingCount: reviews.length, reviews: reviews.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(({ rating, comment, customerName, createdAt }) => ({ rating, comment, customerName, createdAt })) }); } catch (e) { next(e); }
});
app.post('/api/reviews', reviewRateLimit, async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to review this salon.' });
    const rating = Number(req.body?.rating); const reference = String(req.body?.reference || '').trim().toUpperCase(); const comment = String(req.body?.comment || '').trim().slice(0, 500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5 stars.' });
    const outcome = await mutateStateSafely((state) => {
      const appointment = state.appointments.find((item) => item.reference === reference && item.customerUserId === user.id);
      if (!appointment || appointment.status !== 'completed') return { persist: false, httpStatus: 403, error: 'You can rate a salon after your completed visit.' };
      state.reviews ||= [];
      if (state.reviews.some((item) => item.appointmentId === appointment.id)) return { persist: false, httpStatus: 409, error: 'This visit already has a review.' };
      const review = { id: randomUUID(), appointmentId: appointment.id, rating, comment, customerName: user.name.split(' ')[0], createdAt: new Date().toISOString() };
      state.reviews.push(review);
      return { review };
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.status(201).json({ review: outcome.review });
  } catch (e) { next(e); }
});
app.get('/api/customer/bookings', async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope?.platform);
    if (!user) return res.status(401).json({ error: 'Sign in to see your bookings.' });
    const branches = scope.platform.tenants.flatMap((tenant) => (tenant.branches || []).map((branch) => ({ tenant, branch })));
    const bookings = (await Promise.all(branches.map(async ({ tenant, branch }) => {
      const state = await readStateFor({ tenant, branch });
      return state.appointments.filter((item) => item.customerUserId === user.id).map((item) => ({ reference: item.reference, serviceName: item.serviceName, staffName: item.staffName, groupId: item.groupId || null, groupIndex: item.groupIndex || 1, partySize: item.partySize || 1, date: item.date, time: item.time, status: item.status, paymentStatus: item.paymentStatus, depositAmount: item.depositAmount, depositCurrency: item.depositCurrency, depositForfeited: item.depositForfeited, salonName: tenant.name, salonSlug: tenant.slug, branchName: branch.name, branchId: branch.id }));
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
    if (!service || !validDateString(date)) return res.status(400).json({ error: 'Choose a service and valid date.' });
    const partySize = Number(req.query.partySize || 1);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) return res.status(400).json({ error: 'Choose between 1 and 4 people.' });
    const preferredStaffId = String(req.query.staffId || '');
    const weekday = weekdayFromDate(date);
    const slots = [];
    const open = minutes(state.settings.openingTime);
    const close = minutes(state.settings.closingTime);
    for (let start = open; start < close; start += SLOT_STEP) {
      const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      if (wallTimeInZone(date, time, state.settings.timeZone || scopeStorage.getStore()?.branch.timeZone || 'Etc/UTC') <= new Date()) continue;
      const staff = state.settings.openDays.includes(weekday) ? availableStaffForSlot(state, date, time, service) : [];
      if (staff.length >= partySize && (!preferredStaffId || staff.some((member) => member.id === preferredStaffId))) slots.push({ time, staff: staff.map(({ id, name, role, color }) => ({ id, name, role, color })) });
    }
    res.json({ date, service, partySize, slots });
  } catch (e) { next(e); }
});

app.post('/api/appointments', bookingCreateRateLimit, async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const customerUser = customerFromRequest(req, scope.platform);
    if (!customerUser) return res.status(401).json({ error: 'Create an account or sign in before booking.' });
    if (req.body?.depositPolicyAccepted !== true) return res.status(400).json({ error: 'Please accept the booking advance and no-show policy.' });
    const { serviceId, staffId = '', date, time, notes = '' } = req.body || {}; const { name, phone } = customerUser;
    const partySize = Number(req.body?.partySize || 1);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) return res.status(400).json({ error: 'Choose between 1 and 4 people.' });
    if (!validDateString(date) || !validTimeString(time)) return res.status(400).json({ error: 'Choose a valid date and available time.' });
    if (wallTimeInZone(date, time, scope.branch?.timeZone || 'Etc/UTC') <= new Date()) return res.status(400).json({ error: 'Choose a future time.' });
    const outcome = await mutateStateSafely((state) => {
      if (!validSlotStart(time, state.settings.openingTime)) return { persist: false, httpStatus: 400, error: 'Choose an available appointment time.' };
      const service = getService(state, serviceId);
      if (!service) return { persist: false, httpStatus: 400, error: 'Choose a valid service.' };
      const assignedStaff = assignStaffForParty(state, date, time, service, partySize, staffId);
      if (assignedStaff.length !== partySize) return { persist: false, httpStatus: 409, error: `That time needs ${partySize} available team member${partySize === 1 ? '' : 's'}. Please choose another time.` };
      const customer = ensureCustomer(state, { name, phone, notes: typeof notes === 'string' ? notes.trim().slice(0, 300) : '' });
      const depositPercent = 25; const groupId = partySize > 1 ? randomUUID() : null; const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const appointments = assignedStaff.map((staff, index) => {
        const depositAmount = Math.max(1, Math.round(service.price * depositPercent / 100));
        const appointment = { id: randomUUID(), reference: makeReference(), groupId, groupIndex: index + 1, partySize, customerId: customer.id, customerUserId: customerUser.id, customerEmail: customerUser.email, name, phone, serviceId, serviceName: service.name, minutes: service.minutes, price: service.price, staffId: staff.id, staffName: staff.name, date, time, notes: typeof notes === 'string' ? notes.trim().slice(0, 300) : '', status: 'awaiting-payment', paymentStatus: 'deposit_due', depositAmount, depositCurrency: scope.branch.currency || state.settings.currency || 'INR', depositPercent, depositForfeited: false, paymentExpiresAt: expiresAt, createdAt: new Date().toISOString() };
        state.appointments.push(appointment);
        return appointment;
      });
      const depositTotal = appointments.reduce((total, appointment) => total + appointment.depositAmount, 0);
      return { appointment: { reference: appointments[0].reference, groupId, partySize, name, serviceName: service.name, staffName: appointments[0].staffName, staffNames: assignedStaff.map((member) => member.name), date, time, minutes: service.minutes, price: service.price * partySize, status: 'awaiting-payment', depositAmount: depositTotal, depositCurrency: appointments[0].depositCurrency, depositPercent }, appointments: appointments.map((appointment) => ({ reference: appointment.reference, staffName: appointment.staffName, groupIndex: appointment.groupIndex, partySize: appointment.partySize })), groupId, partySize };
    }, scope);
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.status(201).json(outcome);
  } catch (e) { next(e); }
});

app.post('/api/payments/order', paymentRateLimit, async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to pay your booking deposit.' });
    const state = await readState(); const appointment = state.appointments.find((item) => item.reference === String(req.body?.reference || '').toUpperCase() && item.customerUserId === user.id);
    if (!appointment || appointment.status !== 'awaiting-payment' || new Date(appointment.paymentExpiresAt) < new Date()) return res.status(409).json({ error: 'This booking hold expired. Please choose a time again.' });
    const appointments = bookingGroupAppointments(state, appointment, user.id);
    if (appointments.some((item) => item.status !== 'awaiting-payment' || new Date(item.paymentExpiresAt) < new Date())) return res.status(409).json({ error: 'One or more group booking holds expired. Please choose a time again.' });
    const currency = appointment.depositCurrency; const depositTotal = appointments.reduce((total, item) => total + Number(item.depositAmount || 0), 0); const amountMinor = Math.round(depositTotal * (['JPY','KRW','VND','CLP'].includes(currency) ? 1 : 100));
    const keyId = process.env.RAZORPAY_KEY_ID; const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return res.json({ mode: 'demo', reference: appointment.reference, amount: depositTotal, currency, partySize: appointments.length, references: appointments.map((item) => item.reference), message: 'Demo payment only. No money will be charged.' });
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amountMinor, currency, receipt: appointment.reference, notes: { salon: scope.tenant.name, branch: scope.branch.name, appointment: appointment.reference } }) });
    const order = await response.json(); if (!response.ok) return res.status(502).json({ error: order.error?.description || 'Could not start online payment.' });
    const recordResult = await mutateStateSafely((latest) => {
      const current = latest.appointments.find((item) => item.id === appointment.id && item.customerUserId === user.id);
      const group = bookingGroupAppointments(latest, current, user.id);
      if (!current || group.length !== appointments.length || group.some((item) => item.status !== 'awaiting-payment' || new Date(item.paymentExpiresAt) < new Date())) return { persist: false, ok: false };
      latest.paymentRecords ||= [];
      latest.paymentRecords.push({ id: randomUUID(), appointmentId: current.id, appointmentIds: group.map((item) => item.id), groupId: current.groupId || null, customerUserId: user.id, provider: 'razorpay', orderId: order.id, amount: depositTotal, amountMinor, currency, status: 'created', createdAt: new Date().toISOString() });
      return { ok: true };
    }, scope);
    if (!recordResult.ok) return res.status(409).json({ error: 'This booking hold changed while payment was starting. Please choose a time again.' });
    res.json({ mode: 'razorpay', keyId, orderId: order.id, amount: amountMinor, currency, name: scope.tenant.name, description: `${appointment.depositPercent}% booking advance · ${appointment.reference}`, prefill: { name: user.name, email: user.email, contact: user.phone } });
  } catch (e) { next(e); }
});
app.post('/api/payments/demo-confirm', paymentRateLimit, async (req, res, next) => {
  try {
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return res.status(403).json({ error: 'Demo payments are disabled while Razorpay is configured.' });
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to confirm this payment.' });
    const outcome = await mutateStateSafely((state) => {
      const appointment = state.appointments.find((item) => item.reference === String(req.body?.reference || '').toUpperCase() && item.customerUserId === user.id);
      const appointments = bookingGroupAppointments(state, appointment, user.id);
      if (!appointment || appointments.some((item) => item.status !== 'awaiting-payment' || new Date(item.paymentExpiresAt) < new Date())) return { persist: false, error: 'The booking hold expired. Choose another time.' };
      const depositTotal = appointments.reduce((total, item) => total + Number(item.depositAmount || 0), 0);
      confirmBookingGroup(appointments, { paymentStatus: 'demo-paid' });
      state.paymentRecords ||= []; state.paymentRecords.push({ id: randomUUID(), appointmentId: appointment.id, appointmentIds: appointments.map((item) => item.id), groupId: appointment.groupId || null, customerUserId: user.id, provider: 'demo', amount: depositTotal, currency: appointment.depositCurrency, status: 'demo-paid', createdAt: new Date().toISOString() });
      return { reference: appointment.reference, status: appointment.status, paymentStatus: appointment.paymentStatus, depositAmount: depositTotal, currency: appointment.depositCurrency, partySize: appointments.length, references: appointments.map((item) => item.reference), demo: true };
    }, scope);
    if (outcome.error) return res.status(409).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.post('/api/payments/verify', paymentRateLimit, async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore(); const user = customerFromRequest(req, scope.platform); if (!user) return res.status(401).json({ error: 'Sign in to confirm payment.' });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {}; const state = await readState(); const record = (state.paymentRecords || []).find((item) => item.orderId === orderId && item.customerUserId === user.id);
    if (!record || !paymentId || !signature) return res.status(400).json({ error: 'Payment details do not match a booking.' });
    const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest(); const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return res.status(400).json({ error: 'Payment signature verification failed.' });
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64'); const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { signal: AbortSignal.timeout(10000), headers: { Authorization: `Basic ${auth}` } }); const payment = await response.json();
    if (!response.ok || payment.order_id !== orderId || payment.status !== 'captured' || payment.amount !== record.amountMinor || payment.currency !== record.currency) return res.status(409).json({ error: 'Payment is not captured for the expected deposit. Check status or try again.' });
    const outcome = await mutateStateSafely((latest) => {
      const latestRecord = (latest.paymentRecords || []).find((item) => item.orderId === orderId && item.customerUserId === user.id);
      if (!latestRecord) return { persist: false, error: 'Payment booking was not found.' };
      const appointmentIds = latestRecord.appointmentIds || [latestRecord.appointmentId];
      const appointments = latest.appointments.filter((item) => appointmentIds.includes(item.id));
      if (!appointments.length || appointments.length !== appointmentIds.length) return { persist: false, error: 'Payment booking was not found.' };
      if (latestRecord.status === 'captured' && latestRecord.paymentId === paymentId) return { reference: appointments[0].reference, status: 'confirmed', paymentStatus: 'deposit-paid', depositAmount: latestRecord.amount, currency: latestRecord.currency, partySize: appointments.length, references: appointments.map((item) => item.reference) };
      const alreadyPaidByAnotherPayment = appointments.some((item) => item.paymentId && item.paymentId !== paymentId);
      const bookingNoLongerPayable = appointments.some((item) => item.status !== 'awaiting-payment' || (item.paymentExpiresAt && new Date(item.paymentExpiresAt) <= new Date()));
      if (latestRecord.status === 'captured' || alreadyPaidByAnotherPayment || bookingNoLongerPayable) {
        latestRecord.status = 'duplicate-captured'; latestRecord.paymentId = paymentId; latestRecord.requiresRefundReview = true; latestRecord.refundReviewReason = 'A captured payment arrived after this booking was already paid, changed, or expired.'; latestRecord.capturedAt = new Date().toISOString();
        return { error: 'This booking was already paid, changed, or expired. The captured payment is flagged for refund review.' };
      }
      confirmBookingGroup(appointments, { paymentStatus: 'deposit-paid', paymentId });
      latestRecord.status = 'captured'; latestRecord.paymentId = paymentId; latestRecord.capturedAt = new Date().toISOString();
      return { reference: appointments[0].reference, status: 'confirmed', paymentStatus: 'deposit-paid', depositAmount: latestRecord.amount, currency: latestRecord.currency, partySize: appointments.length, references: appointments.map((item) => item.reference) };
    }, scope);
    if (outcome.error) return res.status(404).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});

app.post('/api/booking/lookup', bookingLookupRateLimit, async (req, res, next) => {
  try {
    const state = await readState();
    const item = state.appointments.find((a) => a.reference === String(req.body?.reference || '').toUpperCase() && a.phone === String(req.body?.phone || '').trim());
    if (!item) return res.status(404).json({ error: 'Booking reference or phone number does not match.' });
    res.json({ reference: item.reference, name: item.name, serviceId: item.serviceId, serviceName: item.serviceName, staffId: item.staffId, staffName: item.staffName, date: item.date, time: item.time, minutes: item.minutes, price: item.price, status: item.status, partySize: item.partySize || 1 });
  } catch (e) { next(e); }
});
app.patch('/api/booking/:reference', bookingManageRateLimit, async (req, res, next) => {
  try {
    const scope = scopeStorage.getStore();
    const outcome = await mutateStateSafely((state) => {
      const item = state.appointments.find((appointment) => appointment.reference === req.params.reference.toUpperCase());
      if (!item || item.phone !== String(req.body?.phone || '').trim()) return { persist: false, httpStatus: 404, error: 'Booking reference or phone number does not match.' };
      const group = bookingGroupAppointments(state, item);
      if (req.body.action === 'cancel') {
        if (group.some((appointment) => !['awaiting-payment', 'confirmed'].includes(appointment.status))) return { persist: false, httpStatus: 409, error: 'This booking can no longer be cancelled online. Contact the salon for help.' };
        for (const appointment of group) { appointment.status = 'cancelled'; appointment.updatedAt = new Date().toISOString(); }
      } else if (req.body.action === 'reschedule') {
        if (group.some((appointment) => !['awaiting-payment', 'confirmed'].includes(appointment.status))) return { persist: false, httpStatus: 409, error: 'This booking can no longer be changed online. Contact the salon for help.' };
        const service = getService(state, item.serviceId);
        const date = String(req.body.date || ''); const time = String(req.body.time || '');
        if (!validDateString(date) || !validSlotStart(time, state.settings.openingTime)) return { persist: false, httpStatus: 400, error: 'Choose a valid date and time.' };
        if (!service || wallTimeInZone(date, time, state.settings.timeZone || scope.branch.timeZone || 'Etc/UTC') <= new Date()) return { persist: false, httpStatus: 409, error: 'That time is not available. Choose another slot.' };
        const assignedStaff = assignStaffForParty(state, date, time, service, group.length, req.body.staffId || item.staffId, group.map((appointment) => appointment.id));
        if (assignedStaff.length !== group.length) return { persist: false, httpStatus: 409, error: `That time needs ${group.length} available team member${group.length === 1 ? '' : 's'}. Choose another time.` };
        group.forEach((appointment, index) => { appointment.date = date; appointment.time = time; appointment.staffId = assignedStaff[index].id; appointment.staffName = assignedStaff[index].name; appointment.updatedAt = new Date().toISOString(); });
      } else return { persist: false, httpStatus: 400, error: 'Choose reschedule or cancel.' };
      return { reference: item.reference, status: item.status, date: item.date, time: item.time, staffName: item.staffName, partySize: group.length, references: group.map((appointment) => appointment.reference), staffNames: group.map((appointment) => appointment.staffName) };
    }, scope);
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});

app.use('/api/admin', requireAdmin);
registerEventMarketplaceRoutes(app, { databasePool, ensureDatabase, scopeStorage, readPlatform, customerFromRequest, mutateStateSafely, readStateFor, distanceKm, wallTimeInZone, minutes, weekdayFromDate, sessionSecret, eventRequestRateLimit, eventActionRateLimit });
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
    const { status, date, time, staffId } = req.body || {};
    if (status && !['confirmed', 'completed', 'cancelled', 'arrived', 'in-service', 'no-show'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const outcome = await mutateStateSafely((state) => {
      const item = state.appointments.find((appointment) => appointment.id === req.params.id);
      if (!item) return { persist: false, httpStatus: 404, error: 'Appointment not found.' };
      if (date || time || staffId) {
        const service = getService(state, item.serviceId);
        const newDate = date || item.date; const newTime = time || item.time;
        if (!validDateString(newDate) || !validTimeString(newTime) || !validSlotStart(newTime, state.settings.openingTime)) return { persist: false, httpStatus: 400, error: 'Choose a valid date and available time.' };
        const staff = service && assignStaff(state, newDate, newTime, service, staffId || item.staffId, item.id);
        if (!staff) return { persist: false, httpStatus: 409, error: 'That chair is no longer available.' };
        item.date = newDate; item.time = newTime; item.staffId = staff.id; item.staffName = staff.name;
      }
      if (status) { item.status = status; if (status === 'no-show' && Number(item.depositPaid) > 0) { item.depositForfeited = true; item.paymentStatus = 'forfeited'; item.depositForfeitedAt = new Date().toISOString(); } }
      item.updatedAt = new Date().toISOString();
      return item;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/staff', async (_req, res, next) => { try { res.json((await readState()).staff); } catch (e) { next(e); } });
app.post('/api/admin/staff', async (req, res, next) => {
  try {
    const { name, role = 'Barber', start = '10:00', end = '20:00', days = [2, 3, 4, 5, 6, 0] } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80 || typeof role !== 'string' || role.trim().length > 50 || !validTimeString(start) || !validTimeString(end) || minutes(start) >= minutes(end)) return res.status(400).json({ error: 'Enter a name and valid working hours.' });
    if (!Array.isArray(days) || !days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'Choose one or more valid working days.' });
    const member = { id: randomUUID(), name: name.trim(), role: role.trim() || 'Barber', start, end, days: [...new Set(days)], active: true, color: '#9cae83' };
    await mutateStateSafely((state) => { state.staff.push(member); return member; });
    res.status(201).json(member);
  } catch (e) { next(e); }
});
app.patch('/api/admin/staff/:id', async (req, res, next) => {
  try {
    const { name, role, start, end, days, active, color } = req.body || {};
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80)) return res.status(400).json({ error: 'Enter a team member name between 2 and 80 characters.' });
    if (role !== undefined && (typeof role !== 'string' || !role.trim() || role.trim().length > 50)) return res.status(400).json({ error: 'Enter a valid role.' });
    if (start !== undefined && !validTimeString(start) || end !== undefined && !validTimeString(end)) return res.status(400).json({ error: 'Enter working hours in valid HH:MM format.' });
    if (start !== undefined && end !== undefined && minutes(start) >= minutes(end)) return res.status(400).json({ error: 'End time must be after start time.' });
    if (days !== undefined && (!Array.isArray(days) || !days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return res.status(400).json({ error: 'Choose one or more valid working days.' });
    if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'Active must be true or false.' });
    if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) return res.status(400).json({ error: 'Choose a valid team color.' });
    const outcome = await mutateStateSafely((state) => {
      const item = state.staff.find((row) => row.id === req.params.id);
      if (!item) return { persist: false, httpStatus: 404, error: 'Team member not found.' };
      const nextStart = start ?? item.start; const nextEnd = end ?? item.end;
      if (minutes(nextStart) >= minutes(nextEnd)) return { persist: false, httpStatus: 400, error: 'End time must be after start time.' };
      if (name !== undefined) item.name = name.trim(); if (role !== undefined) item.role = role.trim(); if (start !== undefined) item.start = start; if (end !== undefined) item.end = end;
      if (days !== undefined) item.days = [...new Set(days)]; if (active !== undefined) item.active = active; if (color !== undefined) item.color = color;
      return item;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/services', async (_req, res, next) => { try { res.json((await readState()).services); } catch (e) { next(e); } });
app.post('/api/admin/services', async (req, res, next) => {
  try {
    const { name, category = 'Hair', minutes: duration, price, description = '' } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100 || typeof category !== 'string' || category.length > 50 || !Number.isInteger(Number(duration)) || Number(duration) < 10 || Number(duration) > 240 || !Number.isFinite(Number(price)) || Number(price) < 0 || typeof description !== 'string' || description.length > 500) return res.status(400).json({ error: 'Enter a service name, duration, price, and valid details.' });
    const item = { id: randomUUID(), name: name.trim(), category: category.trim(), minutes: Number(duration), price: Number(price), description: description.trim(), active: true };
    await mutateStateSafely((state) => { state.services.push(item); return item; });
    res.status(201).json(item);
  } catch (e) { next(e); }
});
app.patch('/api/admin/services/:id', async (req, res, next) => {
  try {
    const { name, category, minutes: duration, price, description, active } = req.body || {};
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) || category !== undefined && (typeof category !== 'string' || category.length > 50) || duration !== undefined && (!Number.isInteger(Number(duration)) || Number(duration) < 10 || Number(duration) > 240) || price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0) || description !== undefined && (typeof description !== 'string' || description.length > 500) || active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'Invalid service details.' });
    const outcome = await mutateStateSafely((state) => {
      const item = state.services.find((row) => row.id === req.params.id);
      if (!item) return { persist: false, httpStatus: 404, error: 'Service not found.' };
      if (name !== undefined) item.name = name.trim(); if (category !== undefined) item.category = category.trim(); if (duration !== undefined) item.minutes = Number(duration); if (price !== undefined) item.price = Number(price); if (description !== undefined) item.description = description.trim(); if (active !== undefined) item.active = active;
      return item;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/customers', async (req, res, next) => {
  try { const s = await readState(); const q = String(req.query.q || '').toLowerCase(); res.json(s.customers.filter((c) => !q || `${c.name} ${c.phone}`.toLowerCase().includes(q)).map((c) => ({ ...c, lastVisit: s.appointments.filter((a) => a.customerId === c.id).sort(byStart).at(-1)?.date || null, lifetimeSpend: s.orders.filter((o) => o.customerId === c.id).reduce((n, o) => n + o.total, 0) }))); } catch (e) { next(e); }
});
app.patch('/api/admin/customers/:id', async (req, res, next) => {
  try {
    if (req.body?.notes !== undefined && (typeof req.body.notes !== 'string' || req.body.notes.length > 500)) return res.status(400).json({ error: 'Customer notes must be 500 characters or fewer.' });
    const outcome = await mutateStateSafely((state) => {
      const customer = state.customers.find((item) => item.id === req.params.id);
      if (!customer) return { persist: false, httpStatus: 404, error: 'Customer not found.' };
      if (typeof req.body?.notes === 'string') customer.notes = req.body.notes;
      return customer;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/products', async (_req, res, next) => { try { res.json((await readState()).products); } catch (e) { next(e); } });
app.post('/api/admin/products', async (req, res, next) => {
  try {
    const { name, category = 'General', price, stock = 0, lowStockAt = 3, sku = '' } = req.body || {};
    const threshold = Number(lowStockAt);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || !Number.isFinite(Number(price)) || Number(price) < 0 || !Number.isInteger(Number(stock)) || Number(stock) < 0 || !Number.isInteger(threshold) || threshold < 0 || threshold > 100000) return res.status(400).json({ error: 'Enter a product name, price, valid stock, and reorder threshold.' });
    const item = { id: randomUUID(), name: name.trim(), category: String(category).slice(0, 60), price: Number(price), stock: Number(stock), lowStockAt: threshold, sku: String(sku).slice(0, 40), active: true };
    await mutateStateSafely((state) => {
      state.products.push(item);
      if (item.stock) state.movements.push({ id: randomUUID(), productId: item.id, productName: item.name, quantity: item.stock, type: 'initial', note: 'Opening stock', createdAt: new Date().toISOString() });
      return item;
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
});
app.post('/api/admin/products/:id/receive', async (req, res, next) => {
  try {
    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return res.status(400).json({ error: 'Enter a positive whole-number quantity.' });
    const outcome = await mutateStateSafely((state) => {
      const product = state.products.find((item) => item.id === req.params.id);
      if (!product) return { persist: false, httpStatus: 404, error: 'Product not found.' };
      product.stock += quantity;
      state.movements.push({ id: randomUUID(), productId: product.id, productName: product.name, quantity, type: 'received', note: String(req.body?.note || 'Stock received').slice(0, 100), createdAt: new Date().toISOString() });
      return product;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/purchases', async (_req, res, next) => { try { res.json((await readState()).purchaseOrders.slice().reverse()); } catch (e) { next(e); } });
app.post('/api/admin/purchases', async (req, res, next) => {
  try {
    const { supplier, productId, quantity } = req.body || {}; const qty = Number(quantity);
    if (typeof supplier !== 'string' || supplier.trim().length < 2 || supplier.trim().length > 100 || !Number.isInteger(qty) || qty < 1 || qty > 10000) return res.status(400).json({ error: 'Enter a supplier and valid quantity.' });
    const outcome = await mutateStateSafely((state) => {
      const product = state.products.find((item) => item.id === productId && item.active);
      if (!product) return { persist: false, httpStatus: 404, error: 'Choose an active product.' };
      const unitCost = Number(product.cost || product.price);
      const order = { id: randomUUID(), reference: `PO-${Date.now().toString().slice(-8)}-${randomBytes(2).toString('hex').toUpperCase()}`, supplier: supplier.trim(), productId: product.id, productName: product.name, quantity: qty, unitCost, total: qty * unitCost, status: 'ordered', createdAt: new Date().toISOString() };
      state.purchaseOrders.push(order);
      return order;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.status(201).json(outcome);
  } catch (e) { next(e); }
});
app.patch('/api/admin/purchases/:id/receive', async (req, res, next) => {
  try {
    const outcome = await mutateStateSafely((state) => {
      const order = state.purchaseOrders.find((item) => item.id === req.params.id);
      if (!order) return { persist: false, httpStatus: 404, error: 'Purchase order not found.' };
      if (order.status === 'received') return { persist: false, httpStatus: 409, error: 'This purchase order was already received.' };
      const product = state.products.find((item) => item.id === order.productId);
      if (!product) return { persist: false, httpStatus: 404, error: 'The ordered product no longer exists.' };
      product.stock += order.quantity; order.status = 'received'; order.receivedAt = new Date().toISOString();
      state.movements.push({ id: randomUUID(), productId: product.id, productName: product.name, quantity: order.quantity, type: 'purchase', note: `${order.reference} · ${order.supplier}`, createdAt: order.receivedAt });
      return order;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/orders', async (_req, res, next) => { try { res.json((await readState()).orders.slice().reverse()); } catch (e) { next(e); } });
app.post('/api/admin/orders', async (req, res, next) => {
  try {
    const { items = [], phone = '', customerName = '', paymentMethod = 'cash', discount = 0, redeemPoints = 0, appointmentReference = '' } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: 'Add between 1 and 50 items to the checkout.' });
    if (!['cash', 'card', 'upi'].includes(paymentMethod)) return res.status(400).json({ error: 'Choose cash, card, or UPI.' });
    if (!Number.isFinite(Number(discount)) || Number(discount) < 0 || !Number.isInteger(Number(redeemPoints)) || Number(redeemPoints) < 0) return res.status(400).json({ error: 'Enter a valid discount and whole-number reward points.' });
    const outcome = await mutateStateSafely((state) => {
      const lines = []; const reservedProducts = new Map();
      for (const raw of items) {
        if (!raw || !['product', 'service'].includes(raw.type)) return { persist: false, httpStatus: 400, error: 'Choose a valid product or service.' };
        const quantity = Number(raw.quantity === undefined ? 1 : raw.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return { persist: false, httpStatus: 400, error: 'Invalid item quantity.' };
        const item = raw.type === 'product' ? state.products.find((row) => row.id === raw.id && row.active) : state.services.find((row) => row.id === raw.id && row.active);
        if (!item) return { persist: false, httpStatus: 400, error: 'One of the selected items is unavailable.' };
        if (raw.type === 'product') {
          const alreadyReserved = reservedProducts.get(item.id) || 0;
          if (item.stock - alreadyReserved < quantity) return { persist: false, httpStatus: 409, error: `${item.name} does not have enough stock for this bill.` };
          reservedProducts.set(item.id, alreadyReserved + quantity);
        }
        lines.push({ type: raw.type, itemId: item.id, name: item.name, quantity, unitPrice: item.price, lineTotal: item.price * quantity });
      }
      const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);
      if (!Number.isFinite(subtotal) || subtotal < 0) return { persist: false, httpStatus: 400, error: 'The bill total is invalid.' };
      const customer = phone && validPhone(phone) ? ensureCustomer(state, { name: String(customerName || 'Studio customer').trim().slice(0, 80), phone: phone.trim() }) : null;
      const pointsToUse = Number(redeemPoints);
      if (pointsToUse && (!customer || customer.points < pointsToUse)) return { persist: false, httpStatus: 400, error: 'Customer does not have enough loyalty points.' };
      const pointsDiscount = pointsToUse * Number(state.settings.redemptionValue || 0.5);
      const appliedDiscount = Math.min(subtotal, Math.min(Number(discount), subtotal) + pointsDiscount);
      const beforeAdvance = Math.max(0, subtotal - appliedDiscount); let depositCredit = 0; let linkedAppointment = null;
      if (appointmentReference) {
        linkedAppointment = state.appointments.find((item) => item.reference === String(appointmentReference).toUpperCase() && item.phone === String(phone).trim());
        if (!linkedAppointment || !['arrived', 'in-service', 'completed'].includes(linkedAppointment.status) || Number(linkedAppointment.depositPaid) <= 0 || linkedAppointment.depositApplied || linkedAppointment.depositForfeited) return { persist: false, httpStatus: 400, error: 'Booking reference has no available deposit to apply. Confirm the customer and booking status.' };
        depositCredit = Math.min(beforeAdvance, Number(linkedAppointment.depositPaid)); linkedAppointment.depositApplied = depositCredit; linkedAppointment.depositAppliedAt = new Date().toISOString(); linkedAppointment.status = 'completed'; linkedAppointment.paymentStatus = linkedAppointment.paymentStatus === 'demo-paid' ? 'demo-applied' : 'applied';
      }
      const total = Math.max(0, beforeAdvance - depositCredit);
      const createdAt = new Date().toISOString();
      const order = { id: randomUUID(), receipt: `FM-${Date.now().toString().slice(-8)}-${randomBytes(2).toString('hex').toUpperCase()}`, customerId: customer?.id || null, customerName: customer?.name || 'Walk-in', phone: customer?.phone || '', appointmentReference: linkedAppointment?.reference || null, depositCredit, items: lines, subtotal, discount: appliedDiscount, total, paymentMethod, paymentStatus: 'paid', pointsRedeemed: pointsToUse, pointsEarned: customer ? Math.floor(total * Number(state.settings.pointsPerRupee || 0.1)) : 0, createdAt };
      for (const [productId, quantity] of reservedProducts) {
        const product = state.products.find((row) => row.id === productId); product.stock -= quantity;
        state.movements.push({ id: randomUUID(), productId: product.id, productName: product.name, quantity: -quantity, type: 'sold', note: `Receipt ${order.receipt}`, createdAt });
      }
      if (customer) { customer.points = customer.points - pointsToUse + order.pointsEarned; customer.visits += lines.some((line) => line.type === 'service') ? 1 : 0; }
      state.orders.push(order);
      return { order };
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.status(201).json(outcome.order);
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
  try {
    const { openingTime, closingTime, openDays, businessName } = req.body || {};
    if (openingTime !== undefined && !validTimeString(openingTime) || closingTime !== undefined && !validTimeString(closingTime)) return res.status(400).json({ error: 'Enter valid opening and closing times in HH:MM format.' });
    if (openDays !== undefined && (!Array.isArray(openDays) || openDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return res.status(400).json({ error: 'Choose valid working days.' });
    if (businessName !== undefined && (typeof businessName !== 'string' || businessName.trim().length > 80)) return res.status(400).json({ error: 'Business name must be 80 characters or fewer.' });
    const outcome = await mutateStateSafely((state) => {
      const nextOpening = openingTime ?? state.settings.openingTime; const nextClosing = closingTime ?? state.settings.closingTime;
      if (minutes(nextOpening) >= minutes(nextClosing)) return { persist: false, httpStatus: 400, error: 'Closing time must be after opening time.' };
      if (openingTime !== undefined) state.settings.openingTime = openingTime;
      if (closingTime !== undefined) state.settings.closingTime = closingTime;
      if (openDays !== undefined) state.settings.openDays = [...new Set(openDays)];
      if (businessName?.trim()) state.settings.businessName = businessName.trim();
      return state.settings;
    });
    if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
    res.json(outcome);
  } catch (e) { next(e); }
});
app.get('/api/admin/movements', async (_req, res, next) => { try { res.json((await readState()).movements.slice().reverse()); } catch (e) { next(e); } });
app.get('/api/admin/ics/:id', async (req, res, next) => {
  try { const s = await readState(); const a = s.appointments.find((x) => x.id === req.params.id); if (!a) return res.status(404).end(); const date = a.date.replaceAll('-', ''); const time = a.time.replace(':', '') + '00'; const end = minutes(a.time) + a.minutes; const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}${String(end % 60).padStart(2, '0')}00`; res.set('Cache-Control', 'private, no-store').type('text/calendar').attachment(`booking-${a.reference}.ics`).send(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FORME//Barber Studio//EN\r\nBEGIN:VEVENT\r\nUID:${a.id}@forme.local\r\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}\r\nDTSTART:${date}T${time}\r\nDTEND:${date}T${endTime}\r\nSUMMARY:${escapeCalendarText(a.serviceName)} at FORME\r\nDESCRIPTION:Booking ${escapeCalendarText(a.reference)} with ${escapeCalendarText(a.staffName)}\r\nEND:VEVENT\r\nEND:VCALENDAR`); } catch (e) { next(e); }
});

app.get('/events', (_req, res) => res.sendFile(path.join(clientDir, 'events.html')));
app.get('/platform-admin', (_req, res) => { res.set({ 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); res.sendFile(path.join(clientDir, 'platform-admin.html')); });
app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' }); if (path.extname(req.path)) return next(); if (req.accepts('html')) return res.sendFile(path.join(clientDir, 'index.html')); next(); });

app.use((error, req, res, _next) => {
  const parserError = typeof error.type === 'string' && error.type.startsWith('entity.');
  const appStatus = !parserError && Number.isInteger(error.statusCode) ? error.statusCode : null;
  const parserStatus = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : null;
  const status = appStatus || parserStatus || 500;
  console.error('Request failed.', { status, code: String(error.code || '').slice(0, 80) || null, name: String(error.name || '').slice(0, 80) || null, method: req.method, path: req.path });
  const message = parserError ? (status === 413 ? 'Request body exceeds the allowed size.' : 'Invalid request body.') : appStatus ? error.message : status === 400 ? 'Invalid request body.' : status === 413 ? 'Request body exceeds the allowed size.' : status < 500 ? 'Request could not be processed.' : 'Something went wrong. Please try again.';
  res.status(status).json({ error: message });
});
app.listen(port, () => console.log(`FORME Barber Studio listening on port ${port}`));
