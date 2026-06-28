-- À exécuter une seule fois dans Supabase (SQL Editor → New query → Run), après les
-- 2 migrations précédentes. Déplace le mot de passe de l'onglet Tableau de bord HORS du
-- code source (qui est public sur GitHub) vers Supabase, sous forme de hash uniquement
-- (jamais en clair, et jamais lisible directement même avec la clé "anon" publique : tout
-- passe par les fonctions ci-dessous, qui ne renvoient que vrai/faux).
--
-- ⚠️ Avant d'exécuter ce fichier : remplacez 'CHANGEZ-MOI' (dans la requête "update" plus
-- bas) par le mot de passe que vous voulez utiliser réellement. Ne réutilisez pas
-- "David&Stéphane26!" : il reste visible pour toujours dans l'historique Git public du
-- dépôt, même après cette migration.

create extension if not exists pgcrypto;

create table if not exists app_security (
  id text primary key default 'singleton',
  password_hash text not null,
  password_salt text not null,
  reset_token text,
  reset_token_expires_at timestamptz,
  reset_email_pending boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into app_security (id, password_salt, password_hash)
values ('singleton', encode(gen_random_bytes(16), 'hex'), '')
on conflict (id) do nothing;

-- ⚠️ Remplacez 'CHANGEZ-MOI' ci-dessous avant d'exécuter ce fichier.
update app_security
set password_hash = encode(digest(password_salt || 'CHANGEZ-MOI', 'sha256'), 'hex')
where id = 'singleton';

alter table app_security enable row level security;
-- Volontairement AUCUNE policy "select" : ni le navigateur ni le script GitHub Actions ne
-- peuvent lire le hash/sel directement, seulement via les fonctions security definer
-- ci-dessous (chacune ne renvoie que le strict nécessaire : vrai/faux, ou un token).
create policy "allow anon update" on app_security
  for update using (true);

-- Vérifie un mot de passe saisi sur l'écran de connexion. Ne renvoie que vrai/faux.
create or replace function verify_gate_password(input text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select password_hash = encode(digest(password_salt || input, 'sha256'), 'hex')
  from app_security where id = 'singleton';
$$;
grant execute on function verify_gate_password(text) to anon;

-- Changement de mot de passe depuis le menu réglages (l'utilisateur connaît déjà l'ancien).
create or replace function change_gate_password(current_password text, new_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  ok boolean;
  new_salt text;
begin
  select password_hash = encode(digest(password_salt || current_password, 'sha256'), 'hex')
  into ok
  from app_security where id = 'singleton';
  if not ok then
    return false;
  end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  update app_security
  set password_salt = new_salt,
      password_hash = encode(digest(new_salt || new_password, 'sha256'), 'hex'),
      updated_at = now()
  where id = 'singleton';
  return true;
end;
$$;
grant execute on function change_gate_password(text, text) to anon;

-- Demande un lien de réinitialisation ("mot de passe oublié"). Le site appelle cette
-- fonction puis le script GitHub Actions (toutes les 5 minutes) envoie le lien par email.
create or replace function request_password_reset(token text, expires_at timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  update app_security
  set reset_token = token, reset_token_expires_at = expires_at, reset_email_pending = true
  where id = 'singleton';
$$;
grant execute on function request_password_reset(text, timestamptz) to anon;

-- Utilisée par le script GitHub Actions pour savoir s'il y a un email à envoyer, sans
-- jamais exposer le hash/sel de la table.
create or replace function get_pending_password_reset()
returns table(token text, expires_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select reset_token, reset_token_expires_at
  from app_security
  where id = 'singleton' and reset_email_pending = true;
$$;
grant execute on function get_pending_password_reset() to anon;

create or replace function mark_password_reset_email_sent()
returns void
language sql
security definer
set search_path = public
as $$
  update app_security set reset_email_pending = false where id = 'singleton';
$$;
grant execute on function mark_password_reset_email_sent() to anon;

-- Finalise la réinitialisation depuis la page dédiée (lien reçu par email). Vérifie le
-- token ET son expiration dans la même transaction, puis remplace le mot de passe.
create or replace function complete_password_reset(in_token text, new_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  valid boolean;
  new_salt text;
begin
  select (reset_token = in_token and reset_token_expires_at > now()) into valid
  from app_security where id = 'singleton';
  if not valid then
    return false;
  end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  update app_security
  set password_salt = new_salt,
      password_hash = encode(digest(new_salt || new_password, 'sha256'), 'hex'),
      reset_token = null,
      reset_token_expires_at = null,
      reset_email_pending = false,
      updated_at = now()
  where id = 'singleton';
  return true;
end;
$$;
grant execute on function complete_password_reset(text, text) to anon;
