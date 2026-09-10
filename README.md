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
make dev                  # uvicorn --reload (8000) + vite dev (5173)
make test                 # backend ruff + pytest (same as CI)
make prod-check           # build the prod image and smoke-test via compose (8484)
```

## Deploy

```bash
docker compose up -d      # proxy(Caddy, :8484) + app; state in the filesharer-data volume
```

CI (GitHub Actions): gitleaks secret scan → backend/frontend lint+test → Docker image
(pushed to GHCR on main). E2E smoke (Playwright) runs on every main push and on PRs
labeled `e2e`.
