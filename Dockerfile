# ── Stage 1: 프론트엔드 빌드 ─────────────────────────────
# --platform=$BUILDPLATFORM: 프런트 빌드는 아키텍처 무관한 정적 산출물(dist)만 만든다.
# 이 스테이지를 '빌드 러너의 네이티브 아키텍처'(amd64)에 고정하면, 멀티아치(amd64+arm64)
# 빌드에서도 vite/npm 빌드를 QEMU arm64 에뮬레이션으로 두 번 돌리지 않는다 → 한 번만 네이티브로.
# (arm64 에뮬레이션에서 무거운 프런트 빌드가 멈춰 image 잡이 6시간 타임아웃으로 죽던 문제 수정.
#  아래 python 스테이지만 타깃별로 크로스빌드되고, 여기 dist는 그대로 복사됨.)
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# 버전 문자열을 번들에 박지 않는다 → 이 무거운 빌드 레이어가 버전과 무관해져 캐시가 그대로
# 재사용되고(배포 속도), 동시에 "파일명은 같은데 내용만 다른" 번들이 사라져 CDN이 옛 버전을
# 내주는 문제도 없어진다. 버전은 서버가 /api/health 로 말한다(아래 스테이지의 APP_VERSION).
# 이 빌드는 dist 와 dist-sourcemaps 를 나눠 내놓는다 — 맵에는 원본 코드가 통째로 들어
# 있는데 file.rgrg.im 은 공개 주소라, 배포되는 dist 에 같이 실으면 누구나 받아간다.
# 떼어내는 일을 **빌드가** 한다(scripts/split-sourcemaps.mjs). 여기서 지우게 했더니
# 이미지에는 없고 로컬·CI e2e 가 보는 dist 에는 남아, 새지 않는다는 걸 확인할 데가 없었다.
RUN npm run build

# ── (이미지가 아님) 소스맵만 꺼내가는 출구 ────────────────────
# CI 가 `--target sourcemaps --output type=local` 로 이 스테이지만 꺼내 Sentry 에 올린다.
# web 스테이지는 방금 구운 것이 캐시에 그대로 있으니 다시 빌드되지 않는다 — 태그 배포가
# 24초에서 느려지지 않는다. scratch 라 레지스트리에 올라가지도 않는다.
#
# **반드시 마지막 스테이지보다 앞에 있어야 한다.** docker 는 타깃을 안 주면 맨 끝 스테이지를
# 굽는다 — 이걸 파일 끝에 뒀더니 아무것도 없는 scratch 가 이미지가 됐다.
FROM scratch AS sourcemaps
COPY --from=web /web/dist-sourcemaps /

# ── Stage 2: 백엔드 + 정적파일 → 단일 이미지 ───────────────
FROM python:3.13-slim AS app
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
# 오피스 문서(PPT·워드·엑셀·한글) 미리보기용 PDF 변환기 + 한글 폰트.
# libreoffice-h2orestart: 한컴 HWP/HWPX 임포트 필터(Java 확장, GPLv3) → JRE 동반 설치됨.
# (기본 LibreOffice의 libhwplo는 구형 .hwp만, 신형 .hwpx는 h2orestart가 필요)
# ffmpeg: 영상 미리보기에서 브라우저 비호환 오디오(AC-3 등)를 AAC로 변환(ffprobe 포함).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-h2orestart \
      fonts-noto-cjk \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 app \
    && mkdir /data && chown app:app /data
WORKDIR /srv/backend
COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
# 운영 스크립트(계정 복구·백업 목록·복원)는 **서버에서 실행하는 물건**이라 이미지에 있어야 한다.
# 빠뜨리면 문서가 안내하는 명령이 "No such file"로 죽는다(실제로 그랬다).
COPY backend/scripts ./scripts
RUN pip install .
COPY --from=web /web/dist ./static
# 서버가 자기 버전을 말할 수 있어야 한다. 프런트 번들 안의 문자열은 파일명이 안 바뀌는
# 배포(백엔드만 변경)에서 CDN이 옛 바이트를 계속 내주며 거짓말을 한다 — 실제로 겪었다.
# 이 ENV 는 마지막 레이어들 근처라 캐시 무효화 비용이 거의 없다.
ARG APP_VERSION=""
ARG APP_BUILD=""
ARG APP_PR=""
ARG APP_BUILT_AT=""
ENV APP_VERSION=${APP_VERSION} APP_BUILD=${APP_BUILD} APP_PR=${APP_PR} \
    APP_BUILT_AT=${APP_BUILT_AT}
USER app
VOLUME /data
EXPOSE 8000
# --proxy-headers: Caddy 뒤에서 올바른 scheme/host로 리다이렉트 생성
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
