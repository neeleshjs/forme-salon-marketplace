# FORME Salon Cloud

A responsive salon marketplace website with location-led salon discovery, ratings, customer accounts, online booking, and salon partner tools. It connects local customers to salons while giving salon owners a multi-brand, multi-branch operations workspace. Each branch has its own appointments, team, services, customers, stock, local time zone, and currency. Owners can switch locations from one workspace and review their portfolio across branches.

## Run locally

1. Install Node.js 20 or newer.
2. In `server/`, run `npm install`.
3. Copy `server/.env.example` to `server/.env`; set a private `SESSION_SECRET` and demo owner password before deployment.
4. Run `npm run dev` from `server/`.
5. Open `http://localhost:5050`.
6. Choose **Owner login**. Demo access: `owner@forme.studio` / `forme-demo-2026`.

## Host a public demo

This repository includes a Render Blueprint for a free Node web service. Once the repository is on GitHub, connect it in Render and create the service from `render.yaml`. The service serves the customer website and API from the same URL. Render generates a session secret and demo owner password for the hosted instance; inspect the service environment in Render if you need owner dashboard access.

The free demo uses local JSON files and has no persistent disk, so bookings, accounts, reviews, and salon data can reset when the service restarts or redeploys. Razorpay is not configured by default, so deposits use the labeled demo payment flow. Use a persistent database and configure a payment provider before relying on it for real customers.

The first start creates the demo owner and FORME location in `server/data/platform.json`. Salon records are stored separately under `server/data/tenants/`; FORME's original demo records remain in `server/data/studio.json`. These local JSON files, `.env`, and `node_modules` are ignored by Git.

## Salon partner workflow

- Register an owner account with its first salon brand and location.
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

Razorpay Standard Checkout is wired for server-created orders and server-side payment signature/status verification. Configure test `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to use its test checkout. Without those keys, the app offers a clearly labeled demo payment simulation that does not charge money. Configure and test the gateway's capture/refund and webhook policies before taking live payments. SMS, calendar provider sync, and accounting exports need integrations. Local JSON storage and the built-in password/session implementation are for a prototype. Use a production database, secret management, backups, and a managed identity provider before public deployment. Currency-adjusted starter prices are demo values, not live foreign-exchange conversions.

## API overview

- Public directory: `GET /api/public/salons`.
- Account routes: `POST /api/auth/register`, `/login`, `/select`, `/switch-context`; `GET /api/auth/me`.
- Public booking routes: `GET /api/services`, `/api/staff`, `/api/availability`; `POST /api/appointments`, `/api/booking/lookup`; `PATCH /api/booking/:reference`.
- Owner routes under `/api/admin/*` use the `x-session-token` header and include branch management and cross-branch portfolio metrics.
