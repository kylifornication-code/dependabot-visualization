# Obsidian Integration

This project includes a script that generates Obsidian-compatible markdown notes from your collected Dependabot data — the same information as the web dashboard, readable and navigable inside your vault.

## What gets generated

Running `scripts/generate-obsidian.mjs` writes the following into your vault:

```
{vault}/Security/Dependabot/
├── Dashboard.md          # Summary: total alerts, severity breakdown, repo table
├── {owner} — {repo}.md  # One note per repo: alerts by severity, open PRs table
└── ...
```

Each note includes YAML frontmatter (total alerts, severity counts, timestamps) so the data is queryable if you use the Dataview plugin. All notes link back to each other via wikilinks.

---

## Setup

### 1. Configure your vault path

By default the script targets `~/Documents/KJ Smoketower`. To point it at a different vault, set the `OBSIDIAN_VAULT` environment variable:

```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
node scripts/generate-obsidian.mjs
```

Or add it to a `.env` file and source it before running.

---

### 2. Run it once manually to verify

```bash
node scripts/generate-obsidian.mjs
```

You should see output like:

```
✓ Dashboard.md
✓ owner — repo-name.md
...
Wrote N notes to: /path/to/vault/Security/Dependabot
```

Open Obsidian — the `Security/Dependabot/` folder will be in your file explorer.

---

### 3. Set up the Shell Commands plugin for in-app refresh

The [Shell Commands](https://github.com/Taitava/obsidian-shellcommands) plugin lets you run the generator directly from Obsidian's command palette without opening a terminal.

#### Install the plugin

**Option A — via Obsidian UI (recommended):**
1. Open Obsidian → Settings → Community plugins
2. Turn off **Restricted Mode**
3. Click **Browse**, search for **Shell commands**, install and enable it

**Option B — manual install:**
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Taitava/obsidian-shellcommands/releases/latest)
2. Place them in `{vault}/.obsidian/plugins/obsidian-shellcommands/`
3. In Obsidian: Settings → Community plugins → turn off Restricted Mode → enable Shell commands

#### Configure the command

After installing, create a new shell command in the plugin settings:

| Field | Value |
|---|---|
| **Command** | `node scripts/generate-obsidian.mjs` |
| **Working directory** | `/path/to/dependabot-visualization` |
| **Alias** | `Refresh Dependabot Notes` |
| **Output: stdout** | Notification |

Save, then open the command palette (`Cmd+P` / `Ctrl+P`) and search **"Execute: Refresh Dependabot Notes"**.

---

### 4. (Optional) Auto-refresh after data collection

To refresh Obsidian notes every time you run the data collector, update your local workflow:

```bash
# Run both together
export GH_TOKEN=ghp_...
node scripts/collect.mjs && node scripts/generate-obsidian.mjs
```

Or add an npm script to `package.json`:

```json
{
  "scripts": {
    "refresh": "node scripts/collect.mjs && node scripts/generate-obsidian.mjs"
  }
}
```

Then just run `npm run refresh`.

---

## Note format

### Dashboard.md

```markdown
---
generated: "2026-04-13T08:17:58.944Z"
total_alerts: 16
critical: 0
high: 9
medium: 7
low: 0
open_prs: 7
repos_affected: 3
repos_scanned: 3
tags: [security, dependabot, dashboard]
---

# Dependabot Dashboard
...
```

### Per-repo notes

```markdown
---
repo: "owner/repo-name"
language: "TypeScript"
total_alerts: 10
critical: 0
high: 6
medium: 4
low: 0
open_prs: 6
generated: "..."
tags: [security, dependabot, repo]
---

# repo-name
...
```

---

## Requirements

- Node.js 20+
- Obsidian desktop (mobile vaults work if the path is accessible, but the shell command requires desktop)
- Shell Commands plugin v0.21.0+
