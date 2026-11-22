// Lecture seule du Google Agenda d'Eniram Beauty (lien iCal privé enregistré dans Réglages).
// L'accès est réservé aux utilisateurs connectés : le jeton Supabase est vérifié par la base elle-même (RLS).
const SUPABASE_URL = 'https://fiotoievhffjfsivgbud.supabase.co';
const SUPABASE_KEY = 'sb_publishable_MM1zoFnf-xTHPUkVzOCiFQ_D3H0lpAH';
const DAY = 86400000;

function unfold(t) { return t.replace(/\r?\n[ \t]/g, ''); }
function unesc(s) { return (s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }

// Heure locale d'un fuseau -> instant UTC (ms)
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
    const off = t => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t; };
    let t = guess - off(guess); t = guess - off(t); return t;
  } catch (e) { return guess; }
}

function parseDate(val, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(val || '');
  if (!m) return null;
  if (!m[4]) return {allDay: true, t: Date.UTC(+m[1], +m[2] - 1, +m[3])};
  if (m[7]) return {allDay: false, t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])};
  const tz = (/TZID=([^;:]+)/.exec(params || '') || [])[1] || 'Europe/Paris';
  return {allDay: false, t: zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], tz)};
}

function parseIcs(text) {
  const out = [], lines = unfold(text).split(/\r?\n/);
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {ex: []}; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const head = line.slice(0, i), val = line.slice(i + 1), name = head.split(';')[0].toUpperCase(), params = head.slice(name.length);
    if (name === 'SUMMARY') ev.title = unesc(val);
    else if (name === 'DESCRIPTION') ev.desc = unesc(val);
    else if (name === 'LOCATION') ev.loc = unesc(val);
    else if (name === 'STATUS') ev.status = val;
    else if (name === 'UID') ev.uid = val;
    else if (name === 'DTSTART') ev.start = parseDate(val, params);
    else if (name === 'DTEND') ev.end = parseDate(val, params);
    else if (name === 'RRULE') ev.rrule = Object.fromEntries(val.split(';').map(x => x.split('=')));
    else if (name === 'EXDATE') val.split(',').forEach(v => { const d = parseDate(v, params); if (d) ev.ex.push(d.t); });
    else if (name === 'RECURRENCE-ID') ev.recId = parseDate(val, params);
  }
  return out;
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function expand(ev, from, to) {
  const dur = ev.end ? ev.end.t - ev.start.t : 0, base = ev.start.t;
  if (!ev.rrule) return base <= to && base + dur >= from ? [base] : [];
  const r = ev.rrule, step = Math.max(1, +r.INTERVAL || 1), until = r.UNTIL ? (parseDate(r.UNTIL.replace(/Z$/, '') + (r.UNTIL.includes('T') ? 'Z' : ''))?.t ?? Infinity) : Infinity, max = +r.COUNT || Infinity;
  const res = []; let n = 0; const d0 = new Date(base);
  const days = (r.BYDAY ? r.BYDAY.split(',').map(x => WD.indexOf(x.slice(-2))) : [d0.getUTCDay()]).filter(x => x >= 0);
  for (let k = 0; k < 2000; k++) {
    let cands = [];
    if (r.FREQ === 'DAILY') cands = [base + k * step * DAY];
    else if (r.FREQ === 'WEEKLY') { const ws = base - d0.getUTCDay() * DAY + k * step * 7 * DAY; cands = days.map(w => ws + w * DAY).filter(t => t >= base).sort((a, b) => a - b); }
    else if (r.FREQ === 'MONTHLY') { const d = new Date(base); d.setUTCMonth(d.getUTCMonth() + k * step); cands = [d.getTime()]; }
    else if (r.FREQ === 'YEARLY') { const d = new Date(base); d.setUTCFullYear(d.getUTCFullYear() + k * step); cands = [d.getTime()]; }
    else return base <= to && base + dur >= from ? [base] : [];
    for (const t of cands) { if (t > until || n >= max) return res; n++; if (t > to) return res; if (t + dur >= from) res.push(t); }
    if (cands.length && Math.min(...cands) > to) break;
  }
  return res;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const auth = req.headers.authorization || '';
  if (!/^Bearer .{20,}/.test(auth)) return res.status(401).json({error: 'Connexion requise'});
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/reglages?select=agenda_ical&id=eq.1`, {headers: {apikey: SUPABASE_KEY, Authorization: auth}});
    if (!r.ok) return res.status(401).json({error: 'Connexion requise'});
    const url = ((await r.json())[0] || {}).agenda_ical;
    if (!url) return res.status(200).json({configured: false, events: []});
    let u; try { u = new URL(url); } catch (e) { return res.status(400).json({error: 'Lien agenda invalide'}); }
    if (u.protocol !== 'https:' || u.hostname !== 'calendar.google.com' || !u.pathname.startsWith('/calendar/ical/')) return res.status(400).json({error: 'Le lien doit venir de Google Agenda (adresse secrète au format iCal)'});
    const f = await fetch(u.href, {redirect: 'error'});
    if (!f.ok) return res.status(502).json({error: 'Google Agenda a refusé le lien (' + f.status + ')'});
    const evs = parseIcs(await f.text());
    const from = Date.now() - 2 * 3600000, to = from + 45 * DAY;
    const overridden = new Set(evs.filter(e => e.recId).map(e => e.uid + '|' + e.recId.t));
    const events = [];
    for (const e of evs) {
      if (e.status === 'CANCELLED') continue;
      const dur = e.end ? e.end.t - e.start.t : 0;
      for (const t of expand(e, from, to)) {
        if (e.ex.includes(t) || (!e.recId && overridden.has(e.uid + '|' + t))) continue;
        events.push({title: e.title || '(sans titre)', start: new Date(t).toISOString(), end: new Date(t + dur).toISOString(), allDay: e.start.allDay, desc: (e.desc || '').slice(0, 500), loc: e.loc || ''});
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    res.status(200).json({configured: true, events: events.slice(0, 60)});
  } catch (e) { res.status(500).json({error: 'Lecture de l\'agenda impossible'}); }
};
module.exports.parseIcs = parseIcs; module.exports.expand = expand;
