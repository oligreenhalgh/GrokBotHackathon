import {buildPortfolio, wault, money, moneyShort, fmtDate, years, USE_COLOURS, FALLBACK_COLOUR} from './portfolio.js';

const STATUS_ORDER = ['extracted', 'derived', 'edited', 'needs_review', 'optional', 'placeholder', 'not_found', 'not_applicable'];
const STATUS_COLOURS = {extracted: '#5b7d44', derived: '#667e8f', edited: '#3f5f8a', needs_review: '#9c263e', optional: '#b8a05f', placeholder: '#d1b678', not_found: '#d9cfd2', not_applicable: '#ece6e8'};
const HORIZON_MONTHS = 36;

let ctx = null;

function tile(label, value, note = '', tone = '') {
  return `<div class="kpi ${tone}"><span class="eyebrow">${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
}

function card(title, subtitle, body, extra = '') {
  return `<section class="an-card ${extra}"><header class="an-card-head"><h3>${title}</h3>${subtitle ? `<p>${subtitle}</p>` : ''}</header>${body}</section>`;
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
  const atRisk = exits.filter(e => e.exit && e.exit <= in24);
  const atRiskRent = atRisk.reduce((s, e) => s + (e.lease.rent || 0), 0);
  const cells = workspace.rows.flatMap(r => workspace.columns.filter(c => c.id !== 'c01').map(c => ({r, c, cell: effective(r, c.id)})));
  const toReview = cells.filter(x => x.cell.status === 'needs_review' && !x.cell.reviewed).length;
  const reviewed = cells.filter(x => x.cell.reviewed).length;

  content.innerHTML = `<div class="page-heading"><h1>Analytics</h1><div class="actions"><span class="tiny muted">${leases.length} leases · as at ${fmtDate(today)}</span><a class="button primary" href="/api/export.xlsx" download>${ctx.icon('download')} Export</a></div></div>
  <div class="an-grid">
    <div class="kpi-row">
      ${tile('Passing rent', moneyShort(rent), `${confirmed.length} of ${leases.length} rents confirmed`)}
      ${tile('WAULT to break', years(wault(leases, 'toBreak')), 'Rent-weighted, confirmed rents')}
      ${tile('WAULT to expiry', years(wault(leases, 'toExpiry')), 'Rent-weighted, confirmed rents')}
      ${tile('Income at a break or expiry within 24 months', atRiskRent ? moneyShort(atRiskRent) : `${atRisk.length} lease${atRisk.length === 1 ? '' : 's'}`, atRisk.length ? `${atRisk.map(e => escape(e.lease.tenant)).join(', ')}${atRisk.some(e => e.lease.rent == null) ? ' · rent to confirm' : ''}` : 'No exits in the next 24 months', atRisk.length ? 'kpi-alert' : '')}
      ${tile('Fields to review', toReview.toLocaleString('en-GB'), `${reviewed} reviewed so far`, toReview ? 'kpi-alert' : '')}
    </div>
    ${card('Lease terms', 'Each bar runs from lease start to expiry. Select a lease to see its source.', timeline(leases, today) + legend([...Object.entries(USE_COLOURS).map(([k, c]) => [k, c]), ['Break', '#30272a', 'lg-break'], ['Rent review', '#30272a', 'lg-review'], ['Today', '#30272a', 'lg-today']]), 'span-2')}
    ${card('First exit by year', 'Earliest future break or expiry for each lease, with the rent it carries.', exitChart(exits, today))}
    ${card('Passing rent by city', 'Confirmed rent only. Leases with a rent to confirm are counted alongside.', cityChart(leases) + legend(Object.entries(USE_COLOURS)))}
    ${card(`Diary: next ${HORIZON_MONTHS} months`, 'Breaks, rent reviews and expiries, with the last date for a tenant break notice.', diary(leases, today, horizon), 'span-2')}
    ${card('Covenant and security', 'What stands behind the income if a tenant fails.', security(leases))}
    ${card('Data gaps', 'Rent roll columns no lease in the register states. These block £psf, ERV and reversion analysis.', gaps(workspace, effective))}
    ${card('Extraction quality by column group', 'Share of cells in each group by status, across all leases.', quality(workspace, effective) + legend(STATUS_ORDER.filter(s => cells.some(x => x.cell.status === s)).map(s => [ctx.statusLabels[s] || s, STATUS_COLOURS[s]])), 'span-2')}
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
  if (!dated.length) return '<div class="empty-state"><p>No leases have both a start and an expiry date yet.</p></div>';
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
  return `<div class="col-chart">${yearsList.map(y => {
    const ls = byYear.get(y) || [];
    const value = ls.reduce((s, l) => s + (l.rent || 0), 0);
    const unconfirmed = ls.filter(l => l.rent == null).length;
    const tip = ls.length ? `<strong>${y}</strong><br>${ls.map(l => ctx.escape(l.tenant)).join('<br>')}<br>${moneyShort(value)} confirmed${unconfirmed ? `, ${unconfirmed} to confirm` : ''}` : `<strong>${y}</strong><br>No exits`;
    return `<div class="col" data-tip="${ctx.escape(tip)}"><span class="col-value">${value ? moneyShort(value) : ''}</span><span class="col-bar-wrap">${value ? `<span class="col-bar" style="height:${Math.max(4, (value / max) * 100)}%"></span>` : ''}${unconfirmed ? `<span class="col-unconfirmed" style="height:${value ? 10 : 18}%" title="${unconfirmed} lease${unconfirmed > 1 ? 's' : ''} with rent to confirm">${unconfirmed}</span>` : ''}</span><span class="col-label">${String(y).slice(2)}</span></div>`;
  }).join('')}</div><p class="an-note">Axis shows years as two digits (’${String(first).slice(2)} to ’${String(last).slice(2)}). Dashed blocks count leases whose rent is still to confirm.</p>`;
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
  return `<div class="bar-list">${rows.map(r => `<div class="bar-row" data-tip="${ctx.escape(`<strong>${r.city}</strong><br>${Object.entries(r.uses).map(([u, v]) => `${u}: ${money(v)}`).join('<br>') || 'No confirmed rent'}${r.unconfirmed ? `<br>${r.unconfirmed} rent${r.unconfirmed > 1 ? 's' : ''} to confirm` : ''}`)}"><span class="bar-label">${ctx.escape(r.city)}</span><span class="bar-track">${Object.entries(r.uses).map(([u, v]) => `<span class="bar-seg" style="width:${(v / max) * 100}%;background:${USE_COLOURS[u] || FALLBACK_COLOUR}"></span>`).join('')}</span><span class="bar-value">${r.total ? moneyShort(r.total) : '—'}${r.unconfirmed ? `<small> +${r.unconfirmed}</small>` : ''}</span></div>`).join('')}</div>`;
}

