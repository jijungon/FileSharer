# ── Stage 1: 프론트엔드 빌드 ─────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# 배포 버전 라벨. 빌드 컨텍스트엔 .git이 없어(.dockerignore) git describe가 안 되므로
# CI가 --build-arg APP_VERSION=... 로 넘겨준다. vite.config가 process.env.APP_VERSION을 우선 사용.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN npm run build

# ── Stage 2: 백엔드 + 정적파일 → 단일 이미지 ───────────────
FROM python:3.13-slim AS app
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
# 오피스 문서(PPT·워드·엑셀·한글) 미리보기용 PDF 변환기 + 한글 폰트.
# libreoffice-h2orestart: 한컴 HWP/HWPX 임포트 필터(Java 확장, GPLv3) → JRE 동반 설치됨.
# (기본 LibreOffice의 libhwplo는 구형 .hwp만, 신형 .hwpx는 h2orestart가 필요)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-h2orestart \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
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
