import {buildPortfolio, wault, money, moneyShort, fmtDate, years, USE_COLOURS, FALLBACK_COLOUR} from './portfolio.js';

// Extraction status, shown as resolved (greens) versus still open (ambers).
// A field the lease does not contain has been checked and found absent, so it counts as resolved.
const STATUS_GROUPS = [
  {key: 'extracted', label: 'Extracted', colour: '#4f7a3a', statuses: ['extracted', 'edited'], resolved: true},
  {key: 'derived', label: 'Interpreted', colour: '#86a86a', statuses: ['derived'], resolved: true},
  {key: 'absent', label: 'Not in lease', colour: '#cfdec0', statuses: ['not_found', 'not_applicable'], resolved: true},
  {key: 'review', label: 'To review', colour: '#d1a84a', statuses: ['needs_review'], resolved: false},
  {key: 'open', label: 'Options to confirm', colour: '#ead7a6', statuses: ['optional', 'placeholder'], resolved: false},
];
const HORIZON_MONTHS = 36;

let ctx = null;

function tile(label, value, note = '') {
  return `<div class="kpi"><span class="eyebrow">${label}</span><strong>${value}</strong><small>${note || '&nbsp;'}</small></div>`;
}

function card(title, body, extra = '') {
  return `<section class="an-card ${extra}"><header class="an-card-head"><h3>${title}</h3></header>${body}</section>`;
}

function legend(items) {
  return `<div class="an-legend">${items.map(([label, colour, cls = '']) => `<span><i class="${cls}" style="background:${colour}"></i>${ctx.escape(label)}</span>`).join('')}</div>`;
}

export function renderAnalytics(context, content) {
  ctx = context;
  const {escape, workspace, effective} = ctx;
  const leases = buildPortfolio(workspace, effective);
  const today = new Date();
  const horizon = new Date(today);
  horizon.setMonth(horizon.getMonth() + HORIZON_MONTHS);
  const confirmed = leases.filter(l => l.rent != null);
  const rent = confirmed.reduce((s, l) => s + l.rent, 0);
  const in24 = new Date(today);
  in24.setMonth(in24.getMonth() + 24);
  const exits = leases.map(l => ({lease: l, exit: [l.breakDate, l.expiry].filter(d => d && d >= today).sort((a, b) => a - b)[0] || null}));
  const soon = exits.filter(e => e.exit && e.exit <= in24);
  const soonRent = soon.reduce((s, e) => s + (e.lease.rent || 0), 0);
  const cells = workspace.rows.flatMap(r => workspace.columns.filter(c => c.id !== 'c01').map(c => effective(r, c.id)));
  const resolvedStatuses = STATUS_GROUPS.filter(g => g.resolved).flatMap(g => g.statuses);
  const checked = cells.filter(c => resolvedStatuses.includes(c.status) || c.reviewed).length;

  content.innerHTML = `<div class="page-heading"><h1>Analytics</h1><div class="actions"><span class="tiny muted">${leases.length} leases · ${fmtDate(today)}</span><a class="button primary" href="/api/export.xlsx" download>${ctx.icon('download')} Export</a></div></div>
  <div class="an-grid">
    <div class="kpi-row">
      ${tile('Passing rent', moneyShort(rent), `${confirmed.length} of ${leases.length} confirmed`)}
      ${tile('WAULT', years(wault(leases, 'toExpiry')))}
      ${tile('WAULB', years(wault(leases, 'toBreak')))}
      ${tile('Exits in 24 months', soon.length ? (soonRent ? moneyShort(soonRent) : `${soon.length} lease${soon.length === 1 ? '' : 's'}`) : 'None', soon.map(e => escape(e.lease.tenant)).join(', '))}
      ${tile('Fields checked', `${Math.round((checked / cells.length) * 100)}%`, `${checked.toLocaleString('en-GB')} of ${cells.length.toLocaleString('en-GB')}`)}
    </div>
    ${card('Lease terms', timeline(leases, today) + legend([...Object.entries(USE_COLOURS), ['Break', '#30272a', 'lg-break'], ['Rent review', '#30272a', 'lg-review'], ['Today', '#30272a', 'lg-today']]), 'span-2')}
    ${card('First exit by year', exitChart(exits, today))}
    ${card('Passing rent by city', cityChart(leases) + legend(Object.entries(USE_COLOURS)))}
    ${card(`Next ${HORIZON_MONTHS} months`, diary(leases, today, horizon), 'span-2')}
    ${card('Security', security(leases))}
    ${card('Columns not in any lease', gaps(workspace, effective))}
    ${card('Extraction status', quality(workspace, effective) + legend(STATUS_GROUPS.map(g => [g.label, g.colour])), 'span-2')}
  </div><div id="chart-tip" class="chart-tip" role="tooltip"></div>`;
  wire(content);
}