function diary(leases, today, horizon) {
  const {escape} = ctx;
  const events = leases.flatMap(l => l.events.filter(e => e.date >= today && e.date <= horizon).map(e => ({...e, lease: l}))).sort((a, b) => a.date - b.date);
  if (!events.length) return `<div class="empty-state"><p>Nothing falls due in the next ${HORIZON_MONTHS} months.</p></div>`;
  const months = d => Math.round((d - today) / (30.44 * 864e5));
  return `<div class="diary"><div class="diary-head"><span>Date</span><span>Lease</span><span>Event</span><span>Action</span><span>Rent</span></div>${events.map(e => {
    const noticePassed = e.noticeBy && e.noticeBy < today;
    const action = e.type === 'Break' ? (e.noticeBy ? (noticePassed ? `Notice window closed ${fmtDate(e.noticeBy)}` : `Tenant notice by ${fmtDate(e.noticeBy)}`) : 'Notice period not stated') : e.type === 'Rent review' ? `${e.lease.reviewBasis || 'Review'}${months(e.date) <= 12 ? ' · prepare evidence' : ''}` : 'Lease ends';
    return `<button class="diary-row" data-cell="${escape(e.lease.id)}|${e.columnId}"><span><strong>${fmtDate(e.date)}</strong><small>in ${months(e.date)} months</small></span><span><strong>${escape(e.lease.tenant)}</strong><small>${escape(e.lease.ref)} · ${escape(e.lease.city || '')}</small></span><span><span class="badge ${e.type === 'Break' ? 'red' : e.type === 'Expiry' ? 'amber' : 'blue'}">${e.type}</span></span><span class="diary-action ${e.noticeBy && !noticePassed && months(e.noticeBy) <= 6 ? 'urgent' : ''}">${escape(action)}</span><span>${e.lease.rent == null ? '<span class="muted">To confirm</span>' : moneyShort(e.lease.rent)}</span></button>`;
  }).join('')}</div>`;
}

