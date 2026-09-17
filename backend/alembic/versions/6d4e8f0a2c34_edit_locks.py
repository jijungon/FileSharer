"""add edit_locks (editing lock) table

Revision ID: 6d4e8f0a2c34
Revises: 5c3d7e9f1b23
Create Date: 2026-09-17 01:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "6d4e8f0a2c34"
down_revision: str | None = "5c3d7e9f1b23"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "edit_locks",
        sa.Column("node_id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["node_id"], ["nodes.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("node_id"),
    )
    op.create_index("ix_edit_locks_user_id", "edit_locks", ["user_id"])
    op.create_index("ix_edit_locks_heartbeat_at", "edit_locks", ["heartbeat_at"])


def downgrade() -> None:
    op.drop_index("ix_edit_locks_heartbeat_at", table_name="edit_locks")
    op.drop_index("ix_edit_locks_user_id", table_name="edit_locks")
    op.drop_table("edit_locks")
