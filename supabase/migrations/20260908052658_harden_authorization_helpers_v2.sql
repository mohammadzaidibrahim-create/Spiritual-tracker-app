create schema if not exists private;

create or replace function private.can_access_user_data(p_subject_user_id uuid, p_permission text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.accountability_relationships r
    join public.accountability_permissions p on p.relationship_id = r.id
    where r.partner_id = p_subject_user_id
      and r.requester_id = (select auth.uid())
      and r.role = 'mentor'
      and r.status = 'active'
      and case p_permission
        when 'recovery_data' then p.recovery_data
        when 'relapse_history' then p.relapse_history
        when 'trigger_details' then p.trigger_details
        when 'daily_checkin' then p.daily_checkin
        when 'streak' then p.streak
        when 'weekly_reports' then p.weekly_reports
        when 'monthly_reports' then p.monthly_reports
        when 'reflections' then p.reflections
        else false
      end
  );
$$;

revoke all on schema private from public;
grant usage on schema private to authenticated;
grant execute on function private.can_access_user_data(uuid, text) to authenticated;

DROP POLICY IF EXISTS recovery_events_select_authorized ON public.recovery_events;
DROP POLICY IF EXISTS recovery_events_update_authorized ON public.recovery_events;
DROP POLICY IF EXISTS recovery_profiles_select_authorized ON public.recovery_profiles;

create policy recovery_events_select_authorized on public.recovery_events for select to authenticated using ((user_id = (select auth.uid())) or private.can_access_user_data(user_id, 'recovery_data'));
create policy recovery_profiles_select_authorized on public.recovery_profiles for select to authenticated using ((user_id = (select auth.uid())) or private.can_access_user_data(user_id, 'recovery_data'));

revoke all on function public.can_access_user_data(uuid, text) from public;
revoke all on function public.can_access_user_data(uuid, text) from anon;
revoke all on function public.can_access_user_data(uuid, text) from authenticated;

create index if not exists mentor_notes_mentor_id_idx on public.mentor_notes(mentor_id);
create index if not exists mentor_notes_subject_user_id_idx on public.mentor_notes(subject_user_id);