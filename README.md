# FileSharer

Internal file sharing with a built-in Markdown viewer/editor.
Upload and download files in personal/team/org spaces, view & edit Markdown side-by-side
(source | rendered), and hand any file or folder to a VM with a single command:

```bash
curl -fsSL https://<host>/s/<token>/get | sh
```

## Stack

FastAPI + SQLite (metadata) · React/Vite (SPA) · single Docker image behind Caddy.
All state lives in one `/data` volume (blobs + SQLite).

## Development

```bash
cp .env.example .env      # fill in values (never committed)
make bootstrap            # venv + node_modules
make dev                  # uvicorn --reload (8642) + vite dev (5173)
make test                 # backend ruff + pytest (same as CI)
make prod-check           # build the prod image and smoke-test via compose (8484)
```

## 서버(헤드리스) 업로드 — Server-side upload

Push files into FileSharer from a headless server (cloud/IDC) with no browser, authenticated
by an API token (`Authorization: Bearer <token>`). This is the "push" counterpart to the
share one-liner above.

**1) Get a temp token** (in the web UI): open the files screen, click **서버 업로드** (next to
다운로드 / 공유 링크; also in the editor toolbar when a file is open), then click **🔑 임시 토큰
발급**. A short-lived token (default **10 minutes**, scoped to the folder/space you're viewing) is
issued and auto-filled into the curl one-liner below — no token-management page to visit. The
plaintext is shown **once only** — the server stores just a scrypt hash. Token format is
`fsk_<id>.<secret>`. **One temp token can push several files within its window**, then it just
expires (nothing to clean up). For unattended automation, mint a longer-lived token directly via
`POST /api/tokens` (`expires_in_days`, or omit for no expiry).

**2) curl one-liner** — the 서버 업로드 popover fills this in for you. The **destination rides in
the token** (wherever you clicked 서버 업로드), so the URL is just `/api/upload` — no folder/space
id needed. List several `-F file=@…` to send **multiple files in one request**:

```bash
# destination = token's scope · several files in one request
curl -H "Authorization: Bearer <TOKEN>" -F file=@a.log -F file=@b.log https://file.rgrg.im/api/upload
```

Or target an explicit location (the token must be in scope). One `file` field per request here:

```bash
curl -H "Authorization: Bearer <TOKEN>" -F file=@a.log https://file.rgrg.im/api/nodes/<FOLDER_ID>/files
curl -H "Authorization: Bearer <TOKEN>" -F file=@a.log https://file.rgrg.im/api/spaces/<SPACE_ID>/files
```

**3) CLI uploader** (in this repo, dependency-light — bash+curl, or Python stdlib). With a scoped
token you **don't need `--folder/--space`** (the token carries the destination); pass them only to
target an explicit place. Prefer `FS_TOKEN` over `--token` (argv is visible in `ps`):

```bash
FS_BASE=https://file.rgrg.im FS_TOKEN=<TOKEN> ./scripts/fs-upload.sh a.log b.log report.csv
FS_BASE=https://file.rgrg.im FS_TOKEN=<TOKEN> python3 scripts/fs_upload.py report.csv
# explicit location still works:  --folder <FOLDER_ID>   |   --space <SPACE_ID>
# optional: --rel-path 2026/09/ creates intermediate folders server-side (single file only)
```

**Scope & security**

- **Scope** is enforced server-side (403 otherwise): a folder-scoped token may upload only into
  that folder (and its subfolders); a space-scoped token only into that space; a token with no
  scope only into the owner's personal space (safe default).
- Uploads run through the **same validation** as browser uploads (max size, filename sanitizing,
  path-traversal guard) and are recorded in the **audit log** as the token owner, tagged with the
  token label. Tokens are never written to logs, URLs, or error messages.
- **Auto-expiry is the norm**: temp tokens issued from the UI are short-lived (minutes) and vanish
  on their own — you don't manage or rotate them. You can also **revoke** immediately via
  `DELETE /api/tokens/{id}`; revoked/expired tokens are rejected with 401.
- Never commit real tokens. Use placeholders (`<TOKEN>`) in docs and scripts.

## Deploy (internal VM)

```bash
# one-time: install docker, clone repo, cp .env.example .env (set real SECRET_KEY, APP_ENV=prod,
# BASE_URL=https://<host>, Google OAuth values), register the prod redirect URI in GCP
docker compose up -d      # proxy(Caddy, :8484) + app; state in the filesharer-data volume
```

- HTTPS: put your hostname in `deploy/Caddyfile` (replace `:80`) and Caddy issues certs automatically.
- Upgrade/rollback: `docker compose pull && docker compose up -d` (images on GHCR, tagged by commit).
- Backup: `./deploy/backup.sh /opt/backups` daily via cron (keeps 14); restore with
  `./deploy/restore.sh <file>` while stopped. Rehearse restores.

CI (GitHub Actions): gitleaks secret scan → backend/frontend lint+test → Docker image
(pushed to GHCR on main). E2E smoke (Playwright) runs on every main push and on PRs
labeled `e2e`.
