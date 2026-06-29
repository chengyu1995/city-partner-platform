create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text,
  avatar_url text,
  gender text check (gender is null or gender in ('female', 'male', 'nonbinary', 'prefer_not_to_say')),
  birth_year integer check (birth_year is null or (birth_year between 1900 and extract(year from now())::integer)),
  city text,
  district text,
  bio text,
  interests text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.partner_posts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  title text not null,
  description text,
  city text not null,
  district text,
  meeting_place text,
  starts_at timestamptz,
  capacity integer not null default 2 check (capacity > 0),
  gender_preference text not null default 'any' check (gender_preference in ('any', 'female', 'male', 'nonbinary')),
  age_min integer check (age_min is null or age_min >= 18),
  age_max integer check (age_max is null or age_max >= 18),
  status text not null default 'published' check (status in ('draft', 'published', 'closed', 'expired', 'cancelled')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_posts_age_range check (age_min is null or age_max is null or age_min <= age_max)
);

create table if not exists public.partner_applications (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.partner_posts(id) on delete cascade,
  applicant_id uuid not null references auth.users(id) on delete cascade,
  message text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, applicant_id)
);

create index if not exists partner_posts_public_feed_idx
  on public.partner_posts (status, city, district, starts_at);

create index if not exists partner_posts_creator_idx
  on public.partner_posts (creator_id, created_at desc);

create index if not exists partner_applications_post_idx
  on public.partner_applications (post_id, created_at desc);

create index if not exists partner_applications_applicant_idx
  on public.partner_applications (applicant_id, created_at desc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists partner_posts_set_updated_at on public.partner_posts;
create trigger partner_posts_set_updated_at
before update on public.partner_posts
for each row execute function public.set_updated_at();

drop trigger if exists partner_applications_set_updated_at on public.partner_applications;
create trigger partner_applications_set_updated_at
before update on public.partner_applications
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, nickname)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1))
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

alter table public.profiles enable row level security;
alter table public.partner_posts enable row level security;
alter table public.partner_applications enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
using (auth.uid() = user_id);

drop policy if exists "Users can create own profile" on public.profiles;
create policy "Users can create own profile"
on public.profiles for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Public can read published partner posts" on public.partner_posts;
create policy "Public can read published partner posts"
on public.partner_posts for select
using (
  status = 'published'
  and (expires_at is null or expires_at > now())
);

drop policy if exists "Creators can read own partner posts" on public.partner_posts;
create policy "Creators can read own partner posts"
on public.partner_posts for select
using (auth.uid() = creator_id);

drop policy if exists "Authenticated users can create partner posts" on public.partner_posts;
create policy "Authenticated users can create partner posts"
on public.partner_posts for insert
to authenticated
with check (auth.uid() = creator_id);

drop policy if exists "Creators can update own partner posts" on public.partner_posts;
create policy "Creators can update own partner posts"
on public.partner_posts for update
to authenticated
using (auth.uid() = creator_id)
with check (auth.uid() = creator_id);

drop policy if exists "Applicants and post creators can read applications" on public.partner_applications;
create policy "Applicants and post creators can read applications"
on public.partner_applications for select
to authenticated
using (
  auth.uid() = applicant_id
  or exists (
    select 1
    from public.partner_posts
    where partner_posts.id = partner_applications.post_id
      and partner_posts.creator_id = auth.uid()
  )
);

drop policy if exists "Authenticated users can apply to partner posts" on public.partner_applications;
create policy "Authenticated users can apply to partner posts"
on public.partner_applications for insert
to authenticated
with check (
  auth.uid() = applicant_id
  and exists (
    select 1
    from public.partner_posts
    where partner_posts.id = partner_applications.post_id
      and partner_posts.status = 'published'
      and (partner_posts.expires_at is null or partner_posts.expires_at > now())
  )
);

drop policy if exists "Post creators can approve applications" on public.partner_applications;
create policy "Post creators can approve applications"
on public.partner_applications for update
to authenticated
using (
  exists (
    select 1
    from public.partner_posts
    where partner_posts.id = partner_applications.post_id
      and partner_posts.creator_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.partner_posts
    where partner_posts.id = partner_applications.post_id
      and partner_posts.creator_id = auth.uid()
  )
);
