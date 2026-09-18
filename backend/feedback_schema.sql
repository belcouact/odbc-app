-- ===========================================================================
-- ODBC Query App — Feedback board schema
-- ===========================================================================
-- Run this ONCE in the Supabase dashboard of project llbxyhphblhplfpgyjht
-- (the same project that serves app updates):  SQL Editor -> paste -> Run.
--
-- Creates:
--   public.feedback_threads   one row per feedback topic
--   public.feedback_replies   replies, deleted with their thread
--   public.feedback_likes     "same problem" votes (one per machine/thread)
--   storage bucket            feedback-attachments (public read, anon write)
--
-- Access model: the app has no sign-in, so the anon key can read and write
-- every row.  The UI only offers edit/delete on your own posts and the
-- backend scopes those calls by the machine's own author id, but this is a
-- convenience boundary, not a security boundary — anyone holding the anon key
-- could call the REST API directly.  Do not put confidential data in here;
-- use this dashboard to remove anything that should not be public.
-- ===========================================================================

-- ---- Tables ---------------------------------------------------------------

create table if not exists public.feedback_threads (
    id            uuid primary key default gen_random_uuid(),
    title         text not null check (char_length(btrim(title)) between 1 and 200),
    body          text not null default '' check (char_length(body) <= 8000),
    category      text not null default 'other'
                  check (category in ('bug', 'idea', 'question', 'other')),
    status        text not null default 'open'
                  check (status in ('open', 'resolved')),
    author_id     text not null,
    author_name   text not null default '',
    app_version   text not null default '',
    attachments   jsonb not null default '[]'::jsonb,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create table if not exists public.feedback_replies (
    id            uuid primary key default gen_random_uuid(),
    thread_id     uuid not null
                  references public.feedback_threads (id) on delete cascade,
    body          text not null check (char_length(btrim(body)) between 1 and 8000),
    author_id     text not null,
    author_name   text not null default '',
    app_version   text not null default '',
    attachments   jsonb not null default '[]'::jsonb,
    created_at    timestamptz not null default now()
);

create table if not exists public.feedback_likes (
    thread_id     uuid not null
                  references public.feedback_threads (id) on delete cascade,
    author_id     text not null,
    created_at    timestamptz not null default now(),
    primary key (thread_id, author_id)
);

create index if not exists feedback_threads_updated_idx
    on public.feedback_threads (updated_at desc);
create index if not exists feedback_threads_status_idx
    on public.feedback_threads (status, updated_at desc);
create index if not exists feedback_threads_category_idx
    on public.feedback_threads (category, updated_at desc);
create index if not exists feedback_replies_thread_idx
    on public.feedback_replies (thread_id, created_at);
create index if not exists feedback_likes_thread_idx
    on public.feedback_likes (thread_id);

-- ---- Keep the thread timestamp fresh when a reply arrives -----------------

create or replace function public.feedback_touch_thread()
returns trigger
language plpgsql
as $$
begin
    update public.feedback_threads
       set updated_at = now()
     where id = new.thread_id;
    return new;
end;
$$;

drop trigger if exists feedback_replies_touch on public.feedback_replies;
create trigger feedback_replies_touch
    after insert on public.feedback_replies
    for each row execute function public.feedback_touch_thread();

-- ---- Row level security: open board, no sign-in --------------------------

alter table public.feedback_threads enable row level security;
alter table public.feedback_replies enable row level security;
alter table public.feedback_likes   enable row level security;

grant select, insert, update, delete
    on public.feedback_threads to anon, authenticated;
grant select, insert, update, delete
    on public.feedback_replies to anon, authenticated;
grant select, insert, update, delete
    on public.feedback_likes to anon, authenticated;

drop policy if exists feedback_threads_read on public.feedback_threads;
create policy feedback_threads_read on public.feedback_threads
    for select to anon, authenticated using (true);

drop policy if exists feedback_threads_insert on public.feedback_threads;
create policy feedback_threads_insert on public.feedback_threads
    for insert to anon, authenticated with check (true);

drop policy if exists feedback_threads_update on public.feedback_threads;
create policy feedback_threads_update on public.feedback_threads
    for update to anon, authenticated using (true) with check (true);

drop policy if exists feedback_threads_delete on public.feedback_threads;
create policy feedback_threads_delete on public.feedback_threads
    for delete to anon, authenticated using (true);

drop policy if exists feedback_replies_read on public.feedback_replies;
create policy feedback_replies_read on public.feedback_replies
    for select to anon, authenticated using (true);

drop policy if exists feedback_replies_insert on public.feedback_replies;
create policy feedback_replies_insert on public.feedback_replies
    for insert to anon, authenticated with check (true);

drop policy if exists feedback_replies_update on public.feedback_replies;
create policy feedback_replies_update on public.feedback_replies
    for update to anon, authenticated using (true) with check (true);

drop policy if exists feedback_replies_delete on public.feedback_replies;
create policy feedback_replies_delete on public.feedback_replies
    for delete to anon, authenticated using (true);

drop policy if exists feedback_likes_read on public.feedback_likes;
create policy feedback_likes_read on public.feedback_likes
    for select to anon, authenticated using (true);

drop policy if exists feedback_likes_insert on public.feedback_likes;
create policy feedback_likes_insert on public.feedback_likes
    for insert to anon, authenticated with check (true);

drop policy if exists feedback_likes_delete on public.feedback_likes;
create policy feedback_likes_delete on public.feedback_likes
    for delete to anon, authenticated using (true);

-- ---- Attachment storage ---------------------------------------------------
-- Screenshots / logs are uploaded here by the backend with the anon key.
-- Public read so the images render straight from the CDN URL; no update or
-- delete policy, so an uploaded object can only be replaced/removed from the
-- dashboard.  This bucket is deliberately separate from the release bucket
-- (odbc-app) so anonymous writes can never touch published builds.

insert into storage.buckets (id, name, public, file_size_limit)
values ('feedback-attachments', 'feedback-attachments', true, 10485760)
on conflict (id) do update set public = true, file_size_limit = 10485760;

drop policy if exists feedback_attachments_read on storage.objects;
create policy feedback_attachments_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'feedback-attachments');

drop policy if exists feedback_attachments_insert on storage.objects;
create policy feedback_attachments_insert on storage.objects
    for insert to anon, authenticated
    with check (bucket_id = 'feedback-attachments');
