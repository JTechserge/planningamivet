// Habillage HTML partagé par les emails (réinitialisation de mot de passe, récapitulatif
// des congés), aligné sur la charte graphique du site (mêmes couleurs que :root dans
// amivet-planning.html). Tableaux + styles en ligne uniquement : c'est ce qui rend le mieux
// de façon fiable dans les clients mail (Gmail, Outlook, Apple Mail...).
export const LOGO_URL = 'https://jtechserge.github.io/planningamivet/logo.png';
export const APP_URL = 'https://jtechserge.github.io/planningamivet/amivet-planning.html';
export const COLORS = {
  primary: '#0F766E',
  primaryLight: '#14B8A6',
  secondary: '#F0FDF9',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  text: '#0F172A',
  textMuted: '#64748B',
  textFaint: '#94A3B8',
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function wrapEmailHtml(bodyHtml: string): string {
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

export function buttonHtml(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;"><tr><td style="background:${COLORS.primary};border-radius:8px;">
    <a href="${href}" style="display:inline-block;padding:12px 24px;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;font-family:${FONT};">${label}</a>
  </td></tr></table>`;
}
