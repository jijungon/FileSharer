"""add nodes.updated_by (last editor)

Revision ID: 7e5f9a1b3d45
Revises: 6d4e8f0a2c34
Create Date: 2026-09-17 02:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "7e5f9a1b3d45"
down_revision: str | None = "6d4e8f0a2c34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # nullable 컬럼 추가 — SQLite도 plain add_column으로 처리 가능(FK 제약은 ORM에서만 사용).
    op.add_column("nodes", sa.Column("updated_by", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("nodes") as batch:
        batch.drop_column("updated_by")
