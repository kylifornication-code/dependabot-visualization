/* ── Dependabot Alert Insights — dashboard ─────────────────────────────── */

let currentData = null;
let historyData = [];
let chartSeverity = null;
let chartEcosystem = null;
let trendChart = null;
let sortState = { col: 'totalAlerts', asc: false };

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_COLOR = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#eab308',
};
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

const ECO_COLORS = {
  npm: '#38bdf8',
  pip: '#4f46e5',
  composer: '#9333ea',
  nuget: '#0d9488',
  go: '#0284c7',
  maven: '#ea580c',
  rubygems: '#e11d48',
  rust: '#57534e',
  pub: '#16a34a',
  actions: '#64748b',
  other: '#94a3b8',
};

/** CSS class for Dependabot compatibility % (uses worst score when a range is shown). */
function compatPillClass(pr) {
  const n = pr.compatibilityMin;
  if (n == null) return 'muted';
  if (n >= 90) return 'compat-high';
  if (n >= 70) return 'compat-mid';
  return 'compat-low';
}

function compatPillLabel(pr) {
  if (pr.compatibilityDisplay) return `Compat ${pr.compatibilityDisplay}`;
  return 'No compatibility data';
}

function el(id) {
  return document.getElementById(id);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
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

function healthClass(summary) {
  if (summary.bySeverity.critical > 0) return 'critical';
  if (summary.bySeverity.high > 0) return 'high';
  if (summary.bySeverity.medium > 0) return 'medium';
  if (summary.bySeverity.low > 0) return 'low';
  return 'healthy';
}

/** Fallback when `summary.byEcosystem` is missing (older snapshots). */
function getByEcosystem(summary, repos) {
  if (summary.byEcosystem && Object.keys(summary.byEcosystem).length > 0) return { ...summary.byEcosystem };
  const m = {};
  for (const r of repos) {
    const ecs = (r.ecosystems ?? []).filter(e => e && e !== 'unknown');
    const n = r.totalAlerts;
    if (n === 0) continue;
    if (ecs.length === 0) {
      m.other = (m.other || 0) + n;
      continue;
    }
    const share = n / ecs.length;
    for (const e of ecs) m[e] = (m[e] || 0) + share;
  }
  for (const k of Object.keys(m)) m[k] = Math.round(m[k]);
  return m;
}

function ecoColor(name) {
  const key = (name || '').toLowerCase();
  return ECO_COLORS[key] ?? ECO_COLORS.other;
}

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

function destroyCharts() {
  if (chartSeverity) {
    chartSeverity.destroy();
    chartSeverity = null;
  }
  if (chartEcosystem) {
    chartEcosystem.destroy();
    chartEcosystem = null;
  }
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
}

function renderHeader() {
  const { summary, generatedAt } = currentData;
  const cls = healthClass(summary);
  const label = {
    healthy: 'Healthy',
    low: 'Low risk',
    medium: 'Medium risk',
    high: 'High risk',
    critical: 'Critical',
  }[cls];

  el('health-badge').className = `badge badge-${cls}`;
  el('health-badge').textContent = label;
  el('last-updated').textContent = `Updated ${timeAgo(generatedAt)} · ${formatDate(generatedAt)}`;
}

function renderFixedAndOpenCards() {
  const total = currentData.summary.totalAlerts;
  el('open-alerts-total').textContent = total;

  const fixedEl = el('fixed-count');
  const hintEl = el('fixed-hint');
  if (!historyData || historyData.length < 2) {
    fixedEl.textContent = '—';
    hintEl.textContent = 'Net reduction shows after two or more collector runs';
    return;
  }
  const prev = historyData[historyData.length - 2];
  const delta = (prev.totalAlerts ?? 0) - total;
  const cleared = Math.max(0, delta);
  fixedEl.textContent = cleared;
  hintEl.textContent = delta > 0 ? 'Fewer open alerts than last snapshot' : delta === 0 ? 'Unchanged since last snapshot' : 'More open alerts than last snapshot';
}

function renderSeverityDonut() {
  const s = currentData.summary.bySeverity;
  const values = SEV_ORDER.map(k => s[k] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  el('sev-total').textContent = total;

  const labels = SEV_ORDER.map(k => SEV_LABEL[k]);
  const colors = SEV_ORDER.map(k => SEV_COLOR[k]);

  el('legend-severity').innerHTML = SEV_ORDER.map((k, i) => `
    <li><span class="legend-swatch" style="background:${colors[i]}"></span>${labels[i]}</li>
  `).join('');

  const ctx = el('chart-severity').getContext('2d');
  if (chartSeverity) chartSeverity.destroy();

  const data = total === 0 ? [1] : values;
  const bg = total === 0 ? ['#e2e8f0'] : colors;
  const lbl = total === 0 ? ['No open alerts'] : labels;

  chartSeverity = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: lbl,
      datasets: [{
        data,
        backgroundColor: bg,
        borderWidth: total === 0 ? 0 : 2,
        borderColor: '#ffffff',
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: total > 0,
          callbacks: {
            label(ctx) {
              const v = ctx.raw;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return ` ${ctx.label}: ${v} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function renderEcosystemDonut() {
  const raw = getByEcosystem(currentData.summary, currentData.repos ?? []);
  const entries = Object.entries(raw).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  el('eco-total').textContent = total;

  el('legend-ecosystem').innerHTML = entries.map(([name]) => `
    <li><span class="legend-swatch" style="background:${ecoColor(name)}"></span>${name}</li>
  `).join('');

  const ctx = el('chart-ecosystem').getContext('2d');
  if (chartEcosystem) chartEcosystem.destroy();

  const labels = entries.length ? entries.map(([n]) => n) : ['None'];
  const values = entries.length ? entries.map(([, v]) => v) : [1];
  const colors = entries.length ? entries.map(([n]) => ecoColor(n)) : ['#e2e8f0'];

  chartEcosystem = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: entries.length ? 2 : 0,
        borderColor: '#ffffff',
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: entries.length > 0,
          callbacks: {
            label(ctx) {
              const v = ctx.raw;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return ` ${ctx.label}: ${v} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function renderTrendChart() {
  const wrap = document.querySelector('.chart-container--trend');
  if (!wrap) return;

  if (historyData.length === 0) {
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
    wrap.innerHTML = '<p class="state-box" style="padding:48px 16px">Historical data appears after the collector has run on more than one day.</p>';
    return;
  }

  if (!el('trend-chart')) {
    wrap.innerHTML = '<canvas id="trend-chart"></canvas>';
  }
  const ctx = el('trend-chart').getContext('2d');

  const recent = historyData.slice(-90);
  const labels = recent.map(e => {
    const [, mo, d] = e.date.split('-');
    return `${parseInt(mo, 10)}/${parseInt(d, 10)}`;
  });
  const totals = recent.map(e => e.totalAlerts ?? 0);

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Open alerts',
        data: totals,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: recent.length > 20 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: '#2563eb',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: '#64748b',
            boxWidth: 12,
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#f8fafc',
          bodyColor: '#e2e8f0',
          borderColor: '#334155',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', maxTicksLimit: 12, font: { size: 11 } },
        },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { size: 11 }, precision: 0 },
          beginAtZero: true,
        },
      },
    },
  });
}

