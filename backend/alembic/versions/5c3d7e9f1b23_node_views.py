"""add node_views (recently viewed) table

Revision ID: 5c3d7e9f1b23
Revises: 4b2c6d8e0a12
Create Date: 2026-09-16 06:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "5c3d7e9f1b23"
down_revision: str | None = "4b2c6d8e0a12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "node_views",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("node_id", sa.String(length=32), nullable=False),
        sa.Column("viewed_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["node_id"], ["nodes.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "node_id", name="uq_nodeview_user_node"),
    )
    op.create_index("ix_node_views_user_id", "node_views", ["user_id"])
    op.create_index("ix_node_views_node_id", "node_views", ["node_id"])
    op.create_index("ix_node_views_viewed_at", "node_views", ["viewed_at"])


def downgrade() -> None:
    op.drop_index("ix_node_views_viewed_at", table_name="node_views")
    op.drop_index("ix_node_views_node_id", table_name="node_views")
    op.drop_index("ix_node_views_user_id", table_name="node_views")
    op.drop_table("node_views")
