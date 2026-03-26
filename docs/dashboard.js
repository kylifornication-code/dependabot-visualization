/* ── Dependabot Dashboard — UI ──────────────────────────────────────── */

// ── State ────────────────────────────────────────────────────────────────
let currentData  = null;
let historyData  = [];
let trendChart   = null;
let sortState    = { col: 'totalAlerts', asc: false };

// ── Constants ────────────────────────────────────────────────────────────
const SEV_ORDER  = ['critical', 'high', 'medium', 'low', 'unknown'];
const SEV_COLOR  = {
  critical: '#f85149',
  high:     '#d29922',
  medium:   '#e3b341',
  low:      '#58a6ff',
  unknown:  '#6e7681',
};
const SEV_LABEL  = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' };

const STATE_COLOR = {
  clean:    'green',
  dirty:    'red',
  unstable: 'orange',
  blocked:  'orange',
  behind:   'blue',
  draft:    'muted',
  unknown:  'muted',
};
const STATE_LABEL = {
  clean:    'Ready to merge',
  dirty:    'Has conflicts',
  unstable: 'CI failing',
  blocked:  'Blocked',
  behind:   'Behind base',
  draft:    'Draft',
  unknown:  'Checking…',
};

// ── Utilities ────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (seconds < 60)   return 'just now';
  const mins = Math.floor(seconds / 60);
  if (mins < 60)      return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)       return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30)      return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12)    return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysOld(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso)) / 86_400_000);
}

function pill(text, cls) {
  return `<span class="pill pill-${cls}">${text}</span>`;
}

function sevPill(sev) {
  return pill(SEV_LABEL[sev] ?? sev, sev in SEV_COLOR ? sev : 'unknown');
}

function healthClass(summary) {
  if (summary.bySeverity.critical > 0) return 'critical';
  if (summary.bySeverity.high     > 0) return 'high';
  if (summary.bySeverity.medium   > 0) return 'medium';
  if (summary.bySeverity.low      > 0) return 'low';
  return 'healthy';
}

function el(id) { return document.getElementById(id); }

// ── Data loading ─────────────────────────────────────────────────────────
async function loadData() {
  const bust = `?t=${Date.now()}`;

  const [snapRes, histRes] = await Promise.all([
    fetch(`data/current.json${bust}`),
    fetch(`data/history-index.json${bust}`),
  ]);

  if (!snapRes.ok) throw new Error(`current.json not found (${snapRes.status}). Has the GitHub Action run yet?`);

  currentData = await snapRes.json();
  historyData = histRes.ok ? await histRes.json() : [];
}

