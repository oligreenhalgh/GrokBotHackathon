import {buildPortfolio, geocode, buildings, wault, money, moneyShort, fmtDate, years, USE_COLOURS, FALLBACK_COLOUR} from './portfolio.js';

const L = window.L;
let map = null, markers = new Map(), selectedId = null, useFilter = '', query = '', leases = [], groups = [], ctx = null, savedView = null;

const TERMS = [
  ['c35', 'Passing rent', l => money(l.rent)],
  ['c19', 'Lease start', l => fmtDate(l.start)],
  ['c24', 'Expiry', l => fmtDate(l.expiry)],
  ['c20', 'Break', l => (l.breakDate ? `${fmtDate(l.breakDate)}${l.breakParty ? ` · ${l.breakParty}` : ''}` : 'None stated')],
  ['c22', 'Break notice', l => (l.breakNotice != null ? `${l.breakNotice} months` : '—')],
  ['c25', 'Next rent review', l => (l.review ? `${fmtDate(l.review)}${l.reviewBasis ? ` · ${l.reviewBasis}` : ''}` : '—')],
  ['c16', 'Guarantor', l => l.guarantor || '—'],
  ['c18', '1954 Act', l => (l.act1954 === 'Out' ? 'Contracted out' : l.act1954 === 'In' ? 'Inside the Act' : l.act1954 || '—')],
  ['c51', 'Repair', l => l.repair || '—'],
  ['c54', 'Alienation', l => l.alienation || '—'],
  ['c09', 'Permitted use', l => l.permittedUse || '—'],
];

export function destroyMap() {
  if (!map) return;
  savedView = {center: map.getCenter(), zoom: map.getZoom()};
  map.remove();
  map = null;
  markers = new Map();
}

