"""에러 리포트에서 '그대로 쓸 수 있는 열쇠'를 지우는지.

에러 리포트는 제3자(sentry.io)에 남는다. 공유 링크 토큰 하나가 새면 **그 리포트를 본
사람이 파일을 받을 수 있다.** 그래서 이건 편의 기능이 아니라 보안 장치다.
"""

from app.observability import init_sentry, redact, scrub

# 일부러 '명백히 가짜'로 만든다 — 진짜처럼 생긴 토큰을 저장소에 넣으면 비밀 스캐너가
# 잡고(실제로 CI가 잡았다), 무엇보다 진짜와 구분이 안 된다. 길이·형식만 맞추면 충분하다.
SHARE = "sharetoken" * 5  # 50자 — 실제 토큰(43자)보다 길어 정규식 검증에 문제없다
TOKEN = "fsk_" + "a" * 8 + "." + "b" * 16


def test_share_token_in_url_is_removed():
    out = redact(f"https://file.rgrg.im/s/{SHARE}/download")
    assert SHARE not in out
    assert "/s/<share-token>/download" in out


def test_api_token_is_removed():
    assert TOKEN not in redact(f'curl -H "Authorization: Bearer {TOKEN}" https://x/api/upload')


def test_scrub_walks_the_whole_event():
    """URL·브레드크럼·예외 메시지·추가필드 — 경로가 많아서 전수 조사한다."""
    event = {
        "request": {
            "url": f"https://file.rgrg.im/s/{SHARE}",
            "headers": {"X-Share-Password": "hunter2", "User-Agent": "x"},
        },
        "breadcrumbs": [{"message": f"GET /s/{SHARE}/raw"}],
        "exception": {"values": [{"value": f"토큰 {TOKEN} 이 만료됨"}]},
        "extra": {"nested": [{"deep": f"/s/{SHARE}"}]},
    }

    out = scrub(event)

    flat = repr(out)
    assert SHARE not in flat
    assert TOKEN not in flat
    assert "hunter2" not in flat
    assert out["request"]["headers"]["X-Share-Password"] == "<removed>"
    assert out["request"]["headers"]["User-Agent"] == "x"  # 무해한 건 남는다


def test_scrub_keeps_ordinary_text():
    event = {"message": "업로드 실패: 용량 초과", "level": "error"}
    assert scrub(event) == event


def test_scrub_handles_non_string_values():
    event = {"n": 1, "ok": True, "none": None, "t": (1, "x")}
    assert scrub(event) == event


def test_short_paths_are_not_mangled():
    """짧은 /s/ 경로(토큰이 아닌 것)까지 지워버리면 리포트가 쓸모없어진다."""
    assert redact("/s/abc") == "/s/abc"


def test_init_is_noop_without_dsn():
    class S:
        sentry_dsn = ""
        app_env = "test"
        app_version = "v1.0.0"
        app_build = "#1"
        sentry_traces_sample_rate = 0.0

    assert init_sentry(S()) is False


def test_init_failure_does_not_raise():
    """추적기 초기화 실패가 서비스를 막으면 본말전도다."""

    class S:
        sentry_dsn = "그건-DSN이-아니다"
        app_env = "test"
        app_version = "v1.0.0"
        app_build = "#1"
        sentry_traces_sample_rate = 0.0

    assert init_sentry(S()) is False
