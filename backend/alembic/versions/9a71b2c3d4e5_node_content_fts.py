"""add node_content_fts (FTS5 trigram content index for file search)

Revision ID: 9a71b2c3d4e5
Revises: 8f60a1b2c3d4
Create Date: 2026-09-23 06:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "9a71b2c3d4e5"
down_revision: str | None = "8f60a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 파일 내용 전문검색용 FTS5 가상 테이블. 트라이그램 토크나이저라 3자 이상
    # LIKE '%term%' 가 인덱스로 가속된다. node_id 는 조인용이라 UNINDEXED.
    op.execute(
        "CREATE VIRTUAL TABLE node_content_fts "
        "USING fts5(node_id UNINDEXED, content, tokenize='trigram')"
    )


def downgrade() -> None:
    op.execute("DROP TABLE node_content_fts")
