/**
 * Geography policy for in-person / "come visit you" language in outreach.
 *
 * Deaton is in Central Texas (Georgetown). We only suggest dropping by or
 * visiting **their** facility when headquarters look to be inside or near the
 * Texas Triangle megaregion (DFW, Houston, San Antonio, Austin, and corridor cities).
 * Otherwise copy should emphasize remote collaboration, timezone, and logistics—
 * not implying we will travel to their site.
 */

/** Remote / no fixed HQ: do not promise visits. */
const REMOTE_OR_UNKNOWN = /\b(remote|worldwide|global|distributed|virtual|multiple offices|n\/a)\b/i;

/**
 * Texas cities clearly outside the Texas Triangle (Panhandle, far West, RGV,
 * East Texas outside Houston orbit, etc.). Matched as substrings on lowercased HQ.
 */
const TX_OUTSIDE_TRIANGLE = [
  'el paso',
  'amarillo',
  'lubbock',
  'midland',
  'odessa',
  'wichita falls',
  'texarkana',
  'abilene',
  'san angelo',
  'laredo',
  'brownsville',
  'mcallen',
  'mission',
  'edinburg',
  'harlingen',
  'eagle pass',
  'del rio',
  'tyler',
  'longview',
  'nacogdoches',
  'plainview',
  'pampa',
  'childress',
  'hereford',
  'borger',
];

/**
 * Locales treated as in or near the megaregion (substring match on lowercased HQ).
 * Keep multi-word phrases before relying on single-word city names that collide (e.g. Georgetown KY).
 */
const TX_TRIANGLE_LOCALE = [
  'san antonio',
  'new braunfels',
  'the woodlands',
  'sugar land',
  'fort worth',
  'grand prairie',
  'cedar park',
  'round rock',
  'pflugerville',
  'college station',
  'corpus christi',
  'galveston',
  'austin',
  'georgetown',
  'houston',
  'dallas',
  'frisco',
  'plano',
  'irving',
  'arlington',
  'mckinney',
  'denton',
  'richardson',
  'garland',
  'carrollton',
  'lewisville',
  'katy',
  'pearland',
  'pasadena',
  'baytown',
  'conroe',
  'cypress',
  'spring',
  'tomball',
  'bryan',
  'waco',
  'temple',
  'killeen',
  'belton',
  'harker heights',
  'brenham',
  'victoria',
  'san marcos',
  'kyle',
  'buda',
  'leander',
  'lakeway',
  'schertz',
  'seguin',
  'friendswood',
];

/** Obvious non-Texas US markers (substring; avoids short false positives like standalone "in"). */
const NON_TX_US_MARKERS = [
  'california',
  ', ca ',
  ', ca,',
  'new york',
  ', ny ',
  ', ny,',
  'florida',
  ', fl ',
  ', fl,',
  'illinois',
  ', il ',
  ', il,',
  'washington',
  ', wa ',
  ', wa,',
  'colorado',
  ', co ',
  ', co,',
  'massachusetts',
  'georgia',
  ', ga ',
  ', ga,',
  'north carolina',
  ', nc ',
  ', nc,',
  'virginia',
  ', va ',
  ', va,',
  'pennsylvania',
  ', pa ',
  ', pa,',
  'ohio',
  ', oh ',
  ', oh,',
  'michigan',
  ', mi ',
  ', mi,',
  'minnesota',
  ', mn ',
  ', mn,',
  'wisconsin',
  ', wi ',
  ', wi,',
  'oregon',
  ', or ',
  ', or,',
  'nevada',
  ', nv ',
  ', nv,',
  'arizona',
  ', az ',
  ', az,',
  'tennessee',
  ', tn ',
  ', tn,',
  'missouri',
  ', mo ',
  ', mo,',
  'indiana',
  ', in ',
  ', in,',
  'kentucky',
  ', ky ',
  ', ky,',
  'alabama',
  ', al ',
  ', al,',
  'maryland',
  ', md ',
  ', md,',
  'connecticut',
  ', ct ',
  ', ct,',
  'new jersey',
  ', nj ',
  ', nj,',
  'oklahoma',
  ', ok ',
  ', ok,',
  'kansas',
  ', ks ',
  ', ks,',
  'nebraska',
  ', ne ',
  ', ne,',
  'iowa',
  ', ia ',
  ', ia,',
  'south carolina',
  ', sc ',
  ', sc,',
  'utah',
  ', ut ',
  ', ut,',
  'montana',
  ', mt ',
  ', mt,',
  'idaho',
  ', id ',
  ', id,',
  'wyoming',
  ', wy ',
  ', wy,',
  'north dakota',
  ', nd ',
  ', nd,',
  'south dakota',
  ', sd ',
  ', sd,',
  'vermont',
  ', vt ',
  ', vt,',
  'new hampshire',
  ', nh ',
  ', nh,',
  'maine',
  ', me ',
  ', me,',
  'rhode island',
  ', ri ',
  ', ri,',
  'delaware',
  ', de ',
  ', de,',
  'alaska',
  ', ak ',
  ', ak,',
  'hawaii',
  ', hi ',
  ', hi,',
  'mississippi',
  ', ms ',
  ', ms,',
  'arkansas',
  ', ar ',
  ', ar,',
  'west virginia',
  ', wv ',
  ', wv,',
];

const INTL_MARKERS = [
  'canada',
  'toronto',
  'vancouver',
  'montreal',
  'united kingdom',
  'england',
  'ireland',
  'scotland',
  'wales',
  ', uk',
  ' uk ',
  'germany',
  'france',
  'india',
  'japan',
  'china',
  'australia',
  'israel',
  'netherlands',
  'spain',
  'italy',
  'switzerland',
  'brazil',
  'mexico city',
  'guadalajara',
  'monterrey',
  'singapore',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'poland',
];

