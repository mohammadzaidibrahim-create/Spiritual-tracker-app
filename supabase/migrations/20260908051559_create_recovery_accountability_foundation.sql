create type public.accountability_role as enum ('mentor','peer');
create type public.relationship_status as enum ('pending','active','declined','revoked');

create table public.recovery_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recovery_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  duration_minutes integer,
  context jsonb not null default '{}'::jsonb,
  emotional_state jsonb not null default '{}'::jsonb,
  triggers jsonb not null default '{}'::jsonb,
  pathway jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recovery_events_duration_nonnegative check (duration_minutes is null or duration_minutes >= 0),
  constraint recovery_events_context_object check (jsonb_typeof(context) = 'object'),
  constraint recovery_events_emotional_object check (jsonb_typeof(emotional_state) = 'object'),
  constraint recovery_events_triggers_object check (jsonb_typeof(triggers) = 'object'),
  constraint recovery_events_pathway_object check (jsonb_typeof(pathway) = 'object')
);

create table public.accountability_relationships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  partner_id uuid not null references auth.users(id) on delete cascade,
  role public.accountability_role not null,
  status public.relationship_status not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint accountability_no_self_relationship check (requester_id <> partner_id)
);

create table public.accountability_permissions (
  relationship_id uuid primary key references public.accountability_relationships(id) on delete cascade,
  daily_checkin boolean not null default true,
  streak boolean not null default true,
  weekly_reports boolean not null default true,
  monthly_reports boolean not null default true,
  recovery_data boolean not null default false,
  relapse_history boolean not null default false,
  trigger_details boolean not null default false,
  reflections boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.mentor_notes (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.accountability_relationships(id) on delete cascade,
  mentor_id uuid not null references auth.users(id) on delete cascade,
  subject_user_id uuid not null references auth.users(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recovery_events_user_occurred_idx on public.recovery_events(user_id, occurred_at desc);
create index accountability_relationships_requester_idx on public.accountability_relationships(requester_id, status);
create index accountability_relationships_partner_idx on public.accountability_relationships(partner_id, status);
create index mentor_notes_relationship_idx on public.mentor_notes(relationship_id, created_at desc);

alter table public.recovery_profiles enable row level security;
alter table public.recovery_events enable row level security;
alter table public.accountability_relationships enable row level security;
alter table public.accountability_permissions enable row level security;
alter table public.mentor_notes enable row level security;

create policy recovery_profiles_select_own on public.recovery_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy recovery_profiles_insert_own on public.recovery_profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy recovery_profiles_update_own on public.recovery_profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy recovery_profiles_delete_own on public.recovery_profiles for delete to authenticated using (user_id = (select auth.uid()));

create policy recovery_events_select_own on public.recovery_events for select to authenticated using (user_id = (select auth.uid()));
create policy recovery_events_insert_own on public.recovery_events for insert to authenticated with check (user_id = (select auth.uid()));
create policy recovery_events_update_own on public.recovery_events for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy recovery_events_delete_own on public.recovery_events for delete to authenticated using (user_id = (select auth.uid()));

create policy accountability_relationships_select_participant on public.accountability_relationships for select to authenticated using (requester_id = (select auth.uid()) or partner_id = (select auth.uid()));
create policy accountability_relationships_insert_requester on public.accountability_relationships for insert to authenticated with check (requester_id = (select auth.uid()) and requester_id <> partner_id);
create policy accountability_relationships_update_participant on public.accountability_relationships for update to authenticated using (requester_id = (select auth.uid()) or partner_id = (select auth.uid())) with check (requester_id = (select auth.uid()) or partner_id = (select auth.uid()));

create policy accountability_permissions_select_participant on public.accountability_permissions for select to authenticated using (exists (select 1 from public.accountability_relationships r where r.id = relationship_id and (r.requester_id = (select auth.uid()) or r.partner_id = (select auth.uid()))));
create policy accountability_permissions_insert_requester on public.accountability_permissions for insert to authenticated with check (exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid())));
create policy accountability_permissions_update_requester on public.accountability_permissions for update to authenticated using (exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid()))) with check (exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid())));

create policy mentor_notes_select_mentor on public.mentor_notes for select to authenticated using (mentor_id = (select auth.uid()) and exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid()) and r.partner_id = subject_user_id and r.role = 'mentor' and r.status = 'active'));
create policy mentor_notes_insert_mentor on public.mentor_notes for insert to authenticated with check (mentor_id = (select auth.uid()) and exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid()) and r.partner_id = subject_user_id and r.role = 'mentor' and r.status = 'active'));
create policy mentor_notes_update_mentor on public.mentor_notes for update to authenticated using (mentor_id = (select auth.uid())) with check (mentor_id = (select auth.uid()));
create policy mentor_notes_delete_mentor on public.mentor_notes for delete to authenticated using (mentor_id = (select auth.uid()));