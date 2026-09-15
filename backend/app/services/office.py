"""오피스 문서(PPT·워드·엑셀 등) → PDF 변환.

브라우저가 자체 렌더하지 못하는 형식을 LibreOffice(headless)로 PDF로 바꿔
기존 PDF 뷰어로 보여준다. 변환 결과는 cache_key(보통 blob의 storage_key)로
캐시해 같은 파일을 다시 열 때 재변환하지 않는다.
"""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

# 신뢰할 수 없는 문서를 파싱하는 LibreOffice에 넘겨줄 최소 환경변수만 골라낸다.
# (앱 시크릿 R2_*/SECRET_KEY 등이 변환기 프로세스에 노출되지 않게 함)
_ENV_ALLOW = ("PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ")

OFFICE_EXTS = {
    ".ppt",
    ".pptx",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".odp",
    ".ods",
    ".odt",
    ".hwp",  # 한글(구형 v5) — LibreOffice hwp 필터(libhwplo). .hwpx(신형 XML)는 미지원이라 제외.
}


class OfficeConvertError(RuntimeError):
    """변환기 미설치·변환 실패·시간 초과 등."""


def ext_of(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot != -1 else ""


def is_office(name: str) -> bool:
    return ext_of(name) in OFFICE_EXTS


def soffice_bin() -> str | None:
    """LibreOffice 실행 파일 경로 (없으면 None)."""
    return shutil.which("soffice") or shutil.which("libreoffice")


def _sandbox_env(home: Path) -> dict[str, str]:
    """변환기에 넘길 최소 환경. 앱 시크릿을 제거하고 HOME은 임시 프로필로 격리."""
    env = {k: os.environ[k] for k in _ENV_ALLOW if k in os.environ}
    env.setdefault("PATH", "/usr/bin:/bin")
    env["HOME"] = str(home)
    return env


# 자식(soffice)에 걸 자원 상한: 코어덤프 금지(메모리 유출 방지), CPU/출력 크기 상한.
# preexec_fn은 멀티스레드 앱에서 위험하므로 sh의 ulimit로 exec 직전에 건다.
_ULIMIT_PREAMBLE = "ulimit -c 0; ulimit -t 130; ulimit -f 1048576; exec \"$@\""


def convert_to_pdf(src: Path, cache_dir: Path, cache_key: str) -> Path:
    """src(오피스 문서)를 PDF로 변환해 그 경로를 돌려준다.

    cache_dir/<cache_key>.pdf 가 이미 있으면 재사용한다.
    실패하면 OfficeConvertError를 던진다.
    """
    out = cache_dir / f"{cache_key}.pdf"
    if out.is_file():
        return out

    binary = soffice_bin()
    if not binary:
        raise OfficeConvertError("LibreOffice(soffice)가 설치돼 있지 않습니다")

    cache_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        # 동시 변환 시 공유 프로필 잠금 충돌을 피하려 호출마다 별도 UserInstallation
        profile = f"-env:UserInstallation=file://{tmp_path / 'profile'}"
        soffice_cmd = [
            binary,
            "--headless",
            profile,
            "--convert-to",
            "pdf",
            "--outdir",
            str(tmp_path),
            str(src),
        ]
        try:
            subprocess.run(
                # sh가 ulimit을 건 뒤 exec으로 soffice로 대체(중간 프로세스 없음).
                # env는 시크릿을 뺀 최소 환경만 전달.
                ["/bin/sh", "-c", _ULIMIT_PREAMBLE, "sh", *soffice_cmd],
                check=True,
                capture_output=True,
                timeout=120,
                env=_sandbox_env(tmp_path),
            )
        except subprocess.TimeoutExpired as exc:
            raise OfficeConvertError("변환 시간이 초과됐습니다") from exc
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.decode("utf-8", "ignore")[:200] if exc.stderr else ""
            raise OfficeConvertError(f"변환에 실패했습니다: {detail}") from exc

        produced = sorted(tmp_path.glob("*.pdf"))
        if not produced:
            raise OfficeConvertError("변환 결과 PDF가 생성되지 않았습니다")
        # 임시 위치 → 최종 캐시 경로
        shutil.move(str(produced[0]), str(out))

    return out
