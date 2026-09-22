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
# 배포 속도: 버전과 무관한 '고정 placeholder'로 빌드한다. 이렇게 하면 이 무거운 npm/vite
# 빌드 레이어의 캐시 키가 버전에 물리지 않아, 버전만 바뀌는 배포(백엔드·e2e·ci 등)에서
# arm64 재빌드가 통째로 도는 걸 막는다(캐시 재사용).
RUN APP_VERSION=__FS_APP_VERSION__ npm run build
# 버전 뱃지 = 머지된 PR 번호. CI(image 잡)가 머지 커밋의 (#NN)→v0.0.<PR>로 넣어준다.
# 무거운 빌드 '뒤에' 싼 문자열 치환으로만 실제 버전을 주입 → 여기서부터만 캐시 무효화(수 초).
# APP_VERSION이 없으면(로컬 도커 빌드·PR 등, 미배포) 'dev'로 표기.
ARG APP_VERSION=""
RUN grep -rl "__FS_APP_VERSION__" dist/assets 2>/dev/null \
      | xargs -r sed -i "s/__FS_APP_VERSION__/${APP_VERSION:-dev}/g"

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
RUN pip install .
COPY --from=web /web/dist ./static
USER app
VOLUME /data
EXPOSE 8000
# --proxy-headers: Caddy 뒤에서 올바른 scheme/host로 리다이렉트 생성
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
