# ── Stage 1: 프론트엔드 빌드 ─────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: 백엔드 + 정적파일 → 단일 이미지 ───────────────
FROM python:3.13-slim AS app
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 1000 app \
    && mkdir /data && chown app:app /data
WORKDIR /srv/backend
COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
RUN pip install .
COPY --from=web /web/dist ./static
USER app
VOLUME /data
EXPOSE 8000
# --proxy-headers: Caddy 뒤에서 올바른 scheme/host로 리다이렉트 생성
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
