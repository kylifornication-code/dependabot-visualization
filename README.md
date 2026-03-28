# Dependabot visualization

A static **Dependabot Alert Insights** dashboard that summarizes open dependency security alerts across your GitHub repositories. Data is collected with a Node script, committed to this repo, and published with **GitHub Pages** via GitHub Actions.

## What it does

- **Collects** open Dependabot alerts and related open pull requests from the GitHub API (public repositories only; private repos are never scanned).
- **Writes** JSON snapshots under `docs/data/` (`current.json`, per-day history files, and a rolling `history-index.json` for trends).
- **Renders** a client-side dashboard (`docs/index.html`) with Chart.js: severity and ecosystem breakdowns, open-alert counts, a repo table, a trend line over time, and a searchable list of open Dependabot PRs.

The collector is designed so the published site avoids leaking sensitive advisory detail: it keeps severity, ecosystem, package name, manifest path, PR metadata, labels, and Dependabot compatibility-style signals, and **does not** publish CVE/GHSA identifiers, advisory text, CVSS, or vulnerable version ranges.

## Repository layout

| Path | Purpose |
|------|---------|
| `scripts/collect.mjs` | Fetches and aggregates data; requires `GH_TOKEN` or `GITHUB_TOKEN` |
| `docs/` | GitHub Pages site: HTML, CSS, JS, and `docs/data/*.json` |
| `.github/workflows/collect-data.yml` | Scheduled + manual workflow: run collector, commit data, deploy Pages |

## Setup (GitHub Actions + Pages)

1. Create a [Personal Access Token](https://github.com/settings/tokens) with scopes **`repo`** and **`security_events`**. If you scan organization repositories, add **`read:org`**.
2. Add the token as a repository secret named **`GH_TOKEN`** (Settings → Secrets and variables → Actions).
3. Enable **GitHub Pages** with source **GitHub Actions** (Settings → Pages).
4. *(Optional)* Set an Actions variable **`GITHUB_ORG`** to use the org-level alerts flow, or pass an org when running the workflow manually.
5. *(Optional)* Set **`SCAN_ALL_REPOS=true`** in the workflow env if you want to include public repos where you have push access but not admin/maintain (default is admin/maintain only).

The workflow runs on a **daily schedule** (06:00 UTC) and supports **workflow_dispatch** so you can refresh data on demand.

## Local collection

Requires Node.js 20+ (same as the workflow).

```bash
export GH_TOKEN=ghp_...   # or GITHUB_TOKEN
# Optional:
# export GITHUB_ORG=my-org
# export SCAN_ALL_REPOS=true

node scripts/collect.mjs
```

Outputs are written to `docs/data/`.

## License

MIT — see [LICENSE](LICENSE).
