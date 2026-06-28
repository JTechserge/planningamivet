// Récapitulatif des demandes de congé ASV en attente, envoyé par email à la clinique.
// Lancé tous les jours par .github/workflows/weekly-leave-recap.yml (GitHub Actions), mais
// n'envoie réellement qu'au rythme choisi dans les réglages du site (⚙️ → Email
// récapitulatif des congés) — c'est ce script qui applique le filtre de fréquence, GitHub
// Actions ne sachant déclencher qu'un cron fixe, pas une fréquence configurable en ligne.
const SUPABASE_URL = 'https://ubowqtowyqmpraoxbaoo.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVib3dxdG93eXFtcHJhb3hiYW9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzkzNjksImV4cCI6MjA5ODIxNTM2OX0.cC7vTWrK-Ykii5dtlg_6lA5quHe6rv78IRxZT-ArV_8';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FREQUENCY_DAYS = { daily:1, weekly:7, biweekly:14, monthly:30 };
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

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

async function main(){
  if(!RESEND_API_KEY) throw new Error('RESEND_API_KEY manquant (secret GitHub non configuré).');

  const settings = await loadEmailSettings();
  const now = new Date();
  const frequencyDays = FREQUENCY_DAYS[settings.frequency] || 7;
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
    'Merci de les traiter depuis le Tableau de bord de l\'application (onglet "Demandes de congé").',
    '',
    '— Amivet Planning (envoi automatique)',
  ].join('\n');

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Amivet Planning <onboarding@resend.dev>',
      to: [settings.recipient_email],
      subject,
      text,
    }),
  });
  if(!emailRes.ok){
    throw new Error(`Resend a répondu HTTP ${emailRes.status} — ${await emailRes.text()}`);
  }
  await markRun(now);
  console.log(`Email envoyé à ${settings.recipient_email} avec ${groups.length} demande(s) en attente.`);
}

main().catch(e => { console.error(e); process.exit(1); });
