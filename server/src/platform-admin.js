import { randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE_NAME = 'forme_platform_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITE_MS = 48 * 60 * 60 * 1000;
const BOOTSTRAP_MS = 15 * 60 * 1000;
const ROLES = new Set(['owner', 'reviewer', 'support']);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const normEmail = (value) => String(value || '').trim().toLowerCase();
const bootstrapEmail = () => normEmail(process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL || process.env.GMAIL_SMTP_USER);
const b64 = (value) => Buffer.from(value).toString('base64url');
const secretKey = (secret) => createHmac('sha256', secret).update('FORME/platform-admin/mfa/v1').digest();
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }

function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ciphertext)}`;
}
function unseal(value, key) {
  const [iv, tag, ciphertext] = String(value || '').split('.').map((part) => Buffer.from(part || '', 'base64url'));
  if (!iv?.length || !tag?.length || !ciphertext?.length) throw new Error('Encrypted MFA secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; let output = '';
  for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const output = [];
  for (const char of String(input).toUpperCase().replace(/=+$/g, '')) {
    const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid authenticator secret.');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function totpCounter(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = base32Decode(secret); const current = Math.floor(now / 30000);
  for (const counter of [current - 1, current, current + 1]) {
    const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', key).update(buffer).digest(); const offset = digest[digest.length - 1] & 15;
    const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
    const expected = String(binary % 1000000).padStart(6, '0');
    const actualBuffer = Buffer.from(String(code)); const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)) return counter;
  }
  return null;
}
function newTotpSecret() { return base32Encode(randomBytes(20)); }
function otpAuthUri(secret, email) {
  const label = encodeURIComponent(`FORME Operations:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=FORME%20Operations&algorithm=SHA1&digits=6&period=30`;
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return { salt, hash: scryptSync(password, salt, 64).toString('hex') }; }
function checkPassword(password, user) {
  const actual = scryptSync(String(password || ''), user.password_salt, 64); const expected = Buffer.from(user.password_hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
function safeSlug(value) { return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) { try { return decodeURIComponent(value.join('=')); } catch { return ''; } } }
  return '';
}
function clearCookie(req, res) {
  const secure = String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/api/platform-admin; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
}
function setCookie(req, res, token, expiresAt) {
  const secure = String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api/platform-admin; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${secure}`);
}
function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  let parsed; try { parsed = new URL(origin); } catch { return false; }
  const forwardedHost = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const forwardedProto = String(req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  return parsed.host === forwardedHost && parsed.protocol === `${forwardedProto}:`;
}
function auditRequestAddress(req) { return String(req.socket?.remoteAddress || '').slice(0, 80); }
function sanitizeAdmin(row) { return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, createdAt: row.created_at, mfaEnabled: Boolean(row.totp_secret_encrypted) }; }
function reviewStatus(tenant) { return tenant.reviewStatus || 'approved'; }
function businessReviewRow(tenant, platform) {
  const owner = platform.users.find((user) => user.id === tenant.ownerUserId);
  const branches = (tenant.branches || []).filter((branch) => branch.active !== false);
  return { id: tenant.id, slug: tenant.slug, name: tenant.name, categoryId: tenant.categoryId || 'hair-salon', categoryName: tenant.categoryName || 'Hair salon and unisex salon', subcategoryName: tenant.subcategoryName || null, status: reviewStatus(tenant), reviewNote: tenant.reviewNote || '', createdAt: tenant.createdAt, ownerEmail: owner?.email || '', branches: branches.map((branch) => ({ name: branch.name, city: branch.city || '', country: branch.country || '' })) };
}

