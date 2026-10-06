"""device_auths — CLI 로그인(디바이스 플로우)

Revision ID: ab82c3d4e5f6
Revises: 9a71b2c3d4e5
"""

import sqlalchemy as sa

from alembic import op

revision: str = "ab82c3d4e5f6"
down_revision: str | None = "9a71b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_auths",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("code_hash", sa.String(length=255), nullable=False),
        sa.Column("user_code", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("user_id", sa.String(length=32), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("client_name", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("client_ip", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("space_id", sa.String(length=32), sa.ForeignKey("spaces.id"), nullable=True),
        sa.Column("node_id", sa.String(length=32), sa.ForeignKey("nodes.id"), nullable=True),
        sa.Column("token_days", sa.Integer(), nullable=False, server_default="90"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("last_polled_at", sa.DateTime(), nullable=True),
    )
    # user_code 로 승인 화면이 찾고, status 로 만료 청소가 쓴다
    op.create_index("ix_device_auths_user_code", "device_auths", ["user_code"])
    op.create_index("ix_device_auths_status", "device_auths", ["status"])


def downgrade() -> None:
    op.drop_index("ix_device_auths_status", table_name="device_auths")
    op.drop_index("ix_device_auths_user_code", table_name="device_auths")
    op.drop_table("device_auths")
