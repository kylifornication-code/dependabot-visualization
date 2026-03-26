#!/usr/bin/env node
/**
 * Dependabot Dashboard — Data Collector
 *
 * Fetches open Dependabot alerts and related PRs across all repos the token
 * has access to. Sanitizes output so it is safe to publish on a public site:
 *   INCLUDED:  severity level, package ecosystem, package name, manifest path,
 *              PR status, PR merge state, age, labels
 *   EXCLUDED:  CVE IDs, GHSA IDs, advisory descriptions, CVSS scores,
 *              vulnerable version ranges, advisory references
 *
 * Required env var:
 *   GH_TOKEN  — Personal Access Token with scopes: repo, security_events
 *               (For org repos also add: read:org)
 *
 * Optional env vars:
 *   GITHUB_ORG      — If set, uses the org-level alerts endpoint (faster).
 *   SCAN_ALL_REPOS  — Set to "true" to include repos where you only have push
 *                     access (not admin). Default: admin/maintain only.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'docs', 'data');
const HISTORY_DIR = join(DATA_DIR, 'history');

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('ERROR: GH_TOKEN or GITHUB_TOKEN environment variable is required.');
  console.error('Create a PAT at https://github.com/settings/tokens with scopes: repo, security_events');
  process.exit(1);
}

const ORG = process.env.GITHUB_ORG || '';
const SCAN_ALL = process.env.SCAN_ALL_REPOS === 'true';
const API = 'https://api.github.com';

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dependabot-dashboard-collector/1.0',
};

// ── API helpers ────────────────────────────────────────────────────────────

async function apiFetch(path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const res = await fetch(url.toString(), { headers: HEADERS });

  if (res.status === 403) {
    // 403 often means dependabot is disabled on this repo — skip silently
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function paginate(path, params = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await apiFetch(path, { ...params, per_page: 100, page });
    if (!data || !Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
    // Gentle rate-limit back-off: ~300 req/min well within 5000/hr limit
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

// ── Data sanitizers ────────────────────────────────────────────────────────

/**
 * Strip all vulnerability-specific details. Keep only what's needed to
 * understand severity and which package/manifest is affected.
 */
function sanitizeAlert(alert) {
  return {
    number: alert.number,
    severity:
      alert.security_advisory?.severity ??
      alert.security_vulnerability?.severity ??
      'unknown',
    ecosystem: alert.dependency?.package?.ecosystem ?? 'unknown',
    packageName: alert.dependency?.package?.name ?? 'unknown',
    manifestPath: alert.dependency?.manifest_path ?? null,
    scope: alert.dependency?.scope ?? null, // runtime | development
    createdAt: alert.created_at,
    updatedAt: alert.updated_at,
    // ⚠️  Deliberately omitted: ghsa_id, cve_id, summary, description,
    //     cvss, cwes, identifiers, references, vulnerable_version_range,
    //     first_patched_version, html_url (contains advisory path)
  };
}

