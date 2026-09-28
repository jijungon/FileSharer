# 프로덕션 배포 (Cloudflare + Oracle Cloud)

Cloudflare가 오리진 앞에서 TLS를 종단하고, 오리진은 Docker Compose(Caddy + app)로
GHCR 이미지를 받아 구동한다.

```
브라우저 ─HTTPS→ Cloudflare(프록시) ─HTTP:80→ Caddy(:80) ─HTTP→ app(uvicorn:8000)
```

- **지금(Flexible)**: Cloudflare SSL = Flexible. 오리진은 80으로 평문 서빙.
- **나중(Full strict)**: 오리진에 Cloudflare Origin Certificate를 깔고 Caddy가 443/TLS
  종단. 그때 `Caddyfile`의 `header_up X-Forwarded-Proto https`를 제거하고 도메인 블록으로 전환.

## 1. 사전 준비 (콘솔 작업)

1. **Cloudflare DNS**: `A  <sub>  <오리진 공인 IP>  (Proxied, 주황 구름)`.
2. **Cloudflare SSL/TLS**: 모드 = **Flexible**. Network → Upload 최대 크기 = **500 MB**
   (플랜 상한). "Always Use HTTPS" 켜기.
3. **Cloudflare OAuth**: Google Cloud Console → 사용자 OAuth 클라이언트 →
   Authorized redirect URIs에 `https://<sub>.<domain>/api/auth/google/callback` 추가.
4. **OCI Security List**: 인그레스 `TCP 80`, `TCP 443` (0.0.0.0/0) 허용.
   서버 방화벽(ubuntu)도 열려 있어야 함: `sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT`
   (이미 iptables 규칙이 있으면 위치 조정). netfilter-persistent로 저장.

## 2. 서버의 `.env` (오리진에만 둠, 절대 커밋 금지)

`.env.example`를 복사해 채운다. dev와 다른 prod 값만 표기:

| 키 | prod 값 |
|----|---------|
| `APP_ENV` | `prod` (SECRET_KEY 검증·Secure 쿠키 활성) |
| `SECRET_KEY` | `openssl rand -hex 32`로 새로 생성 |
| `BASE_URL` | `https://<sub>.<domain>` (OAuth 콜백·절대 URL 기준) |
| `FRONTEND_URL` | `https://<sub>.<domain>` (로그인 후 복귀 오리진, 결정론적) |
| `FILESHARER_PORT` | `80` (Caddy를 호스트 80에 게시 → CF가 붙는 포트) |
| `MAX_UPLOAD_MB` | `500` (CF 업로드 상한과 정합) |
| `STORAGE_BACKEND` | `r2` |
| `R2_*` | R2 버킷/키 (대시보드에서) |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth 클라이언트 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 초기 관리자 |
| `ALLOWED_GOOGLE_DOMAIN` | 회사 도메인 |

**백업은 따로 설정할 게 없다.** `APP_ENV=prod` 면 앱이 알아서 주 1회·월 1회
공간별 tar.gz + DB 스냅샷을 버킷의 `backup/` 프리픽스에 쌓는다(운영 키와 분리).
보관 기간만 바꾸고 싶으면 `BACKUP_KEEP_WEEKLY` / `BACKUP_KEEP_MONTHLY`.
돌고 있는지 확인: `backend/.venv/bin/python backend/scripts/backup_list.py` (읽기 전용)

## 2-1. 계정 잠김 복구 (관리자가 없거나 비밀번호를 잃었을 때)

지금 구조에는 막다른 길이 있다. 부트스트랩 관리자는 `users` 테이블이 **비어 있을 때만**
만들어지고, 구글 로그인은 **최초 1인만** admin이며, 역할 변경은 **관리자만** 할 수 있다.
즉 **관리자 비밀번호를 잃으면 관리자 기능에 영영 못 들어간다.**

서버 셸에서 (컨테이너 안):

```bash
docker compose exec app python scripts/user_admin.py list
docker compose exec app python scripts/user_admin.py promote joji@parametacorp.com
docker compose exec -it app python scripts/user_admin.py create test@parametacorp.com --role member
docker compose exec -it app python scripts/user_admin.py reset-password admin@parametacorp.com
```

- 비밀번호를 받는 명령(`create`, `reset-password`)은 **`-it`** 로 실행한다(입력을 물어본다).
  인자로 받지 않는 이유: 셸 히스토리와 `ps` 에 남기지 않기 위해서다.
- **마지막 관리자는 강등되지 않는다** — 그러면 아무도 되돌릴 수 없기 때문.
- 새로 뚫는 구멍이 아니다. 서버 셸 + DB 접근이 있어야 실행되는데, 그 권한이면 이미 최고 권한이다.

## 3. 배포

```bash
# 서버에서 (compose.yml + deploy/ 를 올려둔 디렉터리)
docker compose pull        # GHCR에서 최신 멀티아치 이미지
docker compose up -d
docker compose logs -f app # alembic upgrade + 기동 확인
```

## 4. 검증

```bash
curl -fsS https://<sub>.<domain>/api/health        # {"status":"ok"}
```
- 브라우저에서 Google 로그인 → 로그인 유지되는지(쿠키 Secure/https) 확인
- 파일 업로드 → R2에 객체 생기는지, 다운로드/미리보기 되는지 확인

## 5. Full(strict)로 업그레이드 (나중)

1. Cloudflare → SSL/TLS → Origin Server → Create Certificate → 서버에 설치.
2. `Caddyfile`을 도메인 블록 + `tls <cert> <key>`로 바꾸고 `header_up X-Forwarded-Proto https` 제거
   (Caddy가 실제 https를 종단하므로 스킴이 자동으로 올바름).
3. Cloudflare SSL 모드 = Full (strict), `FILESHARER_PORT=443`.
