import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';

const MODES = new Set(['business', 'home', 'venue']);
const MAX_PARTICIPANTS = 100;
const MAX_SERVICES = 40;

function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function asMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function safeText(value, max = 300) { return String(value ?? '').trim().slice(0, max); }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }
function validTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }
function parseCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}
function venueKey(sessionSecret) {
  const configured = String(process.env.EVENT_PII_ENCRYPTION_KEY || '').trim();
  if (configured) {
    if (/^[a-f\d]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    throw fail(503, 'Event address encryption is not configured correctly.');
  }
  if (!sessionSecret || sessionSecret === 'local-prototype-session-secret-change-before-deploy') throw fail(503, 'Event address encryption needs a private session secret.');
  return createHmac('sha256', sessionSecret).update('FORME:event-venue-encryption:v1').digest();
}
function encryptVenue(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}
function decryptVenue(row, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.venue_private_iv));
  decipher.setAuthTag(Buffer.from(row.venue_private_tag));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.venue_private_ciphertext)), decipher.final()]).toString('utf8'));
}
function publicPackage(row, items = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    bookingMode: row.booking_mode,
    occasionId: row.occasion_id,
    occasionName: row.occasion_name || null,
    fulfillmentModes: row.fulfillment_modes,
    startingPrice: Number(row.starting_price),
    currency: row.currency,
    minNoticeHours: row.min_notice_hours,
    maxDistanceKm: row.max_distance_km === null ? null : Number(row.max_distance_km),
    travelBaseFee: Number(row.travel_base_fee),
    travelFeePerKm: Number(row.travel_fee_per_km),
    travelBufferMinutes: row.travel_buffer_minutes,
    portfolioUrls: row.portfolio_urls || [],
    items: items.map((item) => ({ id: item.id, name: item.name, participantRole: item.participant_role, durationMinutes: item.duration_minutes, quantity: item.quantity, included: item.included, price: Number(item.price) })),
  };
}