function yearTicks(from, to) {
  const ticks = [];
  for (let y = Math.ceil(from.getFullYear() / 5) * 5; y <= to.getFullYear(); y += 5) ticks.push(y);
  return ticks;
}

function timeline(leases, today) {
  const {escape} = ctx;
  const dated = leases.filter(l => l.start && l.expiry).sort((a, b) => a.expiry - b.expiry);
  if (!dated.length) return '<div class="empty-state"><p>No dated leases.</p></div>';
  const min = new Date(Math.min(...dated.map(l => l.start)));
  const max = new Date(Math.max(...dated.map(l => l.expiry)));
  const from = new Date(min.getFullYear(), 0, 1), to = new Date(max.getFullYear() + 1, 0, 1);
  const x = d => ((d - from) / (to - from)) * 100;
  const ticks = yearTicks(from, to);
  return `<div class="gantt"><div class="gantt-axis"><span class="gantt-label"></span><div class="gantt-track">${ticks.map(y => `<span class="gantt-tick" style="left:${x(new Date(y, 0, 1))}%">${y}</span>`).join('')}</div></div>
  ${dated.map(l => {
    const tip = `<strong>${escape(l.tenant)}</strong><br>${fmtDate(l.start)} to ${fmtDate(l.expiry)}${l.breakDate ? `<br>Break ${fmtDate(l.breakDate)}` : ''}${l.review ? `<br>Review ${fmtDate(l.review)}` : ''}<br>${l.rent == null ? 'Rent to confirm' : money(l.rent) + ' pa'}`;
    return `<button class="gantt-row" data-cell="${escape(l.id)}|c24" data-tip="${escape(tip)}"><span class="gantt-label"><strong>${escape(l.tenant)}</strong><small>${escape(l.ref)} · ${escape(l.city || '')}</small></span><span class="gantt-track">${ticks.map(y => `<i class="gantt-grid" style="left:${x(new Date(y, 0, 1))}%"></i>`).join('')}<span class="gantt-bar" style="left:${x(l.start)}%;width:${x(l.expiry) - x(l.start)}%;background:${l.colour}"></span>${l.breakDate ? `<span class="gantt-break" style="left:${x(l.breakDate)}%"></span>` : ''}${l.review ? `<span class="gantt-review" style="left:${x(l.review)}%"></span>` : ''}</span></button>`;
  }).join('')}
  <div class="gantt-today-layer" aria-hidden="true"><span class="gantt-today" style="left:${x(today)}%"><b>Today</b></span></div></div>`;
}

