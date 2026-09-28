"""에러 추적(Sentry) — 사용자가 만난 오류를 우리가 알게 한다.

DSN이 비면 **아무 일도 하지 않는다**(로컬·CI 기본값). 서버 `.env` 에 넣는 순간 켜진다.

**보내기 전에 지우는 것들** — 에러 리포트는 제3자(sentry.io)에 남고, 우리 팀 밖의 눈이
볼 수도 있다. 그 안에 '그대로 쓸 수 있는 열쇠'가 들어가면 안 된다.
  * 공유 링크 토큰 `/s/<token>` — **이게 곧 파일 접근 권한**이다. 리포트만 보면 받을 수 있다.
  * API 토큰 `fsk_…` — 업로드·다운로드 자격.
  * 공유 비밀번호 헤더 `X-Share-Password`.
  * 이메일 등 개인정보는 애초에 보내지 않는다(`send_default_pii=False`). 누구인지는
    사용자 **id** 로만 남기고, 필요하면 관리자가 DB에서 찾는다.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("filesharer")

# /s/<token> — 토큰은 32바이트 urlsafe(43자)지만, 짧게 잘린 로그도 잡히게 16자 이상으로 본다
_SHARE_URL = re.compile(r"(/s/)[A-Za-z0-9_\-]{16,}")
_API_TOKEN = re.compile(r"\bfsk_[A-Za-z0-9_.\-]+")
_DROP_HEADERS = {"x-share-password", "authorization", "cookie", "set-cookie"}


def redact(text: str) -> str:
    """문자열에서 '그대로 쓸 수 있는 열쇠'를 지운다."""
    text = _SHARE_URL.sub(r"\1<share-token>", text)
    return _API_TOKEN.sub("<api-token>", text)


def scrub(value: Any) -> Any:
    """이벤트를 통째로 훑어 지운다.

    영리한 선별보다 **전수 조사**가 낫다. 이벤트는 작고, 한 군데라도 놓치면
    토큰이 그대로 나간다(URL·브레드크럼·예외 메시지·로그 등 경로가 많다).
    """
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if isinstance(key, str) and key.lower() in _DROP_HEADERS:
                out[key] = "<removed>"
            else:
                out[key] = scrub(item)
        return out
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, tuple):
        return tuple(scrub(item) for item in value)
    return value


def _before_send(event: dict, _hint: dict) -> dict:
    return scrub(event)


def init_sentry(settings) -> bool:  # noqa: ANN001
    """설정돼 있으면 Sentry를 켠다. 켜졌으면 True.

    실패해도 앱을 죽이지 않는다 — 에러 추적을 못 붙였다고 서비스가 안 뜨면 본말전도다.
    """
    dsn = getattr(settings, "sentry_dsn", "")
    if not dsn:
        return False
    try:
        import sentry_sdk

        version = settings.app_version or "dev"
        build = settings.app_build or ""
        sentry_sdk.init(
            dsn=dsn,
            environment=settings.app_env,
            # 어느 배포에서 터졌는지 — 오늘 만든 버전 체계를 그대로 쓴다
            release=f"{version}{'+' + build.lstrip('#') if build else ''}",
            send_default_pii=False,  # 이메일·IP를 보내지 않는다
            traces_sample_rate=settings.sentry_traces_sample_rate,
            before_send=_before_send,
            before_send_transaction=_before_send,
        )
        logger.info("Sentry 켜짐 (environment=%s)", settings.app_env)
        return True
    except Exception:  # 추적기 초기화 실패가 서비스를 막으면 안 된다
        logger.exception("Sentry 초기화 실패 — 추적 없이 계속합니다")
        return False


def bind_user(user_id: str | None) -> None:
    """이 요청이 누구 것인지 남긴다 — **id 만**(이메일은 보내지 않는다)."""
    try:
        import sentry_sdk

        sentry_sdk.set_user({"id": user_id} if user_id else None)
    except Exception:  # 추적 부가기능이 요청을 깨뜨리면 안 된다
        pass
