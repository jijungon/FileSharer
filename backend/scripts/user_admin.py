"""계정 비상 도구 — 서버 셸에서 직접 역할을 바꾸거나 계정을 만든다.

**왜 필요한가**: 지금 구조에는 막다른 길이 있다.
  * 부트스트랩 관리자는 `users` 테이블이 **비어 있을 때만** 만들어진다.
  * 구글 로그인은 **최초 1인만** admin, 그 뒤는 member.
  * 역할 변경은 **관리자만** 할 수 있다.
따라서 **관리자 비밀번호를 잃으면 관리자 기능에 영영 못 들어간다.** 이 스크립트가 그 탈출구다.

**보안**: 새로 뚫는 구멍이 아니다. 서버 셸 + DB 파일 접근 권한이 있어야 실행되는데,
그 권한이 있으면 이미 최고 권한이다. 웹으로는 닿지 않는다.
비밀번호는 인자로 받지 않고 **물어본다**(셸 히스토리·`ps` 노출 방지).

사용:
  python backend/scripts/user_admin.py list
  python backend/scripts/user_admin.py promote joji@parametacorp.com
  python backend/scripts/user_admin.py demote someone@parametacorp.com
  python backend/scripts/user_admin.py create test@parametacorp.com [--role member]
  python backend/scripts/user_admin.py reset-password admin@parametacorp.com
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.exc import OperationalError  # noqa: E402

from app.bootstrap import create_user  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import build_engine, make_sessionmaker  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password  # noqa: E402

ROLES = ("admin", "member")


def _session():  # noqa: ANN202
    settings = get_settings()
    engine = build_engine(settings.database_url)
    try:
        with engine.connect() as con:
            con.execute(text("select 1 from users limit 1"))
    except OperationalError:
        # 비상 도구가 트레이스백을 토하면 급할 때 더 당황한다 — 무엇이 잘못됐는지만 말한다
        print(f"DB를 읽을 수 없습니다: {settings.database_url}")
        print("DATABASE_URL 이 맞는지, 앱이 한 번이라도 기동해 스키마가 만들어졌는지 확인하세요.")
        raise SystemExit(1) from None
    return make_sessionmaker(engine)


def _find(db, email: str) -> User:  # noqa: ANN001
    user = db.scalar(select(User).where(User.email == email.lower().strip()))
    if user is None:
        print(f"그런 계정이 없습니다: {email}")
        raise SystemExit(1)
    return user


def _ask_password(email: str) -> str:
    first = getpass.getpass(f"{email} 의 새 비밀번호: ")
    if len(first) < 8:
        print("비밀번호는 8자 이상이어야 합니다.")
        raise SystemExit(1)
    if first != getpass.getpass("한 번 더: "):
        print("두 번 입력이 다릅니다.")
        raise SystemExit(1)
    return first


def cmd_list(_args) -> None:  # noqa: ANN001
    with _session()() as db:
        rows = db.scalars(select(User).order_by(User.created_at)).all()
        print(f"{'이메일':<34}{'역할':<9}{'로그인':<11}{'상태'}")
        print("-" * 64)
        for u in rows:
            how = "비밀번호" if u.password_hash else "구글전용"
            state = "비활성" if u.disabled_at else "활성"
            print(f"{u.email:<34}{u.role:<9}{how:<11}{state}")
        admins = [u.email for u in rows if u.role == "admin" and not u.disabled_at]
        print(f"\n활성 관리자 {len(admins)}명: {', '.join(admins) or '(없음 — 위험)'}")


def cmd_promote(args) -> None:  # noqa: ANN001
    with _session()() as db:
        user = _find(db, args.email)
        if user.role == "admin":
            print(f"이미 관리자입니다: {user.email}")
            return
        user.role = "admin"
        db.commit()
        print(f"관리자로 올렸습니다: {user.email}")


def cmd_demote(args) -> None:  # noqa: ANN001
    with _session()() as db:
        user = _find(db, args.email)
        others = db.scalars(
            select(User).where(
                User.role == "admin", User.id != user.id, User.disabled_at.is_(None)
            )
        ).all()
        if user.role == "admin" and not others:
            # 마지막 관리자를 내리면 아무도 역할을 되돌릴 수 없다(이 스크립트 말고는)
            print("마지막 관리자입니다. 다른 관리자를 먼저 만든 뒤에 내리세요.")
            raise SystemExit(1)
        user.role = "member"
        db.commit()
        print(f"일반 사용자로 내렸습니다: {user.email}")


def cmd_create(args) -> None:  # noqa: ANN001
    email = args.email.lower().strip()
    with _session()() as db:
        if db.scalar(select(User).where(User.email == email)):
            print(f"이미 있는 계정입니다: {email}")
            raise SystemExit(1)
        password = _ask_password(email)
        user = create_user(db, email=email, role=args.role, password=password)
        db.commit()
        print(f"만들었습니다: {user.email} ({user.role}) · 개인 공간도 함께 생성")


def cmd_reset_password(args) -> None:  # noqa: ANN001
    with _session()() as db:
        user = _find(db, args.email)
        user.password_hash = hash_password(_ask_password(user.email))
        db.commit()
        print(f"비밀번호를 바꿨습니다: {user.email}")


def main() -> None:
    ap = argparse.ArgumentParser(description="계정 비상 도구 (서버 셸 전용)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="계정과 역할을 본다").set_defaults(func=cmd_list)

    p = sub.add_parser("promote", help="관리자로 올린다")
    p.add_argument("email")
    p.set_defaults(func=cmd_promote)

    p = sub.add_parser("demote", help="일반 사용자로 내린다")
    p.add_argument("email")
    p.set_defaults(func=cmd_demote)

    p = sub.add_parser("create", help="계정을 만든다(비밀번호는 물어본다)")
    p.add_argument("email")
    p.add_argument("--role", choices=ROLES, default="member")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("reset-password", help="비밀번호를 바꾼다")
    p.add_argument("email")
    p.set_defaults(func=cmd_reset_password)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
