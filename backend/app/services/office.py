"""오피스 문서(PPT·워드·엑셀 등) → PDF 변환.

브라우저가 자체 렌더하지 못하는 형식을 LibreOffice(headless)로 PDF로 바꿔
기존 PDF 뷰어로 보여준다. 변환 결과는 cache_key(보통 blob의 storage_key)로
캐시해 같은 파일을 다시 열 때 재변환하지 않는다.
"""

import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

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
        try:
            subprocess.run(
                [
                    binary,
                    "--headless",
                    profile,
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(tmp_path),
                    str(src),
                ],
                check=True,
                capture_output=True,
                timeout=120,
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
