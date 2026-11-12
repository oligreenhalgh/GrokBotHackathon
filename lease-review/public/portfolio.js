// Portfolio view of the register: one object per lease row, built from the
// effective (reviewed or corrected) cell values, plus browser-side geocoding.

export const USE_COLOURS = {Office: '#8e2a45', Retail: '#b8862f'};
export const FALLBACK_COLOUR = '#7b6d72';
const DAY = 864e5;
const YEAR = 365.25 * DAY;

const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : null);
const number = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const POSTCODE = /([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})\b/i;

export const money = v => (v == null ? '—' : `£${Math.round(v).toLocaleString('en-GB')}`);
export const moneyShort = v => (v == null ? '—' : v >= 1e6 ? `£${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `£${(v / 1e3).toFixed(1)}k` : `£${Math.round(v)}`);
export const fmtDate = d => (d ? d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}) : '—');
export const years = v => (v == null ? '—' : `${v.toFixed(1)} yrs`);

function addMonths(d, months) {
  const next = new Date(d);
  next.setMonth(next.getMonth() - months);
  return next;
}

export function buildPortfolio(workspace, effective, today = new Date()) {
  return workspace.rows.map(row => {
    const v = id => effective(row, id).value;
    const s = id => effective(row, id).status;
    const building = v('c04') || v('c03') || '';
    const address = v('c03') || building;
    const postcode = (String(address).match(POSTCODE) || String(building).match(POSTCODE) || [])[0]?.toUpperCase().replace(/\s+/, ' ') || null;
    const segments = String(building).split(',').map(x => x.trim()).filter(Boolean);
    const city = segments.length ? segments.at(-1).replace(POSTCODE, '').trim() || null : null;
    const use = v('c02') || (row.category ? row.category[0].toUpperCase() + row.category.slice(1) : 'Other');
    const start = date(v('c19'));
    const expiry = date(v('c24'));
    const breakDate = date(v('c20'));
    const breakNotice = number(v('c22'));
    const review = date(v('c25'));
    const rent = number(v('c35'));
    const tenant = v('c14') || row.title;
    const events = [];
    if (breakDate) events.push({type: 'Break', date: breakDate, columnId: 'c20', noticeBy: breakNotice != null ? addMonths(breakDate, breakNotice) : null});
    if (review) events.push({type: 'Rent review', date: review, columnId: 'c25'});
    if (expiry) events.push({type: 'Expiry', date: expiry, columnId: 'c24'});
    events.sort((a, b) => a.date - b.date);
    const upcoming = events.filter(e => e.date >= today);
    const toExpiry = expiry ? Math.max(0, (expiry - today) / YEAR) : null;
    const toBreak = breakDate && breakDate >= today ? (breakDate - today) / YEAR : toExpiry;
    return {
      id: row.id,
      row,
      ref: (row.title.match(/^[A-Z]+-\d+/) || [row.id])[0],
      tenant,
      use,
      colour: USE_COLOURS[use] || FALLBACK_COLOUR,
      address,
      building,
      buildingKey: String(building).toLowerCase(),
      postcode,
      city,
      unit: v('c05') || segments[0] || '',
      rent,
      rentStatus: s('c35'),
      start,
      expiry,
      breakDate,
      breakNotice,
      breakParty: v('c21'),
      review,
      reviewBasis: v('c27'),
      guarantor: v('c16'),
      act1954: v('c18'),
      repair: v('c51'),
      alienation: v('c54'),
      permittedUse: v('c09'),
      events,
      nextEvent: upcoming[0] || null,
      toExpiry,
      toBreak,
    };
  });
}

/** Rent-weighted average unexpired term; leases without a confirmed rent are left out. */
export function wault(leases, key) {
  const weighted = leases.filter(l => l.rent != null && l[key] != null);
  const total = weighted.reduce((sum, l) => sum + l.rent, 0);
  return total ? weighted.reduce((sum, l) => sum + l.rent * l[key], 0) / total : null;
}

const CACHE_KEY = 'folio.geocode.v1';
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function writeCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage unavailable */ }
}

/**
 * Postcode centroids from postcodes.io. Synthetic postcodes often do not exist,
 * so those fall back to the outward-code centroid and are marked approximate.
 */
export async function geocode(leases) {
  const cache = readCache();
  const missing = [...new Set(leases.map(l => l.postcode).filter(p => p && !cache[p]))];
  if (missing.length) {
    try {
      const response = await fetch('https://api.postcodes.io/postcodes', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({postcodes: missing})});
      const {result} = await response.json();
      for (const {query, result: hit} of result) {
        if (hit) cache[query] = {lat: hit.latitude, lng: hit.longitude, precision: 'Postcode'};
      }
      const outward = [...new Set(missing.filter(p => !cache[p]).map(p => p.split(' ')[0]))];
      await Promise.all(outward.map(async code => {
        const r = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(code)}`);
        if (!r.ok) return;
        const {result: hit} = await r.json();
        for (const p of missing.filter(m => m.startsWith(`${code} `))) cache[p] = {lat: hit.latitude, lng: hit.longitude, precision: 'Postcode district'};
      }));
      writeCache(cache);
    } catch { /* offline: leases without a cached location stay off the map */ }
  }
  for (const lease of leases) lease.location = lease.postcode ? cache[lease.postcode] || null : null;
  return leases;
}

/** One map pin per building; different buildings sharing a centroid are fanned out slightly. */
export function buildings(leases) {
  const groups = new Map();
  for (const lease of leases.filter(l => l.location)) {
    if (!groups.has(lease.buildingKey)) groups.set(lease.buildingKey, {key: lease.buildingKey, name: lease.building, city: lease.city, postcode: lease.postcode, location: {...lease.location}, leases: []});
    groups.get(lease.buildingKey).leases.push(lease);
  }
  const byPoint = new Map();
  for (const group of groups.values()) {
    const point = `${group.location.lat.toFixed(4)},${group.location.lng.toFixed(4)}`;
    const siblings = byPoint.get(point) || [];
    if (siblings.length) {
      const angle = siblings.length * 2.4;
      const radius = 0.0035 * Math.sqrt(siblings.length);
      group.location.lat += Math.sin(angle) * radius;
      group.location.lng += Math.cos(angle) * radius * 1.6;
    }
    siblings.push(group);
    byPoint.set(point, siblings);
  }
  for (const group of groups.values()) group.rent = group.leases.reduce((sum, l) => sum + (l.rent || 0), 0);
  return [...groups.values()];
}
