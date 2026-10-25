(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { admin: null, csrf: '', page: 'overview', businessStatus: 'pending_review', businessQuery: '', businessPage: 1, categories: [] };
  const authScreen = $('#authScreen'); const consoleScreen = $('#consoleScreen'); const view = $('#view');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateText = (value) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  let toastTimer;
  function notify(message, error = false) { const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3400); }
  function showMessage(message, error = false) { const box = $('#authMessage'); if (!box) return; box.textContent = message; box.className = `message visible${error ? ' error' : ''}`; }
  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD' && state.csrf) headers['x-platform-admin-csrf'] = state.csrf;
    const response = await fetch(`/api/platform-admin${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    let data; try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function setAuthenticated(admin, csrf) {
    state.admin = admin; state.csrf = csrf || '';
    authScreen.hidden = true; consoleScreen.hidden = false;
    $('#adminName').textContent = admin.name; $('#adminEmail').textContent = admin.email; $('#avatar').textContent = admin.name.slice(0, 1).toUpperCase(); $('#roleLabel').textContent = admin.role.toUpperCase();
    document.body.classList.add('authenticated');
    $$('.owner-only').forEach((item) => { item.hidden = admin.role !== 'owner'; });
    navigate('overview');
  }
  function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }
  function authCard(title, intro, content, eyebrow = 'FORMÉ PLATFORM SECURITY') {
    authScreen.innerHTML = `<section class="auth-card"><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p><div id="authMessage" class="message"></div>${content}</section>`;
    authScreen.hidden = false; consoleScreen.hidden = true;
  }
  function renderLogin() {
    authCard('Sign in to operations.', 'Platform administrators use a separate account and authenticator. Salon partner credentials do not work here.', `<form id="loginForm" class="form-grid"><div class="field"><label for="loginEmail">Admin email</label><input id="loginEmail" name="email" type="email" autocomplete="username" required maxlength="254"></div><div class="field"><label for="loginPassword">Password</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required maxlength="128"></div><div class="field"><label for="loginCode">Authenticator code</label><input id="loginCode" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="000 000" required maxlength="6"></div><button class="primary-button wide" type="submit">Continue securely <span>→</span></button></form><p class="helper">Use the current 6-digit code from your authenticator app. Codes work once.</p>`);
  }
  function renderBootstrap(token = '') {
    authCard('Set up the first owner.', 'This one-time setup needs the approved owner email and private bootstrap token stored in Render environment settings.', `<form id="bootstrapStartForm" class="form-grid"><div class="field"><label for="bootstrapEmail">Approved owner email</label><input id="bootstrapEmail" type="email" autocomplete="email" required maxlength="254"></div><div class="field"><label for="bootstrapToken">One-time bootstrap token</label><input id="bootstrapToken" type="password" autocomplete="off" required maxlength="256"></div><button class="primary-button wide" type="submit">Begin secure setup <span>→</span></button></form><p class="helper">The bootstrap token is only for initial owner setup. Never send it in chat or include it in source code.</p>`);
    if (token) $('#bootstrapToken').value = token;
  }
  function renderSetupForm({ token, secret, email, uri, invite = false, name = '' }) {
    authCard(invite ? 'Activate your admin access.' : 'Secure your owner account.', invite ? 'Finish your invitation by creating a password and enrolling an authenticator app.' : 'Add the secret to an authenticator app, then enter its current code to finish owner setup.', `<div class="secret-box"><label>ADD THIS KEY IN GOOGLE AUTHENTICATOR, 1PASSWORD, OR ANOTHER TOTP APP</label><div class="secret-value"><span id="secretValue">${escapeHtml(secret)}</span><button type="button" class="quiet-button" data-copy-secret>Copy</button></div></div><p class="helper">Manual key setup works with most authenticator apps. Issuer link: <a href="${escapeHtml(uri)}">open authenticator</a></p><form id="setupCompleteForm" class="form-grid"><input type="hidden" name="token" value="${escapeHtml(token)}">${invite ? `<div class="invite-banner">Invitation for <strong>${escapeHtml(email)}</strong> · ${escapeHtml(name || 'Admin')}</div>` : `<div class="field"><label for="ownerName">Your name</label><input id="ownerName" name="name" autocomplete="name" minlength="2" maxlength="80" required></div>`}<div class="field"><label for="setupPassword">${invite ? 'Create a unique password' : 'Create your owner password'}</label><input id="setupPassword" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small class="helper">Use at least 12 characters. A password manager is recommended.</small></div><div class="field"><label for="setupCode">Current authenticator code</label><input id="setupCode" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000 000" required></div><button class="primary-button wide" type="submit">Finish secure setup <span>→</span></button></form>`);
  }
  async function initializeAuth() {
    const inviteToken = new URLSearchParams(location.search).get('invite');
    if (inviteToken) {
      authCard('Preparing your invitation.', 'We are creating your personal authenticator setup.', '<div class="loading">Please wait…</div>', 'ADMIN INVITATION');
      try { const invite = await api('/invites/start', { method: 'POST', body: JSON.stringify({ token: inviteToken }) }); renderSetupForm({ token: inviteToken, secret: invite.secret, email: invite.email, name: invite.name, uri: invite.otpauthUri, invite: true }); }
      catch (error) { authCard('Invitation unavailable.', error.message, '<a class="primary-button" href="/platform-admin">Return to sign in</a>', 'ADMIN INVITATION'); }
      return;
    }
    try {
      const session = await api('/session'); state.csrf = session.csrfToken; setAuthenticated(session.admin, session.csrfToken); return;
    } catch {}
    try {
      const status = await api('/bootstrap/status');
      if (status.hasAdmin) return renderLogin();
      if (!status.bootstrapEnabled) return authCard('Owner setup is not ready yet.', 'The platform bootstrap email and token must be added to the Render web service environment before anyone can create an admin account.', `<div class="setup-steps"><strong>One-time Render setup</strong><ol><li>Add <code>PLATFORM_ADMIN_BOOTSTRAP_EMAIL</code> for your owner email.</li><li>Add a long random <code>PLATFORM_ADMIN_BOOTSTRAP_TOKEN</code> in the service environment.</li><li>Save and deploy, then reopen this page.</li></ol></div><p class="helper">No public admin signup is available. This page stays closed until those private values exist.</p>`, 'FIRST OWNER SETUP');
      renderBootstrap();
    } catch (error) { authCard('Operations console unavailable.', error.message, '<p class="helper">Confirm the service is connected to PostgreSQL and reload this page.</p>'); }
  }
  async function navigate(page) {
    if (page === 'audit' && state.admin?.role !== 'owner' || page === 'admins' && state.admin?.role !== 'owner') page = 'overview';
    state.page = page; $$('#nav [data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
    const titles = { overview: 'Overview', businesses: 'Businesses', categories: 'Categories', audit: 'Audit trail', admins: 'Admin access' }; $('#pageTitle').textContent = titles[page] || 'Overview'; view.innerHTML = '<div class="loading">Loading platform data…</div>';
    try {
      if (page === 'overview') return await renderOverview();
      if (page === 'businesses') return await renderBusinesses();
      if (page === 'categories') return await renderCategories();
      if (page === 'audit') return await renderAudit();
      if (page === 'admins') return await renderAdmins();
    } catch (error) { view.innerHTML = `<section class="panel"><h2 class="section-title">Could not load this section</h2><p class="helper">${escapeHtml(error.message)}</p><button class="secondary-button" data-reload-page>Try again</button></section>`; }
  }
  async function renderOverview() {
    const data = await api('/overview'); const pending = Number(data.pending || 0);
    $('#pendingBadge').textContent = pending; $('#pendingBadge').hidden = pending < 1;
    view.innerHTML = `<div class="welcome-row"><div><h2>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${escapeHtml(state.admin.name.split(' ')[0])}.</h2><p>Here is the current health of your FORME marketplace.</p></div><span class="date-note">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span></div><div class="stat-grid"><article class="stat-card"><div class="stat-label">Registered businesses</div><div class="stat-value">${Number(data.businesses)}</div><div class="stat-hint">Partner accounts on the platform</div></article><article class="stat-card alert"><div class="stat-label">Waiting for review</div><div class="stat-value">${pending}</div><div class="stat-hint">Need a verification decision</div></article><article class="stat-card accent"><div class="stat-label">Approved listings</div><div class="stat-value">${Number(data.approved)}</div><div class="stat-hint">Visible to customers</div></article><article class="stat-card"><div class="stat-label">Active categories</div><div class="stat-value">${Number(data.categories)}</div><div class="stat-hint">Marketplace discovery groups</div></article></div><section class="panel"><div class="panel-heading"><div><h2>Review businesses before they go live</h2><p>New partner listings stay private until an authorized reviewer approves them.</p></div><button class="primary-button" data-go-page="businesses">${pending ? 'Review pending' : 'View businesses'} <span>→</span></button></div><div class="subtle-note">Platform-admin access is separate from salon workspaces. Every approval, suspension, category change, and admin-access change is recorded in the audit trail.</div></section><section class="panel"><div class="panel-heading"><div><h2>Access role</h2><p>Your current platform permissions.</p></div><span class="pill approved">${escapeHtml(state.admin.role)}</span></div><p class="helper">Owner: manage categories, business decisions, admins, and audit trail. Reviewer: verify listings. Support: view business records. All admins sign in with a password and authenticator code.</p></section>`;
  }
  async function renderBusinesses() {
    const params = new URLSearchParams({ status: state.businessStatus, q: state.businessQuery, page: state.businessPage }); const data = await api(`/businesses?${params}`);
    const canReview = ['owner', 'reviewer'].includes(state.admin.role);
    view.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>Business verification</h2><p>Approve legitimate listings. Rejected or suspended listings stay hidden from customer discovery.</p></div><span class="pill pending_review">${data.total} total</span></div><div class="filter-row"><div class="toolbar"><select id="businessStatus"><option value="pending_review" ${state.businessStatus === 'pending_review' ? 'selected' : ''}>Needs review</option><option value="approved" ${state.businessStatus === 'approved' ? 'selected' : ''}>Approved</option><option value="rejected" ${state.businessStatus === 'rejected' ? 'selected' : ''}>Rejected</option><option value="suspended" ${state.businessStatus === 'suspended' ? 'selected' : ''}>Suspended</option><option value="all" ${state.businessStatus === 'all' ? 'selected' : ''}>All statuses</option></select><input id="businessSearch" type="search" value="${escapeHtml(state.businessQuery)}" placeholder="Business, city, or owner email"><button class="secondary-button" data-search-businesses>Search</button></div></div><div class="table-wrap"><table><thead><tr><th>Business</th><th>Category</th><th>Location</th><th>Owner account</th><th>Status</th><th>Review action</th></tr></thead><tbody>${data.businesses.length ? data.businesses.map((business) => `<tr><td class="business-name"><strong>${escapeHtml(business.name)}</strong><small>/${escapeHtml(business.slug)} · ${business.branches.length} location${business.branches.length === 1 ? '' : 's'}</small></td><td><span class="cell-stack">${escapeHtml(business.categoryName)}<small>${escapeHtml(business.subcategoryName || 'No subcategory')}</small></span></td><td><span class="cell-stack">${escapeHtml(business.branches.map((branch) => [branch.city, branch.country].filter(Boolean).join(', ')).join(' · ') || 'No location')}</span></td><td>${escapeHtml(business.ownerEmail || 'Owner account unavailable')}</td><td><span class="pill ${escapeHtml(business.status)}">${escapeHtml(business.status.replace('_', ' '))}</span>${business.reviewNote ? `<small class="cell-stack">${escapeHtml(business.reviewNote)}</small>` : ''}</td><td class="table-business-actions">${canReview ? `<div class="row-actions">${business.status !== 'approved' ? `<button class="secondary-button" data-review="approved" data-id="${escapeHtml(business.id)}" data-name="${escapeHtml(business.name)}">Approve</button>` : `<button class="quiet-button" data-review="suspended" data-id="${escapeHtml(business.id)}" data-name="${escapeHtml(business.name)}">Suspend</button>`}${business.status !== 'rejected' ? `<button class="danger-button" data-review="rejected" data-id="${escapeHtml(business.id)}" data-name="${escapeHtml(business.name)}">Reject</button>` : ''}</div>` : '<span class="helper">View only</span>'}</td></tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◇</div>No businesses match this filter.</div></td></tr>`}</tbody></table></div><div class="panel-heading" style="margin:13px 0 0"><span class="helper">Showing ${data.businesses.length} of ${data.total}</span><div class="toolbar"><button class="quiet-button" data-business-page="prev" ${state.businessPage <= 1 ? 'disabled' : ''}>← Previous</button><span class="helper">Page ${data.page}</span><button class="quiet-button" data-business-page="next" ${data.page * data.pageSize >= data.total ? 'disabled' : ''}>Next →</button></div></div></section>`;
  }
  async function renderCategories() {
    const categories = await api('/categories'); state.categories = categories; const canEdit = state.admin.role === 'owner';
    view.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>Discovery categories</h2><p>Manage the categories businesses select and customers browse.</p></div>${canEdit ? '<button class="primary-button" data-create-category>+ Add category</button>' : ''}</div><div class="category-grid">${categories.length ? categories.map((category) => `<article class="category-card"><div class="category-top"><div><strong>${escapeHtml(category.name)}</strong><small>/${escapeHtml(category.slug)} · ${category.active ? 'Active in signup' : 'Inactive'}</small></div><span class="pill ${category.active ? 'approved' : 'rejected'}">${category.active ? 'Active' : 'Inactive'}</span></div><p class="helper">${escapeHtml(category.description || 'No description')}</p><div class="subcategory-list">${category.subcategories.length ? category.subcategories.map((sub) => `<span class="subcategory-tag">${escapeHtml(sub.name)}${sub.active ? '' : ' · hidden'}</span>`).join('') : '<span class="helper">No subcategories</span>'}</div>${canEdit ? `<div class="category-actions"><button class="quiet-button" data-edit-category="${escapeHtml(category.id)}">Edit</button><button class="quiet-button" data-add-subcategory="${escapeHtml(category.id)}">+ Subcategory</button><button class="quiet-button" data-toggle-category="${escapeHtml(category.id)}" data-active="${category.active}">${category.active ? 'Deactivate' : 'Activate'}</button></div>${category.subcategories.map((sub) => `<div class="category-actions"><small class="helper">${escapeHtml(sub.name)}</small><button class="quiet-button" data-edit-subcategory="${escapeHtml(sub.id)}" data-category-id="${escapeHtml(category.id)}" data-active="${sub.active}">${sub.active ? 'Edit / hide' : 'Edit / show'}</button></div>`).join('')}` : ''}</article>`).join('') : '<div class="empty-state">No categories yet.</div>'}</div><div class="subtle-note" style="margin-top:16px">Categories are saved in the marketplace database. They are deactivated instead of deleted so existing business records keep their category.</div></section>`;
  }
  async function renderAudit() {
    const data = await api('/audit?limit=75');
    view.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>Administrative activity</h2><p>Who changed what, when, and why. Audit records cannot be edited through this console.</p></div><button class="quiet-button" data-reload-page>Refresh</button></div>${data.events.length ? data.events.map((event) => `<article class="audit-row"><time>${escapeHtml(dateText(event.createdAt))}</time><div><strong>${escapeHtml(event.action.replaceAll('.', ' · '))}</strong><p>${escapeHtml(event.actorEmail)} · ${escapeHtml(event.targetType)} ${escapeHtml(event.targetId)}${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}</p>${Object.keys(event.metadata || {}).length ? `<p>${escapeHtml(JSON.stringify(event.metadata))}</p>` : ''}</div><span class="audit-meta">${escapeHtml(event.remoteAddress || '—')}</span></article>`).join('') : '<div class="empty-state">No admin actions recorded yet.</div>'}</section>`;
  }
  async function renderAdmins() {
    const data = await api('/admins');
    view.innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>Invite a platform administrator</h2><p>Invitations expire in 48 hours and require the recipient to enroll MFA.</p></div></div><form id="inviteForm" class="toolbar"><input name="name" placeholder="Admin name" required minlength="2" maxlength="80"><input name="email" placeholder="Work email" type="email" required maxlength="254"><select name="role"><option value="reviewer">Reviewer · approve listings</option><option value="support">Support · view-only</option></select><button class="primary-button">Send invite</button></form><p class="helper">New admins cannot access salon workspaces. Only an owner can invite, promote, or deactivate administrators.</p></section><section class="panel"><div class="panel-heading"><div><h2>Admin accounts</h2><p>Deactivate access immediately when an administrator leaves.</p></div></div>${data.admins.map((admin) => `<div class="admin-row"><div><strong>${escapeHtml(admin.name)}</strong><small>${escapeHtml(admin.email)} · added ${escapeHtml(dateText(admin.createdAt))}</small></div><select data-admin-role="${escapeHtml(admin.id)}" aria-label="Role for ${escapeHtml(admin.name)}" ${admin.id === state.admin.id ? 'disabled' : ''}><option value="owner" ${admin.role === 'owner' ? 'selected' : ''}>Owner</option><option value="reviewer" ${admin.role === 'reviewer' ? 'selected' : ''}>Reviewer</option><option value="support" ${admin.role === 'support' ? 'selected' : ''}>Support</option></select><span class="status-dot ${admin.active ? '' : 'off'}">${admin.active ? 'Active' : 'Inactive'} · MFA ${admin.mfaEnabled ? 'on' : 'off'}</span><button class="${admin.active ? 'danger-button' : 'secondary-button'}" data-toggle-admin="${escapeHtml(admin.id)}" data-active="${admin.active}" ${admin.id === state.admin.id ? 'disabled' : ''}>${admin.active ? 'Deactivate' : 'Reactivate'}</button></div>`).join('')}</section><section class="panel"><div class="panel-heading"><div><h2>Open invitations</h2><p>Expired invitations cannot be used.</p></div></div>${data.invites.length ? data.invites.map((invite) => `<div class="admin-row"><div><strong>${escapeHtml(invite.name)}</strong><small>${escapeHtml(invite.email)} · ${escapeHtml(dateText(invite.createdAt))}</small></div><span>${escapeHtml(invite.role)}</span><span class="status-dot ${invite.consumedAt || new Date(invite.expiresAt) < new Date() ? 'off' : ''}">${invite.consumedAt ? 'Accepted' : new Date(invite.expiresAt) < new Date() ? 'Expired' : 'Waiting'}</span><span class="helper">${escapeHtml(dateText(invite.expiresAt))}</span>${!invite.consumedAt ? `<button class="danger-button" data-revoke-invite="${escapeHtml(invite.email)}">Revoke</button>` : ''}</div>`).join('') : '<div class="empty-state">No invitations have been sent.</div>'}</section>`;
  }
  function currentCategory(id) { return state.categories.find((category) => category.id === id); }
  async function reviewBusiness(id, name, status) {
    const reasons = { approved: 'Reviewed business details and approved listing.', rejected: 'Business listing does not meet platform requirements.', suspended: 'Listing temporarily suspended pending review.', pending_review: 'Returned to review queue.' };
    const reason = window.prompt(`Reason for ${status.replace('_', ' ')}:`, reasons[status]); if (reason === null) return;
    try { await api(`/businesses/${encodeURIComponent(id)}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }); notify(`${name} moved to ${status.replace('_', ' ')}.`); await navigate(state.page); }
    catch (error) { notify(error.message, true); }
  }
  async function createCategory() {
    const name = window.prompt('Category name (for example, Nail studio)'); if (!name) return; const description = window.prompt('Short description shown to partners (optional).', '') || '';
    try { await api('/categories', { method: 'POST', body: JSON.stringify({ name, description }) }); notify('Category added.'); await navigate('categories'); }
    catch (error) { notify(error.message, true); }
  }
  async function editCategory(id) {
    const category = currentCategory(id); if (!category) return; const name = window.prompt('Category name', category.name); if (!name) return; const description = window.prompt('Short description', category.description) ?? category.description;
    try { await api(`/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, description, active: category.active }) }); notify('Category updated.'); await navigate('categories'); }
    catch (error) { notify(error.message, true); }
  }
  async function toggleCategory(id, active) {
    const category = currentCategory(id); if (!category) return;
    try { await api(`/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: category.name, description: category.description, active: !active }) }); notify(`Category ${active ? 'deactivated' : 'activated'}.`); await navigate('categories'); }
    catch (error) { notify(error.message, true); }
  }
  async function addSubcategory(id) {
    const name = window.prompt('Subcategory name'); if (!name) return;
    try { await api(`/categories/${encodeURIComponent(id)}/subcategories`, { method: 'POST', body: JSON.stringify({ name }) }); notify('Subcategory added.'); await navigate('categories'); }
    catch (error) { notify(error.message, true); }
  }
  async function editSubcategory(categoryId, subcategoryId, active) {
    const category = currentCategory(categoryId); const sub = category?.subcategories.find((item) => item.id === subcategoryId); if (!sub) return; const name = window.prompt('Subcategory name', sub.name); if (!name) return;
    try { await api(`/categories/${encodeURIComponent(categoryId)}/subcategories/${encodeURIComponent(subcategoryId)}`, { method: 'PATCH', body: JSON.stringify({ name, active: !active }) }); notify('Subcategory updated.'); await navigate('categories'); }
    catch (error) { notify(error.message, true); }
  }
  async function toggleAdmin(id, active) {
    if (!window.confirm(`${active ? 'Deactivate' : 'Reactivate'} this administrator?${active ? ' Their active sessions will be revoked.' : ''}`)) return;
    try { await api(`/admins/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: !active }) }); notify(`Admin ${active ? 'deactivated' : 'reactivated'}.`); await navigate('admins'); }
    catch (error) { notify(error.message, true); }
  }
  async function revokeInvite(email) {
    if (!window.confirm(`Revoke the open invitation for ${email}?`)) return;
    try { await api(`/admins/invites/${encodeURIComponent(email)}`, { method: 'DELETE' }); notify('Invitation revoked.'); await navigate('admins'); }
    catch (error) { notify(error.message, true); }
  }
  async function updateAdminRole(select) {
    const role = select.value; select.disabled = true;
    try { await api(`/admins/${encodeURIComponent(select.dataset.adminRole)}`, { method: 'PATCH', body: JSON.stringify({ role }) }); notify('Admin role updated.'); await navigate('admins'); }
    catch (error) { notify(error.message, true); await navigate('admins'); }
  }

  $('#nav').addEventListener('click', (event) => { const button = event.target.closest('[data-page]'); if (button) navigate(button.dataset.page); });
  $('#logoutButton').addEventListener('click', async () => { try { await api('/logout', { method: 'POST', body: '{}' }); } catch {} state.admin = null; state.csrf = ''; await initializeAuth(); });
  view.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.goPage) return navigate(button.dataset.goPage);
    if (button.hasAttribute('data-reload-page')) return navigate(state.page);
    if (button.dataset.searchBusinesses !== undefined) { state.businessQuery = $('#businessSearch').value.trim(); state.businessStatus = $('#businessStatus').value; state.businessPage = 1; return navigate('businesses'); }
    if (button.dataset.businessPage) { state.businessPage += button.dataset.businessPage === 'next' ? 1 : -1; return navigate('businesses'); }
    if (button.dataset.review) return reviewBusiness(button.dataset.id, button.dataset.name, button.dataset.review);
    if (button.hasAttribute('data-create-category')) return createCategory();
    if (button.dataset.editCategory) return editCategory(button.dataset.editCategory);
    if (button.dataset.toggleCategory) return toggleCategory(button.dataset.toggleCategory, button.dataset.active === 'true');
    if (button.dataset.addSubcategory) return addSubcategory(button.dataset.addSubcategory);
    if (button.dataset.editSubcategory) return editSubcategory(button.dataset.categoryId, button.dataset.editSubcategory, button.dataset.active === 'true');
    if (button.dataset.toggleAdmin) return toggleAdmin(button.dataset.toggleAdmin, button.dataset.active === 'true');
    if (button.dataset.revokeInvite) return revokeInvite(button.dataset.revokeInvite);
    if (button.hasAttribute('data-copy-secret')) { await navigator.clipboard?.writeText($('#secretValue').textContent); return notify('Authenticator key copied. Keep it private.'); }
  });
  view.addEventListener('change', (event) => { if (event.target.matches('[data-admin-role]')) updateAdminRole(event.target); });
  view.addEventListener('submit', async (event) => {
    if (event.target.id !== 'inviteForm') return; event.preventDefault(); const form = event.target; const values = Object.fromEntries(new FormData(form)); const button = form.querySelector('button'); button.disabled = true;
    try { await api('/admins/invites', { method: 'POST', body: JSON.stringify(values) }); notify(`Invitation sent to ${values.email}.`); await navigate('admins'); }
    catch (error) { notify(error.message, true); button.disabled = false; }
  });
  authScreen.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.target; const button = form.querySelector('button[type="submit"]'); if (button) button.disabled = true;
    try {
      if (form.id === 'loginForm') {
        const data = Object.fromEntries(new FormData(form)); const result = await api('/login', { method: 'POST', body: JSON.stringify(data) }); history.replaceState(null, '', '/platform-admin'); setAuthenticated(result.admin, result.csrfToken);
      } else if (form.id === 'bootstrapStartForm') {
        const data = { email: $('#bootstrapEmail').value, bootstrapToken: $('#bootstrapToken').value }; const result = await api('/bootstrap/start', { method: 'POST', body: JSON.stringify(data) }); renderSetupForm({ token: result.setupToken, secret: result.secret, email: data.email, uri: result.otpauthUri }); showMessage('Now enter your authenticator code. Setup expires in 15 minutes.');
      } else if (form.id === 'setupCompleteForm') {
        const data = Object.fromEntries(new FormData(form)); const invite = new URLSearchParams(location.search).has('invite'); const result = invite ? await api('/invites/complete', { method: 'POST', body: JSON.stringify(data) }) : await api('/bootstrap/complete', { method: 'POST', body: JSON.stringify(data) }); history.replaceState(null, '', '/platform-admin'); setAuthenticated(result.admin, result.csrfToken);
      }
    } catch (error) { showMessage(error.message, true); if (button) button.disabled = false; }
  });
  authScreen.addEventListener('click', async (event) => { if (!event.target.closest('[data-copy-secret]')) return; try { await navigator.clipboard.writeText($('#secretValue').textContent); notify('Authenticator key copied. Keep it private.'); } catch { notify('Select and copy the authenticator key manually.', true); } });
  (async () => {
    if (new URLSearchParams(location.search).has('invite')) return initializeAuth();
    try { const session = await api('/session'); setAuthenticated(session.admin, session.csrfToken); }
    catch { await initializeAuth(); }
  })();
})();
