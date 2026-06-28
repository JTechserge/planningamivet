-- À exécuter une seule fois dans Supabase (SQL Editor → New query → Run), après
-- supabase-schema.sql. Stocke l'adresse destinataire et la fréquence d'envoi du
-- récapitulatif hebdomadaire des congés ASV, modifiables depuis le site (réglages ⚙️).

create table if not exists email_settings (
  id text primary key default 'singleton',
  recipient_email text not null default 'cliniqueamivet@hotmail.fr',
  -- 'daily' | 'weekly' | 'biweekly' | 'monthly'
  frequency text not null default 'weekly',
  last_run_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into email_settings (id)
values ('singleton')
on conflict (id) do nothing;

alter table email_settings enable row level security;

create policy "allow anon read" on email_settings
  for select using (true);

create policy "allow anon update" on email_settings
  for update using (true);