function isDependabotPR(pr) {
  if (pr.user?.login === 'dependabot[bot]') return true;
  if (pr.labels?.some(l => l.name === 'dependencies')) return true;
  return /^(Bump |bump |chore[\s([]deps|build[\s([]deps)/i.test(pr.title ?? '');
}

function sanitizePR(pr) {
  return {
    number: pr.number,
    title: pr.title ?? '',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    isDependabot: pr.user?.login === 'dependabot[bot]',
    // Security updates fix a CVE; version bumps are routine maintenance
    isSecurityUpdate: pr.labels?.some(l => l.name === 'security') ?? false,
    autoMergeEnabled: pr.auto_merge != null,
    mergeable: pr.mergeable ?? null,   // null = GitHub hasn't computed it yet
    mergeableState: pr.mergeable_state ?? 'unknown',
    isDraft: pr.draft ?? false,
    labels: (pr.labels ?? []).map(l => l.name),
    url: pr.html_url,
  };
}

// ── Collection strategies ──────────────────────────────────────────────────

async function collectByRepo(repos) {
  const results = [];

  for (const repo of repos) {
    const { owner: { login: owner }, name } = repo;
    process.stdout.write(`  ${owner}/${name} ... `);

    const [rawAlerts, rawPRs] = await Promise.all([
      paginate(`/repos/${owner}/${name}/dependabot/alerts`, { state: 'open' }),
      paginate(`/repos/${owner}/${name}/pulls`, { state: 'open' }),
    ]);

    const alerts = (rawAlerts ?? []).map(sanitizeAlert);
    const prs = (rawPRs ?? []).filter(isDependabotPR).map(sanitizePR);

    console.log(`${alerts.length} alerts, ${prs.length} PRs`);

    if (alerts.length > 0 || prs.length > 0) {
      results.push({ owner, name, repo, alerts, prs });
    }
  }

  return results;
}

async function collectByOrg(org) {
  console.log(`Fetching org-level alerts for ${org} ...`);
  const rawAlerts = await paginate(`/orgs/${org}/dependabot/alerts`, { state: 'open' });

  // Group alerts by repo
  const byRepo = new Map();
  for (const alert of rawAlerts ?? []) {
    const key = alert.repository?.full_name;
    if (!key) continue;
    if (!byRepo.has(key)) {
      byRepo.set(key, { repo: alert.repository, alerts: [], prs: [] });
    }
    byRepo.get(key).alerts.push(sanitizeAlert(alert));
  }

  // Fetch open PRs per affected repo
  const results = [];
  for (const [fullName, entry] of byRepo) {
    const [owner, name] = fullName.split('/');
    process.stdout.write(`  ${fullName} ... `);
    const rawPRs = await paginate(`/repos/${owner}/${name}/pulls`, { state: 'open' });
    entry.prs = (rawPRs ?? []).filter(isDependabotPR).map(sanitizePR);
    console.log(`${entry.alerts.length} alerts, ${entry.prs.length} PRs`);
    results.push({ owner, name, ...entry });
  }

  return results;
}

// ── Aggregation ────────────────────────────────────────────────────────────

function aggregateRepo({ owner, name, repo, alerts, prs }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const a of alerts) {
    const key = a.severity in counts ? a.severity : 'unknown';
    counts[key]++;
  }

  const ecosystems = [...new Set(alerts.map(a => a.ecosystem).filter(e => e !== 'unknown'))];
  const oldestAlert = alerts
    .map(a => a.createdAt)
    .sort()[0] ?? null;

  // Sort PRs: security updates first, then by oldest
  prs.sort((a, b) => {
    if (a.isSecurityUpdate !== b.isSecurityUpdate) return a.isSecurityUpdate ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  return {
    repo: `${owner}/${name}`,
    name,
    owner,
    isPrivate: repo?.private ?? false,
    language: repo?.language ?? null,
    alertCounts: counts,
    totalAlerts: alerts.length,
    openPRs: prs.length,
    prs,
    ecosystems,
    oldestAlert,
  };
}

function riskScore(r) {
  return r.alertCounts.critical * 10000
    + r.alertCounts.high    * 1000
    + r.alertCounts.medium  * 10
    + r.alertCounts.low;
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Dependabot Dashboard — Data Collector      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const user = await apiFetch('/user');
  if (!user) throw new Error('Authentication failed. Is GH_TOKEN valid?');
  console.log(`Authenticated as: ${user.login}\n`);

  let rawResults;

  if (ORG) {
    rawResults = await collectByOrg(ORG);
  } else {
    const repos = await paginate('/user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      type: 'all',
    });

    const scannable = repos.filter(r => {
      if (r.archived) return false;
      if (SCAN_ALL) return true;
      return r.permissions?.admin || r.permissions?.maintain;
    });

    console.log(`Found ${repos.length} repos total, scanning ${scannable.length}\n`);
    rawResults = await collectByRepo(scannable);
  }

  // Aggregate and sort by risk
  const repoData = rawResults.map(aggregateRepo).sort((a, b) => riskScore(b) - riskScore(a));

  // Global totals
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const r of repoData) {
    for (const [sev, n] of Object.entries(r.alertCounts)) {
      bySeverity[sev] = (bySeverity[sev] || 0) + n;
    }
  }
  const totalAlerts    = Object.values(bySeverity).reduce((s, n) => s + n, 0);
  const totalOpenPRs   = repoData.reduce((s, r) => s + r.openPRs, 0);
  const reposAffected  = repoData.filter(r => r.totalAlerts > 0).length;
  const reposWithPRs   = repoData.filter(r => r.openPRs > 0).length;

  const generatedAt = new Date().toISOString();
  const date = generatedAt.split('T')[0];

  const snapshot = {
    generatedAt,
    summary: {
      totalAlerts,
      bySeverity,
      totalOpenPRs,
      reposAffected,
      reposWithPRs,
      reposScanned: repoData.length,
    },
    repos: repoData,
  };

  const historyEntry = {
    date,
    generatedAt,
    totalAlerts,
    bySeverity,
    totalOpenPRs,
    reposAffected,
  };

  // Write output
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(HISTORY_DIR, { recursive: true });

  writeFileSync(join(DATA_DIR, 'current.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(HISTORY_DIR, `${date}.json`), JSON.stringify(historyEntry, null, 2));

  // Maintain rolling history index (365 days)
  const indexPath = join(DATA_DIR, 'history-index.json');
  let index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf-8'))
    : [];
  index = index.filter(e => e.date !== date);
  index.push(historyEntry);
  index.sort((a, b) => a.date.localeCompare(b.date));
  if (index.length > 365) index = index.slice(-365);
  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  // Summary
  console.log('\n──────────────────────────────────────────────');
  console.log('Results');
  console.log('──────────────────────────────────────────────');
  console.log(`Total open alerts : ${totalAlerts}`);
  console.log(`  Critical        : ${bySeverity.critical}`);
  console.log(`  High            : ${bySeverity.high}`);
  console.log(`  Medium          : ${bySeverity.medium}`);
  console.log(`  Low             : ${bySeverity.low}`);
  console.log(`Open PRs          : ${totalOpenPRs}`);
  console.log(`Repos affected    : ${reposAffected} / ${repoData.length}`);
  console.log('\nOutput written to:');
  console.log('  docs/data/current.json');
  console.log(`  docs/data/history/${date}.json`);
  console.log('  docs/data/history-index.json');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
