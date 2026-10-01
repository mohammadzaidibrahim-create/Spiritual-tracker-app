create or replace function public.is_active_accountability_relationship(p_relationship_id uuid, p_user_id uuid, p_role public.accountability_role default null)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.accountability_relationships r
    where r.id = p_relationship_id
      and r.status = 'active'
      and (r.requester_id = p_user_id or r.partner_id = p_user_id)
      and (p_role is null or r.role = p_role)
  );
$$;

create or replace function public.can_access_user_data(p_subject_user_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_subject_user_id = (select auth.uid())
  or exists (
    select 1
    from public.accountability_relationships r
    join public.accountability_permissions p on p.relationship_id = r.id
    where r.status = 'active'
      and r.partner_id = p_subject_user_id
      and r.requester_id = (select auth.uid())
      and (
        (p_permission = 'daily_checkin' and p.daily_checkin) or
        (p_permission = 'streak' and p.streak) or
        (p_permission = 'weekly_reports' and p.weekly_reports) or
        (p_permission = 'monthly_reports' and p.monthly_reports) or
        (p_permission = 'recovery_data' and p.recovery_data) or
        (p_permission = 'relapse_history' and p.relapse_history) or
        (p_permission = 'trigger_details' and p.trigger_details) or
        (p_permission = 'reflections' and p.reflections)
      )
  );
$$;

revoke all on function public.can_access_user_data(uuid,text) from public;
grant execute on function public.can_access_user_data(uuid,text) to authenticated;

create policy recovery_events_select_authorized on public.recovery_events for select to authenticated using (
  user_id = (select auth.uid())
  or public.can_access_user_data(user_id, 'recovery_data')
);

create policy recovery_events_update_authorized on public.recovery_events for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy recovery_profiles_select_authorized on public.recovery_profiles for select to authenticated using (
  user_id = (select auth.uid())
  or public.can_access_user_data(user_id, 'recovery_data')
);

create policy accountability_relationships_delete_participant on public.accountability_relationships for delete to authenticated using (requester_id = (select auth.uid()) or partner_id = (select auth.uid()));

create policy accountability_permissions_delete_requester on public.accountability_permissions for delete to authenticated using (exists (select 1 from public.accountability_relationships r where r.id = relationship_id and r.requester_id = (select auth.uid())));

create policy mentor_notes_select_subject_forbidden on public.mentor_notes for select to authenticated using (false);

create or replace function public.create_accountability_relationship(p_partner_id uuid, p_role public.accountability_role)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if p_partner_id = (select auth.uid()) then raise exception 'Cannot create a relationship with yourself'; end if;
  insert into public.accountability_relationships(requester_id, partner_id, role)
  values ((select auth.uid()), p_partner_id, p_role)
  returning id into v_id;
  insert into public.accountability_permissions(relationship_id) values (v_id);
  return v_id;
end;
$$;
revoke all on function public.create_accountability_relationship(uuid,public.accountability_role) from public;
grant execute on function public.create_accountability_relationship(uuid,public.accountability_role) to authenticated;

create or replace function public.respond_to_accountability_relationship(p_relationship_id uuid, p_accept boolean)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.accountability_relationships
  set status = case when p_accept then 'active'::public.relationship_status else 'declined'::public.relationship_status end,
      accepted_at = case when p_accept then now() else null end
  where id = p_relationship_id
    and partner_id = (select auth.uid())
    and status = 'pending';
  return found;
end;
$$;
revoke all on function public.respond_to_accountability_relationship(uuid,boolean) from public;
grant execute on function public.respond_to_accountability_relationship(uuid,boolean) to authenticated;

create or replace function public.revoke_accountability_relationship(p_relationship_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.accountability_relationships
  set status = 'revoked'::public.relationship_status, revoked_at = now()
  where id = p_relationship_id
    and (requester_id = (select auth.uid()) or partner_id = (select auth.uid()))
    and status = 'active';
  return found;
end;
$$;
revoke all on function public.revoke_accountability_relationship(uuid) from public;
grant execute on function public.revoke_accountability_relationship(uuid) to authenticated;

create trigger recovery_profiles_set_updated_at before update on public.recovery_profiles for each row execute function public.set_updated_at();
create trigger recovery_events_set_updated_at before update on public.recovery_events for each row execute function public.set_updated_at();
create trigger accountability_permissions_set_updated_at before update on public.accountability_permissions for each row execute function public.set_updated_at();
create trigger mentor_notes_set_updated_at before update on public.mentor_notes for each row execute function public.set_updated_at();