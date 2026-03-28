#!/usr/bin/env node
/**
 * Dependabot Dashboard — Data Collector
 *
 * Fetches open Dependabot alerts and related PRs across all repos the token
 * has access to. Sanitizes output so it is safe to publish on a public site:
 *   INCLUDED:  severity level, package ecosystem, package name, manifest path,
 *              PR age, labels, Dependabot compatibility score (aggregate % from
 *              public dependabot-badges.githubapp.com, same source as GitHub’s UI)
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

/** Parse GitHub `Link` response header into rel → URL map. */
function parseLinkHeader(linkHeader) {
  const links = {};
  if (!linkHeader) return links;
  const re = /<([^>]+)>;\s*rel="([^"]+)"/g;
  let m;
  while ((m = re.exec(linkHeader)) !== null) links[m[2]] = m[1];
  return links;
}

/**
 * Cursor pagination (after / Link rel="next"). Required for Dependabot alerts —
 * offset `page` pagination is not supported on those endpoints.
 */
async function paginateCursor(path, params = {}) {
  const all = [];
  let url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  for (const [k, v] of Object.entries({ ...params, per_page: 100 })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  while (true) {
    const res = await fetch(url.toString(), { headers: HEADERS });

    if (res.status === 403) return all.length ? all : null;
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);

    const next = parseLinkHeader(res.headers.get('link')).next;
    if (!next) break;
    url = new URL(next);
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
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

// ── Dependabot compatibility scores (public badge SVG, same as dependabot/fetch-metadata) ──

const COMPAT_BADGE_RE = /https:\/\/dependabot-badges\.githubapp\.com\/badges\/compatibility_score\?[^\s)\]>"']+/gi;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCompatBadgeSvg(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dependabot-dashboard-collector/1.0' },
  });
  if (!res.ok) return null;
  return res.text();
}

function scoreFromCompatSvg(svg) {
  const m = svg?.match(/compatibility:\s*(\d+)%/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractCompatBadgeUrls(body) {
  if (!body) return [];
  const found = body.match(COMPAT_BADGE_RE) ?? [];
  return [...new Set(found)];
}

async function scoresFromBadgeUrls(urls) {
  const scores = [];
  for (const url of urls) {
    const svg = await fetchCompatBadgeSvg(url);
    const s = scoreFromCompatSvg(svg);
    if (s != null && s > 0) scores.push(s);
    await sleep(80);
  }
  return scores;
}

function ecosystemFromHeadRef(ref) {
  if (!ref || ref.length < 11 || !ref.startsWith('dependabot')) return null;
  const delim = ref[9];
  const parts = ref.split(delim);
  return parts[1] || null;
}

function extractYamlFrontMatter(message) {
  const m = message.match(/^---\r?\n([\s\S]*?)\r?\n\.\.\.\r?\n/m);
  return m ? m[1] : null;
}

function parseBumpLine(message) {
  const m = message.match(/^Bumps (.+?) from (v?\S+) to (v?\S+)\.\s*$/m);
  if (m) return { name: m[1].trim(), from: m[2].trim(), to: m[3].trim() };
  const m2 = message.match(/^Update (.+?) requirement from \S*? ?(v?\S*) to \S*? ?(v?\S*)\s*$/m);
  if (m2) return { name: m2[1].trim(), from: m2[2].trim(), to: m2[3].trim() };
  return null;
}

function parseUpdatesLines(message) {
  const map = new Map();
  const re = /^Updates `([^`]+)`(?: from (\S+) )?to (\S+)\s*$/gm;
  let x;
  while ((x = re.exec(message)) !== null) {
    map.set(x[1].trim(), { from: (x[2] || '').trim(), to: x[3].trim() });
  }
  return map;
}

function parseUpdatedDependenciesYaml(yml) {
  const lines = yml.split(/\r?\n/);
  const deps = [];
  for (let i = 0; i < lines.length; i++) {
    const lm = lines[i].match(/^\s*-\s*dependency-name:\s*(.+)$/);
    if (!lm) continue;
    const name = lm[1].trim();
    let nextVersion = '';
    for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
      const vm = lines[j].match(/^\s*dependency-version:\s*(.+)$/);
      if (vm) {
        nextVersion = vm[1].trim();
        break;
      }
    }
    if (name && nextVersion) deps.push({ name, nextVersion });
  }
  return deps;
}

function attachPrevVersions(deps, bump, updatesMap) {
  for (const d of deps) {
    const u = updatesMap.get(d.name);
    if (u?.from) d.prevVersion = u.from;
  }
  if (deps.length === 1 && bump) {
    const d0 = deps[0];
    if (!d0.prevVersion) d0.prevVersion = bump.from;
    if (!d0.nextVersion && bump.to) d0.nextVersion = bump.to;
  }
}

async function scoresFromCommitMetadata(owner, name, pr) {
  const commits = await apiFetch(`/repos/${owner}/${name}/pulls/${pr.number}/commits`, {});
  const msg = commits?.[0]?.commit?.message;
  if (!msg) return [];

  const head = pr.head?.ref ?? '';
  const pkgMgr = ecosystemFromHeadRef(head);
  if (!pkgMgr) return [];

  const yaml = extractYamlFrontMatter(msg);
  const bump = parseBumpLine(msg);
  const updatesMap = parseUpdatesLines(msg);

  let deps = [];
  if (yaml?.includes('updated-dependencies:')) {
    deps = parseUpdatedDependenciesYaml(yaml);
    attachPrevVersions(deps, bump, updatesMap);
  }
  if (deps.length === 0 && bump) {
    deps = [{ name: bump.name, prevVersion: bump.from, nextVersion: bump.to }];
  }

  const scores = [];
  for (const d of deps) {
    if (!d.prevVersion || !d.nextVersion || !d.name) continue;
    const q = new URLSearchParams({
      'dependency-name': d.name,
      'package-manager': pkgMgr,
      'previous-version': d.prevVersion,
      'new-version': d.nextVersion,
    });
    const url = `https://dependabot-badges.githubapp.com/badges/compatibility_score?${q}`;
    const svg = await fetchCompatBadgeSvg(url);
    const s = scoreFromCompatSvg(svg);
    if (s != null && s > 0) scores.push(s);
    await sleep(100);
  }
  return scores;
}

