// Récapitulatif des demandes de congé ASV en attente, envoyé par email à la clinique.
// Lancé tous les jours par .github/workflows/weekly-leave-recap.yml (GitHub Actions), mais
// n'envoie réellement qu'au rythme choisi dans les réglages du site (⚙️ → Email
// récapitulatif des congés) — c'est ce script qui applique le filtre de fréquence, GitHub
// Actions ne sachant déclencher qu'un cron fixe, pas une fréquence configurable en ligne.
// Le bouton "Envoyer maintenant" du site appelle un chemin équivalent mais instantané
// (supabase/functions/send-leave-recap) — garder les deux gabarits d'email synchronisés.
const SUPABASE_URL = 'https://ubowqtowyqmpraoxbaoo.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVib3dxdG93eXFtcHJhb3hiYW9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzkzNjksImV4cCI6MjA5ODIxNTM2OX0.cC7vTWrK-Ykii5dtlg_6lA5quHe6rv78IRxZT-ArV_8';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Seules ces 2 fréquences restent sélectionnables sur le site ; tout autre/ancien réglage
// (ex. "daily"/"now" laissés par d'anciens tests) retombe sur la fenêtre hebdomadaire.
const FREQUENCY_DAYS = { weekly: 7, monthly: 30 };
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

const LOGO_URL = 'https://jtechserge.github.io/planningamivet/logo.png';
const APP_URL = 'https://jtechserge.github.io/planningamivet/amivet-planning.html';
const COLORS = {
  primary: '#0F766E', secondary: '#F0FDF9', surface: '#FFFFFF', border: '#E2E8F0',
  text: '#0F172A', textMuted: '#64748B',
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function wrapEmailHtml(bodyHtml){
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${COLORS.secondary};font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.secondary};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;background:${COLORS.surface};border-radius:16px;overflow:hidden;border:1px solid ${COLORS.border};">
        <tr><td style="background:${COLORS.primary};padding:22px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td><img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;border-radius:8px;"></td>
            <td style="padding-left:12px;color:#FFFFFF;font-size:17px;font-weight:700;">Amivet Planning</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid ${COLORS.border};color:${COLORS.textMuted};font-size:11.5px;">
          Clinique Vétérinaire Amivet — Dr. Pelois &amp; Dr. Maquinay
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
function buttonHtml(href, label){
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;"><tr><td style="background:${COLORS.primary};border-radius:8px;">
    <a href="${href}" style="display:inline-block;padding:12px 24px;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;font-family:${FONT};">${label}</a>
  </td></tr></table>`;
}

async function loadEmailSettings(){
  const res = await fetch(`${SUPABASE_URL}email_settings?select=*&id=eq.singleton`, { headers: HEADERS });
  if(!res.ok) throw new Error(`Supabase (email_settings) a répondu HTTP ${res.status}`);
  const rows = await res.json();
  if(!rows[0]) throw new Error('Table email_settings vide ou inexistante — exécute supabase-schema-2-email-settings.sql.');
  return rows[0];
}
async function markRun(now){
  await fetch(`${SUPABASE_URL}email_settings?id=eq.singleton`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Content-Type':'application/json', Prefer:'return=minimal' },
    body: JSON.stringify({ last_run_at: now.toISOString() }),
  });
}

function isNextSlot(prev, next){
  if(prev.iso === next.iso) return prev.slot === 'M' && next.slot === 'AM';
  if(!(prev.slot === 'AM' && next.slot === 'M')) return false;
  const prevDate = new Date(prev.iso + 'T00:00:00Z');
  const nextDate = new Date(next.iso + 'T00:00:00Z');
  const diffDays = Math.round((nextDate - prevDate) / 86400000);
  if(diffDays === 1) return true;
  if(diffDays === 2){
    const between = new Date(prevDate.getTime() + 86400000);
    return between.getUTCDay() === 0; // dimanche entre les deux : pont, comme dans l'app
  }
  return false;
}

function formatFR(iso){
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC' });
}
function toISODate(d){ return d.toISOString().slice(0, 10); }

async function main(){
  if(!RESEND_API_KEY) throw new Error('RESEND_API_KEY manquant (secret GitHub non configuré).');

  const settings = await loadEmailSettings();
  const now = new Date();
  const frequencyDays = FREQUENCY_DAYS[settings.frequency] ?? 7;
  const lastRun = settings.last_run_at ? new Date(settings.last_run_at) : null;
  // Marge d'une heure pour absorber le décalage normal d'exécution d'un cron GitHub Actions.
  if(lastRun && (now - lastRun) < frequencyDays * 86400000 - 3600000){
    console.log(`Fréquence "${settings.frequency}" : dernier passage le ${lastRun.toISOString()}, pas encore l'heure.`);
    return;
  }

  const res = await fetch(`${SUPABASE_URL}planning_data?select=data&id=eq.singleton`, { headers: HEADERS });
  if(!res.ok) throw new Error(`Supabase a répondu HTTP ${res.status}`);
  const rows = await res.json();
  const slots = (rows[0] && rows[0].data) || {};

  const pending = [];
  const decisionRe = /^(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_(M|AM)_decision$/;
  for(const key of Object.keys(slots)){
    const m = key.match(decisionRe);
    if(m && slots[key] === 'pending'){
      const [, iso, personId, slot] = m;
      pending.push({ iso, personId, slot, label: slots[`${iso}_${personId}_${slot}_label`] || '' });
    }
  }

  if(pending.length === 0){
    console.log('Aucune demande de congé ASV en attente — pas d\'email envoyé.');
    await markRun(now);
    return;
  }

  // "AM" < "M" en tri alphabétique, ce qui inverserait l'ordre chronologique des
  // demi-journées d'une même date — on trie donc M avant AM explicitement.
  const SLOT_ORDER = { M: 0, AM: 1 };
  pending.sort((a, b) => a.personId.localeCompare(b.personId) || a.iso.localeCompare(b.iso) || (SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]));

  const groups = [];
  for(const s of pending){
    const last = groups[groups.length - 1];
    if(last && last.personId === s.personId && last.label === s.label && isNextSlot(last.slots[last.slots.length - 1], s)){
      last.slots.push(s);
    } else {
      groups.push({ personId: s.personId, label: s.label, slots: [s] });
    }
  }

  // Heures supplémentaires ASV sur la période couverte par la fréquence choisie.
  const windowStartIso = toISODate(new Date(now.getTime() - frequencyDays * 86400000));
  const overtimeByPerson = {};
  const overtimeRe = /^(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_overtime$/;
  for(const key of Object.keys(slots)){
    const m = key.match(overtimeRe);
    if(!m) continue;
    const [, iso, personId] = m;
    if(iso < windowStartIso) continue;
    const hours = parseFloat(slots[key]);
    if(!hours) continue;
    overtimeByPerson[personId] = (overtimeByPerson[personId] || 0) + hours;
  }
  const overtimeEntries = Object.entries(overtimeByPerson).sort((a, b) => a[0].localeCompare(b[0]));
  const periodLabel = `${frequencyDays} derniers jours`;

  const lines = groups.map(g => {
    const first = g.slots[0], last = g.slots[g.slots.length - 1];
    const range = first.iso === last.iso ? formatFR(first.iso) : `du ${formatFR(first.iso)} au ${formatFR(last.iso)}`;
    return `- ${g.personId} — ${range}${g.label ? ' — ' + g.label : ''} (${g.slots.length} demi-journée${g.slots.length > 1 ? 's' : ''})`;
  });

  const subject = `Amivet Planning — ${groups.length} demande(s) de congé ASV en attente`;
  const text = [
    'Bonjour,',
    '',
    `Voici le récapitulatif (fréquence : ${settings.frequency}) des demandes de congé ASV en attente de traitement (${groups.length}) :`,
    '',
    ...lines,
    '',
    `Heures supplémentaires ASV (${periodLabel}) :`,
    ...(overtimeEntries.length
      ? overtimeEntries.map(([p, h]) => `- ${p} : ${h}h`)
      : ['- Aucune heure supplémentaire enregistrée sur cette période.']),
    '',
    'Merci de les traiter depuis le Tableau de bord de l\'application (onglet "Demandes de congé").',
    '',
    '— Amivet Planning (envoi automatique)',
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
      to: [settings.recipient_email],
      subject,
      text,
      html,
    }),
  });
  if(!emailRes.ok){
    throw new Error(`Resend a répondu HTTP ${emailRes.status} — ${await emailRes.text()}`);
  }
  await markRun(now);
  console.log(`Email envoyé à ${settings.recipient_email} avec ${groups.length} demande(s) en attente.`);
}

main().catch(e => { console.error(e); process.exit(1); });