export async function renderMap(context, content) {
  ctx = context;
  destroyMap();
  const {escape} = ctx;
  content.innerHTML = `<div class="map-view"><div id="portfolio-map" class="map-canvas" role="region" aria-label="Map of leased properties"></div><aside class="map-rail" id="map-rail" aria-label="Portfolio"></aside><div class="map-legend" aria-label="Map key">${Object.entries(USE_COLOURS).map(([k, c]) => `<span><i style="background:${c}"></i>${escape(k)}</span>`).join('')}<span class="legend-size"><i class="dot-small"></i><i class="dot-large"></i>Pin size = passing rent</span><span><i class="dot-dashed"></i>Rent to confirm</span></div><div class="map-status" id="map-status">Locating properties…</div></div>`;
  leases = buildPortfolio(ctx.workspace, ctx.effective);
  map = L.map('portfolio-map', {zoomControl: false, attributionControl: true, scrollWheelZoom: true}).setView(savedView?.center || [52.9, -1.9], savedView?.zoom || 6);
  L.control.zoom({position: 'topright'}).addTo(map);
  // Esri Light Gray Canvas: keyless and does not depend on a Referer header (the server sends Referrer-Policy: same-origin).
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_';
  L.tileLayer(`${esri}Base/MapServer/tile/{z}/{y}/{x}`, {maxZoom: 16, attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'}).addTo(map);
  L.tileLayer(`${esri}Reference/MapServer/tile/{z}/{y}/{x}`, {maxZoom: 16, pane: 'overlayPane'}).addTo(map);
  renderRail();
  await geocode(leases);
  if (!map) return;
  groups = buildings(leases);
  const located = leases.filter(l => l.location).length;
  const approx = leases.some(l => l.location?.precision === 'Postcode district');
  const status = document.getElementById('map-status');
  if (status) status.textContent = located < leases.length ? `${leases.length - located} of ${leases.length} leases have no postcode to place` : approx ? 'Pins at postcode-district centroids' : '';
  status?.classList.toggle('hidden', !status.textContent);
  drawMarkers();
  if (!savedView && groups.length) map.fitBounds(L.latLngBounds(groups.map(g => [g.location.lat, g.location.lng])), window.innerWidth <= 600 ? {paddingTopLeft: [30, 60], paddingBottomRight: [30, Math.round(window.innerHeight * 0.5)], maxZoom: 12} : {paddingTopLeft: [390, 50], paddingBottomRight: [60, 80], maxZoom: 12});
  renderRail();
}

function visible(lease) {
  const q = query.trim().toLowerCase();
  return (!useFilter || lease.use === useFilter) && (!q || `${lease.tenant} ${lease.address} ${lease.city} ${lease.ref}`.toLowerCase().includes(q));
}

function pinSize(rent, max) {
  return rent ? 16 + Math.round(18 * Math.sqrt(rent / max)) : 16;
}

function drawMarkers() {
  markers.forEach(m => m.remove());
  markers = new Map();
  const max = Math.max(1, ...groups.map(g => g.rent));
  for (const group of groups) {
    const shown = group.leases.filter(visible);
    if (!shown.length) continue;
    const rent = shown.reduce((sum, l) => sum + (l.rent || 0), 0);
    const size = pinSize(rent, max);
    const colours = [...new Set(shown.map(l => l.colour))];
    const fill = colours.length > 1 ? `conic-gradient(${colours[0]} 0 50%, ${colours[1]} 0 100%)` : colours[0];
    const unconfirmed = shown.some(l => l.rent == null);
    const active = shown.some(l => l.id === selectedId);
    const icon = L.divIcon({
      className: 'pin-wrap',
      iconSize: [size, size],
      html: `<span class="pin ${unconfirmed ? 'pin-unconfirmed' : ''} ${active ? 'pin-active' : ''}" style="width:${size}px;height:${size}px;background:${fill}">${shown.length > 1 ? shown.length : ''}</span>`,
    });
    const marker = L.marker([group.location.lat, group.location.lng], {icon, keyboard: true, title: group.name, riseOnHover: true}).addTo(map);
    marker.bindTooltip(`<strong>${ctx.escape(group.name)}</strong><br>${shown.length} lease${shown.length > 1 ? 's' : ''} · ${rent ? moneyShort(rent) + ' pa' : 'rent to confirm'}`, {direction: 'top', offset: [0, -size / 2], className: 'pin-tip'});
    marker.on('click', () => select(shown.find(l => l.id === selectedId) ? selectedId : shown[0].id, false));
    for (const lease of group.leases) markers.set(lease.id, marker);
  }
}

function select(id, fly = true) {
  if (id !== selectedId) ctx.closePanel();
  selectedId = id;
  const lease = leases.find(l => l.id === id);
  drawMarkers();
  renderRail();
  if (fly && lease?.location && map) map.flyTo([lease.location.lat, lease.location.lng], Math.max(map.getZoom(), 13), {duration: 0.6});
}

function renderRail() {
  const rail = document.getElementById('map-rail');
  if (!rail) return;
  const lease = leases.find(l => l.id === selectedId);
  rail.innerHTML = lease ? detail(lease) : list();
  wireRail(rail);
}

function stat(label, value, note = '') {
  return `<div class="rail-stat"><span class="eyebrow">${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
}

function list() {
  const {escape, icon} = ctx;
  const shown = leases.filter(visible);
  const confirmed = shown.filter(l => l.rent != null);
  const rent = confirmed.reduce((sum, l) => sum + l.rent, 0);
  const cities = [...new Set(shown.map(l => l.city || 'No location'))].sort();
  const uses = [...new Set(leases.map(l => l.use))].sort();
  return `<div class="rail-head"><div class="eyebrow">Portfolio</div><h2>${shown.length} lease${shown.length === 1 ? '' : 's'} · ${new Set(shown.map(l => l.buildingKey)).size} buildings</h2></div>
  <div class="rail-stats">${stat('Passing rent', moneyShort(rent), `${confirmed.length} of ${shown.length} confirmed`)}${stat('WAULT to break', years(wault(shown, 'toBreak')))}${stat('WAULT to expiry', years(wault(shown, 'toExpiry')))}</div>
  <div class="rail-controls"><label class="search">${icon('search')}<input id="map-search" placeholder="Search tenant, address or city" value="${escape(query)}" aria-label="Search leases on the map"></label><div class="segmented" role="group" aria-label="Filter by use"><button class="${!useFilter ? 'active' : ''}" data-use="">All</button>${uses.map(u => `<button class="${useFilter === u ? 'active' : ''}" data-use="${escape(u)}">${escape(u)}</button>`).join('')}</div></div>
  <div class="rail-list">${cities.map(city => {
    const inCity = shown.filter(l => (l.city || 'No location') === city).sort((a, b) => (b.rent || 0) - (a.rent || 0));
    const total = inCity.reduce((sum, l) => sum + (l.rent || 0), 0);
    return `<section><div class="rail-city"><span>${escape(city)}</span><span>${total ? moneyShort(total) : ''}</span></div>${inCity.map(l => `<button class="rail-lease" data-lease="${escape(l.id)}"><i class="use-dot" style="background:${l.colour}"></i><span class="rail-lease-main"><strong>${escape(l.tenant)}</strong><small>${escape(l.unit)} · ${escape(l.building.split(',')[0])}</small></span><span class="rail-lease-side"><strong class="${l.rent == null ? 'to-confirm' : ''}">${l.rent == null ? 'To confirm' : moneyShort(l.rent)}</strong>${l.nextEvent ? `<small>${escape(l.nextEvent.type)} ${escape(l.nextEvent.date.getFullYear())}</small>` : ''}</span></button>`).join('')}</section>`;
  }).join('') || `<div class="empty-state"><h3>No matching leases</h3><p>Try another search or filter.</p></div>`}</div>`;
}

function termBar(lease) {
  if (!lease.start || !lease.expiry) return '';
  const span = lease.expiry - lease.start;
  const pos = d => Math.min(100, Math.max(0, ((d - lease.start) / span) * 100));
  const today = new Date();
  const marks = [
    ...(lease.breakDate ? [{d: lease.breakDate, cls: 'mark-break', label: `Break ${fmtDate(lease.breakDate)}`}] : []),
    ...(lease.review ? [{d: lease.review, cls: 'mark-review', label: `Review ${fmtDate(lease.review)}`}] : []),
  ];
  return `<div class="term-bar" aria-label="Lease term from ${fmtDate(lease.start)} to ${fmtDate(lease.expiry)}"><div class="term-track"><div class="term-elapsed" style="width:${pos(today)}%"></div>${marks.map(m => `<span class="term-mark ${m.cls}" style="left:${pos(m.d)}%" title="${m.label}"></span>`).join('')}<span class="term-today" style="left:${pos(today)}%" title="Today"></span></div><div class="term-scale"><span>${lease.start.getFullYear()}</span><span class="term-key"><i class="mark-break"></i>Break <i class="mark-review"></i>Review</span><span>${lease.expiry.getFullYear()}</span></div></div>`;
}

function detail(lease) {
  const {escape, icon, effective, badge} = ctx;
  const neighbours = leases.filter(l => l.buildingKey === lease.buildingKey && l.id !== lease.id);
  const noticeBy = lease.events.find(e => e.type === 'Break')?.noticeBy;
  return `<div class="rail-head"><button class="rail-back" id="rail-back">${icon('arrow')} All leases</button><div class="eyebrow"><i class="use-dot" style="background:${lease.colour}"></i>${escape(lease.ref)} · ${escape(lease.use)}</div><h2>${escape(lease.tenant)}</h2><p class="rail-address">${escape(lease.address)}</p></div>
  <div class="rail-stats">${stat('Passing rent', lease.rent == null ? 'To confirm' : moneyShort(lease.rent), lease.rent == null ? 'Open source to check' : 'per annum')}${stat('To break', lease.breakDate && lease.breakDate > new Date() ? years(lease.toBreak) : 'Passed')}${stat('To expiry', years(lease.toExpiry))}</div>
  ${termBar(lease)}
  ${lease.nextEvent ? `<div class="next-event"><span class="eyebrow">Next event</span><strong>${escape(lease.nextEvent.type)} · ${fmtDate(lease.nextEvent.date)}</strong>${lease.nextEvent.type === 'Break' && noticeBy ? `<small>Tenant notice due by ${fmtDate(noticeBy)}</small>` : ''}</div>` : ''}
  <div class="rail-terms"><div class="rail-section-title">Lease terms <span class="muted">Select a term to see its source</span></div>${TERMS.map(([id, label, value]) => {
    const cell = effective(lease.row, id);
    return `<button class="term-row" data-field="${id}"><span class="term-label">${label}</span><span class="term-value">${escape(value(lease))}</span>${cell.status !== 'extracted' ? badge(cell.status) : ''}</button>`;
  }).join('')}</div>
  ${neighbours.length ? `<div class="rail-terms"><div class="rail-section-title">Also in this building</div>${neighbours.map(n => `<button class="rail-lease" data-lease="${escape(n.id)}"><i class="use-dot" style="background:${n.colour}"></i><span class="rail-lease-main"><strong>${escape(n.tenant)}</strong><small>${escape(n.unit)}</small></span><span class="rail-lease-side"><strong>${n.rent == null ? 'To confirm' : moneyShort(n.rent)}</strong></span></button>`).join('')}</div>` : ''}
  <div class="rail-actions"><a class="button" href="/viewer.html?document=${encodeURIComponent(lease.row.documentId)}&page=1" target="_blank" rel="noopener">${icon('file')} Open lease</a><button class="button" id="show-register">${icon('grid')} Show in register</button></div>`;
}

function wireRail(rail) {
  rail.querySelectorAll('[data-lease]').forEach(b => (b.onclick = () => select(b.dataset.lease)));
  rail.querySelectorAll('[data-lease]').forEach(b => {
    b.onmouseenter = () => markers.get(b.dataset.lease)?.openTooltip();
    b.onmouseleave = () => markers.get(b.dataset.lease)?.closeTooltip();
  });
  rail.querySelectorAll('[data-use]').forEach(b => (b.onclick = () => { useFilter = b.dataset.use; drawMarkers(); renderRail(); }));
  const search = rail.querySelector('#map-search');
  if (search) search.oninput = e => {
    const pos = e.target.selectionStart;
    query = e.target.value;
    drawMarkers();
    renderRail();
    const next = document.getElementById('map-search');
    next.focus();
    next.setSelectionRange(pos, pos);
  };
  rail.querySelector('#rail-back')?.addEventListener('click', () => { selectedId = null; ctx.closePanel(); drawMarkers(); renderRail(); });
  rail.querySelectorAll('[data-field]').forEach(b => (b.onclick = () => ctx.selectCell(selectedId, b.dataset.field)));
  rail.querySelector('#show-register')?.addEventListener('click', () => ctx.goToRegister(leases.find(l => l.id === selectedId)));
}