/** USPS-style state/territory abbreviations except TX — used with trailing ", IL" style HQ lines. */
const US_STATE_ABBR_EXCEPT_TX = new Set(
  (
    'al,ak,az,ar,ca,co,ct,de,fl,ga,hi,id,il,in,ia,ks,ky,la,me,md,ma,mi,mn,ms,mo,mt,ne,nv,'
    + 'nh,nj,nm,ny,nc,nd,oh,ok,or,pa,ri,sc,sd,tn,ut,vt,va,wa,wv,wi,wy,dc,pr,vi,gu,as,mp'
  ).split(','),
);

function normalizeHq(hq: string | null | undefined): string {
  return (hq ?? '').trim().toLowerCase();
}

/**
 * True when headquarters are plausibly in or around the Texas Triangle so we
 * may reference stopping by or easy travel to **their** location. False when
 * unknown, remote, clearly elsewhere, or in Texas but far from the megaregion.
 */
export function mayOfferInPersonTexasVisit(headquarters: string | null | undefined): boolean {
  const raw = (headquarters ?? '').trim();
  if (!raw) return false;

  const s = normalizeHq(raw);
  if (REMOTE_OR_UNKNOWN.test(s) || s === 'unknown' || s === 'n/a') return false;

  // Austin, Minnesota vs Austin, Texas
  if (/\baustin\b/.test(s) && /\b(minnesota|\bmn\b)\b/.test(s)) return false;
  // Georgetown, Kentucky vs Georgetown, Texas
  if (/\bgeorgetown\b/.test(s) && /\b(kentucky|\bky\b)\b/.test(s)) return false;
  // Portland, Oregon (not Portland, TX)
  if (/\bportland\b/.test(s) && (/\boregon\b/.test(s) || /portland,\s*or\b/.test(s))) return false;

  for (const fragment of TX_OUTSIDE_TRIANGLE) {
    if (s.includes(fragment)) return false;
  }

  const trailingState = s.match(/,\s*([a-z]{2})\s*$/i);
  if (trailingState) {
    const ab = trailingState[1].toLowerCase();
    if (ab !== 'tx' && US_STATE_ABBR_EXCEPT_TX.has(ab)) return false;
  }

  const mentionsTexas = /\b(texas|tx)\b/i.test(s);

  if (!mentionsTexas) {
    for (const m of NON_TX_US_MARKERS) {
      if (s.includes(m)) return false;
    }
    for (const m of INTL_MARKERS) {
      if (s.includes(m)) return false;
    }
  }

  if (mentionsTexas) return true;

  for (const fragment of TX_TRIANGLE_LOCALE) {
    if (s.includes(fragment)) return true;
  }

  return false;
}

/**
 * Deterministic scan: wording that promises deploying staff to the prospect's location.
 * Used by Hard QC when `mayOfferInPersonTexasVisit` is false. Returns a single fix message
 * or null if no known pattern matched.
 */
export function describeNonTriangleVisitViolationIfAny(text: string): string | null {
  const patterns = [
    /\bsend(ing)?\s+engineers\b/i,
    /\bdispatch(ing)?\s+engineers\b/i,
    /\bdeploy(ing)?\s+engineers\b/i,
    /\bon-?\s*site\s+commissioning\b/i,
    /\bon-?\s*site\s+(visit|visits|support|work)\b/i,
    /\bengineers\s+(on|at)\s+(your|their|the)\s+(site|facility|plant)\b/i,
    /\bvisit\s+your\s+(facility|plant|site|office|hq|headquarters)\b/i,
    /\b(stop|swing|drop)\s+by\s+your\b/i,
    /\bcome\s+(see\s+you|to\s+your\s+(facility|plant|site))\b/i,
    /\bbe\s+on-?\s*site\s+(at|with)\s+(you|your)\b/i,
  ];
  for (const re of patterns) {
    if (re.test(text)) {
      return (
        'Prospect HQ is not Texas Triangle–proximal: remove promises of sending/dispatching/deploying engineers to them, '
        + 'on-site commissioning or on-site engineering at their facility, or visiting their site. '
        + 'Describe **remote** engineering support, program rhythm, documentation, and logistics (e.g. shipping equipment) '
        + 'without dispatching people to their location.'
      );
    }
  }
  return null;
}

/** Injected into generation and QC prompts so the model applies the same rule. */
export function visitLanguageGuidanceForPrompt(headquarters: string | null | undefined): string {
  const hq = (headquarters ?? '').trim() || '(not provided)';

  if (mayOfferInPersonTexasVisit(headquarters)) {
    return [
      '**In-person / visit language:** Headquarters (`' + hq + '`) are treated as **in or near the Texas Triangle** (DFW, Houston, San Antonio, Austin, and nearby corridor).',
      'For step 9 (geography) and elsewhere, it is acceptable—when appropriate—to mention easy travel, being Texas-based, or stopping by **their** site.',
    ].join('\n');
  }

  return [
      '**In-person / visit language:** Headquarters (`' + hq + '`) are **not** treated as in or around the Texas Triangle (or location is unknown / remote).',
      '- **Do not** invite yourself to their office, offer to "drop by", "swing by", "come see you", or say you are "nearby" their facility.',
      '- **Banned phrasing (non-exhaustive):** "sending engineers", "dispatch/deploy engineers", "on-site commissioning", "on-site support" at **their** site, "engineers on-site" at their facility, "visit your facility/plant", "stop by your", or bundling Central Texas logistics with **sending staff** to them.',
      '- For step 9 (geography), stress timezone overlap, strong remote collaboration, shipping / program cadence, and that Deaton is Central Texas–based—**without** implying you will travel to them or station engineers at their site.',
    ].join('\n');
}
