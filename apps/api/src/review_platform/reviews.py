"""Транзакционные обсуждения, вложения, повторы отправки и TTL каждого сообщения."""

import json
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException
from sqlalchemy import delete, exists, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .auth import TTL, Principal, digest
from .models import Attachment, Comment, Operation, ProjectOrigin, Thread, User, identifier
from .schemas import CreateThread, Reply
from .storage import Storage
from .time import utcnow


def attachment_json(row: Attachment) -> dict:
    return {
        "id": row.id,
        "width": row.width,
        "height": row.height,
        "size": row.size,
        "contentType": "image/webp",
        "context": row.context,
    }


def threads_json(db: Session, threads: list[Thread], principal: Principal, role: str) -> list[dict]:
    """Собирает активные сообщения/авторов/снимки двумя запросами для всей страницы."""
    if not threads:
        return []
    rows = list(
        db.execute(
            select(Comment, User.name)
            .join(User, User.id == Comment.user_id)
            .where(
                Comment.thread_id.in_([thread.id for thread in threads]),
                Comment.expires_at > utcnow(),
            )
            .order_by(Comment.created_at, Comment.id)
        )
    )
    files = (
        db.scalars(
            select(Attachment).where(
                Attachment.comment_id.in_([row.id for row, _ in rows]), Attachment.state == "linked"
            )
        )
        if rows
        else []
    )
    by_comment: dict[str, list[dict]] = {}
    for file in files:
        by_comment.setdefault(file.comment_id, []).append(attachment_json(file))
    by_thread: dict[str, list[dict]] = {}
    for row, name in rows:
        by_thread.setdefault(row.thread_id, []).append(
            {
                "id": row.id,
                "body": row.body,
                "author": {"id": row.user_id, "name": name},
                "createdAt": row.created_at,
                "expiresAt": row.expires_at,
                "canDelete": (principal.cookie or "comments:write" in principal.credential.scopes)
                and (row.user_id == principal.user.id or role in {"owner", "moderator"}),
                "captureState": row.capture_state,
                "attachments": by_comment.get(row.id, []),
            }
        )
    return [
        {
            "id": thread.id,
            "context": thread.context,
            "anchor": thread.anchor,
            "comments": by_thread.get(thread.id, []),
        }
        for thread in threads
    ]


def thread_json(db: Session, thread: Thread, principal: Principal, role: str) -> dict:
    """Возвращает одно обсуждение; истёкшие сообщения скрыты до физической очистки."""
    return threads_json(db, [thread], principal, role)[0]


def safe_context(db: Session, project_id: str, context: dict) -> dict:
    """Разрешает только origin проекта; query и fragment исключаются из снимка страницы."""
    value = context.get("url", "")
    if value:
        parts = urlsplit(value)
        origin = f"{parts.scheme}://{parts.netloc}"
        if parts.username or parts.password or db.get(ProjectOrigin, (project_id, origin)) is None:
            raise HTTPException(422, "Адрес страницы не относится к проекту")
        context = {**context, "url": urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))}
    return context


