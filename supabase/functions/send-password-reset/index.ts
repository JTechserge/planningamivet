// Appelée directement par le site quand quelqu'un clique "Mot de passe oublié ?" — envoie le
// lien de réinitialisation immédiatement (plus besoin d'attendre le cron GitHub Actions).
// Tourne côté serveur (Deno, sur l'infra Supabase), donc la clé Resend reste secrète.
import { wrapEmailHtml, buttonHtml, APP_URL, COLORS } from '../_shared/email-template.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const RESET_VALID_MS = 30 * 60 * 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if(req.method === 'OPTIONS'){
    return new Response('ok', { headers: CORS_HEADERS });
  }
  try{
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + RESET_VALID_MS).toISOString();

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/app_security?id=eq.singleton`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ reset_token: token, reset_token_expires_at: expiresAt }),
    });
    if(!updateRes.ok) throw new Error(`Échec de l'enregistrement du token (HTTP ${updateRes.status})`);

    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/email_settings?select=recipient_email&id=eq.singleton`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    const settingsRows = await settingsRes.json();
    const recipient = settingsRows[0]?.recipient_email || 'cliniqueamivet@hotmail.fr';

    const resetLink = `${APP_URL}?reset=${encodeURIComponent(token)}`;
    const text = [
      'Bonjour,',
      '',
      'Une réinitialisation du mot de passe de l\'onglet Tableau de bord d\'Amivet Planning a été demandée.',
      '',
      'Cliquez sur ce lien pour choisir un nouveau mot de passe (valable 30 minutes) :',
      resetLink,
      '',
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet email : aucun changement ne sera effectué.',
      '',
      '— Amivet Planning (envoi automatique)',
    ].join('\n');
    const html = wrapEmailHtml(`
      <h1 style="font-size:18px;color:${COLORS.text};margin:0 0 12px;">🔑 Réinitialisation du mot de passe</h1>
      <p style="font-size:14px;color:${COLORS.textMuted};line-height:1.6;margin:0 0 20px;">Une réinitialisation du mot de passe de l'onglet Tableau de bord a été demandée.</p>
      ${buttonHtml(resetLink, 'Choisir un nouveau mot de passe')}
      <p style="font-size:12.5px;color:${COLORS.textMuted};line-height:1.6;margin:0 0 4px;">Ce lien est valable 30 minutes. Si le bouton ne fonctionne pas, copiez ce lien :</p>
      <p style="font-size:12px;color:${COLORS.primary};word-break:break-all;margin:0 0 20px;">${resetLink}</p>
      <p style="font-size:12px;color:${COLORS.textFaint};margin:0;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : aucun changement ne sera effectué.</p>
    `);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Amivet Planning <onboarding@resend.dev>',
        to: [recipient],
        subject: 'Amivet Planning — Réinitialisation du mot de passe',
        text,
        html,
      }),
    });
    if(!emailRes.ok) throw new Error(`Resend a répondu HTTP ${emailRes.status} — ${await emailRes.text()}`);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }catch(e){
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
