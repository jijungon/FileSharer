"""오피스 변환 샌드박스 강화 검증 (실제 LibreOffice 없이 subprocess 모킹)."""

import subprocess
from pathlib import Path

from app.services import office


def test_sandbox_env_scrubs_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "supersecret")
    monkeypatch.setenv("SECRET_KEY", "app-secret")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "g-secret")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("LANG", "ko_KR.UTF-8")

    env = office._sandbox_env(tmp_path)

    # 앱 시크릿은 변환기 환경에 없어야 한다
    for secret in ("R2_SECRET_ACCESS_KEY", "SECRET_KEY", "GOOGLE_CLIENT_SECRET"):
        assert secret not in env
    # 필요한 것만 통과 + HOME 격리
    assert env["PATH"] == "/usr/bin:/bin"
    assert env["LANG"] == "ko_KR.UTF-8"
    assert env["HOME"] == str(tmp_path)


def test_convert_wraps_with_ulimit_and_scrubbed_env(monkeypatch, tmp_path):
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "supersecret")
    monkeypatch.setattr(office, "soffice_bin", lambda: "/usr/bin/soffice")

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        outdir = Path(cmd[cmd.index("--outdir") + 1])
        (outdir / "in.pdf").write_bytes(b"%PDF-1.4 test")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    src = tmp_path / "in.docx"
    src.write_bytes(b"x")
    out = office.convert_to_pdf(src, tmp_path / "cache", "k1")
    assert out.is_file()

    cmd = captured["cmd"]
    # sh -c 로 ulimit을 건 뒤 exec 하는 래퍼
    assert cmd[0] == "/bin/sh" and cmd[1] == "-c"
    assert "ulimit -c 0" in cmd[2] and "exec" in cmd[2]
    # 실제 soffice 인자 포함
    assert "/usr/bin/soffice" in cmd and "--convert-to" in cmd and "pdf" in cmd
    # env 스크러빙 + HOME 격리
    env = captured["kwargs"]["env"]
    assert "R2_SECRET_ACCESS_KEY" not in env
    assert "HOME" in env
    assert captured["kwargs"]["timeout"] == 120


def test_convert_uses_cache(monkeypatch, tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "k1.pdf").write_bytes(b"%PDF cached")

    def must_not_run(*a, **k):
        raise AssertionError("캐시 히트면 soffice를 호출하면 안 된다")

    monkeypatch.setattr(subprocess, "run", must_not_run)
    src = tmp_path / "in.docx"
    src.write_bytes(b"x")
    out = office.convert_to_pdf(src, cache, "k1")
    assert out == cache / "k1.pdf"


def test_hwp_is_office_but_hwpx_is_not():
    # 한글 구형(.hwp)은 LibreOffice로 변환 가능 → 오피스 취급. 신형(.hwpx)은 미지원 → 제외.
    assert office.is_office("현장점검.hwp") is True
    assert office.is_office("현장점검.hwpx") is False
    assert office.is_office("발표.pptx") is True