def add_message(
    db: Session, project_id: str, principal: Principal, payload: Reply, thread_id: str | None = None
) -> Thread:
    """Сохраняет сообщение один раз. Повтор удалённого/истёкшего сообщения даёт 409."""
    data = payload.model_dump(mode="json", by_alias=True)
    fingerprint = digest(
        json.dumps({"thread": thread_id, "payload": data}, sort_keys=True, ensure_ascii=False)
    )
    operation_id = identifier()
    inserted = db.scalar(
        insert(Operation)
        .values(
            id=operation_id,
            project_id=project_id,
            user_id=principal.user.id,
            request_id=str(payload.request_id),
            fingerprint=fingerprint,
            expires_at=utcnow() + TTL,
        )
        .on_conflict_do_nothing()
        .returning(Operation.id)
    )
    if inserted is None:
        operation = db.scalar(
            select(Operation)
            .where(
                Operation.project_id == project_id,
                Operation.user_id == principal.user.id,
                Operation.request_id == str(payload.request_id),
            )
            .with_for_update()
        )
        if operation is None or operation.fingerprint != fingerprint:
            raise HTTPException(409, "Этот запрос уже использован для другого сообщения")
        comment = db.get(Comment, operation.comment_id) if operation.comment_id else None
        if comment is None or comment.expires_at <= utcnow():
            raise HTTPException(409, "Ранее отправленное сообщение удалено или истекло")
        return db.get(Thread, comment.thread_id)
    operation = db.get(Operation, operation_id)
    if thread_id:
        thread = db.scalar(
            select(Thread)
            .where(Thread.id == thread_id, Thread.project_id == project_id)
            .with_for_update()
        )
        if thread is None or not db.scalar(
            select(exists().where(Comment.thread_id == thread.id, Comment.expires_at > utcnow()))
        ):
            raise HTTPException(404, "Обсуждение недоступно")
    else:
        if not isinstance(payload, CreateThread):
            raise HTTPException(422, "Нужен контекст блока")
        context = safe_context(db, project_id, data["context"])
        anchor = data["anchor"]
        values = dict(
            id=identifier(),
            project_id=project_id,
            surface=context["surface"],
            page_key=context["pageKey"],
            anchor_digest=digest(anchor["key"]),
            context=context,
            anchor=anchor,
        )
        thread = db.scalar(
            insert(Thread)
            .values(**values)
            .on_conflict_do_update(
                index_elements=[
                    Thread.project_id,
                    Thread.surface,
                    Thread.page_key,
                    Thread.anchor_digest,
                ],
                set_={"id": Thread.id},
            )
            .returning(Thread)
        )
    files = []
    for file_id in payload.attachment_ids:
        row = db.scalar(select(Attachment).where(Attachment.id == str(file_id)).with_for_update())
        if (
            row is None
            or row.project_id != project_id
            or row.user_id != principal.user.id
            or row.state != "uploaded"
            or row.created_at < utcnow() - timedelta(hours=1)
        ):
            raise HTTPException(422, "Снимок недоступен или уже прикреплён")
        files.append(row)
    if payload.capture_state == "captured" and not files:
        raise HTTPException(422, "Состояние captured требует снимок")
    comment = Comment(
        thread_id=thread.id,
        user_id=principal.user.id,
        body=payload.body,
        capture_state=payload.capture_state,
        expires_at=utcnow() + TTL,
    )
    db.add(comment)
    db.flush()
    for row in files:
        row.state = "linked"
        row.comment_id = comment.id
    operation.comment_id = comment.id
    operation.expires_at = comment.expires_at
    db.commit()
    return thread


def purge_expired(db: Session, storage: Storage) -> dict[str, int]:
    """Удаляет до 500 вложений за запуск; не затрагивает активные сообщения."""
    now = utcnow()
    expired_message = select(Comment.id).where(Comment.expires_at <= now)
    candidates = db.scalars(
        select(Attachment)
        .where(
            or_(
                Attachment.state == "deleted",
                Attachment.comment_id.in_(expired_message),
                (Attachment.state == "uploaded")
                & (Attachment.created_at < now - timedelta(hours=1)),
            )
        )
        .limit(500)
        .with_for_update(skip_locked=True)
    )
    count = 0
    for row in candidates:
        storage.delete(row.id)
        db.delete(row)
        count += 1
    # Сначала удаляем связанные файлы; большие очереди сохраняют строки для следующей пачки.
    has_files = exists().where(Attachment.comment_id == Comment.id)
    deleted = db.execute(delete(Comment).where(Comment.expires_at <= now, ~has_files)).rowcount
    # Пишущая транзакция владеет строкой блока. Не ждём её и повторно проверяем
    # отсутствие сообщений после захвата блокировки: новый ответ не удалится.
    empty_threads = list(
        db.scalars(
            select(Thread.id)
            .where(~exists().where(Comment.thread_id == Thread.id))
            .limit(500)
            .with_for_update(skip_locked=True)
        )
    )
    if empty_threads:
        db.execute(
            delete(Thread).where(
                Thread.id.in_(empty_threads), ~exists().where(Comment.thread_id == Thread.id)
            )
        )
    db.execute(delete(Operation).where(Operation.expires_at <= now))
    db.commit()
    return {"attachments": count, "comments": deleted}
