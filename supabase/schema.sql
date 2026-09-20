-- ============================================================
-- Mealio — Supabase schema v3
-- Rechtstreekse toegang vanuit de browser (anon key), beveiligd met
-- Row Level Security + een e-mail-allowlist gekoppeld aan Google-login
-- via Supabase Auth. Geen eigen server meer nodig.
-- ============================================================

-- >>> VERVANG deze twee e-mailadressen door jullie eigen Google-accounts <<<
-- Deze functie wordt in alle policies hieronder gebruikt.
create or replace function is_allowed_user()
returns boolean as $$
  select (auth.jwt() ->> 'email') in (
    'bral.ampe@gmail.com',
    'peter@casentis.be'
  );
$$ language sql stable;

-- 1. RECEPTEN
create table recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  portions_base int not null default 1,
  carbs_per_portion numeric,               -- gram koolhydraten per portie (optioneel, voor de dagtotalen)
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  stars int check (stars between 1 and 5),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. WEEKMENU (blijft permanent bewaard per week -> dient meteen als geschiedenis)
create table weekmenu_entries (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  day text not null,
  meal text not null,
  persons int not null default 2,
  type text,
  recipe_id uuid references recipes(id) on delete set null,
  locked boolean not null default false,
  feedback text check (feedback in ('up', 'down')),  -- kook-feedback, stuurt de sterren van het recept bij
  ai_generated boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (week_start, day, meal)
);

-- 3. IN DE KAST
create table pantry_stock (
  id uuid primary key default gen_random_uuid(),
  ingredient_name text not null unique,
  in_stock boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 4. AI-RECEPTVOORSTELLEN (wachtlijst)
create table ai_recipe_suggestions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text,
  portions_base int default 1,
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  based_on_ingredients text[],
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- 5. INSTELLINGEN (winkels, boodschappenlijst-status)
create table app_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index idx_weekmenu_recipe on weekmenu_entries(recipe_id);
create index idx_weekmenu_week on weekmenu_entries(week_start);
create index idx_suggestions_status on ai_recipe_suggestions(status);

-- ------------------------------------------------------------
-- Row Level Security: AAN. Alleen wie met een van de twee toegelaten
-- Google-accounts is ingelogd, mag lezen én schrijven — voor alle tabellen.
-- ------------------------------------------------------------
alter table recipes enable row level security;
alter table weekmenu_entries enable row level security;
alter table pantry_stock enable row level security;
alter table ai_recipe_suggestions enable row level security;
alter table app_settings enable row level security;

create policy "allowed users full access" on recipes
  for all using (is_allowed_user()) with check (is_allowed_user());
create policy "allowed users full access" on weekmenu_entries
  for all using (is_allowed_user()) with check (is_allowed_user());
create policy "allowed users full access" on pantry_stock
  for all using (is_allowed_user()) with check (is_allowed_user());
create policy "allowed users full access" on ai_recipe_suggestions
  for all using (is_allowed_user()) with check (is_allowed_user());
create policy "allowed users full access" on app_settings
  for all using (is_allowed_user()) with check (is_allowed_user());