// ── Header ───────────────────────────────────────────────────────────────
function renderHeader() {
  const { summary, generatedAt } = currentData;
  const cls   = healthClass(summary);
  const label = { healthy: 'Healthy', low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical' }[cls];

  el('health-badge').className    = `badge badge-${cls}`;
  el('health-badge').textContent  = label;
  el('last-updated').textContent  = `Updated ${timeAgo(generatedAt)} · ${formatDate(generatedAt)}`;
}

// ── Summary cards ─────────────────────────────────────────────────────────
function renderSummaryCards() {
  const { summary } = currentData;
  const s = summary.bySeverity;

  const cards = [
    { cls: 'critical', value: s.critical,           label: 'Critical',       sub: 'alerts' },
    { cls: 'high',     value: s.high,               label: 'High',           sub: 'alerts' },
    { cls: 'medium',   value: s.medium,             label: 'Medium',         sub: 'alerts' },
    { cls: 'low',      value: s.low,                label: 'Low',            sub: 'alerts' },
    { cls: 'prs',      value: summary.totalOpenPRs, label: 'Open PRs',       sub: `across ${summary.reposWithPRs ?? '?'} repos` },
    { cls: 'repos',    value: summary.reposAffected, label: 'Repos affected', sub: `of ${summary.reposScanned ?? '?'} scanned` },
  ];

  el('summary-cards').innerHTML = cards.map(c => `
    <div class="summary-card ${c.cls}">
      <div class="card-value">${c.value}</div>
      <div class="card-label">${c.label}</div>
      <div class="card-sub">${c.sub}</div>
    </div>
  `).join('');
}

// ── Trend chart ───────────────────────────────────────────────────────────
function renderTrendChart() {
  if (historyData.length === 0) {
    el('chart-container').innerHTML = `
      <div class="state-box" style="padding:32px 0">
        <p>Historical data will appear here after the action has run for at least two days.</p>
      </div>`;
    return;
  }

  // Use last 90 days max
  const recent = historyData.slice(-90);
  const labels = recent.map(e => {
    const [, m, d] = e.date.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
  });

  const datasets = SEV_ORDER.filter(s => s !== 'unknown').map(sev => ({
    label: SEV_LABEL[sev],
    data:  recent.map(e => e.bySeverity?.[sev] ?? 0),
    borderColor:     SEV_COLOR[sev],
    backgroundColor: SEV_COLOR[sev] + '22',
    borderWidth:     2,
    pointRadius:     recent.length > 14 ? 0 : 3,
    pointHoverRadius: 4,
    tension:         0.3,
    fill:            false,
  }));

  const ctx = el('trend-chart').getContext('2d');
  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor:     '#30363d',
          borderWidth:     1,
          titleColor:      '#e6edf3',
          bodyColor:       '#c9d1d9',
        },
      },
      scales: {
        x: {
          grid:   { color: '#21262d' },
          ticks:  { color: '#8b949e', maxTicksLimit: 10, font: { size: 11 } },
        },
        y: {
          grid:      { color: '#21262d' },
          ticks:     { color: '#8b949e', font: { size: 11 }, precision: 0 },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── Work estimate ─────────────────────────────────────────────────────────
function renderWorkEstimate() {
  const allPRs = currentData.repos.flatMap(r => r.prs ?? []);

  if (allPRs.length === 0) {
    el('work-estimate').innerHTML = `
      <div class="state-box" style="padding:24px 0">
        <p>No open Dependabot PRs found.</p>
      </div>`;
    return;
  }

  const categories = {
    autoMerge:  { label: 'Auto-merge enabled',  desc: 'Will self-merge when CI passes', dot: 'green',  count: 0 },
    ready:      { label: 'Ready to merge',       desc: 'Green CI, no conflicts',         dot: 'green',  count: 0 },
    security:   { label: 'Security updates',     desc: 'Patch a known vulnerability',    dot: 'orange', count: 0 },
    conflicts:  { label: 'Has conflicts',        desc: 'Needs rebase or manual fix',     dot: 'red',    count: 0 },
    failing:    { label: 'CI failing',           desc: 'Checks must pass first',         dot: 'red',    count: 0 },
    blocked:    { label: 'Blocked / needs review', desc: 'Add an approval',              dot: 'orange', count: 0 },
    draft:      { label: 'Draft',               desc: 'Not ready yet',                  dot: 'muted',  count: 0 },
    other:      { label: 'Other / unknown',      desc: 'Status pending from GitHub',     dot: 'muted',  count: 0 },
  };

  for (const pr of allPRs) {
    if (pr.isDraft)                            { categories.draft.count++;     continue; }
    if (pr.autoMergeEnabled)                   { categories.autoMerge.count++; continue; }
    if (pr.isSecurityUpdate)                   { categories.security.count++;  continue; }

    const state = pr.mergeableState ?? 'unknown';
    if (state === 'clean')                     { categories.ready.count++;     continue; }
    if (state === 'dirty')                     { categories.conflicts.count++; continue; }
    if (state === 'unstable')                  { categories.failing.count++;   continue; }
    if (state === 'blocked')                   { categories.blocked.count++;   continue; }
    categories.other.count++;
  }

  el('work-estimate').innerHTML = `
    <div class="work-list">
      ${Object.values(categories).filter(c => c.count > 0).map(c => `
        <div class="work-row">
          <div class="work-dot dot-${c.dot}"></div>
          <div class="work-count">${c.count}</div>
          <div class="work-info">
            <div class="work-label">${c.label}</div>
            <div class="work-desc">${c.desc}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="work-total">${allPRs.length} total open PR${allPRs.length !== 1 ? 's' : ''}</div>
  `;
}

// ── Repo table ────────────────────────────────────────────────────────────
function renderRepoTable() {
  const repos = [...(currentData.repos ?? [])];
  const maxAlerts = Math.max(...repos.map(r => r.totalAlerts), 1);

  // Sort
  repos.sort((a, b) => {
    let va = a[sortState.col] ?? 0;
    let vb = b[sortState.col] ?? 0;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (sortState.col.startsWith('alertCounts.')) {
      const k = sortState.col.split('.')[1];
      va = a.alertCounts?.[k] ?? 0;
      vb = b.alertCounts?.[k] ?? 0;
    }
    if (va < vb) return sortState.asc ? -1 :  1;
    if (va > vb) return sortState.asc ?  1 : -1;
    return 0;
  });

  // Table header columns
  const cols = [
    { key: 'name',              label: 'Repository',  align: 'left'   },
    { key: 'alertCounts.critical', label: 'Crit.',    align: 'center' },
    { key: 'alertCounts.high',     label: 'High',     align: 'center' },
    { key: 'alertCounts.medium',   label: 'Med.',     align: 'center' },
    { key: 'alertCounts.low',      label: 'Low',      align: 'center' },
    { key: 'totalAlerts',       label: 'Total',       align: 'center' },
    { key: 'openPRs',           label: 'Open PRs',    align: 'center' },
    { key: 'oldestAlert',       label: 'Oldest alert',align: 'left'   },
  ];

  function thCls(key) {
    if (sortState.col !== key) return '';
    return sortState.asc ? 'sort-asc' : 'sort-desc';
  }

  const thead = `<thead><tr>${cols.map(c => `
    <th data-col="${c.key}" class="${thCls(c.key)}" style="text-align:${c.align}">
      ${c.label}
    </th>`).join('')}</tr></thead>`;

  const tbody = `<tbody>${repos.map(r => {
    const age  = daysOld(r.oldestAlert);
    const stale = age > 90;
    const bars = SEV_ORDER.filter(s => s !== 'unknown').map(s => {
      const pct = Math.round(((r.alertCounts?.[s] ?? 0) / maxAlerts) * 100);
      return pct > 0 ? `<div class="bar-seg" style="width:${pct}%;background:${SEV_COLOR[s]}"></div>` : '';
    }).join('');

    const sevCell = (sev) => {
      const n = r.alertCounts?.[sev] ?? 0;
      return `<td class="sev-cell ${sev} ${n === 0 ? 'zero' : ''}" style="text-align:center">${n || '—'}</td>`;
    };

    const tags = [
      r.isPrivate  ? '<span class="repo-tag">private</span>' : '<span class="repo-tag">public</span>',
      r.language   ? `<span class="repo-tag">${r.language}</span>` : '',
      ...(r.ecosystems ?? []).map(e => `<span class="repo-tag">${e}</span>`),
    ].filter(Boolean).join('');

    return `<tr>
      <td>
        <div class="repo-name">${r.repo}</div>
        <div class="repo-meta">${tags}</div>
        <div class="alert-bar bar-cell" style="margin-top:5px">${bars}</div>
      </td>
      ${sevCell('critical')}
      ${sevCell('high')}
      ${sevCell('medium')}
      ${sevCell('low')}
      <td style="text-align:center;font-weight:600;color:var(--text-bright)">${r.totalAlerts || '—'}</td>
      <td style="text-align:center">${r.openPRs > 0 ? `<span style="font-weight:600;color:var(--blue)">${r.openPRs}</span>` : '—'}</td>
      <td>
        <span class="oldest-chip ${stale ? 'stale' : ''}">
          ${r.oldestAlert ? `${age}d ago` : '—'}
        </span>
      </td>
    </tr>`;
  }).join('')}</tbody>`;

  el('repos-table').innerHTML = thead + tbody;

  // Attach sort handlers
  el('repos-table').querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.asc = !sortState.asc;
      } else {
        sortState.col = col;
        sortState.asc = false;
      }
      renderRepoTable();
    });
  });

  el('repo-count').textContent = repos.length;
}

// ── PR list ───────────────────────────────────────────────────────────────
function renderPRList(filterText = '', filterRepo = '') {
  const allPRs = currentData.repos.flatMap(r =>
    (r.prs ?? []).map(pr => ({ ...pr, repoName: r.repo, repoPrivate: r.isPrivate }))
  );

  // Sort: security first, then by mergeability, then oldest
  allPRs.sort((a, b) => {
    if (a.isSecurityUpdate !== b.isSecurityUpdate) return a.isSecurityUpdate ? -1 : 1;
    const stateOrder = ['clean', 'behind', 'blocked', 'unstable', 'dirty', 'unknown', 'draft'];
    const ai = stateOrder.indexOf(a.mergeableState ?? 'unknown');
    const bi = stateOrder.indexOf(b.mergeableState ?? 'unknown');
    if (ai !== bi) return ai - bi;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const text   = filterText.toLowerCase().trim();
  const filtered = allPRs.filter(pr => {
    if (filterRepo && pr.repoName !== filterRepo) return false;
    if (text && !pr.title.toLowerCase().includes(text) && !pr.repoName.includes(text)) return false;
    return true;
  });

  if (filtered.length === 0) {
    el('prs-list').innerHTML = `
      <div class="state-box">
        <p>${allPRs.length === 0 ? 'No open Dependabot PRs found.' : 'No PRs match your filter.'}</p>
      </div>`;
    el('pr-count').textContent = '0';
    return;
  }

  el('prs-list').innerHTML = filtered.map(pr => {
    const state     = pr.isDraft ? 'draft' : (pr.mergeableState ?? 'unknown');
    const stateCol  = STATE_COLOR[state] ?? 'muted';
    const stateText = STATE_LABEL[state]  ?? state;

    const badges = [
      pr.isSecurityUpdate  ? pill('Security update', 'orange') : '',
      pr.autoMergeEnabled  ? pill('Auto-merge on',   'green')  : '',
      pr.isDependabot      ? '' : pill('External PR', 'muted'),
    ].filter(Boolean).join('');

    const age = daysOld(pr.createdAt);

    return `
      <div class="pr-item">
        <div>
          <div class="pr-title-row">
            <a class="pr-title" href="${pr.url}" target="_blank" rel="noopener">#${pr.number} ${pr.title}</a>
            ${badges}
          </div>
          <div class="pr-meta">
            <span class="pr-repo">${pr.repoName}</span>
            <span class="pr-age">${age === 0 ? 'today' : `${age}d ago`}</span>
          </div>
        </div>
        <div class="pr-status">
          ${pill(stateText, stateCol)}
        </div>
      </div>
    `;
  }).join('');

  el('pr-count').textContent = filtered.length;
}

// ── Repo filter dropdown ───────────────────────────────────────────────────
function populateRepoFilter() {
  const repos = (currentData.repos ?? []).filter(r => r.openPRs > 0).map(r => r.repo).sort();
  const sel = el('repo-filter');
  sel.innerHTML = `<option value="">All repos</option>` +
    repos.map(r => `<option value="${r}">${r}</option>`).join('');
}

// ── Main render ───────────────────────────────────────────────────────────
function render() {
  renderHeader();
  renderSummaryCards();
  renderTrendChart();
  renderWorkEstimate();
  renderRepoTable();
  populateRepoFilter();
  renderPRList();
}

// ── Event wiring ──────────────────────────────────────────────────────────
function wireEvents() {
  const searchInput = el('pr-search');
  const repoSelect  = el('repo-filter');

  function onFilter() {
    renderPRList(searchInput.value, repoSelect.value);
  }

  searchInput.addEventListener('input', onFilter);
  repoSelect.addEventListener('change', onFilter);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
    el('loading-state').classList.add('hidden');
    el('content').classList.remove('hidden');
    render();
    wireEvents();
  } catch (err) {
    el('loading-state').classList.add('hidden');
    el('error-state').classList.remove('hidden');
    el('error-message').textContent = err.message;
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
