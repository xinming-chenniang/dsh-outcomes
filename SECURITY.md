# Security policy

## What this package touches

`dsh-outcomes` records **paths and metadata** about deliverables. It never moves, copies, uploads or
deletes a file, and it does not read file contents (it only `stat`s them to report existence).
The full inventory — which paths are read, which are written, what leaves the machine (nothing) — is in
[`docs/CAPABILITY-DISCLOSURE.md`](docs/CAPABILITY-DISCLOSURE.md). Read that first; it is the contract.

Short version:

- Writes: `$DSH_HOME/plugin-data/dsh-outcomes/*.jsonl` (registry + deleted log + `.bak`).
- Reads: the files you registered (existence only), plus `$DSH_HOME/.dsh-outcomes.json` for config.
- Network: **none**. No telemetry, no update check, no outbound requests.
- Listens: nothing new — the HTTP routes ride on DSH's own loopback web server.

## Threat model (what this package does and does not defend against)

| In scope | Out of scope |
|---|---|
| A registered **web page** trying to reach your DSH session when you preview it | Malware already running as your user |
| **Cross-site / accidental writes** to the registry (write guard header + loopback-only routes) | Someone with access to your unlocked machine |
| A **path traversal** attempt on the file route (URL carries only `id` + index; paths come from the registry) | People you gave your DSH port to (the routes have no authentication — see below) |
| A malicious **registered file name** (no shell interpolation anywhere; content-disposition is sanitised) | Data at rest (delete the registry and it is gone — it is a plain JSONL file) |

**Known, deliberate trade-off: the routes are not authenticated.** They are served by DSH's own web server
and are exactly as reachable as the DSH UI itself. If you expose DSH beyond loopback, put authentication in
front of it (reverse proxy) — this plugin does not add its own.

## Reporting a vulnerability

Open a private security advisory on the repository, or — if that is not available — an issue that says only
"security report, please contact me" and wait for a reply before posting details. Please include:
version (`package.json`), platform, the request or tool call that triggers it, and what you expected.

Expect an acknowledgement within a few days. There is no bounty.

## Supported versions

The latest published `0.x` release. Pre-1.0, fixes land on `main` and ship in the next patch release.
