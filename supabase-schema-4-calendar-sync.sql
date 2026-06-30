-- À exécuter une seule fois dans Supabase (SQL Editor → New query → Run), après les
-- migrations précédentes. Stocke un jeton secret par vétérinaire, utilisé pour générer un
-- lien d'abonnement calendrier (iOS/Android) personnel et révocable. Le jeton n'est jamais
-- lisible directement (pas de policy "select") : tout passe par les fonctions ci-dessous.

create table if not exists calendar_sync_tokens (
  person_id text primary key,
  token text,
  updated_at timestamptz not null default now()
);

alter table calendar_sync_tokens enable row level security;
drop policy if exists "allow anon update" on calendar_sync_tokens;
create policy "allow anon update" on calendar_sync_tokens
  for update using (true);
drop policy if exists "allow anon insert" on calendar_sync_tokens;
create policy "allow anon insert" on calendar_sync_tokens
  for insert with check (true);

-- Génère (ou régénère) le lien d'un vétérinaire et renvoie le nouveau jeton.
create or replace function generate_calendar_sync_token(p_person_id text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_token text;
begin
  new_token := encode(gen_random_bytes(24), 'hex');
  insert into calendar_sync_tokens (person_id, token, updated_at)
  values (p_person_id, new_token, now())
  on conflict (person_id) do update set token = new_token, updated_at = now();
  return new_token;
end;
$$;
grant execute on function generate_calendar_sync_token(text) to anon;

-- Désactive le lien d'un vétérinaire (l'ancien lien cesse de fonctionner).
create or replace function revoke_calendar_sync_token(p_person_id text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update calendar_sync_tokens set token = null, updated_at = now() where person_id = p_person_id;
$$;
grant execute on function revoke_calendar_sync_token(text) to anon;

-- Renvoie le jeton actif d'un vétérinaire (ou null s'il n'a pas encore activé la
-- synchronisation), pour pouvoir réafficher/recopier son lien sans devoir le régénérer à
-- chaque fois qu'il rouvre ce panneau de réglages.
create or replace function get_calendar_sync_status(p_person_id text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select token from calendar_sync_tokens where person_id = p_person_id;
$$;
grant execute on function get_calendar_sync_status(text) to anon;

-- Utilisée uniquement par la fonction Edge calendar-feed pour vérifier un jeton reçu dans
-- l'URL d'abonnement (jamais appelée depuis le site).
create or replace function verify_calendar_sync_token(p_person_id text, p_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select token = p_token from calendar_sync_tokens where person_id = p_person_id and token is not null;
$$;
grant execute on function verify_calendar_sync_token(text, text) to anon;
