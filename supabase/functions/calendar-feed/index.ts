// Flux ICS (iCalendar) abonnable depuis l'app Calendrier d'iOS ou Google Agenda sur
// Android. Un vétérinaire génère son lien personnel depuis ⚙️ → Synchronisation
// calendrier ; une fois ajouté à son téléphone, l'OS revient consulter cette URL toutes
// les quelques heures pour se mettre à jour — aucune action supplémentaire de sa part.
// L'URL contient le seul secret (le jeton) : pas d'autre authentification.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const PERSON_LABELS: Record<string, string> = { david: 'David', stephane: 'Stéphane' };
// Fenêtre raisonnable pour garder le flux léger : le passé récent + 2 ans à venir.
const PAST_DAYS = 90;
const FUTURE_DAYS = 730;

function icsEscape(text: string){
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icsDate(iso: string){ return iso.replace(/-/g, ''); }
function addDaysIso(iso: string, days: number){
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type DayStatus = { iso: string; status: 'present' | 'absent'; label: string };

Deno.serve(async (req) => {
  try{
    const url = new URL(req.url);
    const personId = url.searchParams.get('person') || '';
    const token = url.searchParams.get('token') || '';
    const personLabel = PERSON_LABELS[personId];
    if(!personLabel || !token){
      return new Response('Lien invalide.', { status: 400 });
    }

    const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_calendar_sync_token`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_person_id: personId, p_token: token }),
    });
    // Strict: un échec de la requête (table/fonction absente, erreur réseau...) doit
    // refuser l'accès, jamais l'autoriser par défaut — seul un vrai "true" booléen passe.
    if(!verifyRes.ok){
      return new Response('Vérification impossible.', { status: 502 });
    }
    const valid = await verifyRes.json();
    if(valid !== true){
      return new Response('Lien invalide ou révoqué.', { status: 403 });
    }

    const dataRes = await fetch(`${SUPABASE_URL}/rest/v1/planning_data?select=data&id=eq.singleton`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    const dataRows = await dataRes.json();
    const slots: Record<string, string> = (dataRows[0] && dataRows[0].data) || {};

    const today = new Date().toISOString().slice(0, 10);
    const windowStart = addDaysIso(today, -PAST_DAYS);
    const windowEnd = addDaysIso(today, FUTURE_DAYS);

    // Statut par jour : absent si M ou AM est "absent" (avec son motif s'il existe),
    // sinon présent si au moins une demi-journée est "present", sinon pas d'événement.
    const days: DayStatus[] = [];
    const stateRe = /^(\d{4}-\d{2}-\d{2})_([a-z0-9-]+)_(M|AM)$/;
    const byDate: Record<string, { M?: string; AM?: string }> = {};
    for(const key of Object.keys(slots)){
      const m = key.match(stateRe);
      if(!m) continue;
      const [, iso, pid, slot] = m;
      if(pid !== personId) continue;
      if(iso < windowStart || iso > windowEnd) continue;
      (byDate[iso] ||= {})[slot as 'M'|'AM'] = slots[key];
    }
    for(const iso of Object.keys(byDate).sort()){
      const { M, AM } = byDate[iso];
      if(M === 'absent' || AM === 'absent'){
        const label = slots[`${iso}_${personId}_AM_label`] || slots[`${iso}_${personId}_M_label`] || '';
        days.push({ iso, status: 'absent', label });
      } else if(M === 'present' || AM === 'present'){
        days.push({ iso, status: 'present', label: '' });
      }
    }

    // Regroupe les jours consécutifs de même statut (et même motif pour les absences) en
    // un seul événement, pour ne pas saturer le calendrier personnel d'une entrée par jour.
    const events: { start: string; end: string; status: 'present'|'absent'; label: string }[] = [];
    for(const d of days){
      const last = events[events.length - 1];
      if(last && last.status === d.status && last.label === d.label && addDaysIso(last.end, 1) === d.iso){
        last.end = d.iso;
      } else {
        events.push({ start: d.iso, end: d.iso, status: d.status, label: d.label });
      }
    }

    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Amivet Planning//Calendar Sync//FR',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${icsEscape(`Amivet — ${personLabel}`)}`,
      'REFRESH-INTERVAL;VALUE=DURATION:PT4H',
      'X-PUBLISHED-TTL:PT4H',
    ];
    for(const ev of events){
      const summary = ev.status === 'present' ? 'Présent — Clinique Amivet' : `Absent${ev.label ? ' — ' + ev.label : ''}`;
      const uid = `${personId}-${ev.start}-${ev.status}@amivet-planning`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${icsDate(ev.start)}`,
        `DTEND;VALUE=DATE:${icsDate(addDaysIso(ev.end, 1))}`,
        `SUMMARY:${icsEscape(summary)}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');

    return new Response(lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="amivet-planning.ics"',
        'Cache-Control': 'no-cache',
      },
    });
  }catch(e){
    console.error(e);
    return new Response('Erreur interne.', { status: 500 });
  }
});