function renderRepoTable() {
  let repos = (currentData.repos ?? []).filter(r => r.totalAlerts > 0);

  repos.sort((a, b) => {
    let va = a[sortState.col] ?? 0;
    let vb = b[sortState.col] ?? 0;
    if (sortState.col === 'repo') {
      va = a.repo.toLowerCase();
      vb = b.repo.toLowerCase();
    }
    if (va < vb) return sortState.asc ? -1 : 1;
    if (va > vb) return sortState.asc ? 1 : -1;
    return 0;
  });

  const cols = [
    { key: 'repo', label: 'Repository', align: 'left' },
    { key: 'totalAlerts', label: 'Severity', align: 'left' },
    { key: 'openPRs', label: 'State', align: 'left' },
  ];

  function thCls(key) {
    if (sortState.col !== key) return '';
    return sortState.asc ? 'sort-asc' : 'sort-desc';
  }

  const thead = `<thead><tr>${cols.map(c => `
    <th data-col="${c.key}" class="${thCls(c.key)}" style="text-align:${c.align}">${c.label}</th>`).join('')}</tr></thead>`;

  const tbody = repos.length === 0
    ? '<tbody><tr><td colspan="3" style="text-align:center;padding:28px;color:var(--text-muted)">No repositories with open alerts.</td></tr></tbody>'
    : `<tbody>${repos.map(r => {
      const t = r.totalAlerts || 1;
      const segs = SEV_ORDER.map(s => {
        const n = r.alertCounts?.[s] ?? 0;
        if (n === 0) return '';
        const pct = (n / t) * 100;
        return `<div class="bar-stack-seg" style="width:${pct}%;background:${SEV_COLOR[s]}"></div>`;
      }).join('');

      const prRatio = r.totalAlerts > 0 ? Math.min(100, (r.openPRs / r.totalAlerts) * 100) : 0;
      const stateText = r.openPRs > 0
        ? `${r.openPRs} open PR${r.openPRs !== 1 ? 's' : ''}`
        : 'No open PRs';

      const ghUrl = `https://github.com/${r.owner}/${r.name}`;
      return `<tr>
        <td>
          <a class="repo-name" href="${ghUrl}" target="_blank" rel="noopener">${r.name}</a>
          <span class="repo-count-pill">${r.totalAlerts}</span>
        </td>
        <td><div class="bar-stack">${segs || '<div class="bar-stack-seg" style="width:100%;background:#e2e8f0"></div>'}</div></td>
        <td>
          <div class="state-bar-wrap">
            <div class="state-bar"><div class="state-bar-fill" style="width:${prRatio}%"></div></div>
            <div class="state-label">${stateText}</div>
          </div>
        </td>
      </tr>`;
    }).join('')}</tbody>`;

  el('repos-table').innerHTML = thead + tbody;
  el('repo-results-count').textContent = String(repos.length);

  el('repos-table').querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortState.col === col) sortState.asc = !sortState.asc;
      else {
        sortState.col = col;
        sortState.asc = col === 'repo';
      }
      renderRepoTable();
    });
  });
}

function renderPRList(filterText = '', filterRepo = '') {
  const allPRs = currentData.repos.flatMap(r =>
    (r.prs ?? []).map(pr => ({ ...pr, repoName: r.repo, repoPrivate: r.isPrivate })),
  );

  allPRs.sort((a, b) => {
    if (a.isSecurityUpdate !== b.isSecurityUpdate) return a.isSecurityUpdate ? -1 : 1;
    const ca = a.compatibilityMin;
    const cb = b.compatibilityMin;
    if (ca != null && cb != null && ca !== cb) return cb - ca;
    if (ca != null && cb == null) return -1;
    if (ca == null && cb != null) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const text = filterText.toLowerCase().trim();
  const filtered = allPRs.filter(pr => {
    if (filterRepo && pr.repoName !== filterRepo) return false;
    if (text && !pr.title.toLowerCase().includes(text) && !pr.repoName.includes(text)) return false;
    return true;
  });

  if (filtered.length === 0) {
    el('prs-list').innerHTML = `
      <div class="state-box" style="padding:24px 0">
        <p>${allPRs.length === 0 ? 'No open Dependabot PRs found.' : 'No PRs match your filter.'}</p>
      </div>`;
    el('pr-count').textContent = '0';
    return;
  }

  el('prs-list').innerHTML = filtered.map(pr => {
    const badges = [
      pr.isSecurityUpdate ? pill('Security update', 'orange') : '',
      pr.autoMergeEnabled ? pill('Auto-merge on', 'green') : '',
      pr.isDependabot ? '' : pill('External PR', 'muted'),
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
        <div class="pr-status">${pill(compatPillLabel(pr), compatPillClass(pr))}</div>
      </div>`;
  }).join('');

  el('pr-count').textContent = String(filtered.length);
}

function populateRepoFilter() {
  const repos = (currentData.repos ?? []).filter(r => r.openPRs > 0).map(r => r.repo).sort();
  const sel = el('repo-filter');
  sel.innerHTML = '<option value="">All repos</option>'
    + repos.map(r => `<option value="${r}">${r}</option>`).join('');
}

function render() {
  destroyCharts();
  renderHeader();
  renderFixedAndOpenCards();
  renderSeverityDonut();
  renderEcosystemDonut();
  renderTrendChart();

  renderRepoTable();
  populateRepoFilter();
  renderPRList();
}

function wireEvents() {
  const searchInput = el('pr-search');
  const repoSelect = el('repo-filter');

  function onFilter() {
    renderPRList(searchInput.value, repoSelect.value);
  }

  searchInput.addEventListener('input', onFilter);
  repoSelect.addEventListener('change', onFilter);

  el('btn-refresh').addEventListener('click', () => window.location.reload());
  el('btn-reload-table').addEventListener('click', () => {
    renderRepoTable();
  });
}

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
