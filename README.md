# FORME Salon Cloud

[**Open the live website**](https://forme-salon-marketplace.onrender.com)

A responsive salon marketplace website with location-led salon discovery, ratings, customer accounts, online booking, and salon partner tools. It connects local customers to salons while giving salon owners a multi-brand, multi-branch operations workspace. Each branch has its own appointments, team, services, customers, stock, local time zone, and currency. Owners can switch locations from one workspace and review their portfolio across branches.

## Web pages

The web app uses direct, reloadable routes for each main customer and salon workflow:

- `/` : marketplace home.
- `/salons` : salon search and discovery.
- `/account` : customer sign-in, sign-up, and bookings across salon locations.
- `/salon/:slug` : a salon profile and service menu.
- `/salon/:slug/booking` : booking and customer sign-in.
- `/manage-booking` : reschedule or cancel with the booking reference.
- `/partner` : salon partner overview.
- `/partner/login` and `/partner/signup` : partner access.
- `/platform-admin` : separate operations console for business verification, marketplace categories, administrator access, and audit activity.
- `/studio/:section` : overview, appointments, point of sale, customers, inventory, reports, team, and settings.

## Run locally

1. Install Node.js 20 or newer.
2. In `server/`, run `npm install`.
3. Copy `server/.env.example` to `server/.env`; set a private `SESSION_SECRET`, PostgreSQL `DATABASE_URL`, and the one-time platform-admin bootstrap email and token.
4. Run `npm run dev` from `server/`.
5. Open `http://localhost:5050`.
6. Choose **Owner login**. Demo access: `owner@forme.studio` / `forme-demo-2026`.

Run the automated partner authentication and category checks from `server/` with `npm test`.

## Host a public demo

This repository includes a Render Blueprint for a free Node web service and free PostgreSQL database. The service serves the customer website and APIs from the same URL. The salon partner dashboard and the platform-admin console use separate account records and sign-in sessions.

The free PostgreSQL database is suitable for development and early validation, but review Render's current free-database retention and backup limits before relying on it for important customer records. Razorpay is not configured by default, so deposits use the labeled demo payment flow.

The first start creates the demo owner and FORME location in `server/data/platform.json`. Salon records are stored separately under `server/data/tenants/`; FORME's original demo records remain in `server/data/studio.json`. These local JSON files, `.env`, and `node_modules` are ignored by Git.

## Platform-admin console

- Open `/platform-admin`. It is separate from `/partner/login` and does not accept salon owner or customer credentials.
- The first-owner email comes from `PLATFORM_ADMIN_BOOTSTRAP_EMAIL`, or from `GMAIL_SMTP_USER` when the explicit allowlist is unset. The Render Blueprint generates a private random `PLATFORM_ADMIN_BOOTSTRAP_TOKEN`; do not put it in Git or send it in chat.
- Complete the one-time first-owner setup, use a unique password of at least 12 characters, and enroll the generated secret in an authenticator app. The setup challenge expires after 15 minutes. Once the first owner exists, public owner setup is closed.
- The owner can invite reviewers and view-only support admins. Every administrator must enroll TOTP MFA. Owners can promote existing admins and immediately revoke access by deactivating an account.
- New partner listings enter `pending_review` and stay out of public search and booking until approved. Existing businesses without a review status remain treated as approved to preserve current listings. The partner dashboard displays the decision and reviewer note.
- Reviewers can approve, reject, or suspend listings. Owners can manage categories and subcategories. Important changes are recorded in the platform-admin audit table; its API exposes no edit or delete action.
- Sessions use an HttpOnly, Secure-on-HTTPS, SameSite=Strict cookie, CSRF token, an eight-hour expiry, server-side revocation, and TOTP replay prevention. MFA secrets are encrypted in PostgreSQL using a key derived from `SESSION_SECRET`; rotating that secret will require administrators to enroll MFA again.
- The admin console is an initial operations layer, not a claim of complete production readiness. Payment disputes/refunds, customer-support case management, evidence-document storage, WebAuthn/passkeys, recovery codes, and independent security review are future work.

## Salon partner workflow

- Register an owner account with a configurable business category and subcategory, then add its first business location. Categories are seeded into the database from `server/config/business-categories.json` and the signup form loads them from the public categories API.
- Add more locations in **Studio settings**, with each location's country, city, currency, and IANA time zone.
- Use the salon and branch selectors in the workspace header to switch context. Each location has isolated operational data.
- Review upcoming visits and low-stock counts across the brand in the salon portfolio. Revenue stays grouped in each branch's local currency.
- Use **Add salon brand** to create another brand owned by the same account.
- The customer website supports city and salon search, geolocation-based distance sorting, top-rated sorting, salon selection, customer accounts, booking, and verified reviews. Owners can save a salon map pin with device location or latitude/longitude so it appears in nearby results.
- Customers create an account or sign in before booking. A 25% deposit is due to confirm a booking; the prototype marks a paid deposit as retained for a no-show, and applies it to the visit when staff mark the appointment completed.
- Customers can rate a completed appointment once. Public salon cards display the average rating and verified review count.

## Studio workflow

- **Overview:** today's appointments, upcoming bookings, recorded monthly sales, and low-stock alerts.
- **Appointments:** filter the schedule, update visit status, and export `.ics` events.
- **Point of sale:** ring up services and products, add discounts, redeem/earn loyalty points, and print receipts.
- **Customers:** search client profiles, visits, spend, and notes.
- **Products & stock:** manage retail stock, supplier orders, deliveries, and movement history.
- **Reports:** review sales, service mix, average ticket, and receipts.
- **Team & hours:** add staff and configure working hours.
- **Studio settings:** set opening days and hours, maintain the service menu, manage branches, and review the salon portfolio.

## Demo boundaries

Razorpay Standard Checkout is wired for server-created orders and server-side payment signature/status verification. Configure test `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to use its test checkout. Without those keys, the app offers a clearly labeled demo payment simulation that does not charge money. Configure and test the gateway's capture/refund and webhook policies before taking live payments. Customer and first-time salon-partner signup require one six-digit email OTP before an account is created. The mobile number is collected as contact information and is not verified during signup. Forgot-password recovery for both account types sends a six-digit email code, expires it after 10 minutes, limits attempts and sends, and revokes existing sessions after a successful reset. Email delivery supports Resend, Gmail SMTP, and a Gmail Apps Script web app. For Resend, configure `RESEND_API_KEY` and a verified `OTP_EMAIL_FROM` sender in Render. Gmail SMTP uses `GMAIL_SMTP_USER` and `GMAIL_SMTP_APP_PASSWORD`, but Render Free blocks outbound SMTP ports. For Render Free, deploy `server/apps-script/Code.gs` from the `GMAIL_SMTP_USER` account as a Google Apps Script web app, set its `FORME_MAIL_TOKEN` Script Property, then configure `GMAIL_APPS_SCRIPT_URL` and the same `GMAIL_APPS_SCRIPT_TOKEN` in Render. The app script sends through Gmail over HTTPS and has Google account email quotas. SMS, calendar provider sync, and accounting exports need integrations. Local JSON storage and the built-in password/session implementation are for a prototype. Use a production database, secret management, backups, and a managed identity provider before public deployment. Currency-adjusted starter prices are demo values, not live foreign-exchange conversions.

## API overview

- Public directory: `GET /api/public/salons`.
- Account routes: `POST /api/auth/register`, `/verify-registration`, `/login`, `/select`, `/switch-context`, `/password-reset/start`, `/password-reset/complete`; `GET /api/auth/me`. Customer signup uses `POST /api/customer/register` and `/verify-registration`, then `/login`, `/password-reset/start`, `/password-reset/complete`, and `/me`.
- Public booking routes: `GET /api/services`, `/api/staff`, `/api/availability`; `POST /api/appointments`, `/api/booking/lookup`; `PATCH /api/booking/:reference`.
- Owner routes under `/api/admin/*` use the `x-session-token` header and include branch management and cross-branch portfolio metrics.
- Platform operations use a separate `/api/platform-admin/*` API with database-backed admin accounts, roles, TOTP MFA, revocable sessions, business review, category configuration, invitations, and audit history.
