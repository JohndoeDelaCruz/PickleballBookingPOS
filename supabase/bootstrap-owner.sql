-- Replace the placeholder with the verified account created in THIS client project.
-- Run once in the Supabase SQL Editor after setup.sql. Never run in the browser.
do $$
declare owner_email text := 'replace-with-owner@example.com'; owner_id uuid;
begin
 select id into owner_id from auth.users where lower(email)=lower(owner_email) and email_confirmed_at is not null;
 if owner_id is null then raise exception 'Create and verify this owner account first, then replace the email placeholder.';end if;
 insert into public.staff_members(user_id,role) values(owner_id,'owner') on conflict(user_id) do update set role='owner';
end $$;
