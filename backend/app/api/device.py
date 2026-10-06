"""CLI 로그인 엔드포인트 — 디바이스 플로우(RFC 8628).

두 짝으로 나뉜다:

* **미인증** (터미널이 부른다) — ``/code`` 로 코드 한 쌍을 받고, ``/token`` 으로 폴링한다.
  인증 없이 열려 있는 게 맞다. 아직 누구인지 모르는 상태에서 시작하는 흐름이니까.
  대신 발급에 IP 레이트리밋을, 폴링에 간격(slow_down)을 건다.
* **인증 필요** (브라우저가 부른다) — ``/pending`` 으로 무엇을 승인하는지 보고,
  ``/approve`` 또는 ``/deny`` 한다. 여기서 '누가' 가 정해지고, 그 사람이 토큰의 주인이 된다.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import current_user, get_db
from ..models import User
from ..services import audit
from ..services import device_auth as flow
from ..services.permissions import get_node_checked, get_space_checked

router = APIRouter(prefix="/api/device", tags=["device-auth"])


def client_ip(request: Request) -> str:
    """승인 화면에 보여줄 요청자 IP.

    **보여주기 전용이다.** 우리는 Cloudflare → Caddy 뒤에 있어 프록시가 붙인 헤더를
    읽어야 하는데, 그건 신뢰 경계가 아니다. 권한 판단에는 절대 쓰지 않는다 —
    사람이 '내가 지금 친 그 명령이 맞나' 를 가늠하는 단서일 뿐이다.
    """
    for header in ("cf-connecting-ip", "x-forwarded-for"):
        raw = request.headers.get(header)
        if raw:
            return raw.split(",")[0].strip()
    return request.client.host if request.client else ""


class StartBody(BaseModel):
    client_name: str = Field(default="", max_length=120)


@router.post("/code", status_code=201)
def start(body: StartBody, request: Request, db: Session = Depends(get_db)) -> dict:
    """터미널이 부른다 — 코드 한 쌍을 받아간다(미인증)."""
    ip = client_ip(request)
    if flow.issue_rate_limited(ip):
        raise flow.DeviceFlowError("slow_down", status_code=429)

    row, device_code = flow.start(db, client_name=body.client_name, client_ip=ip)
    settings = get_settings()
    # 사람이 브라우저로 여는 주소라 공유 링크와 같은 규칙을 쓴다(shares.py 주석 참고)
    verify = (settings.frontend_url or settings.base_url).rstrip("/") + "/device"
    return {
        "device_code": device_code,  # 원문은 여기서만 — 터미널만 쥔다
        "user_code": row.user_code,  # 사람이 눈으로 옮기는 쪽
        "verification_uri": verify,
        "verification_uri_complete": f"{verify}?code={row.user_code}",
        "expires_in": flow.CODE_TTL_MIN * 60,
        "interval": flow.POLL_INTERVAL_SEC,
    }


class PollBody(BaseModel):
    device_code: str


@router.post("/token")
def poll(body: PollBody, db: Session = Depends(get_db)) -> dict:
    """터미널이 몇 초마다 부른다 — 승인됐으면 토큰을 받아간다(미인증)."""
    token, plaintext = flow.poll(db, body.device_code)
    audit.log(db, "device_login", user_id=token.user_id, detail=token.label or token.id)
    return {
        "token": plaintext,  # 원문은 여기서 단 한 번
        "token_id": token.id,
        "label": token.label,
        "expires_at": token.expires_at.isoformat() if token.expires_at else None,
    }


@router.get("/pending")
def pending(
    code: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """승인 화면이 '무엇을 승인하는지' 를 묻는다(로그인 필요).

    피싱("이 코드 좀 넣어주세요")을 사람이 알아채려면 **무엇을 허락하는지** 가 눈에
    보여야 한다. 그래서 기기 이름·요청 IP·요청 시각을 그대로 돌려준다.
    """
    row = flow.find_pending(db, code)
    return {
        "user_code": row.user_code,
        "client_name": row.client_name,
        "client_ip": row.client_ip,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
        "default_days": flow.DEFAULT_TOKEN_DAYS,
    }


class ApproveBody(BaseModel):
    code: str
    space_id: str | None = None
    node_id: str | None = None
    days: int = Field(default=flow.DEFAULT_TOKEN_DAYS, ge=1, le=365)


@router.post("/approve")
def approve(
    body: ApproveBody, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """허용 — 범위는 **승인하는 사람이** 정한다. 터미널이 요구할 수 없다."""
    row = flow.find_pending(db, body.code)
    space_id: str | None = None
    node_id: str | None = None
    if body.node_id:
        node = get_node_checked(db, user, body.node_id)  # 존재 + 접근 권한
        if node.type != "folder":
            raise HTTPException(status_code=422, detail="폴더만 범위로 지정할 수 있습니다")
        node_id = node.id
    elif body.space_id:
        space_id = get_space_checked(db, user, body.space_id).id
    # 둘 다 없으면 null 범위 → 개인 공간으로만(안전한 기본값, ApiToken 과 같은 규칙)

    flow.approve(db, row, user, space_id=space_id, node_id=node_id, token_days=body.days)
    audit.log(db, "device_approve", user_id=user.id, detail=f"{row.client_name}·{row.client_ip}")
    return {"ok": True}


class DenyBody(BaseModel):
    code: str


@router.post("/deny")
def deny(
    body: DenyBody, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    row = flow.find_pending(db, body.code)
    flow.deny(db, row)
    audit.log(db, "device_deny", user_id=user.id, detail=f"{row.client_name}·{row.client_ip}")
    return {"ok": True}
