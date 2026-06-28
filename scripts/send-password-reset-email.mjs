// Envoie le lien de réinitialisation du mot de passe quand un utilisateur clique
// "Mot de passe oublié ?" sur le site. Lancé toutes les 5 minutes par
// .github/workflows/password-reset-email.yml — le site ne peut pas envoyer l'email
// lui-même (il faudrait exposer la clé Resend au navigateur), donc il se contente de
// poser un "drapeau" dans Supabase que ce script vient consulter.
const SUPABASE_URL = 'https://ubowqtowyqmpraoxbaoo.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVib3dxdG93eXFtcHJhb3hiYW9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzkzNjksImV4cCI6MjA5ODIxNTM2OX0.cC7vTWrK-Ykii5dtlg_6lA5quHe6rv78IRxZT-ArV_8';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = 'https://jtechserge.github.io/planningamivet/amivet-planning.html';
const HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

async function main(){
  if(!RESEND_API_KEY) throw new Error('RESEND_API_KEY manquant (secret GitHub non configuré).');

  const pendingRes = await fetch(`${SUPABASE_URL}rpc/get_pending_password_reset`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type':'application/json' },
    body: '{}',
  });
  if(!pendingRes.ok) throw new Error(`Supabase (get_pending_password_reset) a répondu HTTP ${pendingRes.status}`);
  const rows = await pendingRes.json();
  if(!rows[0]){
    console.log('Aucune demande de réinitialisation en attente.');
    return;
  }
  const { token, expires_at } = rows[0];

  const markSent = ()=> fetch(`${SUPABASE_URL}rpc/mark_password_reset_email_sent`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type':'application/json' },
    body: '{}',
  });

  if(new Date(expires_at) <= new Date()){
    console.log('Le lien en attente a déjà expiré, on annule l\'envoi sans le renvoyer.');
    await markSent();
    return;
  }

  const settingsRes = await fetch(`${SUPABASE_URL}email_settings?select=recipient_email&id=eq.singleton`, { headers: HEADERS });
  if(!settingsRes.ok) throw new Error(`Supabase (email_settings) a répondu HTTP ${settingsRes.status}`);
  const settingsRows = await settingsRes.json();
  const recipient = (settingsRows[0] && settingsRows[0].recipient_email) || 'cliniqueamivet@hotmail.fr';

  const resetLink = `${APP_URL}?reset=${encodeURIComponent(token)}`;
  const text = [
    'Bonjour,',
    '',
    'Une réinitialisation du mot de passe de l\'onglet Tableau de bord d\'Amivet Planning a été demandée.',
    '',
    `Cliquez sur ce lien pour choisir un nouveau mot de passe (valable 30 minutes) :`,
    resetLink,
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet email : aucun changement ne sera effectué.',
    '',
    '— Amivet Planning (envoi automatique)',
  ].join('\n');

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Amivet Planning <onboarding@resend.dev>',
      to: [recipient],
      subject: 'Amivet Planning — Réinitialisation du mot de passe',
      text,
    }),
  });
  if(!emailRes.ok){
    throw new Error(`Resend a répondu HTTP ${emailRes.status} — ${await emailRes.text()}`);
  }
  await markSent();
  console.log(`Email de réinitialisation envoyé à ${recipient}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
