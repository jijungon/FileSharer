"""api_tokens.expires_at 을 필수로 — 영원히 유효한 토큰을 없앤다

공유 링크(share_links.expires_at)는 처음부터 만료가 필수였는데 API 토큰만 빠져 있었다.
같은 설계를 두 곳에 다르게 적용한 셈이고, 그래서 한 번도 안 쓰인 토큰이 영원히 살아
있었다. 본인만 자기 토큰을 볼 수 있으므로(관리자도 못 본다) 사람이 떠나면 회수할
길이 없다.

**기존 NULL 은 '지금부터 90일' 로 채운다.** 두 가지를 저울질했다:

  즉시 만료    — 규칙엔 가장 충실하지만, 지금 돌고 있는 CLI·스크립트가 **그 순간**
                 멈춘다. 사람이 안 보고 있을 때 깨질 수 있다.
  지금부터 90일 — 돌던 것은 그대로 돌고, 90일 안에 한 번은 다시 로그인하게 된다.
                 '영원히'는 사라지고 아무것도 깨지지 않는다.

뒤쪽을 골랐다. 목적은 '지금 당장 끊기'가 아니라 **무기한을 없애는 것**이다.

Revision ID: cd04e5f60718
Revises: bc93d4e5f607
"""

from datetime import UTC, datetime, timedelta

import sqlalchemy as sa

from alembic import op

revision = "cd04e5f60718"
down_revision = "bc93d4e5f607"
branch_labels = None
depends_on = None


def upgrade() -> None:
    grace = datetime.now(UTC).replace(tzinfo=None) + timedelta(days=90)
    op.execute(
        sa.text("UPDATE api_tokens SET expires_at = :g WHERE expires_at IS NULL").bindparams(
            g=grace
        )
    )
    # SQLite 는 컬럼을 제자리에서 못 바꾼다 — batch 가 표를 새로 만들어 옮겨준다.
    with op.batch_alter_table("api_tokens", schema=None) as batch_op:
        batch_op.alter_column("expires_at", existing_type=sa.DateTime(), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("api_tokens", schema=None) as batch_op:
        batch_op.alter_column("expires_at", existing_type=sa.DateTime(), nullable=True)
