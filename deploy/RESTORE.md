# 백업 복원 절차

> 복원해본 적 없는 백업은 백업이 아니다.
> 이 문서는 **실제로 해본 결과**를 적은 것이다(아래 "리허설 기록" 참고).

## 1. 무엇이 백업돼 있나

주 1회·월 1회, R2 버킷의 **`backup/` 프리픽스**(운영 키와 분리)에 쌓인다.

```
backup/weekly/2026-W40/
  spaces/개인-joji.tar.gz     ← 공간별 파일 전체(폴더 구조·이름 그대로)
  spaces/전체 공간.tar.gz
  app.db.gz                   ← DB 스냅샷(VACUUM INTO → gzip)
  manifest.json               ← 각 파일의 크기·sha256. 이게 있으면 '완결된 회차'
backup/monthly/2026-09/…
```

**둘 다 필요하다.** tar 는 풀면 바로 파일이 나오지만 블롭 키를 모르고, DB 는 키를 알지만
파일 본체가 없다. 복원은 이 둘을 맞붙이는 일이다.

지금 뭐가 있는지 보기 (읽기 전용):

```bash
# 서버에서 — 컨테이너 안에 스크립트가 들어 있다
docker compose exec app python scripts/backup_list.py

# 내 컴퓨터에서 — 저장소를 체크아웃한 경우
backend/.venv/bin/python backend/scripts/backup_list.py
```

## 2. 언제 어떤 시나리오인가

| 상황 | 필요한 것 | 방법 |
|---|---|---|
| **DB만 날아감** (서버 디스크 고장) — R2 블롭은 멀쩡 | `app.db.gz` | 스냅샷을 풀어 `/data/app.db` 로 놓고 컨테이너 재시작. 블롭은 그대로 R2에 있다 |
| **파일 몇 개를 실수로 지움** | 해당 `spaces/*.tar.gz` | tar 에서 그 파일만 꺼내 UI로 다시 업로드(새 파일로 들어간다) |
| **전부 날아감** | 회차 전체 | 아래 3번 — 스크립트가 DB와 블롭을 함께 되살린다 |

## 3. 전체 복원

**운영을 건드리지 않는다.** 스크립트는 백업을 읽고, 지정한 빈 폴더에만 쓴다.

복원은 **운영과 분리된 곳에서** 하는 게 안전하다. 서버에서 바로 하거나(컨테이너 안),
내 컴퓨터에 저장소를 체크아웃해 하거나 둘 다 된다.

```bash
# 서버에서 (컨테이너 안 /tmp 에 푼다 — 운영 볼륨을 건드리지 않는다)
docker compose exec app python scripts/restore_backup.py \
    --kind weekly --stamp 2026-W40 --into /tmp/restore-test

# 내 컴퓨터에서
backend/.venv/bin/python backend/scripts/restore_backup.py \
    --kind weekly --stamp 2026-W40 --into /tmp/restore-test
```

하는 일:

1. 회차를 내려받는다(읽기 전용)
2. `manifest.json` 의 **sha256 과 대조** — 하나라도 어긋나면 중단한다
3. `app.db.gz` → `app.db`
4. tar 를 풀면서 각 파일을 **원래 `storage_key` 이름으로** `blobs/` 에 놓는다
   (tar 의 경로 → DB 의 노드 → 그 노드의 키)

끝나면 그 폴더로 앱을 띄워 **눈으로 확인**한다:

```bash
DATABASE_URL="sqlite:////tmp/restore-test/app.db" \
DATA_DIR="/tmp/restore-test" \
STORAGE_BACKEND=local \
SECRET_KEY=$(openssl rand -hex 32) APP_ENV=dev \
backend/.venv/bin/uvicorn app.main:app --app-dir backend --port 8600
```

확인됐으면 운영으로 옮긴다:

```bash
# 서버에서 (컨테이너 정지 후)
cp /tmp/restore-test/app.db /data/app.db
# 블롭은 R2 로: 키 이름 그대로 올린다(prod/ 프리픽스)
# aws s3 cp --recursive /tmp/restore-test/blobs/ s3://<bucket>/prod/ --endpoint-url <r2>
```

> **로그인 계정**: 복원된 DB 에는 사용자와 비밀번호 해시가 그대로 들어 있다.
> 평소 쓰던 계정으로 로그인하면 된다. (리허설처럼 임시 계정이 필요하면
> `app.bootstrap.create_user` 로 **복원본에만** 하나 만들고, 끝나면 폴더째 지운다.)

## 4. 리허설 기록 (2026-09-28, `weekly/2026-W40`)

실제 운영 백업으로 처음부터 끝까지 해본 결과.

| 단계 | 결과 |
|---|---|
| 내려받기 | 5개 객체 · 88.9 MB |
| 무결성 | manifest sha256 **5/5 일치** |
| DB 스냅샷 | 1,863,680 bytes — sqlite 로 정상 열림 |
| 블롭 배치 | **27개 배치 · 양방향 불일치 0건** (tar에 있는데 DB가 모르는 파일 0, DB가 가리키는데 tar에 없는 파일 0) |
| 해시 대조 | 파일 27개 · 118,195,254 bytes — **27/27 DB 기록 해시와 일치** |
| 앱 기동 | 복원 폴더로 정상 기동, 로그인 200 |
| 서빙 확인 | 42 MB PPTX 를 HTTP 로 내려받아 **해시 일치** |

복원에 걸린 시간: 수 분(대부분 다운로드).

## 5. 한계 — 알고 쓰자

- **회차 사이의 변경은 없다.** 주간 백업 기준 최대 7일치 작업이 날아갈 수 있다.
  (더 촘촘히 원하면 `BACKUP_TICK_MINUTES`·주기를 조정해야 한다)
- **자동 복원은 일부러 만들지 않았다.** 잘못된 복원이 운영 데이터를 덮어쓰는 게
  백업이 없는 것보다 위험하다. 항상 **빈 폴더에 복원 → 확인 → 옮기기** 순서로 한다.
- 휴지통에 있던 항목은 백업에 **포함되지 않는다**(`deleted_at` 이 있는 노드는 제외).
- 공간 이름 규칙이 바뀌면 tar 경로와 DB 가 어긋난다 →
  `test_backup_restore_roundtrip` 이 이 짝을 고정하고 있다(규칙을 바꾸면 테스트가 깨진다).
