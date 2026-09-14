"""add nodes.sha256

Revision ID: 3a1b2c4d5e6f
Revises: 2d3000644ea0
Create Date: 2026-09-15 09:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "3a1b2c4d5e6f"
down_revision: str | None = "2d3000644ea0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "nodes",
        sa.Column("sha256", sa.String(length=64), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("nodes", "sha256")