function security(leases) {
  const {escape, effective} = ctx;
  const n = leases.length || 1;
  const named = v => v && !/^none$/i.test(String(v));
  const guaranteed = leases.filter(l => named(l.guarantor));
  const deposits = leases.filter(l => effective(l.row, 'c50').value != null);
  const depositFlagged = leases.filter(l => effective(l.row, 'c50').status === 'needs_review');
  const outside = leases.filter(l => l.act1954 === 'Out');
  const rows = [
    ['Guarantor named', guaranteed.length, guaranteed.map(l => l.tenant)],
    ['Rent deposit amount stated', deposits.length, deposits.map(l => l.tenant)],
    ['Deposit referenced, amount to confirm', depositFlagged.length, depositFlagged.map(l => l.tenant)],
    ['Contracted out of the 1954 Act', outside.length, outside.map(l => l.tenant)],
  ];
  return `<div class="meter-list">${rows.map(([label, count, names]) => `<div class="meter" data-tip="${escape(`<strong>${label}</strong><br>${names.map(escape).join('<br>') || 'None'}`)}"><div class="meter-top"><span>${label}</span><strong>${count} of ${leases.length}</strong></div><div class="meter-track"><span style="width:${(count / n) * 100}%"></span></div></div>`).join('')}</div>`;
}

function gaps(workspace, effective) {
  const {escape} = ctx;
  const missing = workspace.columns.filter(c => c.id !== 'c01' && workspace.rows.every(r => {
    const cell = effective(r, c.id);
    return cell.value == null || cell.value === '';
  }));
  if (!missing.length) return '<p class="an-note">Every column is populated for at least one lease.</p>';
  const groups = new Map();
  for (const c of missing) groups.set(c.group, [...(groups.get(c.group) || []), c]);
  return `<div class="gap-list">${[...groups].map(([group, cols]) => `<div class="gap-group"><span class="gap-group-name">${escape(group)}</span><span class="gap-chips">${cols.map(c => `<span class="gap-chip" title="${escape(c.description)}">${escape(c.label)}</span>`).join('')}</span></div>`).join('')}</div><p class="an-note">${missing.length} of ${workspace.columns.length - 1} columns are empty across every lease.</p>`;
}

function quality(workspace, effective) {
  const {escape, statusLabels} = ctx;
  const groups = new Map();
  for (const c of workspace.columns.filter(c => c.id !== 'c01')) {
    if (!groups.has(c.group)) groups.set(c.group, {});
    const counts = groups.get(c.group);
    for (const r of workspace.rows) {
      const s = effective(r, c.id).status;
      counts[s] = (counts[s] || 0) + 1;
    }
  }
  return `<div class="bar-list quality">${[...groups].map(([group, counts]) => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const known = (counts.extracted || 0) + (counts.derived || 0) + (counts.edited || 0);
    const tip = `<strong>${escape(group)}</strong><br>${STATUS_ORDER.filter(s => counts[s]).map(s => `${statusLabels[s] || s}: ${counts[s]}`).join('<br>')}`;
    return `<div class="bar-row" data-tip="${escape(tip)}"><span class="bar-label">${escape(group)}</span><span class="bar-track stacked">${STATUS_ORDER.filter(s => counts[s]).map(s => `<span class="bar-seg" style="width:${(counts[s] / total) * 100}%;background:${STATUS_COLOURS[s]}"></span>`).join('')}</span><span class="bar-value">${Math.round((known / total) * 100)}%<small> known</small></span></div>`;
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
