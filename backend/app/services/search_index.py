"""파일 내용(전문) 검색 인덱스 — SQLite FTS5 트라이그램.

검색 때마다 R2/로컬 스토리지에서 텍스트 blob을 수백 개씩 읽어 스캔하던 느린 경로를
없앤다. 대신 파일이 바뀔 때(업로드·저장·복사) 그 내용을 ``node_content_fts`` 가상
테이블에 적재해 두고, 검색은 그 테이블만 LIKE로 훑는다. 트라이그램 토크나이저라
3자 이상 ``LIKE '%term%'`` 는 인덱스로 가속된다(3자 미만은 in-DB 내용 스캔으로 폴백).

이름 매치는 기존대로 ``nodes`` 테이블에서 처리하므로 여기선 내용 매치만 담당한다.
소프트 삭제/리네임은 내용이 그대로라 인덱스를 건드릴 필요가 없다(검색이 조인에서
``deleted_at IS NULL`` 로 거른다).
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..models import Node
from .storage import StorageBackend

logger = logging.getLogger("filesharer")


def index_node(db: Session, storage: StorageBackend, node: Node) -> None:
    """node의 내용을 FTS 인덱스에 반영한다(요청 세션 안에서 — 커밋은 호출부/미들웨어가).

    텍스트 파일이면 앞부분을 읽어 (재)적재하고, 아니면(타입이 바뀌었을 수 있으니) 기존
    행을 지우기만 한다. 스토리지 읽기 실패는 삼켜서(로그만 남기고) 요청을 깨지 않는다.

    순서가 중요하다: **느린 스토리지 읽기를 먼저** 끝내고 그 다음에 DELETE/INSERT 한다.
    쓰기를 먼저 하면 SQLite 쓰기 잠금을 쥔 채 원격(R2) 왕복을 기다리게 되어, 그동안 다른
    요청의 쓰기가 busy_timeout 안에 못 들어와 "database is locked" 로 실패할 수 있다.
    """
    # 순환 임포트 방지: 텍스트 판정 헬퍼는 api.nodes 에 있고, 그쪽이 이 모듈을 임포트한다.
    from ..api.nodes import _CONTENT_MAX_BYTES, _is_text_node

    node_id = node.id
    content: str | None = None
    if _is_text_node(node) and node.storage_key:
        try:
            with storage.open_stream(node.storage_key) as fh:
                blob = fh.read(_CONTENT_MAX_BYTES)
            content = blob.decode("utf-8", "ignore")
        except Exception:
            # 읽기 실패 → 인덱스에서 빼둔다(아래 DELETE만 수행). 다음 저장 때 다시 채워진다.
            logger.exception("FTS 인덱싱: 내용 읽기 실패 node=%s", node_id)

    # 여기서부터가 쓰기 구간 — 잠금을 짧게 잡기 위해 읽기가 끝난 뒤에 둔다.
    # 기존 행은 항상 지운다(내용 갱신·타입 변경·읽기 실패 모두 커버).
    db.execute(text("DELETE FROM node_content_fts WHERE node_id = :id"), {"id": node_id})
    if content is None:
        return
    db.execute(
        text("INSERT INTO node_content_fts (node_id, content) VALUES (:id, :content)"),
        {"id": node_id, "content": content},
    )


def remove_node(db: Session, node_id: str) -> None:
    """node의 FTS 행을 제거한다(영구 삭제 시). 가상 테이블엔 FK가 없어 명시적으로 지운다."""
    db.execute(text("DELETE FROM node_content_fts WHERE node_id = :id"), {"id": node_id})


def search_content_ids(db: Session, space_id: str, term: str) -> set[str]:
    """space 안에서 내용에 term이 포함된(비삭제) 파일 node id 집합을 돌려준다.

    LIKE 와일드카드(``% _``)와 이스케이프 문자(``\\``)는 리터럴로 처리한다.
    """
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    rows = db.execute(
        text(
            "SELECT f.node_id FROM node_content_fts f "
            "JOIN nodes n ON n.id = f.node_id "
            "WHERE n.space_id = :sid AND n.deleted_at IS NULL "
            "AND f.content LIKE :like ESCAPE '\\'"
        ),
        {"sid": space_id, "like": like},
    ).all()
    return {r[0] for r in rows}


def backfill(db: Session, storage: StorageBackend) -> int:
    """아직 인덱싱되지 않은 텍스트 파일을 모두 인덱싱한다. 반환: 인덱싱한 파일 수.

    기동 시 1회 백그라운드로 돌려 기존 데이터를 채운다. 이미 인덱스에 있는 파일은
    건너뛰므로 재기동에도 안전(idempotent)하다.
    """
    from ..api.nodes import _is_text_node

    rows = db.execute(
        text(
            "SELECT n.id FROM nodes n "
            "WHERE n.type = 'file' AND n.deleted_at IS NULL "
            "AND n.storage_key <> '' "
            "AND n.id NOT IN (SELECT node_id FROM node_content_fts)"
        )
    ).all()
    ids = [r[0] for r in rows]
    count = 0
    for nid in ids:
        node = db.get(Node, nid)
        if node is None or not _is_text_node(node):
            continue
        index_node(db, storage, node)
        # 파일마다 커밋한다. 묶어서 커밋하면 트랜잭션 하나가 여러 번의 (느린) 원격 읽기
        # 동안 SQLite 쓰기 잠금을 쥐고 있어, 배포 직후 백필이 도는 내내 사용자의
        # 업로드·저장이 busy_timeout 을 넘겨 "database is locked" 로 실패할 수 있다.
        db.commit()
        count += 1
    return count
