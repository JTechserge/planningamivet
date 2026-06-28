-- À exécuter une seule fois dans Supabase (SQL Editor → New query → Run)
-- Stocke tout le planning (présences, absences, demandes de congé) dans une seule ligne
-- JSON partagée entre tous les appareils, au lieu du localStorage propre à chaque navigateur.

create table if not exists planning_data (
  id text primary key default 'singleton',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into planning_data (id, data)
values ('singleton', '{}'::jsonb)
on conflict (id) do nothing;

alter table planning_data enable row level security;

-- Accès simple en lecture/écriture pour tout le monde avec la clé "anon" (pas de compte
-- utilisateur côté Supabase). C'est la même logique que le mot de passe déjà en place dans
-- l'app : une protection légère, pas un vrai contrôle d'accès — la clé anon est de toute
-- façon visible dans le code source public du site.
create policy "allow anon read" on planning_data
  for select using (true);

create policy "allow anon update" on planning_data
  for update using (true);
