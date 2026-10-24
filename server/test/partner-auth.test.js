import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { scryptSync, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionSecret = 'test-only-session-secret-keep-out-of-production';
const signupCode = '654321';
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
  const deadline = Date.now() + 10000;
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

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'forme-partner-auth-'));
  const ownerSalt = 'test-owner-salt';
  const ownerPassword = 'LocalTestPassword123!';
  const ownerHash = scryptSync(ownerPassword, ownerSalt, 64).toString('hex');
  const owner = { id: 'owner-1', name: 'Test Owner', email: 'owner@example.com', phone: '+919876543210', passwordSalt: ownerSalt, passwordHash: ownerHash, tenantIds: ['salon-1'] };
  const otherBranch = { id: 'branch-2', name: 'Other location', slug: 'other-location', city: 'Pune', country: 'India', countryCode: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', active: true };
  const otherTenant = { id: 'salon-2', slug: 'other-salon', name: 'Other Salon', ownerUserId: 'other-owner', userIds: ['other-owner'], active: true, branches: [otherBranch] };
  const challengeId = 'signup-challenge-test';
  const emailOtpHash = createHmac('sha256', sessionSecret).update(`${challengeId}:email:${signupCode}`).digest('hex');
  const platform = {
    users: [owner],
    customerUsers: [],
    tenants: [
      { id: 'salon-1', slug: 'test-salon', name: 'Test Salon', ownerUserId: owner.id, userIds: [owner.id], active: true, branches: [{ id: 'branch-1', name: 'Main branch', slug: 'main-branch', city: 'Delhi', country: 'India', countryCode: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', active: true }] },
      otherTenant,
    ],
    registrationChallenges: [{
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
    }],
    passwordResetChallenges: [],
    otpSendHistory: [],
  };
  await writeFile(path.join(tempDir, 'platform.json'), JSON.stringify(platform));
  await writeFile(path.join(tempDir, 'studio.json'), JSON.stringify({}));

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
