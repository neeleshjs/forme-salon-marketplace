CREATE TABLE IF NOT EXISTS marketplace_accounts (
  id UUID PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('partner', 'customer')),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_type, email)
);

CREATE TABLE IF NOT EXISTS marketplace_businesses (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id TEXT REFERENCES marketplace_categories(id) ON DELETE RESTRICT,
  subcategory_id TEXT REFERENCES marketplace_subcategories(id) ON DELETE SET NULL,
  owner_account_id UUID REFERENCES marketplace_accounts(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'suspended')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_business_memberships (
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, account_id)
);

CREATE TABLE IF NOT EXISTS marketplace_branches (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, slug),
  UNIQUE (id, business_id),
  CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
);

CREATE INDEX IF NOT EXISTS marketplace_branches_business_active_idx ON marketplace_branches (business_id, active);
CREATE INDEX IF NOT EXISTS marketplace_businesses_discovery_idx ON marketplace_businesses (review_status, active, category_id);

CREATE TABLE IF NOT EXISTS event_occasions (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_packages (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  occasion_id UUID REFERENCES event_occasions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  booking_mode TEXT NOT NULL DEFAULT 'quote' CHECK (booking_mode IN ('instant', 'quote')),
  fulfillment_modes TEXT[] NOT NULL DEFAULT ARRAY['venue']::TEXT[],
  starting_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (starting_price >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  min_notice_hours INTEGER NOT NULL DEFAULT 24 CHECK (min_notice_hours >= 0),
  max_distance_km NUMERIC(8,2) CHECK (max_distance_km IS NULL OR max_distance_km >= 0),
  travel_base_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (travel_base_fee >= 0),
  travel_fee_per_km NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (travel_fee_per_km >= 0),
  travel_buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (travel_buffer_minutes BETWEEN 0 AND 1440),
  portfolio_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (branch_id, business_id) REFERENCES marketplace_branches(id, business_id) ON DELETE CASCADE,
  CHECK (cardinality(fulfillment_modes) > 0),
  CHECK (fulfillment_modes <@ ARRAY['business', 'home', 'venue']::TEXT[])
);

CREATE INDEX IF NOT EXISTS event_packages_discovery_idx ON event_packages (occasion_id, booking_mode, active, starting_price);
CREATE INDEX IF NOT EXISTS event_packages_branch_active_idx ON event_packages (business_id, branch_id, active);

CREATE TABLE IF NOT EXISTS event_package_items (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES event_packages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  participant_role TEXT NOT NULL DEFAULT 'any',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  included BOOLEAN NOT NULL DEFAULT TRUE,
  price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_package_items_package_idx ON event_package_items (package_id, sort_order, id);

CREATE TABLE IF NOT EXISTS marketplace_branch_resources (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('staff', 'room', 'equipment')),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (branch_id, business_id) REFERENCES marketplace_branches(id, business_id) ON DELETE CASCADE,
  UNIQUE (id, branch_id)
);
CREATE INDEX IF NOT EXISTS marketplace_branch_resources_active_idx ON marketplace_branch_resources (branch_id, active, resource_type);

CREATE TABLE IF NOT EXISTS event_quote_requests (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL,
  customer_account_id UUID NOT NULL REFERENCES marketplace_accounts(id) ON DELETE RESTRICT,
  package_id UUID REFERENCES event_packages(id) ON DELETE SET NULL,
  occasion_id UUID NOT NULL REFERENCES event_occasions(id) ON DELETE RESTRICT,
  request_type TEXT NOT NULL DEFAULT 'quote' CHECK (request_type IN ('quote', 'instant')),
  status TEXT NOT NULL DEFAULT 'quote_requested' CHECK (status IN ('quote_requested', 'quote_sent', 'quote_accepted', 'change_requested', 'rejected', 'expired', 'awaiting_deposit', 'confirmed', 'cancelled')),
  fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('business', 'home', 'venue')),
  event_date DATE NOT NULL,
  event_start_time TIME NOT NULL,
  ready_by_time TIME NOT NULL,
  time_zone TEXT NOT NULL,
  participant_count INTEGER NOT NULL CHECK (participant_count BETWEEN 1 AND 100),
  required_professionals INTEGER NOT NULL DEFAULT 1 CHECK (required_professionals BETWEEN 1 AND 50),
  venue_private_ciphertext BYTEA NOT NULL,
  venue_private_iv BYTEA NOT NULL,
  venue_private_tag BYTEA NOT NULL,
  venue_city TEXT NOT NULL DEFAULT '',
  travel_distance_km NUMERIC(8,2),
  estimated_travel_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (estimated_travel_fee >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  requirements TEXT NOT NULL DEFAULT '',
  latest_quote_expires_at TIMESTAMPTZ,
  accepted_quote_id UUID,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (branch_id, business_id) REFERENCES marketplace_branches(id, business_id) ON DELETE RESTRICT,
  UNIQUE (customer_account_id, idempotency_key),
  CHECK (ready_by_time > event_start_time)
);

CREATE INDEX IF NOT EXISTS event_quote_requests_business_status_idx ON event_quote_requests (business_id, branch_id, status, event_date);
CREATE INDEX IF NOT EXISTS event_quote_requests_customer_idx ON event_quote_requests (customer_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_request_participants (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES event_quote_requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'guest',
  display_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_request_participants_request_idx ON event_request_participants (request_id, sort_order);

CREATE TABLE IF NOT EXISTS event_request_services (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES event_quote_requests(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES event_request_participants(id) ON DELETE SET NULL,
  package_item_id UUID REFERENCES event_package_items(id) ON DELETE SET NULL,
  requested_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_request_services_request_idx ON event_request_services (request_id, sort_order);

CREATE TABLE IF NOT EXISTS event_quotes (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES event_quote_requests(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'rejected', 'expired', 'superseded')),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  travel_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (travel_fee >= 0),
  taxes NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxes >= 0),
  total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  deposit_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (deposit_percent BETWEEN 0 AND 100),
  deposit_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  currency CHAR(3) NOT NULL,
  terms TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES marketplace_accounts(id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, revision),
  CHECK (total = subtotal + travel_fee + taxes)
);

CREATE TABLE IF NOT EXISTS event_quote_items (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL REFERENCES event_quotes(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES event_request_participants(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes BETWEEN 0 AND 1440),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_quote_items_quote_idx ON event_quote_items (quote_id, sort_order);

CREATE TABLE IF NOT EXISTS event_resource_assignments (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES event_quote_requests(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES marketplace_businesses(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('hold', 'confirmed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (branch_id, business_id) REFERENCES marketplace_branches(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, branch_id) REFERENCES marketplace_branch_resources(id, branch_id) ON DELETE RESTRICT,
  UNIQUE (request_id, resource_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS event_resource_assignments_branch_time_idx ON event_resource_assignments (branch_id, starts_at, ends_at) WHERE status IN ('hold', 'confirmed');

ALTER TABLE event_quote_requests
  ADD CONSTRAINT event_quote_requests_accepted_quote_fk
  FOREIGN KEY (accepted_quote_id) REFERENCES event_quotes(id) ON DELETE SET NULL;

INSERT INTO event_occasions (id, slug, name, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'bridal-makeup', 'Bridal makeup', 10),
  ('00000000-0000-4000-8000-000000000002', 'groom-grooming', 'Groom makeup and grooming', 20),
  ('00000000-0000-4000-8000-000000000003', 'couple-package', 'Bride and groom package', 30),
  ('00000000-0000-4000-8000-000000000004', 'engagement', 'Engagement makeup', 40),
  ('00000000-0000-4000-8000-000000000005', 'reception', 'Reception makeup', 50),
  ('00000000-0000-4000-8000-000000000006', 'haldi', 'Haldi services', 60),
  ('00000000-0000-4000-8000-000000000007', 'mehendi', 'Mehendi services', 70),
  ('00000000-0000-4000-8000-000000000008', 'wedding-guests', 'Wedding guest makeup', 80),
  ('00000000-0000-4000-8000-000000000009', 'family-package', 'Family beauty package', 90),
  ('00000000-0000-4000-8000-000000000010', 'photoshoot-styling', 'Pre-wedding photoshoot styling', 100),
  ('00000000-0000-4000-8000-000000000011', 'party-makeup', 'Party and birthday makeup', 110),
  ('00000000-0000-4000-8000-000000000012', 'hairstyling', 'Hairstyling', 120),
  ('00000000-0000-4000-8000-000000000013', 'draping', 'Draping', 130),
  ('00000000-0000-4000-8000-000000000014', 'custom-event-package', 'Customized event package', 140)
ON CONFLICT (slug) DO NOTHING;
