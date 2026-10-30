-- KUUZ OS isolated cloud-sync table
-- Run this in the SQL Editor of a NEW Supabase project created for KUUZ OS.
-- Do not run this in the database used by the existing KUUZ WORKSPACE app.
create table if not exists public.kuuz_os_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"tasks":[],"decisions":[],"opportunities":[],"reviews":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.kuuz_os_sync enable row level security;
drop policy if exists "Users can read their own KUUZ OS data" on public.kuuz_os_sync;
create policy "Users can read their own KUUZ OS data" on public.kuuz_os_sync for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can insert their own KUUZ OS data" on public.kuuz_os_sync;
create policy "Users can insert their own KUUZ OS data" on public.kuuz_os_sync for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users can update their own KUUZ OS data" on public.kuuz_os_sync;
create policy "Users can update their own KUUZ OS data" on public.kuuz_os_sync for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No anonymous access and never expose a service_role key in browser code.
