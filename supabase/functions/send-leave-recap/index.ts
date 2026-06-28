// Appelée directement par le bouton "Envoyer maintenant" du site (récapitulatif des congés
// ASV) : envoie immédiatement, sans attendre le cron quotidien ni le filtre de fréquence
// (l'utilisateur a explicitement demandé cet envoi). Le cron GitHub Actions garde son propre
// chemin (scripts/send-weekly-recap.mjs) pour l'envoi automatique périodique.
import { wrapEmailHtml, buttonHtml, APP_URL, COLORS } from '../_shared/email-template.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// Seules ces 2 fréquences restent sélectionnables sur le site ; tout autre/ancien réglage
// (ex. "daily"/"now" laissés par d'anciens tests) retombe sur la fenêtre hebdomadaire.
const FREQUENCY_DAYS: Record<string, number> = { weekly: 7, monthly: 30 };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Slot = { iso: string; personId: string; slot: 'M' | 'AM'; label: string };

function toISODate(d: Date){ return d.toISOString().slice(0, 10); }

function isNextSlot(prev: Slot, next: Slot){
  if(prev.iso === next.iso) return prev.slot === 'M' && next.slot === 'AM';
  if(!(prev.slot === 'AM' && next.slot === 'M')) return false;
  const prevDate = new Date(prev.iso + 'T00:00:00Z');
  const nextDate = new Date(next.iso + 'T00:00:00Z');
  const diffDays = Math.round((nextDate.getTime() - prevDate.getTime()) / 86400000);
  if(diffDays === 1) return true;
  if(diffDays === 2){
    const between = new Date(prevDate.getTime() + 86400000);
    return between.getUTCDay() === 0; // dimanche entre les deux : pont, comme dans l'app
  }
  return false;
}

function formatFR(iso: string){
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC' });
}