export function registerPlatformAdminRoutes(app, { databasePool, ensureDatabase, sessionSecret, readPlatform, sendEmail, platformAdminLoginRateLimit, platformAdminBootstrapRateLimit }) {
  const router = express.Router();
  const key = secretKey(sessionSecret);
  const secureSessionSecret = sessionSecret !== 'local-prototype-session-secret-change-before-deploy';
  async function query(sql, params = []) { if (!databasePool) throw Object.assign(new Error('Platform-admin requires the PostgreSQL database.'), { statusCode: 503 }); await ensureDatabase(); return databasePool.query(sql, params); }
  async function audit(client, actor, req, action, targetType, targetId = '', reason = '', metadata = {}) {
    await client.query(`INSERT INTO platform_admin_audit_events (actor_id, actor_email, action, target_type, target_id, reason, metadata, remote_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [actor?.id || null, actor?.email || 'bootstrap', action, targetType, String(targetId), String(reason).slice(0, 500), JSON.stringify(metadata), auditRequestAddress(req)]);
  }
  async function transact(work) {
    if (!databasePool) throw Object.assign(new Error('Platform-admin requires the PostgreSQL database.'), { statusCode: 503 });
    await ensureDatabase(); const client = await databasePool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function requireSession(req, res, next) {
    const rawToken = getCookie(req, COOKIE_NAME); if (!rawToken) return res.status(401).json({ error: 'Platform admin sign-in required.' });
    try {
      const result = await query(`SELECT s.token_hash, s.csrf_hash, s.expires_at, u.id, u.email, u.name, u.role, u.active
        FROM platform_admin_sessions s JOIN platform_admin_users u ON u.id = s.admin_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [hash(rawToken)]);
      const session = result.rows[0];
      if (!session || !session.active) { clearCookie(req, res); return res.status(401).json({ error: 'Your platform-admin session expired. Sign in again.' }); }
      req.platformAdmin = { id: session.id, email: session.email, name: session.name, role: session.role, tokenHash: session.token_hash, csrfHash: session.csrf_hash, expiresAt: session.expires_at };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!originAllowed(req)) return res.status(403).json({ error: 'Request origin check failed.' });
        const csrf = String(req.get('x-platform-admin-csrf') || ''); const actual = Buffer.from(hash(csrf)); const expected = Buffer.from(session.csrf_hash);
        if (!csrf || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(403).json({ error: 'Admin session security check failed. Refresh the page and try again.' });
      }
      next();
    } catch (error) { next(error); }
  }
  const roles = (...allowed) => (req, res, next) => allowed.includes(req.platformAdmin?.role) ? next() : res.status(403).json({ error: 'Your admin role does not allow this action.' });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req)) return res.status(403).json({ error: 'Request origin check failed.' }); next(); });

  router.get('/bootstrap/status', async (_req, res, next) => {
    try { const { rows } = await query('SELECT EXISTS(SELECT 1 FROM platform_admin_users) AS has_admin'); res.json({ hasAdmin: rows[0].has_admin, bootstrapEnabled: Boolean(secureSessionSecret && bootstrapEmail() && String(process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN || '').length >= 32) }); }
    catch (error) { next(error); }
  });
  router.post('/bootstrap/start', platformAdminBootstrapRateLimit, async (req, res, next) => {
    try {
      const email = normEmail(req.body?.email); const providedToken = String(req.body?.bootstrapToken || ''); const configuredToken = String(process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN || '');
      if (!secureSessionSecret) return res.status(503).json({ error: 'Set a private SESSION_SECRET before enabling platform-admin setup.' });
      if (!bootstrapEmail() || configuredToken.length < 32) return res.status(503).json({ error: 'Platform-admin bootstrap is not configured. Set the owner email and a random token with at least 32 characters in Render.' });
      if (email !== bootstrapEmail() || !safeEqual(hash(providedToken), hash(configuredToken))) return res.status(401).json({ error: 'Bootstrap details are incorrect.' });
      return await transact(async (client) => {
        const admins = await client.query('SELECT 1 FROM platform_admin_users LIMIT 1');
        if (admins.rowCount) return res.status(409).json({ error: 'Platform-admin setup has already been completed.' });
        await client.query('DELETE FROM platform_admin_bootstrap_challenges WHERE expires_at <= NOW()');
        const token = randomBytes(32).toString('base64url'); const totp = newTotpSecret(); const expiresAt = new Date(Date.now() + BOOTSTRAP_MS);
        await client.query('INSERT INTO platform_admin_bootstrap_challenges (token_hash,email,totp_secret_encrypted,expires_at) VALUES ($1,$2,$3,$4)', [hash(token), email, seal(totp, key), expiresAt]);
        res.json({ setupToken: token, secret: totp, otpauthUri: otpAuthUri(totp, email), expiresInSeconds: BOOTSTRAP_MS / 1000 });
      });
    } catch (error) { next(error); }
  });
  router.post('/bootstrap/complete', platformAdminBootstrapRateLimit, async (req, res, next) => {
    try {
      const setupToken = String(req.body?.setupToken || ''); const name = String(req.body?.name || '').trim().slice(0, 80); const password = String(req.body?.password || '');
      if (name.length < 2 || password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Use your name and a unique password of 12 to 128 characters.' });
      return await transact(async (client) => {
        const challenge = (await client.query('SELECT * FROM platform_admin_bootstrap_challenges WHERE token_hash=$1 AND expires_at>NOW() FOR UPDATE', [hash(setupToken)])).rows[0];
        if (!challenge) return res.status(400).json({ error: 'Setup session expired. Restart the secure setup.' });
        const admins = await client.query('SELECT 1 FROM platform_admin_users LIMIT 1');
        if (admins.rowCount || normEmail(challenge.email) !== bootstrapEmail()) return res.status(409).json({ error: 'Owner setup is no longer available.' });
        const secret = unseal(challenge.totp_secret_encrypted, key); const counter = totpCounter(secret, req.body?.code);
        if (counter === null) return res.status(400).json({ error: 'Authenticator code is incorrect or expired.' });
        const passwordRecord = hashPassword(password); const id = randomUUID();
        const created = await client.query(`INSERT INTO platform_admin_users (id,email,name,role,password_salt,password_hash,totp_secret_encrypted,last_totp_counter)
          VALUES ($1,$2,$3,'owner',$4,$5,$6,$7) RETURNING *`, [id, challenge.email, name, passwordRecord.salt, passwordRecord.hash, challenge.totp_secret_encrypted, counter]);
        await client.query('DELETE FROM platform_admin_bootstrap_challenges');
        await audit(client, { id, email: challenge.email }, req, 'admin.owner_bootstrapped', 'platform_admin', id, 'Initial owner setup completed');
        const session = await createSession(client, created.rows[0]); setCookie(req, res, session.token, session.expiresAt);
        res.status(201).json({ admin: sanitizeAdmin(created.rows[0]), csrfToken: session.csrf });
      });
    } catch (error) { next(error); }
  });
  router.post('/login', platformAdminLoginRateLimit, async (req, res, next) => {
    try {
      const email = normEmail(req.body?.email); const password = String(req.body?.password || '');
      if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password.length > 128) return res.status(401).json({ error: 'Email, password, or authenticator code is incorrect.' });
      await query("DELETE FROM platform_admin_login_attempts WHERE attempted_at<NOW()-INTERVAL '30 days'");
      const attempts = await query(`SELECT COUNT(*)::int AS count FROM platform_admin_login_attempts WHERE email=$1 AND attempted_at>NOW()-INTERVAL '15 minutes'`, [email]);
      if (attempts.rows[0].count >= 8) return res.status(429).json({ error: 'Too many admin sign-in attempts. Try again in 15 minutes.' });
      const result = await query('SELECT * FROM platform_admin_users WHERE email=$1 AND active=TRUE', [email]); const admin = result.rows[0];
      if (!admin) scryptSync(password, 'forme-platform-admin-unknown-user-salt', 64);
      const counter = admin && checkPassword(password, admin) ? totpCounter(unseal(admin.totp_secret_encrypted, key), req.body?.code) : null;
      if (!admin || counter === null) {
        await query('INSERT INTO platform_admin_login_attempts (email) VALUES ($1)', [email.slice(0, 254)]);
        if (admin) await query(`INSERT INTO platform_admin_audit_events (actor_email,action,target_type,target_id,remote_address) VALUES ($1,'admin.login_failed','platform_admin',$1,$2)`, [email, auditRequestAddress(req)]);
        return res.status(401).json({ error: 'Email, password, or authenticator code is incorrect.' });
      }
      return await transact(async (client) => {
        const updated = await client.query('UPDATE platform_admin_users SET last_totp_counter=$1 WHERE id=$2 AND active=TRUE AND last_totp_counter<$1 RETURNING *', [counter, admin.id]);
        if (!updated.rowCount) return res.status(401).json({ error: 'This authenticator code was already used. Wait for the next code.' });
        await client.query('DELETE FROM platform_admin_login_attempts WHERE email=$1', [email]);
        await audit(client, updated.rows[0], req, 'admin.login', 'platform_admin', admin.id);
        const session = await createSession(client, updated.rows[0]); setCookie(req, res, session.token, session.expiresAt);
        res.json({ admin: sanitizeAdmin(updated.rows[0]), csrfToken: session.csrf });
      });
    } catch (error) { next(error); }
  });

  router.post('/invites/start', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '');
      return await transact(async (client) => {
        const invite = (await client.query('SELECT * FROM platform_admin_invites WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE', [hash(token)])).rows[0];
        if (!invite) return res.status(400).json({ error: 'This admin invitation is invalid or expired.' });
        let encrypted = invite.totp_secret_encrypted;
        if (!encrypted) { encrypted = seal(newTotpSecret(), key); await client.query('UPDATE platform_admin_invites SET totp_secret_encrypted=$1 WHERE token_hash=$2', [encrypted, hash(token)]); }
        const secret = unseal(encrypted, key); res.json({ email: invite.email, name: invite.name, role: invite.role, secret, otpauthUri: otpAuthUri(secret, invite.email), expiresAt: invite.expires_at });
      });
    } catch (error) { next(error); }
  });
  router.post('/invites/complete', async (req, res, next) => {
    try {
      const token = String(req.body?.token || ''); const password = String(req.body?.password || '');
      if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Choose a unique password of 12 to 128 characters.' });
      return await transact(async (client) => {
        const invite = (await client.query('SELECT * FROM platform_admin_invites WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE', [hash(token)])).rows[0];
        if (!invite?.totp_secret_encrypted) return res.status(400).json({ error: 'Start your invitation setup again.' });
        const secret = unseal(invite.totp_secret_encrypted, key); const counter = totpCounter(secret, req.body?.code);
        if (counter === null) return res.status(400).json({ error: 'Authenticator code is incorrect or expired.' });
        const duplicate = await client.query('SELECT 1 FROM platform_admin_users WHERE email=$1', [invite.email]);
        if (duplicate.rowCount) return res.status(409).json({ error: 'An admin already uses this email.' });
        const passwordRecord = hashPassword(password); const id = randomUUID();
        const created = await client.query(`INSERT INTO platform_admin_users (id,email,name,role,password_salt,password_hash,totp_secret_encrypted,last_totp_counter,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, invite.email, invite.name, invite.role, passwordRecord.salt, passwordRecord.hash, invite.totp_secret_encrypted, counter, invite.created_by]);
        await client.query('UPDATE platform_admin_invites SET consumed_at=NOW() WHERE token_hash=$1', [hash(token)]);
        const inviter = (await client.query('SELECT email FROM platform_admin_users WHERE id=$1', [invite.created_by])).rows[0];
        await audit(client, { id, email: invite.email }, req, 'admin.invite_accepted', 'platform_admin', id, 'Admin completed invite and MFA setup', { invitedBy: inviter?.email || '' });
        const session = await createSession(client, created.rows[0]); setCookie(req, res, session.token, session.expiresAt);
        res.status(201).json({ admin: sanitizeAdmin(created.rows[0]), csrfToken: session.csrf });
      });
    } catch (error) { next(error); }
  });

  router.use(requireSession);
  router.get('/session', async (req, res, next) => {
    try { const csrfToken = randomBytes(32).toString('base64url'); await query('UPDATE platform_admin_sessions SET csrf_hash=$1 WHERE token_hash=$2', [hash(csrfToken), req.platformAdmin.tokenHash]); res.json({ admin: { id: req.platformAdmin.id, email: req.platformAdmin.email, name: req.platformAdmin.name, role: req.platformAdmin.role }, csrfToken }); }
    catch (error) { next(error); }
  });
  router.post('/logout', async (req, res, next) => {
    try { await query('DELETE FROM platform_admin_sessions WHERE token_hash=$1', [req.platformAdmin.tokenHash]); await transact((client) => audit(client, req.platformAdmin, req, 'admin.logout', 'platform_admin', req.platformAdmin.id)); clearCookie(req, res); res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  router.get('/overview', roles('owner', 'reviewer', 'support'), async (_req, res, next) => {
    try {
      const platform = await readPlatform();
      const tenants = platform.tenants || [];
      const branches = tenants.filter((tenant) => tenant.active !== false && reviewStatus(tenant) === 'approved').flatMap((tenant) => (tenant.branches || []).filter((branch) => branch.active !== false).map((branch) => ({
        key: branch.isDefault ? 'studio:default' : `studio:${tenant.id}:${branch.id}`,
        currency: String(branch.currency || 'INR').toUpperCase(),
      })));
      const documentKeys = [...new Set(branches.map((branch) => branch.key))];
      const [categoryResult, stateResult, eventResult] = await Promise.all([
        query('SELECT COUNT(*)::int AS count FROM marketplace_categories WHERE active=TRUE'),
        query(`SELECT document_key, payload->'settings'->>'currency' AS currency,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('groupId', COALESCE(item->>'groupId', item->>'id'), 'status', COALESCE(item->>'status', 'unknown')))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload)='array' THEN payload WHEN jsonb_typeof(payload->'appointments')='array' THEN payload->'appointments' ELSE '[]'::jsonb END) item), '[]'::jsonb) AS appointments,
          COALESCE((SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'staff')='array' THEN payload->'staff' ELSE '[]'::jsonb END) item WHERE item->>'active'='true'), 0) AS active_staff,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('total', item->'total')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'orders')='array' THEN payload->'orders' ELSE '[]'::jsonb END) item WHERE item->>'paymentStatus'='paid'), '[]'::jsonb) AS paid_orders,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('amount', item->'amount', 'currency', item->'currency')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'paymentRecords')='array' THEN payload->'paymentRecords' ELSE '[]'::jsonb END) item WHERE item->>'provider'='razorpay' AND item->>'status'='captured'), '[]'::jsonb) AS captured_advances
          FROM forme_documents WHERE document_key = ANY($1::text[])`, [documentKeys]),
        query(`SELECT
          (SELECT COUNT(*)::int FROM event_packages p JOIN marketplace_businesses b ON b.id=p.business_id WHERE p.active=TRUE AND b.active=TRUE AND b.review_status='approved') AS active_packages,
          (SELECT COUNT(*)::int FROM event_quote_requests) AS requests,
          (SELECT COUNT(*)::int FROM event_quote_requests WHERE status IN ('quote_requested','quote_sent','change_requested','awaiting_deposit')) AS open_requests,
          (SELECT COUNT(*)::int FROM event_quote_requests WHERE status='confirmed') AS confirmed_requests`),
      ]);
      const currencyForKey = new Map(branches.map((branch) => [branch.key, branch.currency]));
      const bookingGroups = new Map();
      const salesByCurrency = new Map();
      const advancesByCurrency = new Map();
      let activeStaffProfiles = 0;
      for (const row of stateResult.rows) {
        const currency = [row.currency, currencyForKey.get(row.document_key), 'INR'].map((value) => String(value || '').toUpperCase()).find((value) => /^[A-Z]{3}$/.test(value));
        activeStaffProfiles += Number(row.active_staff || 0);
        for (const appointment of row.appointments || []) {
          const groupId = String(appointment.groupId || appointment.id || '');
          if (groupId) bookingGroups.set(groupId, String(appointment.status || 'unknown'));
        }
        for (const order of row.paid_orders || []) {
          const total = Number(order.total);
          if (currency && Number.isFinite(total) && total >= 0) salesByCurrency.set(currency, (salesByCurrency.get(currency) || 0) + total);
        }
        for (const payment of row.captured_advances || []) {
          const amount = Number(payment.amount);
          const paymentCurrency = String(payment.currency || currency || '').toUpperCase();
          if (Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(paymentCurrency)) advancesByCurrency.set(paymentCurrency, (advancesByCurrency.get(paymentCurrency) || 0) + amount);
        }
      }
      const bookingStatusCounts = {};
      for (const status of bookingGroups.values()) bookingStatusCounts[status] = (bookingStatusCounts[status] || 0) + 1;
      const event = eventResult.rows[0] || {};
      const amountRows = (totals) => [...totals].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => a.currency.localeCompare(b.currency));
      res.json({
        businesses: tenants.length,
        pending: tenants.filter((tenant) => reviewStatus(tenant) === 'pending_review').length,
        approved: tenants.filter((tenant) => reviewStatus(tenant) === 'approved').length,
        rejected: tenants.filter((tenant) => reviewStatus(tenant) === 'rejected').length,
        suspended: tenants.filter((tenant) => reviewStatus(tenant) === 'suspended').length,
        categories: categoryResult.rows[0].count,
        adminRole: _req.platformAdmin.role,
        operations: {
          activeBranches: branches.length,
          customerAccounts: (platform.customerUsers || []).filter((user) => user.active !== false).length,
          activeStaffProfiles,
          bookingGroups: bookingGroups.size,
          bookingStatusCounts,
          partnerSalesByCurrency: _req.platformAdmin.role === 'owner' ? amountRows(salesByCurrency) : null,
          capturedAdvancesByCurrency: _req.platformAdmin.role === 'owner' ? amountRows(advancesByCurrency) : null,
          events: {
            activePackages: Number(event.active_packages || 0),
            requests: Number(event.requests || 0),
            openRequests: Number(event.open_requests || 0),
            confirmedRequests: Number(event.confirmed_requests || 0),
          },
        },
      });
    }
    catch (error) { next(error); }
  });
  router.get('/businesses', roles('owner', 'reviewer', 'support'), async (req, res, next) => {
    try {
      const platform = await readPlatform(); const q = String(req.query.q || '').toLowerCase().slice(0, 100); const status = String(req.query.status || 'all'); const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));
      const filtered = (platform.tenants || []).map((tenant) => businessReviewRow(tenant, platform)).filter((business) => (!q || `${business.name} ${business.slug} ${business.ownerEmail} ${business.branches.map((branch) => `${branch.city} ${branch.country}`).join(' ')}`.toLowerCase().includes(q)) && (status === 'all' || business.status === status));
      filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); res.json({ page, pageSize, total: filtered.length, businesses: filtered.slice((page - 1) * pageSize, page * pageSize) });
    } catch (error) { next(error); }
  });
  router.patch('/businesses/:id/review', roles('owner', 'reviewer'), async (req, res, next) => {
    try {
      const status = String(req.body?.status || ''); const reason = String(req.body?.reason || '').trim().slice(0, 500);
      if (!['pending_review', 'approved', 'rejected', 'suspended'].includes(status)) return res.status(400).json({ error: 'Choose a supported review status.' });
      if (reason.length < 5) return res.status(400).json({ error: 'Add a short review reason (at least 5 characters).' });
      return await transact(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [784215903]);
        const stored = await client.query('SELECT payload FROM forme_documents WHERE document_key=$1 FOR UPDATE', ['platform']);
        const platform = stored.rows[0]?.payload; if (!platform) return res.status(404).json({ error: 'Business was not found.' }); platform.users ||= []; platform.tenants ||= [];
        const tenant = (platform.tenants || []).find((item) => item.id === req.params.id);
        if (!tenant) return res.status(404).json({ error: 'Business was not found.' });
        const previous = reviewStatus(tenant); tenant.reviewStatus = status; tenant.reviewNote = reason; tenant.reviewDecisionAt = new Date().toISOString(); tenant.reviewDecisionBy = req.platformAdmin.id;
        await client.query(`UPDATE forme_documents SET payload=$1::jsonb,updated_at=NOW() WHERE document_key='platform'`, [JSON.stringify(platform)]);
      await client.query('UPDATE marketplace_businesses SET review_status=$1,updated_at=NOW() WHERE id=$2', [status, tenant.id]);
        await audit(client, req.platformAdmin, req, `business.${status}`, 'business', tenant.id, reason, { previousStatus: previous, newStatus: status, businessName: tenant.name });
        res.json({ business: businessReviewRow(tenant, platform) });
      });
    } catch (error) { next(error); }
  });
  router.get('/categories', roles('owner', 'reviewer', 'support'), async (_req, res, next) => {
    try {
      const categories = await query(`SELECT c.id,c.slug,c.name,c.description,c.active,c.sort_order AS "sortOrder", s.id AS sub_id,s.slug AS sub_slug,s.name AS sub_name,s.active AS sub_active,s.sort_order AS sub_order
        FROM marketplace_categories c LEFT JOIN marketplace_subcategories s ON s.category_id=c.id ORDER BY c.sort_order,c.name,s.sort_order,s.name`);
      const map = new Map(); for (const row of categories.rows) { if (!map.has(row.id)) map.set(row.id, { id: row.id, slug: row.slug, name: row.name, description: row.description, active: row.active, sortOrder: row.sortOrder, subcategories: [] }); if (row.sub_id) map.get(row.id).subcategories.push({ id: row.sub_id, slug: row.sub_slug, name: row.sub_name, active: row.sub_active, sortOrder: row.sub_order }); }
      res.json([...map.values()]);
    } catch (error) { next(error); }
  });
  router.post('/categories', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const description = String(req.body?.description || '').trim().slice(0, 240); const slug = safeSlug(req.body?.slug || name);
      if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter a category name and a valid short slug.' });
      const id = randomUUID(); return await transact(async (client) => { await client.query('INSERT INTO marketplace_categories (id,slug,name,description,sort_order) VALUES ($1,$2,$3,$4,$5)', [id, slug, name, description, Math.max(0, Number(req.body?.sortOrder) || 0)]); await audit(client, req.platformAdmin, req, 'category.created', 'category', id, 'Category created', { name, slug }); res.status(201).json({ id, slug, name, description, active: true, subcategories: [] }); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A category already uses that slug.' }); next(error); }
  });
  router.patch('/categories/:id', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const slug = safeSlug(req.body?.slug || name); const description = String(req.body?.description || '').trim().slice(0, 240); const active = req.body?.active !== false;
      if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter a category name and a valid short slug.' });
      return await transact(async (client) => { const result = await client.query('UPDATE marketplace_categories SET name=$1,slug=$2,description=$3,active=$4,updated_at=NOW() WHERE id=$5 RETURNING id,slug,name,description,active', [name, slug, description, active, req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Category not found.' }); await audit(client, req.platformAdmin, req, 'category.updated', 'category', req.params.id, active ? 'Category updated' : 'Category deactivated', { name, slug, active }); res.json(result.rows[0]); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A category already uses that slug.' }); next(error); }
  });
  router.post('/categories/:id/subcategories', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const slug = safeSlug(req.body?.slug || name); if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter a subcategory name and valid slug.' });
      const id = randomUUID(); return await transact(async (client) => { const exists = await client.query('SELECT 1 FROM marketplace_categories WHERE id=$1', [req.params.id]); if (!exists.rowCount) return res.status(404).json({ error: 'Category not found.' }); await client.query('INSERT INTO marketplace_subcategories (id,category_id,slug,name,sort_order) VALUES ($1,$2,$3,$4,$5)', [id, req.params.id, slug, name, Math.max(0, Number(req.body?.sortOrder) || 0)]); await audit(client, req.platformAdmin, req, 'subcategory.created', 'subcategory', id, 'Subcategory created', { categoryId: req.params.id, name, slug }); res.status(201).json({ id, slug, name, active: true }); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'That subcategory slug already exists in this category.' }); next(error); }
  });
  router.patch('/categories/:categoryId/subcategories/:id', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const slug = safeSlug(req.body?.slug || name); const active = req.body?.active !== false; if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter a subcategory name and valid slug.' });
      return await transact(async (client) => { const result = await client.query('UPDATE marketplace_subcategories SET name=$1,slug=$2,active=$3,updated_at=NOW() WHERE id=$4 AND category_id=$5 RETURNING id,slug,name,active', [name, slug, active, req.params.id, req.params.categoryId]); if (!result.rowCount) return res.status(404).json({ error: 'Subcategory not found.' }); await audit(client, req.platformAdmin, req, 'subcategory.updated', 'subcategory', req.params.id, active ? 'Subcategory updated' : 'Subcategory deactivated', { categoryId: req.params.categoryId, name, slug, active }); res.json(result.rows[0]); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'That subcategory slug already exists in this category.' }); next(error); }
  });
  router.get('/event-occasions', roles('owner', 'reviewer', 'support'), async (_req, res, next) => {
    try { const result = await query('SELECT id,slug,name,active,sort_order AS "sortOrder" FROM event_occasions ORDER BY sort_order,name'); res.json(result.rows); }
    catch (error) { next(error); }
  });
  router.post('/event-occasions', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const slug = safeSlug(req.body?.slug || name);
      if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter an event type name and valid short slug.' });
      const id = randomUUID();
      return await transact(async (client) => { await client.query('INSERT INTO event_occasions (id,slug,name,sort_order) VALUES ($1,$2,$3,$4)', [id, slug, name, Math.max(0, Number(req.body?.sortOrder) || 0)]); await audit(client, req.platformAdmin, req, 'event_occasion.created', 'event_occasion', id, 'Event type created', { name, slug }); res.status(201).json({ id, slug, name, active: true }); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'An event type already uses that slug.' }); next(error); }
  });
  router.patch('/event-occasions/:id', roles('owner'), async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80); const slug = safeSlug(req.body?.slug || name); const active = req.body?.active !== false;
      if (name.length < 2 || !slug) return res.status(400).json({ error: 'Enter an event type name and valid short slug.' });
      return await transact(async (client) => { const result = await client.query('UPDATE event_occasions SET name=$1,slug=$2,active=$3,updated_at=NOW() WHERE id=$4 RETURNING id,slug,name,active', [name, slug, active, req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Event type not found.' }); await audit(client, req.platformAdmin, req, 'event_occasion.updated', 'event_occasion', req.params.id, active ? 'Event type updated' : 'Event type deactivated', { name, slug, active }); res.json(result.rows[0]); });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'An event type already uses that slug.' }); next(error); }
  });
  router.get('/audit', roles('owner'), async (req, res, next) => {
    try { const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50)); const before = Number.parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER; const { rows } = await query(`SELECT id,actor_email AS "actorEmail",action,target_type AS "targetType",target_id AS "targetId",reason,metadata,remote_address AS "remoteAddress",created_at AS "createdAt" FROM platform_admin_audit_events WHERE id<$1 ORDER BY id DESC LIMIT $2`, [before, limit]); res.json({ events: rows, nextBefore: rows.length === limit ? rows.at(-1).id : null }); }
    catch (error) { next(error); }
  });
  router.get('/admins', roles('owner'), async (_req, res, next) => {
    try { const { rows: admins } = await query('SELECT * FROM platform_admin_users ORDER BY created_at'); const { rows: invites } = await query('SELECT email,name,role,expires_at AS "expiresAt",consumed_at AS "consumedAt",created_at AS "createdAt" FROM platform_admin_invites ORDER BY created_at DESC LIMIT 100'); res.json({ admins: admins.map(sanitizeAdmin), invites }); }
    catch (error) { next(error); }
  });
  router.delete('/admins/invites/:email', roles('owner'), async (req, res, next) => {
    try { const email = normEmail(req.params.email); return await transact(async (client) => { const removed = await client.query('DELETE FROM platform_admin_invites WHERE email=$1 AND consumed_at IS NULL RETURNING email', [email]); if (!removed.rowCount) return res.status(404).json({ error: 'Open invitation not found.' }); await audit(client, req.platformAdmin, req, 'admin.invite_revoked', 'admin_invite', email, 'Open invitation revoked'); res.json({ ok: true }); }); }
    catch (error) { next(error); }
  });
  router.post('/admins/invites', roles('owner'), async (req, res, next) => {
    try {
      const email = normEmail(req.body?.email); const name = String(req.body?.name || '').trim().slice(0, 80); const role = String(req.body?.role || 'reviewer');
      if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || !['reviewer', 'support'].includes(role)) return res.status(400).json({ error: 'Enter a name, valid email, and reviewer or support role.' });
      const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + INVITE_MS);
      await transact(async (client) => { const duplicate = await client.query('SELECT 1 FROM platform_admin_users WHERE email=$1 UNION ALL SELECT 1 FROM platform_admin_invites WHERE email=$1 AND consumed_at IS NULL AND expires_at>NOW() LIMIT 1', [email]); if (duplicate.rowCount) throw Object.assign(new Error('An admin account or invitation already uses that email.'), { statusCode: 409 }); await client.query('INSERT INTO platform_admin_invites (token_hash,email,name,role,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [hash(token), email, name, role, expiresAt, req.platformAdmin.id]); await audit(client, req.platformAdmin, req, 'admin.invite_created', 'admin_invite', email, 'Admin invite created', { role }); });
      const inviteUrl = `${req.get('origin')}/platform-admin?invite=${encodeURIComponent(token)}`;
      try { await sendEmail({ email, subject: 'FORME Operations Console invitation', html: `<div style="font-family:Arial,sans-serif;color:#18231e"><h2>FORME Operations Console</h2><p>Hello ${escapeHtml(name)},</p><p>You have been invited as a <b>${escapeHtml(role)}</b>. The link expires in 48 hours and can be used once.</p><p><a href="${escapeHtml(inviteUrl)}">Accept invitation and set up your password and authenticator</a></p><p>If you did not expect this invitation, ignore this message.</p></div>` }); }
      catch (error) { console.warn('Platform admin invite email failed.', { provider: error.emailProvider || null, status: error.providerStatus || null }); await transact(async (client) => { await client.query('DELETE FROM platform_admin_invites WHERE token_hash=$1 AND consumed_at IS NULL', [hash(token)]); await audit(client, req.platformAdmin, req, 'admin.invite_email_failed', 'admin_invite', email, 'Invite email delivery failed'); }); return res.status(502).json({ error: 'Invitation was not sent. Check email settings and try again.' }); }
      res.status(201).json({ ok: true, email, expiresAt });
    } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); }
  });
  router.patch('/admins/:id', roles('owner'), async (req, res, next) => {
    try {
      const active = req.body?.active; const role = req.body?.role;
      if (active !== undefined && typeof active !== 'boolean' || role !== undefined && !ROLES.has(role)) return res.status(400).json({ error: 'Choose a valid active setting or admin role.' });
      if (req.params.id === req.platformAdmin.id && active === false) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      return await transact(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [784215904]);
        const current = (await client.query('SELECT * FROM platform_admin_users WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]; if (!current) return res.status(404).json({ error: 'Admin not found.' });
        const nextRole = role || current.role; const nextActive = active === undefined ? current.active : active;
        if (current.role === 'owner' && current.active && (nextRole !== 'owner' || !nextActive)) { const owners = await client.query("SELECT COUNT(*)::int AS n FROM platform_admin_users WHERE role='owner' AND active=TRUE"); if (owners.rows[0].n <= 1) return res.status(409).json({ error: 'Keep at least one active platform owner.' }); }
        const updated = await client.query('UPDATE platform_admin_users SET role=$1,active=$2 WHERE id=$3 RETURNING *', [nextRole, nextActive, req.params.id]);
        await audit(client, req.platformAdmin, req, 'admin.updated', 'platform_admin', req.params.id, 'Admin access updated', { previousRole: current.role, role: nextRole, active: nextActive });
        if (!nextActive) await client.query('DELETE FROM platform_admin_sessions WHERE admin_id=$1', [req.params.id]); res.json({ admin: sanitizeAdmin(updated.rows[0]) });
      });
    } catch (error) { next(error); }
  });
  app.use('/api/platform-admin', router);
}

async function createSession(client, admin) {
  const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + SESSION_MS);
  await client.query('DELETE FROM platform_admin_sessions WHERE expires_at<=NOW()');
  await client.query('INSERT INTO platform_admin_sessions (token_hash,csrf_hash,admin_id,expires_at) VALUES ($1,$2,$3,$4)', [hash(token), hash(csrf), admin.id, expiresAt]);
  return { token, csrf, expiresAt };
}

