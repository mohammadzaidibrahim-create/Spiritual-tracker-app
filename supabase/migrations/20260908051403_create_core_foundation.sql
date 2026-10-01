create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sisters_mode boolean not null default false,
  hayd_mode boolean not null default false,
  sos_visible boolean not null default true,
  feeling_down_visible boolean not null default true,
  reminder_enabled boolean not null default true,
  cloud_sync_enabled boolean not null default false,
  notification_preferences jsonb not null default '{}'::jsonb,
  section_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.daily_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_date date not null,
  score integer not null default 0,
  max_score integer not null default 0,
  fardh_salah jsonb not null default '{}'::jsonb,
  nafl_salah jsonb not null default '{}'::jsonb,
  khushu jsonb not null default '{}'::jsonb,
  gaze jsonb not null default '{}'::jsonb,
  music_free boolean,
  dhikr jsonb not null default '{}'::jsonb,
  quran jsonb not null default '{}'::jsonb,
  fasting jsonb not null default '{}'::jsonb,
  habits jsonb not null default '[]'::jsonb,
  custom_sections jsonb not null default '{}'::jsonb,
  reflection jsonb not null default '{}'::jsonb,
  is_hayd_mode boolean not null default false,
  is_sisters_mode boolean not null default false,
  saved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, record_date),
  check (score >= 0),
  check (max_score >= 0)
);

create index daily_records_user_date_idx on public.daily_records (user_id, record_date desc);

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.daily_records enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "preferences_select_own" on public.user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "preferences_insert_own" on public.user_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "preferences_update_own" on public.user_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "daily_records_select_own" on public.daily_records
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "daily_records_insert_own" on public.daily_records
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "daily_records_update_own" on public.daily_records
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "daily_records_delete_own" on public.daily_records
  for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger preferences_set_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

create trigger daily_records_set_updated_at
before update on public.daily_records
for each row execute function public.set_updated_at();
