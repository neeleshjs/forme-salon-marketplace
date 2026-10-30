import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { scryptSync, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionSecret = 'test-only-session-secret-keep-out-of-production';
const signupCode = '654321';
const customerSignupCode = '987654';
let tempDir;
let baseUrl;
let serverProcess;
let serverOutput = '';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited early: ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${serverOutput}`);
}

async function postJson(route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postSignedWebhook(paymentId) {
  const payload = { event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: 'order-test-1', amount: 2500, currency: 'INR', status: 'captured' } } } };
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', 'test-only-webhook-secret').update(rawBody).digest('hex');
  return fetch(`${baseUrl}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature }, body: rawBody });
}

async function partnerWorkspaceToken() {
  const login = await postJson('/api/auth/login', { email: 'owner@example.com', password: 'LocalTestPassword123!' });
  const { loginToken } = await login.json();
  const selected = await postJson('/api/auth/select', { loginToken, tenantId: 'salon-1', branchId: 'branch-1' });
  return (await selected.json()).sessionToken;
}

async function adminRequest(route, token, method = 'GET', body) {
  return fetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json', 'x-session-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'forme-partner-auth-'));
  const ownerSalt = 'test-owner-salt';
  const ownerPassword = 'LocalTestPassword123!';
  const ownerHash = scryptSync(ownerPassword, ownerSalt, 64).toString('hex');
  const owner = { id: 'owner-1', name: 'Test Owner', email: 'owner@example.com', phone: '+919876543210', passwordSalt: ownerSalt, passwordHash: ownerHash, tenantIds: ['salon-1'] };
  const customerSalt = 'test-customer-salt';
  const customerPassword = 'LocalCustomerPassword123!';
  const customerHash = scryptSync(customerPassword, customerSalt, 64).toString('hex');
  const customer = { id: 'customer-1', name: 'Test Customer', email: 'customer@example.com', phone: '+919123456780', passwordSalt: customerSalt, passwordHash: customerHash, active: true };
  const otherBranch = { id: 'branch-2', name: 'Other location', slug: 'other-location', city: 'Pune', country: 'India', countryCode: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', active: true };
  const otherTenant = { id: 'salon-2', slug: 'other-salon', name: 'Other Salon', ownerUserId: 'other-owner', userIds: ['other-owner'], active: true, branches: [otherBranch] };
  const challengeId = 'signup-challenge-test';
  const emailOtpHash = createHmac('sha256', sessionSecret).update(`${challengeId}:email:${signupCode}`).digest('hex');
  const customerChallengeId = 'customer-signup-challenge-test';
  const customerEmailOtpHash = createHmac('sha256', sessionSecret).update(`${customerChallengeId}:email:${customerSignupCode}`).digest('hex');
  const parallelCustomerChallengeId = 'parallel-customer-signup-challenge-test';
  const parallelCustomerSignupCode = '112233';
  const parallelCustomerEmailOtpHash = createHmac('sha256', sessionSecret).update(`${parallelCustomerChallengeId}:email:${parallelCustomerSignupCode}`).digest('hex');
  const parallelCustomerTwoChallengeId = 'parallel-customer-signup-two-challenge-test';
  const parallelCustomerTwoSignupCode = '334455';
  const parallelCustomerTwoEmailOtpHash = createHmac('sha256', sessionSecret).update(`${parallelCustomerTwoChallengeId}:email:${parallelCustomerTwoSignupCode}`).digest('hex');
  const platform = {
    users: [owner],
    customerUsers: [customer],
    tenants: [
      { id: 'salon-1', slug: 'test-salon', name: 'Test Salon', ownerUserId: owner.id, userIds: [owner.id], active: true, branches: [{ id: 'branch-1', name: 'Main branch', slug: 'main-branch', city: 'Delhi', country: 'India', countryCode: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', active: true }] },
      otherTenant,
    ],
    registrationChallenges: [
      {
        id: challengeId,
        purpose: 'partner',
        email: 'new-owner@example.com',
        phone: '+919123456789',
        emailOtpHash,
        registration: {
          name: 'New Owner',
          email: 'new-owner@example.com',
          phone: '+919123456789',
          passwordSalt: 'signup-test-salt',
          passwordHash: scryptSync('SignupTestPassword123!', 'signup-test-salt', 64).toString('hex'),
          tenantDetails: {
            businessName: 'Test Nail Studio', branchName: 'Main branch', city: 'Delhi', country: 'India', countryCode: 'IN',
            currency: 'INR', timeZone: 'Asia/Kolkata', categoryId: 'nail-lash-studio', subcategoryId: 'nail-lash-studio:nail-studio',
          },
        },
        attempts: 0,
        expiresAt: Date.now() + 600000,
        createdAt: Date.now(),
      },
      {
        id: customerChallengeId,
        purpose: 'customer',
        email: 'new-customer@example.com',
        phone: '+919123456781',
        emailOtpHash: customerEmailOtpHash,
        registration: {
          name: 'New Customer',
          email: 'new-customer@example.com',
          phone: '+919123456781',
          passwordSalt: 'customer-signup-test-salt',
          passwordHash: scryptSync('CustomerSignupTest123!', 'customer-signup-test-salt', 64).toString('hex'),
        },
        attempts: 0,
        expiresAt: Date.now() + 600000,
        createdAt: Date.now(),
      },
      {
        id: parallelCustomerChallengeId,
        purpose: 'customer',
        email: 'parallel-customer@example.com',
        phone: '+919123456782',
        emailOtpHash: parallelCustomerEmailOtpHash,
        registration: {
          name: 'Parallel Customer',
          email: 'parallel-customer@example.com',
          phone: '+919123456782',
          passwordSalt: 'parallel-customer-signup-test-salt',
          passwordHash: scryptSync('ParallelCustomerSignup123!', 'parallel-customer-signup-test-salt', 64).toString('hex'),
        },
        attempts: 0,
        expiresAt: Date.now() + 600000,
        createdAt: Date.now(),
      },
      {
        id: parallelCustomerTwoChallengeId,
        purpose: 'customer',
        email: 'parallel-customer-two@example.com',
        phone: '+919123456783',
        emailOtpHash: parallelCustomerTwoEmailOtpHash,
        registration: {
          name: 'Parallel Customer Two',
          email: 'parallel-customer-two@example.com',
          phone: '+919123456783',
          passwordSalt: 'parallel-customer-two-signup-test-salt',
          passwordHash: scryptSync('ParallelCustomerTwoSignup123!', 'parallel-customer-two-signup-test-salt', 64).toString('hex'),
        },
        attempts: 0,
        expiresAt: Date.now() + 600000,
        createdAt: Date.now(),
      },
    ],
    passwordResetChallenges: [],
    otpSendHistory: [],
  };
  await writeFile(path.join(tempDir, 'platform.json'), JSON.stringify(platform));
  await writeFile(path.join(tempDir, 'studio.json'), JSON.stringify({}));
  const bookingExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const branchDataDir = path.join(tempDir, 'tenants', 'salon-1');
  await mkdir(branchDataDir, { recursive: true });
  await writeFile(path.join(branchDataDir, 'branch-1.json'), JSON.stringify({
    settings: { businessName: 'Test Salon', branchName: 'Main branch', currency: 'INR', timeZone: 'Asia/Kolkata', openingTime: '10:00', closingTime: '20:00', openDays: [0, 1, 2, 3, 4, 5, 6] },
    services: [{ id: 'service-1', name: 'Haircut', minutes: 30, price: 100, active: true }],
    staff: [
      { id: 'staff-1', name: 'Test Barber', role: 'Barber', start: '10:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6], active: true },
      { id: 'staff-2', name: 'Second Barber', role: 'Barber', start: '10:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6], active: true },
    ],
    appointments: [
      { id: 'appointment-1', reference: 'TESTBOOKING1', groupId: null, customerUserId: 'customer-1', name: 'Test Customer', phone: '+919123456780', status: 'awaiting-payment', paymentStatus: 'deposit_due', depositAmount: 25, depositCurrency: 'INR', paymentExpiresAt: bookingExpiry, date: '2030-01-02', time: '10:00', minutes: 30, staffId: 'staff-1', serviceId: 'service-1' },
      { id: 'completed-appointment', reference: 'COMPLETED1', customerUserId: 'customer-1', name: 'Test Customer', phone: '+919123456780', status: 'completed', date: '2030-01-01', time: '10:00', minutes: 30, staffId: 'staff-2', serviceId: 'service-1' },
    ],
    paymentRecords: [{ id: 'payment-record-1', appointmentId: 'appointment-1', appointmentIds: ['appointment-1'], customerUserId: 'customer-1', provider: 'razorpay', orderId: 'order-test-1', amount: 25, amountMinor: 2500, currency: 'INR', status: 'created' }],
  }));

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    SESSION_SECRET: sessionSecret,
    PLATFORM_FILE: path.join(tempDir, 'platform.json'),
    DATA_FILE: path.join(tempDir, 'studio.json'),
    DATABASE_URL: '',
    RESEND_API_KEY: '',
    OTP_EMAIL_FROM: '',
    GMAIL_SMTP_USER: '',
    GMAIL_SMTP_APP_PASSWORD: '',
    GMAIL_APPS_SCRIPT_URL: '',
    GMAIL_APPS_SCRIPT_TOKEN: '',
    PLATFORM_ADMIN_BOOTSTRAP_EMAIL: '',
    PLATFORM_ADMIN_BOOTSTRAP_TOKEN: '',
    RAZORPAY_WEBHOOK_SECRET: 'test-only-webhook-secret',
  };
  serverProcess = spawn(process.execPath, ['src/server.js'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('partner login accepts the correct password and rejects incorrect credentials', async () => {
  const accepted = await postJson('/api/auth/login', { email: ' OWNER@example.com ', password: 'LocalTestPassword123!' });
  assert.equal(accepted.status, 200);
  const session = await accepted.json();
  assert.equal(session.organizations[0].id, 'salon-1');

  const rejected = await postJson('/api/auth/login', { email: 'owner@example.com', password: 'incorrect-password' });
  assert.equal(rejected.status, 401);
});

test('customer login accepts the correct password and rejects incorrect credentials', async () => {
  const accepted = await postJson('/api/customer/login', { email: ' CUSTOMER@example.com ', password: 'LocalCustomerPassword123!' });
  assert.equal(accepted.status, 200);
  const session = await accepted.json();
  assert.equal(session.customer.email, 'customer@example.com');
  assert.ok(session.customerToken);

  const rejected = await postJson('/api/customer/login', { email: 'customer@example.com', password: 'incorrect-password' });
  assert.equal(rejected.status, 401);
});

test('partner login cannot select another owner’s salon', async () => {
  const login = await postJson('/api/auth/login', { email: 'owner@example.com', password: 'LocalTestPassword123!' });
  const { loginToken } = await login.json();
  const denied = await postJson('/api/auth/select', { loginToken, tenantId: 'salon-2', branchId: 'branch-2' });
  assert.equal(denied.status, 403);
});

test('business categories are available and invalid categories are rejected before email delivery', async () => {
  const response = await fetch(`${baseUrl}/api/public/categories`);
  assert.equal(response.status, 200);
  const categories = await response.json();
  assert.ok(categories.some((category) => category.id === 'barbershop'));
  assert.ok(categories.some((category) => category.id === 'qualified-clinic'));

  const invalid = await postJson('/api/auth/register', {
    name: 'New Owner', email: 'new-owner@example.com', phone: '+919123456789', password: 'SignupTestPassword123!',
    businessName: 'Test Business', branchName: 'Main branch', country: 'India', currency: 'INR', timeZone: 'Asia/Kolkata',
    categoryId: 'not-a-category', subcategoryId: '',
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /business category/i);
});

test('email OTP verification creates a partner account with its selected business category', async () => {
  const wrongCode = await postJson('/api/auth/verify-registration', { challengeId: 'signup-challenge-test', emailCode: '000000' });
  assert.equal(wrongCode.status, 400);

  const verified = await postJson('/api/auth/verify-registration', { challengeId: 'signup-challenge-test', emailCode: signupCode });
  assert.equal(verified.status, 201);
  const result = await verified.json();
  assert.equal(result.workspace.tenantName, 'Test Nail Studio');
  assert.equal(result.organizations[0].categoryId, 'nail-lash-studio');
  assert.equal(result.organizations[0].subcategoryId, 'nail-lash-studio:nail-studio');

  const persisted = JSON.parse(await readFile(path.join(tempDir, 'platform.json'), 'utf8'));
  const created = persisted.tenants.find((tenant) => tenant.id === result.workspace.tenantId);
  assert.equal(created.categoryId, 'nail-lash-studio');
  assert.equal(created.subcategoryId, 'nail-lash-studio:nail-studio');
});

test('email OTP verification creates a customer account', async () => {
  const wrongCode = await postJson('/api/customer/verify-registration', { challengeId: 'customer-signup-challenge-test', emailCode: '000000' });
  assert.equal(wrongCode.status, 400);

  const verified = await postJson('/api/customer/verify-registration', { challengeId: 'customer-signup-challenge-test', emailCode: customerSignupCode });
  assert.equal(verified.status, 201);
  const result = await verified.json();
  assert.equal(result.customer.email, 'new-customer@example.com');
  assert.ok(result.customerToken);

  const login = await postJson('/api/customer/login', { email: result.customer.email, password: 'CustomerSignupTest123!' });
  assert.equal(login.status, 200);
});

test('parallel OTP signups preserve both independently created customer accounts', async () => {
  const [first, second] = await Promise.all([
    postJson('/api/customer/verify-registration', { challengeId: 'parallel-customer-signup-challenge-test', emailCode: '112233' }),
    postJson('/api/customer/verify-registration', { challengeId: 'parallel-customer-signup-two-challenge-test', emailCode: '334455' }),
  ]);
  assert.deepEqual([first.status, second.status], [201, 201]);
  const persisted = JSON.parse(await readFile(path.join(tempDir, 'platform.json'), 'utf8'));
  assert.ok(persisted.customerUsers.some((user) => user.email === 'parallel-customer@example.com'));
  assert.ok(persisted.customerUsers.some((user) => user.email === 'parallel-customer-two@example.com'));
});

test('public API does not grant cross-origin read access by default', async () => {
  const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://attacker.example', 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});

test('invalid JSON is reported as a client error without echoing request data', async () => {
  const response = await fetch(`${baseUrl}/api/customer/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret",' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid request body.' });
});

test('calendar downloads escape user-controlled line breaks and are not cached', async () => {
  const branchPath = path.join(tempDir, 'tenants', 'salon-1', 'branch-1.json');
  const state = JSON.parse(await readFile(branchPath, 'utf8'));
  state.appointments[0].serviceName = 'Haircut\r\nATTENDEE:attacker@example.com';
  state.appointments[0].staffName = 'Barber\nORGANIZER:attacker@example.com';
  await writeFile(branchPath, JSON.stringify(state));
  const token = await partnerWorkspaceToken();
  const response = await fetch(`${baseUrl}/api/admin/ics/appointment-1`, { headers: { 'x-session-token': token } });
  const calendar = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.ok(calendar.includes('SUMMARY:Haircut\\nATTENDEE:attacker@example.com at FORME'));
  assert.ok(!calendar.includes('\r\nATTENDEE:attacker@example.com'));
  assert.ok(!calendar.includes('\r\nORGANIZER:attacker@example.com'));
});

test('platform-admin bootstrap endpoints have a per-IP request limit', async () => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) response = await fetch(`${baseUrl}/api/platform-admin/bootstrap/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: 'owner@example.com', bootstrapToken: 'invalid' }) });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('captured payment webhooks are idempotent and flag a second capture for review', async () => {
  const first = await postSignedWebhook('payment-test-1');
  assert.equal(first.status, 200);
  assert.equal((await first.json()).received, true);

  const second = await postSignedWebhook('payment-test-2');
  assert.equal(second.status, 200);
  assert.equal((await second.json()).reviewRequired, true);

  const branchState = JSON.parse(await readFile(path.join(tempDir, 'tenants', 'salon-1', 'branch-1.json'), 'utf8'));
  assert.equal(branchState.appointments[0].paymentId, 'payment-test-1');
  assert.equal(branchState.paymentRecords[0].status, 'duplicate-captured');
  assert.equal(branchState.paymentRecords[0].requiresRefundReview, true);
});

test('invalid calendar dates and times are rejected by the booking API', async () => {
  const availability = await fetch(`${baseUrl}/api/availability?serviceId=service-1&date=2026-02-31`, { headers: { 'x-salon-slug': 'test-salon', 'x-branch-id': 'branch-1' } });
  assert.equal(availability.status, 400);
  const login = await postJson('/api/customer/login', { email: 'customer@example.com', password: 'LocalCustomerPassword123!' });
  const { customerToken } = await login.json();
  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const booking = await fetch(`${baseUrl}/api/appointments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-salon-slug': 'test-salon', 'x-branch-id': 'branch-1', 'x-customer-token': customerToken }, body: JSON.stringify({ serviceId: 'service-1', date: futureDate, time: '99:99', depositPolicyAccepted: true }) });
  assert.equal(booking.status, 400);
});

test('group bookings get unique references and simultaneous staff assignments', async () => {
  const login = await postJson('/api/customer/login', { email: 'customer@example.com', password: 'LocalCustomerPassword123!' });
  const { customerToken } = await login.json();
  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const booking = await fetch(`${baseUrl}/api/appointments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-salon-slug': 'test-salon', 'x-branch-id': 'branch-1', 'x-customer-token': customerToken }, body: JSON.stringify({ serviceId: 'service-1', date: futureDate, time: '10:00', partySize: 2, depositPolicyAccepted: true }) });
  assert.equal(booking.status, 201);
  const result = await booking.json();
  assert.equal(result.appointments.length, 2);
  assert.equal(result.appointments[0].staffName === result.appointments[1].staffName, false);
  assert.equal(result.appointments[0].reference.length, 16);
  assert.equal(result.appointments[1].reference.length, 16);
  assert.notEqual(result.appointments[0].reference, result.appointments[1].reference);
});

test('completed bookings cannot be cancelled through the public phone and reference flow', async () => {
  const response = await fetch(`${baseUrl}/api/booking/COMPLETED1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-salon-slug': 'test-salon', 'x-branch-id': 'branch-1' }, body: JSON.stringify({ action: 'cancel', phone: '+919123456780' }) });
  assert.equal(response.status, 409);
});

test('parallel checkout cannot oversell stock or deduct the same product twice', async () => {
  const token = await partnerWorkspaceToken();
  const created = await adminRequest('/api/admin/products', token, 'POST', { name: 'Test shampoo', price: 100, stock: 1 });
  assert.equal(created.status, 201);
  const product = await created.json();

  const checkouts = await Promise.all([
    adminRequest('/api/admin/orders', token, 'POST', { items: [{ type: 'product', id: product.id, quantity: 1 }] }),
    adminRequest('/api/admin/orders', token, 'POST', { items: [{ type: 'product', id: product.id, quantity: 1 }] }),
  ]);
  assert.deepEqual(checkouts.map((response) => response.status).sort(), [201, 409]);

  const duplicateLine = await adminRequest('/api/admin/orders', token, 'POST', { items: [{ type: 'product', id: product.id, quantity: 1 }, { type: 'product', id: product.id, quantity: 1 }] });
  assert.equal(duplicateLine.status, 409);
  const inventory = await (await adminRequest('/api/admin/products', token)).json();
  assert.equal(inventory.find((item) => item.id === product.id).stock, 0);
});

test('parallel inventory updates are preserved and supplier deliveries are applied only once', async () => {
  const token = await partnerWorkspaceToken();
  const created = await adminRequest('/api/admin/products', token, 'POST', { name: 'Test conditioner', price: 120, stock: 5 });
  const product = await created.json();
  const received = await Promise.all([
    adminRequest(`/api/admin/products/${product.id}/receive`, token, 'POST', { quantity: 4 }),
    adminRequest(`/api/admin/products/${product.id}/receive`, token, 'POST', { quantity: 4 }),
  ]);
  assert.deepEqual(received.map((response) => response.status).sort(), [200, 200]);

  const purchase = await adminRequest('/api/admin/purchases', token, 'POST', { supplier: 'Test supplier', productId: product.id, quantity: 3 });
  const order = await purchase.json();
  const deliveries = await Promise.all([
    adminRequest(`/api/admin/purchases/${order.id}/receive`, token, 'PATCH'),
    adminRequest(`/api/admin/purchases/${order.id}/receive`, token, 'PATCH'),
  ]);
  assert.deepEqual(deliveries.map((response) => response.status).sort(), [200, 409]);
  const inventory = await (await adminRequest('/api/admin/products', token)).json();
  assert.equal(inventory.find((item) => item.id === product.id).stock, 16);
});

test('inactive partner accounts lose old sessions and cannot sign in again', async () => {
  const login = await postJson('/api/auth/login', { email: 'owner@example.com', password: 'LocalTestPassword123!' });
  assert.equal(login.status, 200);
  const { sessionToken } = await login.json();
  const platformPath = path.join(tempDir, 'platform.json');
  const platform = JSON.parse(await readFile(platformPath, 'utf8'));
  platform.users.find((user) => user.id === 'owner-1').active = false;
  await writeFile(platformPath, JSON.stringify(platform));

  const oldSession = await fetch(`${baseUrl}/api/admin/overview`, { headers: { 'x-session-token': sessionToken } });
  assert.equal(oldSession.status, 401);
  const newLogin = await postJson('/api/auth/login', { email: 'owner@example.com', password: 'LocalTestPassword123!' });
  assert.equal(newLogin.status, 401);
});

test('partner login attempts are rate limited', async () => {
  let response;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    response = await postJson('/api/auth/login', { email: 'bruteforce@example.com', password: 'incorrect-password' });
  }
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});