function summarizeCompatScores(scores) {
  const valid = scores.filter(s => typeof s === 'number' && s > 0);
  if (valid.length === 0) return { display: null, min: null, max: null };
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  if (lo === hi) return { display: `${lo}%`, min: lo, max: hi };
  return { display: `${lo}–${hi}%`, min: lo, max: hi };
}

async function resolvePRCompatibility(owner, name, pr) {
  const fromBody = await scoresFromBadgeUrls(extractCompatBadgeUrls(pr.body));
  if (fromBody.length > 0) return summarizeCompatScores(fromBody);
  const fromCommit = await scoresFromCommitMetadata(owner, name, pr);
  return summarizeCompatScores(fromCommit);
}

function sanitizePR(pr, compat = { display: null, min: null, max: null }) {
  return {
    number: pr.number,
    title: pr.title ?? '',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    isDependabot: pr.user?.login === 'dependabot[bot]',
    isSecurityUpdate: pr.labels?.some(l => l.name === 'security') ?? false,
    autoMergeEnabled: pr.auto_merge != null,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? 'unknown',
    isDraft: pr.draft ?? false,
    labels: (pr.labels ?? []).map(l => l.name),
    url: pr.html_url,
    compatibilityDisplay: compat.display,
    compatibilityMin: compat.min,
    compatibilityMax: compat.max,
  };
}

async function enrichDependabotPRs(owner, name, rawPRs) {
  const list = (rawPRs ?? []).filter(isDependabotPR);
  const out = [];
  for (const pr of list) {
    const compat = await resolvePRCompatibility(owner, name, pr);
    out.push(sanitizePR(pr, compat));
    await sleep(40);
  }
  return out;
}

// ── Collection strategies ──────────────────────────────────────────────────

async function collectByRepo(repos) {
  const results = [];

  for (const repo of repos) {
    const { owner: { login: owner }, name } = repo;
    process.stdout.write(`  ${owner}/${name} ... `);

    const [rawAlerts, rawPRs] = await Promise.all([
      paginateCursor(`/repos/${owner}/${name}/dependabot/alerts`, { state: 'open' }),
      paginate(`/repos/${owner}/${name}/pulls`, { state: 'open' }),
    ]);

    const alerts = (rawAlerts ?? []).map(sanitizeAlert);
    const prs = await enrichDependabotPRs(owner, name, rawPRs);

    console.log(`${alerts.length} alerts, ${prs.length} PRs`);

    if (alerts.length > 0 || prs.length > 0) {
      results.push({ owner, name, repo, alerts, prs });
    }
  }

  return results;
}

async function collectByOrg(org) {
  console.log(`Fetching org-level alerts for ${org} ...`);
  const rawAlerts = await paginateCursor(`/orgs/${org}/dependabot/alerts`, { state: 'open' });

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
    entry.prs = await enrichDependabotPRs(owner, name, rawPRs);
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

  const byEcosystem = {};
  for (const row of rawResults) {
    for (const a of row.alerts ?? []) {
      const eco = a.ecosystem && a.ecosystem !== 'unknown' ? a.ecosystem : 'other';
      byEcosystem[eco] = (byEcosystem[eco] || 0) + 1;
    }
  }

  const generatedAt = new Date().toISOString();
  const date = generatedAt.split('T')[0];

  const snapshot = {
    generatedAt,
    summary: {
      totalAlerts,
      bySeverity,
      byEcosystem,
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
