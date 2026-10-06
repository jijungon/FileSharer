"""share_links: 메모(label) + 토큰 앞자리(token_prefix)

발급된 링크가 목록에서 전부 똑같아 보여 어느 걸 회수할지 알 수 없었다.

Revision ID: bc93d4e5f607
Revises: ab82c3d4e5f6
"""

import sqlalchemy as sa

from alembic import op

revision: str = "bc93d4e5f607"
down_revision: str | None = "ab82c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 기존 행은 빈 값으로 들어온다. 토큰 원문은 해시로만 있어 접두사를 되살릴 길이 없다.
    op.add_column(
        "share_links",
        sa.Column("label", sa.String(length=120), nullable=False, server_default=""),
    )
    op.add_column(
        "share_links",
        sa.Column("token_prefix", sa.String(length=12), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("share_links", "token_prefix")
    op.drop_column("share_links", "label")
