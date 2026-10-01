revoke all on function private.can_access_user_data(uuid, text) from public;
revoke all on function private.can_access_user_data(uuid, text) from anon;
revoke all on function private.can_access_user_data(uuid, text) from authenticated;
grant execute on function private.can_access_user_data(uuid, text) to authenticated;