export function registerEventMarketplaceRoutes(app, deps) {
  const { databasePool, ensureDatabase, scopeStorage, readPlatform, customerFromRequest, mutateStateSafely, distanceKm, wallTimeInZone, minutes, weekdayFromDate, sessionSecret, eventRequestRateLimit, eventActionRateLimit } = deps;

  async function ensureEventDatabase() {
    if (!databasePool) throw fail(503, 'Wedding and event requests need the connected PostgreSQL database.');
    await ensureDatabase();
  }
  async function loadPackageItems(client, packageId) {
    const result = await client.query('SELECT id,name,participant_role,duration_minutes,quantity,included,price,sort_order FROM event_package_items WHERE package_id=$1 ORDER BY sort_order,id', [packageId]);
    return result.rows;
  }
  async function loadPackage(client, packageId, includePending = false) {
    const result = await client.query(`SELECT p.*,o.name AS occasion_name,b.name AS business_name,b.slug AS business_slug,b.category_id,b.review_status,
      br.name AS branch_name,br.city,br.country,br.latitude,br.longitude,br.time_zone
      FROM event_packages p JOIN marketplace_businesses b ON b.id=p.business_id
      JOIN marketplace_branches br ON br.id=p.branch_id AND br.business_id=p.business_id
      LEFT JOIN event_occasions o ON o.id=p.occasion_id WHERE p.id=$1 AND p.active=TRUE AND b.active=TRUE AND br.active=TRUE AND ($2::boolean OR b.review_status='approved')`, [packageId, includePending]);
    if (!result.rowCount) return null;
    return { ...result.rows[0], items: await loadPackageItems(client, packageId) };
  }
  function requestSummary(row, venue, participants, services, quote = null) {
    return {
      id: row.id, reference: row.reference, status: row.status, requestType: row.request_type,
      businessId: row.business_id, businessName: row.business_name, businessSlug: row.business_slug,
      branchId: row.branch_id, branchName: row.branch_name, packageId: row.package_id, packageName: row.package_name,
      occasionId: row.occasion_id, occasionName: row.occasion_name, fulfillmentMode: row.fulfillment_mode,
      eventDate: row.event_date instanceof Date ? row.event_date.toISOString().slice(0, 10) : String(row.event_date).slice(0, 10),
      eventStartTime: String(row.event_start_time).slice(0, 5), readyByTime: String(row.ready_by_time).slice(0, 5), timeZone: row.time_zone,
      participantCount: row.participant_count, requiredProfessionals: row.required_professionals,
      venue, venueCity: row.venue_city, travelDistanceKm: row.travel_distance_km === null ? null : Number(row.travel_distance_km),
      estimatedTravelFee: Number(row.estimated_travel_fee), currency: row.currency, requirements: row.requirements,
      customer: row.customer_name ? { name: row.customer_name, email: row.customer_email, phone: row.customer_phone } : undefined,
      participants, services, quote, createdAt: row.created_at,
    };
  }
  async function getRequest(client, requestId, extraFilter = '', params = []) {
    const result = await client.query(`SELECT r.*,b.name AS business_name,b.slug AS business_slug,br.name AS branch_name,
      o.name AS occasion_name,p.name AS package_name,a.display_name AS customer_name,a.email AS customer_email,a.phone AS customer_phone
      FROM event_quote_requests r JOIN marketplace_businesses b ON b.id=r.business_id
      JOIN marketplace_branches br ON br.id=r.branch_id AND br.business_id=r.business_id
      JOIN event_occasions o ON o.id=r.occasion_id LEFT JOIN event_packages p ON p.id=r.package_id
      JOIN marketplace_accounts a ON a.id=r.customer_account_id
      WHERE r.id=$1 ${extraFilter}`, [requestId, ...params]);
    return result.rows[0] || null;
  }
  async function requestChildren(client, requestId) {
    const [participants, services] = await Promise.all([
      client.query('SELECT id,role,display_name AS "displayName",sort_order AS "sortOrder" FROM event_request_participants WHERE request_id=$1 ORDER BY sort_order,id', [requestId]),
      client.query('SELECT id,participant_id AS "participantId",package_item_id AS "packageItemId",requested_name AS name,notes,quantity,sort_order AS "sortOrder" FROM event_request_services WHERE request_id=$1 ORDER BY sort_order,id', [requestId]),
    ]);
    return { participants: participants.rows, services: services.rows };
  }
  async function latestQuote(client, requestId) {
    const quoteResult = await client.query('SELECT * FROM event_quotes WHERE request_id=$1 ORDER BY revision DESC LIMIT 1', [requestId]);
    if (!quoteResult.rowCount) return null;
    const row = quoteResult.rows[0];
    const items = await client.query('SELECT participant_id AS "participantId",description,quantity,duration_minutes AS "durationMinutes",unit_price AS "unitPrice",total,sort_order AS "sortOrder" FROM event_quote_items WHERE quote_id=$1 ORDER BY sort_order,id', [row.id]);
    return { id: row.id, revision: row.revision, status: row.status, subtotal: Number(row.subtotal), travelFee: Number(row.travel_fee), taxes: Number(row.taxes), total: Number(row.total), depositPercent: Number(row.deposit_percent), depositAmount: Number(row.deposit_amount), currency: row.currency, terms: row.terms, expiresAt: row.expires_at, items: items.rows };
  }
  async function fullRequest(client, row, key) {
    const { participants, services } = await requestChildren(client, row.id);
    const venue = decryptVenue(row, key);
    return requestSummary(row, venue, participants, services, await latestQuote(client, row.id));
  }
  async function syncStaffResources(client, scope, state) {
    for (const person of state.staff || []) {
      if (!person?.id || !person.name) continue;
      await client.query(`INSERT INTO marketplace_branch_resources (id,business_id,branch_id,resource_type,name,role,active)
        VALUES ($1,$2,$3,'staff',$4,$5,$6) ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id,branch_id=EXCLUDED.branch_id,name=EXCLUDED.name,role=EXCLUDED.role,active=EXCLUDED.active,updated_at=NOW()`,
      [person.id, scope.tenant.id, scope.branch.id, String(person.name).slice(0, 100), String(person.role || ''), person.active !== false]);
    }
  }
  function overlappingAppointment(state, staffId, date, startMinutes, endMinutes) {
    const appointments = (state.appointments || []).some((item) => {
      if (item.staffId !== staffId || item.date !== date || ['cancelled', 'completed', 'no-show'].includes(item.status)) return false;
      if (item.status === 'awaiting-payment' && item.paymentExpiresAt && new Date(item.paymentExpiresAt) < new Date()) return false;
      const start = minutes(item.time); const end = start + Number(item.minutes || 30);
      return startMinutes < end && start < endMinutes;
    });
    const event = (state.eventReservations || []).some((item) => item.status !== 'released' && item.staffId === staffId && item.date === date && startMinutes < minutes(item.endTime) && minutes(item.startTime) < endMinutes);
    return appointments || event;
  }

  app.get('/api/public/events/occasions', async (_req, res, next) => {
    try { await ensureEventDatabase(); const result = await databasePool.query('SELECT id,slug,name FROM event_occasions WHERE active=TRUE ORDER BY sort_order,name'); res.json(result.rows); } catch (error) { next(error); }
  });

  app.get('/api/public/events/providers', async (req, res, next) => {
    try {
      await ensureEventDatabase();
      const q = safeText(req.query.q, 100).toLowerCase(); const city = safeText(req.query.city, 80).toLowerCase();
      const occasionId = safeText(req.query.occasionId, 40); const mode = safeText(req.query.mode, 20);
      if (mode && !MODES.has(mode)) return res.status(400).json({ error: 'Choose a supported service location.' });
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const pageSize = Math.min(30, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 12));
      const params = []; const filters = ["p.active=TRUE", "b.active=TRUE", "b.review_status='approved'", 'br.active=TRUE'];
      if (q) { params.push(`%${q}%`); filters.push(`(LOWER(b.name) LIKE $${params.length} OR LOWER(p.name) LIKE $${params.length} OR LOWER(p.description) LIKE $${params.length})`); }
      if (city) { params.push(`%${city}%`); filters.push(`LOWER(br.city) LIKE $${params.length}`); }
      if (occasionId) { params.push(occasionId); filters.push(`p.occasion_id=$${params.length}`); }
      if (mode) { params.push(mode); filters.push(`$${params.length}=ANY(p.fulfillment_modes)`); }
      const where = filters.join(' AND ');
      const count = await databasePool.query(`SELECT COUNT(*)::int AS total FROM event_packages p JOIN marketplace_businesses b ON b.id=p.business_id JOIN marketplace_branches br ON br.id=p.branch_id AND br.business_id=p.business_id WHERE ${where}`, params);
      const offset = (page - 1) * pageSize; const rows = await databasePool.query(`SELECT p.*,o.name AS occasion_name,b.name AS business_name,b.slug AS business_slug,b.category_id,c.name AS category_name,
        br.name AS branch_name,br.city,br.country,br.currency AS branch_currency,br.latitude,br.longitude,br.time_zone
        FROM event_packages p JOIN marketplace_businesses b ON b.id=p.business_id JOIN marketplace_branches br ON br.id=p.branch_id AND br.business_id=p.business_id
        LEFT JOIN event_occasions o ON o.id=p.occasion_id LEFT JOIN marketplace_categories c ON c.id=b.category_id
        WHERE ${where} ORDER BY p.starting_price ASC,b.name,p.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
      const packages = await Promise.all(rows.rows.map(async (row) => ({
        businessId: row.business_id, businessName: row.business_name, businessSlug: row.business_slug,
        categoryId: row.category_id, categoryName: row.category_name, branchId: row.branch_id, branchName: row.branch_name,
        city: row.city, country: row.country, timeZone: row.time_zone, verified: row.review_status === 'approved',
        package: publicPackage(row, await loadPackageItems(databasePool, row.id)),
      })));
      res.json({ page, pageSize, total: count.rows[0].total, providers: packages });
    } catch (error) { next(error); }
  });

  app.get('/api/public/events/providers/:slug', async (req, res, next) => {
    try {
      await ensureEventDatabase();
      const result = await databasePool.query(`SELECT p.*,o.name AS occasion_name,b.id AS business_id,b.name AS business_name,b.slug AS business_slug,b.category_id,c.name AS category_name,
        br.id AS branch_id,br.name AS branch_name,br.city,br.country,br.currency AS branch_currency,br.time_zone
        FROM event_packages p JOIN marketplace_businesses b ON b.id=p.business_id JOIN marketplace_branches br ON br.id=p.branch_id AND br.business_id=p.business_id
        LEFT JOIN event_occasions o ON o.id=p.occasion_id LEFT JOIN marketplace_categories c ON c.id=b.category_id
        WHERE b.slug=$1 AND b.active=TRUE AND b.review_status='approved' AND br.active=TRUE AND p.active=TRUE ORDER BY br.name,p.name`, [safeText(req.params.slug, 80).toLowerCase()]);
      res.json({ providers: await Promise.all(result.rows.map(async (row) => ({ businessId: row.business_id, businessName: row.business_name, businessSlug: row.business_slug, categoryId: row.category_id, categoryName: row.category_name, branchId: row.branch_id, branchName: row.branch_name, city: row.city, country: row.country, timeZone: row.time_zone, verified: true, package: publicPackage(row, await loadPackageItems(databasePool, row.id)) }))) });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/event-packages', async (_req, res, next) => {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore();
      const result = await databasePool.query(`SELECT p.*,o.name AS occasion_name FROM event_packages p LEFT JOIN event_occasions o ON o.id=p.occasion_id
        WHERE p.business_id=$1 AND p.branch_id=$2 ORDER BY p.active DESC,p.updated_at DESC`, [scope.tenant.id, scope.branch.id]);
      res.json(await Promise.all(result.rows.map(async (row) => ({ ...publicPackage(row, await loadPackageItems(databasePool, row.id)), active: row.active }))));
    } catch (error) { next(error); }
  });

  async function savePackage(req, res, next, isUpdate = false) {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const body = req.body || {};
      const name = safeText(body.name, 120); const description = safeText(body.description, 1200);
      const modes = Array.isArray(body.fulfillmentModes) ? [...new Set(body.fulfillmentModes.map(String))] : [];
      if (name.length < 2 || !modes.length || modes.some((mode) => !MODES.has(mode))) return res.status(400).json({ error: 'Enter a package name and choose at least one supported service location.' });
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) return res.status(400).json({ error: 'Add between 1 and 40 package services.' });
      if (body.bookingMode && body.bookingMode !== 'quote') return res.status(400).json({ error: 'Event package instant booking is being enabled after the shared availability checks. Quote requests are available now.' });
      const items = body.items.map((item, index) => ({
        id: randomUUID(), name: safeText(item?.name, 100), participantRole: safeText(item?.participantRole || 'any', 50),
        durationMinutes: Number(item?.durationMinutes), quantity: Number(item?.quantity || 1), included: item?.included !== false,
        price: Number(item?.price || 0), sortOrder: index,
      }));
      if (items.some((item) => item.name.length < 2 || !Number.isInteger(item.durationMinutes) || item.durationMinutes < 5 || item.durationMinutes > 1440 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || !Number.isFinite(item.price) || item.price < 0 || item.price > 10000000)) return res.status(400).json({ error: 'Check each service name, duration, quantity and price.' });
      const totalPrice = asMoney(items.filter((item) => item.included).reduce((sum, item) => sum + item.price * item.quantity, 0));
      const branch = scope.branch;
      const maxDistance = body.maxDistanceKm === '' || body.maxDistanceKm === null || body.maxDistanceKm === undefined ? null : Number(body.maxDistanceKm);
      const travelBase = Number(body.travelBaseFee || 0); const travelRate = Number(body.travelFeePerKm || 0); const buffer = Number(body.travelBufferMinutes || 0); const notice = Number(body.minNoticeHours ?? 24);
      if (modes.some((mode) => mode !== 'business') && (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 500 || !Number.isFinite(branch.latitude) || !Number.isFinite(branch.longitude))) return res.status(400).json({ error: 'Add a branch map pin and a maximum travel distance before offering home or venue services.' });
      if (![travelBase, travelRate].every((value) => Number.isFinite(value) && value >= 0 && value <= 1000000) || !Number.isInteger(buffer) || buffer < 0 || buffer > 1440 || !Number.isInteger(notice) || notice < 0 || notice > 8760) return res.status(400).json({ error: 'Check the travel charges, travel buffer and minimum booking notice.' });
      const portfolioUrls = Array.isArray(body.portfolioUrls) ? body.portfolioUrls.slice(0, 8).map((value) => safeText(value, 500)) : [];
      if (portfolioUrls.some((value) => { try { const parsed = new URL(value); return parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password; } catch { return true; } })) return res.status(400).json({ error: 'Portfolio links must use a valid HTTPS address.' });
      const occasionId = safeText(body.occasionId, 40) || null; const id = isUpdate ? safeText(req.params.id, 40) : randomUUID();
      if ((occasionId && !validUuid(occasionId)) || !validUuid(id)) return res.status(400).json({ error: 'Choose a valid event type or package.' });
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`event-package:${scope.tenant.id}:${scope.branch.id}`]);
        if (occasionId) { const occasion = await client.query('SELECT 1 FROM event_occasions WHERE id=$1 AND active=TRUE', [occasionId]); if (!occasion.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose an active event type.' }); } }
        if (isUpdate) {
          const existing = await client.query('SELECT id FROM event_packages WHERE id=$1 AND business_id=$2 AND branch_id=$3 FOR UPDATE', [id, scope.tenant.id, scope.branch.id]);
          if (!existing.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event package not found in this business location.' }); }
          await client.query(`UPDATE event_packages SET occasion_id=$1,name=$2,description=$3,fulfillment_modes=$4,starting_price=$5,currency=$6,min_notice_hours=$7,max_distance_km=$8,travel_base_fee=$9,travel_fee_per_km=$10,travel_buffer_minutes=$11,portfolio_urls=$12,active=$13,updated_at=NOW() WHERE id=$14`, [occasionId, name, description, modes, totalPrice, branch.currency || 'INR', notice, maxDistance, asMoney(travelBase), asMoney(travelRate), buffer, portfolioUrls, body.active !== false, id]);
          await client.query('DELETE FROM event_package_items WHERE package_id=$1', [id]);
        } else {
          await client.query(`INSERT INTO event_packages (id,business_id,branch_id,occasion_id,name,description,booking_mode,fulfillment_modes,starting_price,currency,min_notice_hours,max_distance_km,travel_base_fee,travel_fee_per_km,travel_buffer_minutes,portfolio_urls)
            VALUES ($1,$2,$3,$4,$5,$6,'quote',$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [id, scope.tenant.id, scope.branch.id, occasionId, name, description, modes, totalPrice, branch.currency || 'INR', notice, maxDistance, asMoney(travelBase), asMoney(travelRate), buffer, portfolioUrls]);
        }
        for (const item of items) await client.query(`INSERT INTO event_package_items (id,package_id,name,participant_role,duration_minutes,quantity,included,price,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [item.id, id, item.name, item.participantRole, item.durationMinutes, item.quantity, item.included, asMoney(item.price), item.sortOrder]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      const saved = await loadPackage(databasePool, id, true); res.status(isUpdate ? 200 : 201).json(publicPackage(saved, saved.items));
    } catch (error) { next(error); }
  }
  app.post('/api/admin/event-packages', (req, res, next) => savePackage(req, res, next, false));
  app.patch('/api/admin/event-packages/:id', (req, res, next) => savePackage(req, res, next, true));

  app.post('/api/events/quote-requests', eventRequestRateLimit, async (req, res, next) => {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const platform = scope?.platform || await readPlatform();
      const customer = customerFromRequest(req, platform); if (!customer) return res.status(401).json({ error: 'Sign in to request an event quote.' });
      const body = req.body || {}; const packageId = safeText(body.packageId, 40); const businessSlug = safeText(body.businessSlug, 80).toLowerCase();
      const branchId = safeText(body.branchId, 40); const occasionId = safeText(body.occasionId, 40); const mode = safeText(body.fulfillmentMode, 20);
      const date = String(body.eventDate || ''); const startTime = String(body.eventStartTime || ''); const readyBy = String(body.readyByTime || '');
      const participants = Array.isArray(body.participants) ? body.participants : []; const requestedServices = Array.isArray(body.services) ? body.services : [];
      const requiredProfessionals = Number(body.requiredProfessionals || 1);
      if (!businessSlug || !validUuid(branchId) || !validUuid(occasionId) || (packageId && !validUuid(packageId)) || !MODES.has(mode) || !validDate(date) || !validTime(startTime) || !validTime(readyBy) || readyBy <= startTime) return res.status(400).json({ error: 'Check the provider, occasion, service location, event date, start time and ready-by time.' });
      if (!participants.length || participants.length > MAX_PARTICIPANTS || requestedServices.length < 1 || requestedServices.length > MAX_SERVICES || !Number.isInteger(requiredProfessionals) || requiredProfessionals < 1 || requiredProfessionals > 50) return res.status(400).json({ error: 'Add 1–100 participants, 1–40 requested services and 1–50 professionals.' });
      const cleanParticipants = participants.map((person, index) => ({ id: randomUUID(), role: safeText(person?.role, 50), name: safeText(person?.name, 80), sortOrder: index }));
      if (cleanParticipants.some((person) => person.role.length < 2)) return res.status(400).json({ error: 'Choose a role for each participant, such as Bride, Groom or Guest.' });
      const requirements = safeText(body.requirements, 1500);
      const idempotencyKey = safeText(req.get('idempotency-key'), 100) || null;
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        const providerResult = await client.query(`SELECT b.id AS business_id,b.slug,b.name AS business_name,b.review_status,b.active AS business_active,
          br.id AS branch_id,br.name AS branch_name,br.city,br.country,br.currency,br.time_zone,br.latitude,br.longitude,br.active AS branch_active
          FROM marketplace_businesses b JOIN marketplace_branches br ON br.business_id=b.id WHERE b.slug=$1 AND br.id=$2`, [businessSlug, branchId]);
        const provider = providerResult.rows[0];
        if (!provider || !provider.business_active || !provider.branch_active || provider.review_status !== 'approved') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This verified event provider is no longer available.' }); }
        const occasion = await client.query('SELECT id,name FROM event_occasions WHERE id=$1 AND active=TRUE', [occasionId]);
        if (!occasion.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose an active event type.' }); }
        const eventPackage = packageId ? await loadPackage(client, packageId) : null;
        if (packageId && (!eventPackage || eventPackage.business_id !== provider.business_id || eventPackage.branch_id !== provider.branch_id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose a package offered by this provider location.' }); }
        if (!eventPackage) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose a provider package. For a custom event, choose their custom package and list your requested services.' }); }
        if (!eventPackage.fulfillment_modes.includes(mode)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This provider package does not support the selected service location.' }); }
        if (eventPackage.occasion_id && eventPackage.occasion_id !== occasionId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This package is listed for another event type.' }); }
        const eventStart = wallTimeInZone(date, startTime, provider.time_zone || 'Asia/Kolkata');
        const noticeHours = (eventStart.getTime() - Date.now()) / 3600000;
        if (eventStart <= new Date() || noticeHours < Number(eventPackage.min_notice_hours)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `This provider needs at least ${eventPackage.min_notice_hours} hours of booking notice.` }); }
        if (mode !== 'business' && (!Number.isFinite(provider.latitude) || !Number.isFinite(provider.longitude))) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This provider has not added a map pin for travel services yet.' }); }
        let privateVenue; let venueCity = provider.city || '';
        let travelDistance = 0; let travelFee = 0;
        if (mode === 'business') {
          privateVenue = { address: '', city: venueCity, latitude: provider.latitude, longitude: provider.longitude };
        } else {
          const address = safeText(body.venueAddress, 500); venueCity = safeText(body.venueCity, 100);
          const latitude = parseCoordinate(body.latitude, -90, 90); const longitude = parseCoordinate(body.longitude, -180, 180);
          if (address.length < 8 || venueCity.length < 2 || latitude === null || longitude === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter the full venue or home-service address, city and map coordinates.' }); }
          travelDistance = Math.round(distanceKm(provider.latitude, provider.longitude, latitude, longitude) * 10) / 10;
          if (eventPackage.max_distance_km === null || travelDistance > Number(eventPackage.max_distance_km)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `This address is outside the provider's ${eventPackage.max_distance_km ?? 0} km service area.` }); }
          travelFee = asMoney(Number(eventPackage.travel_base_fee) + Number(eventPackage.travel_fee_per_km) * travelDistance);
          privateVenue = { address, city: venueCity, latitude, longitude };
        }
        const requestedByName = await client.query('SELECT display_name FROM marketplace_accounts WHERE id=$1 AND account_type=\'customer\' AND active=TRUE', [customer.id]);
        if (!requestedByName.rowCount) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Your customer session is no longer active. Sign in again.' }); }
        if (idempotencyKey) {
          const previous = await client.query('SELECT id,reference,status FROM event_quote_requests WHERE customer_account_id=$1 AND idempotency_key=$2', [customer.id, idempotencyKey]);
          if (previous.rowCount) { await client.query('COMMIT'); return res.status(200).json({ request: previous.rows[0], alreadySubmitted: true }); }
        }
        const key = venueKey(sessionSecret); const encrypted = encryptVenue(privateVenue, key); const requestId = randomUUID();
        const reference = `EV-${randomBytes(4).toString('hex').toUpperCase()}`;
        const inserted = await client.query(`INSERT INTO event_quote_requests (id,reference,business_id,branch_id,customer_account_id,package_id,occasion_id,request_type,status,fulfillment_mode,event_date,event_start_time,ready_by_time,time_zone,participant_count,required_professionals,venue_private_ciphertext,venue_private_iv,venue_private_tag,venue_city,travel_distance_km,estimated_travel_fee,currency,requirements,idempotency_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'quote','quote_requested',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [requestId, reference, provider.business_id, provider.branch_id, customer.id, eventPackage.id, occasionId, mode, date, startTime, readyBy, provider.time_zone || 'Asia/Kolkata', cleanParticipants.length, requiredProfessionals, encrypted.ciphertext, encrypted.iv, encrypted.tag, venueCity, travelDistance, travelFee, provider.currency || 'INR', requirements, idempotencyKey]);
        for (const person of cleanParticipants) await client.query('INSERT INTO event_request_participants (id,request_id,role,display_name,sort_order) VALUES ($1,$2,$3,$4,$5)', [person.id, requestId, person.role, person.name, person.sortOrder]);
        const packageItems = new Map(eventPackage.items.map((item) => [item.id, item]));
        for (let index = 0; index < requestedServices.length; index += 1) {
          const raw = requestedServices[index] || {}; const packageItem = raw.packageItemId ? packageItems.get(String(raw.packageItemId)) : null;
          if (raw.packageItemId && !packageItem) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A requested service is not part of the selected package.' }); }
          const participantIndex = raw.participantIndex === undefined ? null : Number(raw.participantIndex);
          if (participantIndex !== null && (!Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex >= cleanParticipants.length)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A service refers to an unknown participant.' }); }
          const serviceName = packageItem?.name || safeText(raw.name, 100); const quantity = Number(raw.quantity || 1);
          if (serviceName.length < 2 || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Check the requested service names and quantities.' }); }
          await client.query(`INSERT INTO event_request_services (id,request_id,participant_id,package_item_id,requested_name,notes,quantity,sort_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), requestId, participantIndex === null ? null : cleanParticipants[participantIndex].id, packageItem?.id || null, serviceName, safeText(raw.notes, 300), quantity, index]);
        }
        await client.query('COMMIT');
        const row = { ...inserted.rows[0], business_name: provider.business_name, business_slug: provider.slug, branch_name: provider.branch_name, package_name: eventPackage.name, occasion_name: occasion.rows[0].name, customer_name: requestedByName.rows[0].display_name };
        const children = await requestChildren(databasePool, requestId);
        res.status(201).json({ request: requestSummary(row, privateVenue, children.participants, children.services), message: 'Quote request sent. The provider must send and you must accept a quote before any booking is confirmed.' });
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') return res.status(409).json({ error: 'This request was already submitted. Refresh your event requests.' }); throw error; }
      finally { client.release(); }
    } catch (error) { next(error); }
  });

  app.get('/api/customer/events', async (req, res, next) => {
    try {
      await ensureEventDatabase(); const platform = scopeStorage.getStore()?.platform || await readPlatform(); const customer = customerFromRequest(req, platform);
      if (!customer) return res.status(401).json({ error: 'Sign in to see your event requests.' });
      const rows = await databasePool.query(`SELECT r.*,b.name AS business_name,b.slug AS business_slug,br.name AS branch_name,o.name AS occasion_name,p.name AS package_name,a.display_name AS customer_name,a.email AS customer_email,a.phone AS customer_phone
        FROM event_quote_requests r JOIN marketplace_businesses b ON b.id=r.business_id JOIN marketplace_branches br ON br.id=r.branch_id AND br.business_id=r.business_id
        JOIN event_occasions o ON o.id=r.occasion_id LEFT JOIN event_packages p ON p.id=r.package_id JOIN marketplace_accounts a ON a.id=r.customer_account_id
        WHERE r.customer_account_id=$1 ORDER BY r.created_at DESC LIMIT 100`, [customer.id]);
      const key = venueKey(sessionSecret); const results = await Promise.all(rows.rows.map((row) => fullRequest(databasePool, row, key)));
      res.json(results);
    } catch (error) { next(error); }
  });

  app.get('/api/admin/events/requests', async (req, res, next) => {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const status = safeText(req.query.status, 30);
      const params = [scope.tenant.id, scope.branch.id]; let statusWhere = '';
      if (status && status !== 'all') { params.push(status); statusWhere = `AND r.status=$${params.length}`; }
      const rows = await databasePool.query(`SELECT r.*,b.name AS business_name,b.slug AS business_slug,br.name AS branch_name,o.name AS occasion_name,p.name AS package_name,a.display_name AS customer_name,a.email AS customer_email,a.phone AS customer_phone
        FROM event_quote_requests r JOIN marketplace_businesses b ON b.id=r.business_id JOIN marketplace_branches br ON br.id=r.branch_id AND br.business_id=r.business_id
        JOIN event_occasions o ON o.id=r.occasion_id LEFT JOIN event_packages p ON p.id=r.package_id JOIN marketplace_accounts a ON a.id=r.customer_account_id
        WHERE r.business_id=$1 AND r.branch_id=$2 ${statusWhere} ORDER BY r.event_date,r.event_start_time,r.created_at LIMIT 100`, params);
      const key = venueKey(sessionSecret); res.json(await Promise.all(rows.rows.map((row) => fullRequest(databasePool, row, key))));
    } catch (error) { next(error); }
  });

  app.post('/api/admin/events/requests/:id/quote', async (req, res, next) => {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const body = req.body || {}; const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 40) return res.status(400).json({ error: 'Add between 1 and 40 itemized quote lines.' });
      if (!validUuid(req.params.id)) return res.status(400).json({ error: 'Invalid event request.' });
      const cleanItems = items.map((item, index) => ({ participantId: safeText(item?.participantId, 40) || null, description: safeText(item?.description, 160), quantity: Number(item?.quantity || 1), durationMinutes: Number(item?.durationMinutes || 0), unitPrice: Number(item?.unitPrice), sortOrder: index }));
      if (cleanItems.some((item) => item.description.length < 2 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || !Number.isInteger(item.durationMinutes) || item.durationMinutes < 0 || item.durationMinutes > 1440 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0 || item.unitPrice > 10000000)) return res.status(400).json({ error: 'Check each quote description, quantity, duration and price.' });
      const subtotal = asMoney(cleanItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
      const taxes = asMoney(Number(body.taxes || 0)); const depositPercent = Number(body.depositPercent || 0); const terms = safeText(body.terms, 1200); const expiryHours = Number(body.expiryHours || 72);
      if (!Number.isFinite(taxes) || taxes < 0 || taxes > 10000000 || !Number.isFinite(depositPercent) || depositPercent < 0 || depositPercent > 100 || !Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 720) return res.status(400).json({ error: 'Check the tax, deposit percentage and quote expiry.' });
      if (depositPercent > 0) return res.status(409).json({ error: 'Event deposit collection is not connected yet. Set the advance to 0% until verified payment processing is enabled.' });
      const client = await databasePool.connect(); let quoteId;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`event-request:${req.params.id}`]);
        const request = await client.query('SELECT * FROM event_quote_requests WHERE id=$1 AND business_id=$2 AND branch_id=$3 FOR UPDATE', [req.params.id, scope.tenant.id, scope.branch.id]);
        if (!request.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event request not found in this business location.' }); }
        if (!['quote_requested', 'quote_sent', 'change_requested'].includes(request.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This request is no longer accepting a quote.' }); }
        const participants = await client.query('SELECT id FROM event_request_participants WHERE request_id=$1', [req.params.id]);
        const participantIds = new Set(participants.rows.map((row) => row.id));
        if (cleanItems.some((item) => item.participantId && (!validUuid(item.participantId) || !participantIds.has(item.participantId)))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A quote line refers to someone outside this event request.' }); }
        await client.query("UPDATE event_quotes SET status='superseded' WHERE request_id=$1 AND status='sent'", [req.params.id]);
        const revisionResult = await client.query('SELECT COALESCE(MAX(revision),0)::int AS revision FROM event_quotes WHERE request_id=$1', [req.params.id]);
        const revision = revisionResult.rows[0].revision + 1; const travelFee = asMoney(Number(request.rows[0].estimated_travel_fee)); const total = asMoney(subtotal + travelFee + taxes); const depositAmount = asMoney(total * depositPercent / 100); quoteId = randomUUID();
        const expiry = new Date(Date.now() + expiryHours * 3600000);
        await client.query(`INSERT INTO event_quotes (id,request_id,revision,status,subtotal,travel_fee,taxes,total,deposit_percent,deposit_amount,currency,terms,expires_at,created_by)
          VALUES ($1,$2,$3,'sent',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [quoteId, req.params.id, revision, subtotal, travelFee, taxes, total, depositPercent, depositAmount, scope.branch.currency || 'INR', terms, expiry, scope.user.id]);
        for (const item of cleanItems) await client.query('INSERT INTO event_quote_items (id,quote_id,participant_id,description,quantity,duration_minutes,unit_price,total,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), quoteId, item.participantId, item.description, item.quantity, item.durationMinutes, asMoney(item.unitPrice), asMoney(item.unitPrice * item.quantity), item.sortOrder]);
        await client.query("UPDATE event_quote_requests SET status='quote_sent',latest_quote_expires_at=$1,updated_at=NOW() WHERE id=$2", [expiry, req.params.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      const quote = await latestQuote(databasePool, req.params.id);
      res.status(201).json({ quote: quote?.id === quoteId ? quote : await loadQuoteById(databasePool, quoteId) });
    } catch (error) { next(error); }
  });

  app.post('/api/events/quotes/:quoteId/respond', eventActionRateLimit, async (req, res, next) => {
    try {
      await ensureEventDatabase(); const platform = scopeStorage.getStore()?.platform || await readPlatform(); const customer = customerFromRequest(req, platform);
      if (!customer) return res.status(401).json({ error: 'Sign in to respond to this quote.' });
      const action = safeText(req.body?.action, 30); const note = safeText(req.body?.note, 1000);
      if (!['accept', 'reject', 'request_changes'].includes(action)) return res.status(400).json({ error: 'Choose accept, reject or request changes.' });
      const client = await databasePool.connect(); let result;
      try {
        await client.query('BEGIN');
        const quoteResult = await client.query('SELECT * FROM event_quotes WHERE id=$1 FOR UPDATE', [req.params.quoteId]);
        if (!quoteResult.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quote not found.' }); }
        const quote = quoteResult.rows[0]; const request = await client.query('SELECT * FROM event_quote_requests WHERE id=$1 AND customer_account_id=$2 FOR UPDATE', [quote.request_id, customer.id]);
        if (!request.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quote not found for your account.' }); }
        if (quote.status !== 'sent' || request.rows[0].status !== 'quote_sent') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This quote is no longer open for a response.' }); }
        if (new Date(quote.expires_at) <= new Date()) { await client.query("UPDATE event_quotes SET status='expired' WHERE id=$1", [quote.id]); await client.query("UPDATE event_quote_requests SET status='expired',updated_at=NOW() WHERE id=$1", [quote.request_id]); await client.query('COMMIT'); return res.status(409).json({ error: 'This quote expired. Ask the provider to send an updated quote.' }); }
        if (action === 'request_changes') {
          await client.query("UPDATE event_quotes SET status='superseded' WHERE id=$1", [quote.id]);
          await client.query("UPDATE event_quote_requests SET status='change_requested',requirements=LEFT(CONCAT(requirements,CASE WHEN requirements='' THEN '' ELSE E'\\n' END,'Customer requested changes: ',$1),1500),updated_at=NOW() WHERE id=$2", [note || 'Please revise this quote.', quote.request_id]);
          result = { status: 'change_requested', message: 'Change request sent. The provider can send a revised quote.' };
        } else if (action === 'reject') {
          await client.query("UPDATE event_quotes SET status='rejected' WHERE id=$1", [quote.id]); await client.query("UPDATE event_quote_requests SET status='rejected',updated_at=NOW() WHERE id=$1", [quote.request_id]);
          result = { status: 'rejected', message: 'Quote declined.' };
        } else {
          await client.query("UPDATE event_quotes SET status='accepted',accepted_at=NOW() WHERE id=$1", [quote.id]);
          const status = Number(quote.deposit_amount) > 0 ? 'awaiting_deposit' : 'quote_accepted';
          await client.query('UPDATE event_quote_requests SET status=$1,accepted_quote_id=$2,updated_at=NOW() WHERE id=$3', [status, quote.id, quote.request_id]);
          result = { status, message: status === 'awaiting_deposit' ? 'Quote accepted. The provider must set up the deposit payment before this event can be confirmed.' : 'Quote accepted. The provider must confirm the team and schedule before this becomes a confirmed event booking.' };
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      res.json(result);
    } catch (error) { next(error); }
  });

  app.post('/api/admin/events/requests/:id/confirm', async (req, res, next) => {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const requestedStaffIds = Array.isArray(req.body?.staffIds) ? [...new Set(req.body.staffIds.map((id) => safeText(id, 40)))] : [];
      const preview = await databasePool.query('SELECT * FROM event_quote_requests WHERE id=$1 AND business_id=$2 AND branch_id=$3', [req.params.id, scope.tenant.id, scope.branch.id]);
      if (!preview.rowCount) return res.status(404).json({ error: 'Event request not found in this business location.' });
      if (preview.rows[0].status !== 'quote_accepted') return res.status(409).json({ error: 'The customer must accept a quote with no unpaid deposit before team confirmation.' });
      if (requestedStaffIds.length < Number(preview.rows[0].required_professionals)) return res.status(400).json({ error: `Assign at least ${preview.rows[0].required_professionals} team member(s) before confirming.` });
      const eventPackage = await databasePool.query('SELECT travel_buffer_minutes FROM event_packages WHERE id=$1', [preview.rows[0].package_id]);
      const buffer = Number(eventPackage.rows[0]?.travel_buffer_minutes || 0);
      const date = preview.rows[0].event_date instanceof Date ? preview.rows[0].event_date.toISOString().slice(0, 10) : String(preview.rows[0].event_date).slice(0, 10);
      const startTime = String(preview.rows[0].event_start_time).slice(0, 5); const readyBy = String(preview.rows[0].ready_by_time).slice(0, 5);
      const localStart = minutes(startTime) - buffer; const localEnd = minutes(readyBy) + buffer;
      if (localStart < 0 || localEnd > 1439 || localEnd <= localStart) return res.status(409).json({ error: 'Travel and setup buffers fall outside the event day. Adjust the event time or buffer.' });
      const bufferStart = `${String(Math.floor(localStart / 60)).padStart(2, '0')}:${String(localStart % 60).padStart(2, '0')}`;
      const bufferEnd = `${String(Math.floor(localEnd / 60)).padStart(2, '0')}:${String(localEnd % 60).padStart(2, '0')}`;
      const startAt = wallTimeInZone(date, bufferStart, preview.rows[0].time_zone).toISOString(); const endAt = wallTimeInZone(date, bufferEnd, preview.rows[0].time_zone).toISOString();
      const outcome = await mutateStateSafely(async (state, { client }) => {
        if (!client) return { persist: false, httpStatus: 503, error: 'Event booking confirmation needs PostgreSQL.' };
        const row = await client.query('SELECT * FROM event_quote_requests WHERE id=$1 AND business_id=$2 AND branch_id=$3 FOR UPDATE', [req.params.id, scope.tenant.id, scope.branch.id]);
        if (!row.rowCount || row.rows[0].status !== 'quote_accepted') return { persist: false, httpStatus: 409, error: 'The event request changed. Refresh the request and try again.' };
        if (!requestedStaffIds.length || requestedStaffIds.some((id) => !(state.staff || []).some((person) => person.id === id && person.active))) return { persist: false, httpStatus: 400, error: 'Choose active team members from this branch.' };
        const weekday = weekdayFromDate(date);
        const assignedStaff = requestedStaffIds.map((id) => state.staff.find((person) => person.id === id));
        if (assignedStaff.some((person) => !person.days?.includes(weekday) || localStart < minutes(person.start) || localEnd > minutes(person.end) || overlappingAppointment(state, person.id, date, localStart, localEnd))) return { persist: false, httpStatus: 409, error: 'One or more team members are outside their working hours or already booked for this event time.' };
        await syncStaffResources(client, scope, state);
        const existing = await client.query(`SELECT a.resource_id FROM event_resource_assignments a WHERE a.branch_id=$1 AND a.status IN ('hold','confirmed')
          AND a.resource_id=ANY($2::uuid[]) AND a.starts_at < $4 AND $3 < a.ends_at`, [scope.branch.id, requestedStaffIds, startAt, endAt]);
        if (existing.rowCount) return { persist: false, httpStatus: 409, error: 'A selected team member already has an event assignment at this time.' };
        for (const person of assignedStaff) {
          await client.query(`INSERT INTO event_resource_assignments (id,request_id,business_id,branch_id,resource_id,starts_at,ends_at,status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed')`, [randomUUID(), req.params.id, scope.tenant.id, scope.branch.id, person.id, startAt, endAt]);
          state.eventReservations ||= [];
          state.eventReservations.push({ eventRequestId: req.params.id, staffId: person.id, date, startTime: bufferStart, endTime: bufferEnd, status: 'confirmed' });
        }
        await client.query("UPDATE event_quote_requests SET status='confirmed',updated_at=NOW() WHERE id=$1", [req.params.id]);
        return { id: req.params.id, reference: row.rows[0].reference, status: 'confirmed', assignedStaff: assignedStaff.map((person) => ({ id: person.id, name: person.name })), eventDate: date, eventStartTime: startTime, readyByTime: readyBy };
      }, scope);
      if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
      res.json(outcome);
    } catch (error) { next(error); }
  });

  async function cancelEvent(req, res, next, isPartner) {
    try {
      await ensureEventDatabase(); const scope = scopeStorage.getStore(); const platform = scope?.platform || await readPlatform();
      const customer = isPartner ? null : customerFromRequest(req, platform); if (!isPartner && !customer) return res.status(401).json({ error: 'Sign in to manage your event request.' });
      const client = await databasePool.connect(); let branchId;
      try {
        const query = isPartner
          ? await client.query('SELECT branch_id FROM event_quote_requests WHERE id=$1 AND business_id=$2 AND branch_id=$3', [req.params.id, scope.tenant.id, scope.branch.id])
          : await client.query('SELECT branch_id FROM event_quote_requests WHERE id=$1 AND customer_account_id=$2', [req.params.id, customer.id]);
        if (!query.rowCount) return res.status(404).json({ error: 'Event request not found.' });
        branchId = query.rows[0].branch_id;
      } finally { client.release(); }
      const tenant = platform.tenants.find((item) => item.branches?.some((branch) => branch.id === branchId));
      const branch = tenant?.branches.find((item) => item.id === branchId);
      if (!tenant || !branch) return res.status(404).json({ error: 'Event provider location not found.' });
      const outcome = await mutateStateSafely(async (state, { client: tx }) => {
        if (!tx) return { persist: false, httpStatus: 503, error: 'Event cancellation needs PostgreSQL.' };
        const target = isPartner ? await tx.query('UPDATE event_quote_requests SET status=\'cancelled\',updated_at=NOW() WHERE id=$1 AND business_id=$2 AND branch_id=$3 AND status NOT IN (\'cancelled\',\'rejected\',\'expired\') RETURNING id', [req.params.id, tenant.id, branch.id]) : await tx.query('UPDATE event_quote_requests SET status=\'cancelled\',updated_at=NOW() WHERE id=$1 AND customer_account_id=$2 AND status NOT IN (\'cancelled\',\'rejected\',\'expired\') RETURNING id', [req.params.id, customer.id]);
        if (!target.rowCount) return { persist: false, httpStatus: 409, error: 'This event request has already ended or was cancelled.' };
        await tx.query("UPDATE event_resource_assignments SET status='released' WHERE request_id=$1", [req.params.id]);
        state.eventReservations = (state.eventReservations || []).filter((reservation) => reservation.eventRequestId !== req.params.id);
        return { id: req.params.id, status: 'cancelled', message: 'Event request cancelled. Any paid amount needs provider review under the agreed cancellation terms.' };
      }, { tenant, branch });
      if (outcome.httpStatus) return res.status(outcome.httpStatus).json({ error: outcome.error });
      res.json(outcome);
    } catch (error) { next(error); }
  }
  app.post('/api/events/:id/cancel', eventActionRateLimit, (req, res, next) => cancelEvent(req, res, next, false));
  app.post('/api/admin/events/requests/:id/cancel', (req, res, next) => cancelEvent(req, res, next, true));
}

async function loadQuoteById(client, quoteId) {
  const result = await client.query('SELECT * FROM event_quotes WHERE id=$1', [quoteId]);
  if (!result.rowCount) return null;
  const row = result.rows[0]; const items = await client.query('SELECT participant_id AS "participantId",description,quantity,duration_minutes AS "durationMinutes",unit_price AS "unitPrice",total,sort_order AS "sortOrder" FROM event_quote_items WHERE quote_id=$1 ORDER BY sort_order,id', [quoteId]);
  return { id: row.id, revision: row.revision, status: row.status, subtotal: Number(row.subtotal), travelFee: Number(row.travel_fee), taxes: Number(row.taxes), total: Number(row.total), depositPercent: Number(row.deposit_percent), depositAmount: Number(row.deposit_amount), currency: row.currency, terms: row.terms, expiresAt: row.expires_at, items: items.rows };
}