function exitChart(exits, today) {
  const byYear = new Map();
  for (const {lease, exit} of exits) {
    if (!exit) continue;
    const y = exit.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(lease);
  }
  if (!byYear.size) return '<div class="empty-state"><p>No future breaks or expiries.</p></div>';
  const first = today.getFullYear(), last = Math.max(...byYear.keys());
  const yearsList = Array.from({length: last - first + 1}, (_, i) => first + i);
  const max = Math.max(...yearsList.map(y => (byYear.get(y) || []).reduce((s, l) => s + (l.rent || 0), 0)), 1);
  const anyUnconfirmed = exits.some(e => e.exit && e.lease.rent == null);
  return `<div class="col-chart">${yearsList.map(y => {
    const ls = byYear.get(y) || [];
    const value = ls.reduce((s, l) => s + (l.rent || 0), 0);
    const unconfirmed = ls.filter(l => l.rent == null).length;
    const tip = ls.length ? `<strong>${y}</strong><br>${ls.map(l => `${ctx.escape(l.tenant)}: ${l.rent == null ? 'rent to confirm' : money(l.rent)}`).join('<br>')}` : `<strong>${y}</strong><br>No exits`;
    return `<div class="col" data-tip="${ctx.escape(tip)}"><span class="col-stack">${value ? `<span class="col-value">${moneyShort(value)}</span>` : ''}${unconfirmed ? `<span class="col-unconfirmed">${unconfirmed}</span>` : ''}${value ? `<span class="col-bar" style="height:${Math.max(3, (value / max) * 100)}%"></span>` : ''}</span><span class="col-label">${y}</span></div>`;
  }).join('')}</div>${anyUnconfirmed ? legend([['Rent', 'var(--accent)'], ['Leases, rent to confirm', '#f9f5e7', 'lg-dashed']]) : ''}`;
}

function cityChart(leases) {
  const cities = new Map();
  for (const l of leases) {
    const city = l.city || 'Unknown';
    if (!cities.has(city)) cities.set(city, {city, uses: {}, total: 0, unconfirmed: 0});
    const c = cities.get(city);
    if (l.rent == null) c.unconfirmed++;
    else { c.uses[l.use] = (c.uses[l.use] || 0) + l.rent; c.total += l.rent; }
  }
  const rows = [...cities.values()].sort((a, b) => b.total - a.total);
  const max = Math.max(...rows.map(r => r.total), 1);
  return `<div class="bar-list">${rows.map(r => `<div class="bar-row" data-tip="${ctx.escape(`<strong>${r.city}</strong><br>${Object.entries(r.uses).map(([u, v]) => `${u}: ${money(v)}`).join('<br>') || 'No confirmed rent'}${r.unconfirmed ? `<br>${r.unconfirmed} rent${r.unconfirmed > 1 ? 's' : ''} to confirm` : ''}`)}"><span class="bar-label">${ctx.escape(r.city)}</span><span class="bar-track">${Object.entries(r.uses).map(([u, v]) => `<span class="bar-seg" style="width:${(v / max) * 100}%;background:${USE_COLOURS[u] || FALLBACK_COLOUR}"></span>`).join('')}</span><span class="bar-value ${r.total ? '' : 'muted'}">${r.total ? moneyShort(r.total) : 'TBC'}</span></div>`).join('')}</div>`;
}

function diary(leases, today, horizon) {
  const {escape} = ctx;
  const events = leases.flatMap(l => l.events.filter(e => e.date >= today && e.date <= horizon).map(e => ({...e, lease: l}))).sort((a, b) => a.date - b.date);
  if (!events.length) return `<div class="empty-state"><p>Nothing due in the next ${HORIZON_MONTHS} months.</p></div>`;
  const months = d => Math.round((d - today) / (30.44 * 864e5));
  return `<div class="diary"><div class="diary-head"><span>Date</span><span>Lease</span><span>Event</span><span>Action</span><span class="num">Rent pa</span></div>${events.map(e => {
    const noticePassed = e.noticeBy && e.noticeBy < today;
    const action = e.type === 'Break' ? (e.noticeBy ? (noticePassed ? 'Notice window closed' : `Notice by ${fmtDate(e.noticeBy)}`) : '—') : e.type === 'Rent review' ? (e.lease.reviewBasis || 'Review') : 'Lease ends';
    return `<button class="diary-row" data-cell="${escape(e.lease.id)}|${e.columnId}"><span><strong>${fmtDate(e.date)}</strong><small>${months(e.date)} months</small></span><span><strong>${escape(e.lease.tenant)}</strong><small>${escape(e.lease.ref)} · ${escape(e.lease.city || '')}</small></span><span><span class="badge ${e.type === 'Break' ? 'red' : e.type === 'Expiry' ? 'amber' : 'blue'}">${e.type}</span></span><span class="diary-action">${escape(action)}</span><span class="num">${e.lease.rent == null ? '<span class="muted">TBC</span>' : money(e.lease.rent)}</span></button>`;
  }).join('')}</div>`;
}