Deno.serve(async (req) => {
  if(req.method === 'OPTIONS'){
    return new Response('ok', { headers: CORS_HEADERS });
  }
  try{
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/email_settings?select=recipient_email,frequency&id=eq.singleton`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    const settingsRows = await settingsRes.json();
    const recipient = settingsRows[0]?.recipient_email || 'cliniqueamivet@hotmail.fr';

    const dataRes = await fetch(`${SUPABASE_URL}/rest/v1/planning_data?select=data&id=eq.singleton`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    const dataRows = await dataRes.json();
    const slots: Record<string, string> = (dataRows[0] && dataRows[0].data) || {};

    const pending: Slot[] = [];
    const decisionRe = /^(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_(M|AM)_decision$/;
    for(const key of Object.keys(slots)){
      const m = key.match(decisionRe);
      if(m && slots[key] === 'pending'){
        const [, iso, personId, slot] = m;
        pending.push({ iso, personId, slot: slot as 'M'|'AM', label: slots[`${iso}_${personId}_${slot}_label`] || '' });
      }
    }

    const now = new Date();
    // Compte comme un passage, pour ne pas déclencher un second envoi quasi-immédiat via le
    // cron automatique juste après cet envoi manuel.
    const markRun = () => fetch(`${SUPABASE_URL}/rest/v1/email_settings?id=eq.singleton`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'return=minimal' },
      body: JSON.stringify({ last_run_at: now.toISOString() }),
    });

    if(pending.length === 0){
      await markRun();
      return new Response(JSON.stringify({ ok: true, sent: false, reason: 'no-pending' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const SLOT_ORDER = { M: 0, AM: 1 };
    pending.sort((a, b) => a.personId.localeCompare(b.personId) || a.iso.localeCompare(b.iso) || (SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]));

    const groups: { personId: string; label: string; slots: Slot[] }[] = [];
    for(const s of pending){
      const last = groups[groups.length - 1];
      if(last && last.personId === s.personId && last.label === s.label && isNextSlot(last.slots[last.slots.length - 1], s)){
        last.slots.push(s);
      } else {
        groups.push({ personId: s.personId, label: s.label, slots: [s] });
      }
    }

    const lines = groups.map(g => {
      const first = g.slots[0], last = g.slots[g.slots.length - 1];
      const range = first.iso === last.iso ? formatFR(first.iso) : `du ${formatFR(first.iso)} au ${formatFR(last.iso)}`;
      return `- ${g.personId} — ${range}${g.label ? ' — ' + g.label : ''} (${g.slots.length} demi-journée${g.slots.length > 1 ? 's' : ''})`;
    });

    // Heures supplémentaires ASV sur la période couverte par la fréquence choisie (7 jours
    // pour "weekly", 30 pour "monthly" — tout autre réglage retombe sur 7).
    const frequency = settingsRows[0]?.frequency || 'weekly';
    const frequencyDays = FREQUENCY_DAYS[frequency] ?? 7;
    const windowStartIso = toISODate(new Date(now.getTime() - frequencyDays * 86400000));
    const overtimeByPerson: Record<string, number> = {};
    const overtimeRe = /^(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_overtime$/;
    for(const key of Object.keys(slots)){
      const m = key.match(overtimeRe);
      if(!m) continue;
      const [, iso, personId] = m;
      if(iso < windowStartIso) continue;
      const hours = parseFloat(slots[key] as unknown as string);
      if(!hours) continue;
      overtimeByPerson[personId] = (overtimeByPerson[personId] || 0) + hours;
    }
    const overtimeEntries = Object.entries(overtimeByPerson).sort((a, b) => a[0].localeCompare(b[0]));
    const periodLabel = `${frequencyDays} derniers jours`;

    const subject = `Amivet Planning — ${groups.length} demande(s) de congé ASV en attente`;
    const text = [
      'Bonjour,',
      '',
      `Récapitulatif des demandes de congé ASV en attente de traitement (${groups.length}) :`,
      '',
      ...lines,
      '',
      `Heures supplémentaires ASV (${periodLabel}) :`,
      ...(overtimeEntries.length
        ? overtimeEntries.map(([p, h]) => `- ${p} : ${h}h`)
        : ['- Aucune heure supplémentaire enregistrée sur cette période.']),
      '',
      'Merci de traiter ces demandes depuis le Tableau de bord de l\'application (onglet "Demandes de congé").',
      '',
      '— Amivet Planning',
    ].join('\n');

    const groupsHtml = groups.map(g => {
      const first = g.slots[0], last = g.slots[g.slots.length - 1];
      const range = first.iso === last.iso ? formatFR(first.iso) : `du ${formatFR(first.iso)} au ${formatFR(last.iso)}`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border:1px solid ${COLORS.border};border-radius:10px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:13.5px;font-weight:700;color:${COLORS.text};">${g.personId}</div>
          <div style="font-size:12.5px;color:${COLORS.textMuted};margin-top:2px;">${range}${g.label ? ' — ' + g.label : ''} · ${g.slots.length} demi-journée${g.slots.length > 1 ? 's' : ''}</div>
        </td></tr>
      </table>`;
    }).join('');

    const overtimeRowsHtml = overtimeEntries.length
      ? overtimeEntries.map(([p, h]) => `<tr>
          <td style="padding:6px 0;font-size:13px;color:${COLORS.text};border-bottom:1px solid ${COLORS.border};">${p}</td>
          <td style="padding:6px 0;font-size:13px;color:${COLORS.text};text-align:right;font-weight:700;border-bottom:1px solid ${COLORS.border};">${h}h</td>
        </tr>`).join('')
      : `<tr><td style="padding:6px 0;font-size:13px;color:${COLORS.textMuted};">Aucune heure supplémentaire enregistrée sur cette période.</td></tr>`;

    const html = wrapEmailHtml(`
      <h1 style="font-size:18px;color:${COLORS.text};margin:0 0 4px;">📋 Récapitulatif des congés ASV</h1>
      <p style="font-size:14px;color:${COLORS.textMuted};margin:0 0 20px;">${groups.length} demande${groups.length > 1 ? 's' : ''} en attente de traitement</p>
      ${groupsHtml}
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid ${COLORS.border};">
        <h2 style="font-size:14px;color:${COLORS.text};margin:0 0 12px;">⏱️ Heures supplémentaires ASV — ${periodLabel}</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${overtimeRowsHtml}</table>
      </div>
      <div style="margin-top:24px;">${buttonHtml(APP_URL, 'Ouvrir Amivet Planning')}</div>
    `);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Amivet Planning <onboarding@resend.dev>',
        to: [recipient],
        subject,
        text,
        html,
      }),
    });
    if(!emailRes.ok) throw new Error(`Resend a répondu HTTP ${emailRes.status} — ${await emailRes.text()}`);
    await markRun();

    return new Response(JSON.stringify({ ok: true, sent: true, count: groups.length, recipient }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }catch(e){
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
