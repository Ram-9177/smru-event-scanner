/**
 * The twelve tables of the build plan, run by the first Knex migration (migrations.ts). Every statement is
 * safe to run again, so it also brings an existing database up to date.
 */
export const SCHEMA_SQL = `
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  role text not null default 'organiser' check (role in ('super_admin','organiser')),
  created_at timestamptz not null default now()
);

-- The Microsoft sign-in the sync job uses (one per org).
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references orgs(id) on delete cascade,
  account_email text,
  refresh_token text,              -- encrypted
  drive_id text,
  root_item_id text,
  root_name text,
  needs_reconnect boolean not null default false,
  connected_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null unique,
  title text not null,
  starts_on date,
  ends_on date,
  venue text,
  status text not null default 'draft' check (status in ('draft','live','closed','archived')),
  album_passcode_hash text,
  allow_download boolean not null default true,
  face_enabled boolean not null default true,
  face_expiry_at timestamptz,
  face_model text,
  onedrive_drive_id text,
  onedrive_folder_id text,
  onedrive_folder_name text,
  crowd_folder_id text,
  last_sync_at timestamptz,
  sync_error text,
  listed boolean not null default true,
  crowd_uploads boolean not null default true,
  auto_approve boolean not null default false,
  cover_media_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  title text not null,
  onedrive_folder_id text not null,
  sort int not null default 0,
  unique (event_id, onedrive_folder_id)
);

-- Every photo and video.
--   source : onedrive (your files) or crowd (a student's upload)
--   review : pending | approved | rejected (your own photos start approved)
--   duplicate_of : the photo that is shown instead of this copy; never another copy
create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  section_id uuid references sections(id) on delete set null,
  type text not null default 'photo' check (type in ('photo','video')),
  status text not null default 'found' check (status in ('found','processing','ready','failed','skipped')),
  status_reason text,
  name text,
  bytes bigint,
  onedrive_item_id text,
  ctag text,
  web_key text,
  thumb_key text,
  width int,
  height int,
  taken_at timestamptz,
  sha256 text,
  phash bytea,
  duplicate_of uuid references media(id),
  face_count int,
  hidden boolean not null default false,
  source text not null default 'onedrive' check (source in ('onedrive','crowd')),
  review text not null default 'approved' check (review in ('pending','approved','rejected')),
  uploader_name text,
  uploader_guest_id uuid,
  keep_both boolean not null default false,   -- the organiser pressed "Show anyway": never mark it as a copy again
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (event_id, onedrive_item_id)
);
create index if not exists media_event_status on media (event_id, status);
create index if not exists media_event_sha on media (event_id, sha256);
create index if not exists media_duplicate_of on media (duplicate_of);

-- One row per face found. embedding = 128 float32 numbers stored as bytes.
create table if not exists faces (
  id bigserial primary key,
  event_id uuid not null references events(id) on delete cascade,
  media_id uuid not null references media(id) on delete cascade,
  embedding bytea not null,
  box_x int not null,
  box_y int not null,
  box_w int not null,
  box_h int not null,
  det_score real not null,
  model text not null
);
create index if not exists faces_event on faces (event_id);
create index if not exists faces_media on faces (media_id);

-- One attendee on one device for one event. No login: the phone holds a random token.
create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  device_token_hash text not null,
  consent_version text,
  consent_at timestamptz,
  keep_updated boolean not null default false,
  embedding bytea,
  album_ok boolean not null default false,
  upload_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (event_id, device_token_hash)
);

create table if not exists matches (
  guest_id uuid not null references guests(id) on delete cascade,
  media_id uuid not null references media(id) on delete cascade,
  similarity real not null,
  tier text not null check (tier in ('sure','maybe')),
  not_me boolean not null default false,
  primary key (guest_id, media_id)
);

create table if not exists search_log (
  id bigserial primary key,
  event_id uuid not null references events(id) on delete cascade,
  guest_id uuid references guests(id) on delete set null,
  ip_hash text,
  result_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists search_log_guest on search_log (guest_id, created_at);

create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  media_id uuid references media(id) on delete cascade,
  guest_id uuid references guests(id) on delete set null,
  kind text not null check (kind in ('report','removal')),
  reason text,
  status text not null default 'open' check (status in ('open','approved','declined')),
  resolved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Columns added after the first build (safe to run again).
alter table media add column if not exists keep_both boolean not null default false;
-- How much fine detail the photo has (blurred burst frames score low): picks which of two same shots is shown.
alter table media add column if not exists sharpness real;
-- Which permission the OneDrive sign-in was given: 'approot' (the app's own folder) or 'folder' (the wider one).
alter table connections add column if not exists scope text;
alter table connections add column if not exists root_mode text;

create table if not exists audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text,
  detail jsonb,
  created_at timestamptz not null default now()
);
`;

/**
 * The one rule for what students see, as a SQL condition on a media row aliased "m". copies_lost: its album copies
 * cannot be made again (the original is gone from OneDrive), so there is nothing to show (media/rebuild.ts).
 */
export const VISIBLE = `(m.status = 'ready' and m.review = 'approved' and not m.hidden and m.duplicate_of is null and not m.copies_lost)`;
