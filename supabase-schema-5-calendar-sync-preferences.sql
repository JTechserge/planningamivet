-- À exécuter une seule fois dans Supabase (SQL Editor → New query → Run), après
-- supabase-schema-4-calendar-sync.sql. Ajoute :
-- 1) un jeton "précédent" pour permettre une coupure propre : un lien qu'on vient de
--    révoquer/régénérer renvoie un calendrier VIDE (au lieu d'une erreur) le temps que le
--    téléphone se resynchronise tout seul, ce qui fait disparaître les événements déjà
--    ajoutés — Apple/Google ne proposent aucun moyen de "pousser" une suppression instantanée
--    vers un calendrier abonné, donc ce mécanisme est le plus proche possible de ce que vous
--    avez demandé.
-- 2) des préférences par vétérinaire : quoi synchroniser (présence / absences / les deux) et
--    une couleur indicative pour les événements.

alter table calendar_sync_tokens add column if not exists previous_token text;
alter table calendar_sync_tokens add column if not exists sync_presence boolean not null default true;
alter table calendar_sync_tokens add column if not exists sync_absences boolean not null default true;
alter table calendar_sync_tokens add column if not exists color text not null default '#0F766E';

-- Génère (ou régénère) le lien d'un vétérinaire. L'ancien jeton (s'il existe) passe en
-- "previous_token" au lieu d'être perdu, pour permettre la coupure propre décrite plus haut.
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
  on conflict (person_id) do update
    set previous_token = calendar_sync_tokens.token, token = new_token, updated_at = now();
  return new_token;
end;
$$;
grant execute on function generate_calendar_sync_token(text) to anon;

-- Désactive le lien d'un vétérinaire : tous les appareils qui y sont abonnés (un même lien
-- peut être ajouté à plusieurs téléphones/comptes) perdent l'accès en même temps.
create or replace function revoke_calendar_sync_token(p_person_id text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update calendar_sync_tokens
  set previous_token = token, token = null, updated_at = now()
  where person_id = p_person_id;
$$;
grant execute on function revoke_calendar_sync_token(text) to anon;

-- Renvoie l'état complet (jeton actif + préférences) pour réafficher le panneau de réglages
-- sans devoir tout régénérer à chaque fois.
create or replace function get_calendar_sync_status(p_person_id text)
returns table(token text, sync_presence boolean, sync_absences boolean, color text)
language sql
security definer
set search_path = public, extensions
as $$
  select token, sync_presence, sync_absences, color
  from calendar_sync_tokens where person_id = p_person_id;
$$;
grant execute on function get_calendar_sync_status(text) to anon;

-- Met à jour les préférences (quoi synchroniser, quelle couleur) sans toucher au jeton.
create or replace function update_calendar_sync_preferences(p_person_id text, p_sync_presence boolean, p_sync_absences boolean, p_color text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into calendar_sync_tokens (person_id, sync_presence, sync_absences, color, updated_at)
  values (p_person_id, p_sync_presence, p_sync_absences, p_color, now())
  on conflict (person_id) do update
    set sync_presence = p_sync_presence, sync_absences = p_sync_absences, color = p_color, updated_at = now();
end;
$$;
grant execute on function update_calendar_sync_preferences(text, boolean, boolean, text) to anon;

-- Utilisée uniquement par la fonction Edge calendar-feed. 'active' = jeton actuel (flux
-- complet) ; 'stale' = ancien jeton tout juste révoqué/remplacé (flux vide, pour nettoyer
-- l'appareil au prochain rafraîchissement) ; aucune ligne = jeton jamais valide.
create or replace function get_calendar_feed_access(p_person_id text, p_token text)
returns table(status text, sync_presence boolean, sync_absences boolean, color text)
language sql
security definer
set search_path = public, extensions
as $$
  select
    case when token = p_token then 'active' else 'stale' end,
    sync_presence, sync_absences, color
  from calendar_sync_tokens
  where person_id = p_person_id and (token = p_token or previous_token = p_token);
$$;
grant execute on function get_calendar_feed_access(text, text) to anon;

-- L'ancienne fonction n'est plus appelée par le site ni par la fonction Edge.
drop function if exists verify_calendar_sync_token(text, text);