function security(leases) {
  const {escape, effective} = ctx;
  const n = leases.length || 1;
  const named = v => v && !/^none$/i.test(String(v));
  const rows = [
    ['Guarantor', leases.filter(l => named(l.guarantor))],
    ['Rent deposit', leases.filter(l => effective(l.row, 'c50').value != null || effective(l.row, 'c50').status === 'needs_review')],
    ['Contracted out of 1954 Act', leases.filter(l => l.act1954 === 'Out')],
  ];
  return `<div class="meter-list">${rows.map(([label, ls]) => `<div class="meter" data-tip="${escape(`<strong>${label}</strong><br>${ls.map(l => escape(l.tenant)).join('<br>') || 'None'}`)}"><div class="meter-top"><span>${label}</span><strong>${ls.length} of ${leases.length}</strong></div><div class="meter-track"><span style="width:${(ls.length / n) * 100}%"></span></div></div>`).join('')}</div>`;
}

const GENERIC_LABELS = /^(£|£psf|Y ?\/ ?N|Cap|Collar|Step Date|% Turnover|Frequency)$/i;
function gaps(workspace, effective) {
  const {escape} = ctx;
  const missing = workspace.columns.filter(c => c.id !== 'c01' && workspace.rows.every(r => {
    const cell = effective(r, c.id);
    return cell.value == null || cell.value === '';
  }));
  if (!missing.length) return '<p class="an-note">None.</p>';
  return `<div class="gap-chips">${missing.map(c => `<span class="gap-chip" title="${escape(c.description)}">${escape(GENERIC_LABELS.test(c.label.trim()) ? `${c.group} ${c.label}` : c.label)}</span>`).join('')}</div>`;
}

function quality(workspace, effective) {
  const {escape} = ctx;
  const groups = new Map();
  for (const c of workspace.columns.filter(c => c.id !== 'c01')) {
    if (!groups.has(c.group)) groups.set(c.group, {});
    const counts = groups.get(c.group);
    for (const r of workspace.rows) {
      const cell = effective(r, c.id);
      const group = cell.reviewed ? STATUS_GROUPS[0] : STATUS_GROUPS.find(g => g.statuses.includes(cell.status)) || STATUS_GROUPS[2];
      counts[group.key] = (counts[group.key] || 0) + 1;
    }
  }
  const rows = [...groups].map(([group, counts]) => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const resolved = STATUS_GROUPS.filter(g => g.resolved).reduce((s, g) => s + (counts[g.key] || 0), 0);
    return {group, counts, total, pct: Math.round((resolved / total) * 100)};
  }).sort((a, b) => b.pct - a.pct);
  return `<div class="bar-list quality"><div class="bar-row bar-head"><span></span><span></span><span class="bar-value">Checked</span></div>${rows.map(({group, counts, total, pct}) => {
    const tip = `<strong>${escape(group)}</strong><br>${STATUS_GROUPS.filter(g => counts[g.key]).map(g => `${g.label}: ${counts[g.key]}`).join('<br>')}`;
    return `<div class="bar-row" data-tip="${escape(tip)}"><span class="bar-label">${escape(group)}</span><span class="bar-track stacked">${STATUS_GROUPS.filter(g => counts[g.key]).map(g => `<span class="bar-seg" style="width:${(counts[g.key] / total) * 100}%;background:${g.colour}"></span>`).join('')}</span><span class="bar-value">${pct}%</span></div>`;
  }).join('')}</div>`;
}

function wire(content) {
  const tip = content.querySelector('#chart-tip');
  content.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', () => { tip.innerHTML = el.dataset.tip; tip.classList.add('visible'); });
    el.addEventListener('mousemove', e => {
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 12);
      const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 12 : e.clientY + 16;
      tip.style.transform = `translate(${x}px, ${y}px)`;
    });
    el.addEventListener('mouseleave', () => tip.classList.remove('visible'));
  });
  content.querySelectorAll('[data-cell]').forEach(el => (el.onclick = () => {
    const [row, col] = el.dataset.cell.split('|');
    tip.classList.remove('visible');
    ctx.selectCell(row, col);
  }));
}
