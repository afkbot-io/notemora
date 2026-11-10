"""HTTP-контракт для виджета и MCP: обсуждения и закрытые снимки."""

import hashlib
from datetime import timedelta
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from .auth import Principal, authenticate, db_session, project_role, require_scope
from .models import Attachment, Comment, Thread, identifier
from .reviews import add_message, attachment_json, safe_context, thread_json, threads_json
from .schemas import CaptureContext, CreateThread, Reply
from .storage import MAX_UPLOAD, normalize_image
from .time import utcnow

router = APIRouter(prefix="/api/v1/projects/{project_id}")


@router.get("/session")
def session(
    project_id: str, principal: Principal = Depends(authenticate), db: Session = Depends(db_session)
):
    project_role(db, principal, project_id)
    require_scope(principal, "comments:read")
    return {
        "user": {"id": principal.user.id, "name": principal.user.name},
        "storage": "shared",
        "csrfToken": principal.credential.csrf if principal.cookie else "bearer",
    }


@router.get("/threads")
def threads(
    project_id: str,
    surface: str | None = None,
    search: str = Query(default="", max_length=200, pattern=r"^[^\x00]*$"),
    page_key: str | None = Query(default=None, alias="pageKey", max_length=300),
    cursor: UUID | None = None,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    """Возвращает до 100 обсуждений с keyset-пагинацией, поиск только по своему проекту."""
    role = project_role(db, principal, project_id)
    require_scope(principal, "comments:read")
    query = (
        select(Thread)
        .where(
            Thread.project_id == project_id,
            exists().where(Comment.thread_id == Thread.id, Comment.expires_at > utcnow()),
        )
        .order_by(Thread.id)
    )
    if surface:
        if surface not in {"app", "storybook"}:
            raise HTTPException(422, "Неизвестная поверхность")
        query = query.where(Thread.surface == surface)
    if page_key:
        query = query.where(Thread.page_key == page_key)
    if cursor:
        query = query.where(Thread.id > str(cursor))
    if search:
        pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.where(
            or_(
                Thread.context["pageTitle"].as_string().ilike(pattern),
                Thread.anchor["label"].as_string().ilike(pattern),
                exists().where(
                    Comment.thread_id == Thread.id,
                    Comment.expires_at > utcnow(),
                    Comment.body.ilike(pattern),
                ),
            )
        )
    rows = list(db.scalars(query.limit(101)))
    return {
        "threads": threads_json(db, rows[:100], principal, role),
        "nextCursor": rows[99].id if len(rows) > 100 else None,
    }


@router.get("/threads/{thread_id}")
def get_thread(
    project_id: str,
    thread_id: str,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    role = project_role(db, principal, project_id)
    require_scope(principal, "comments:read")
    row = db.scalar(select(Thread).where(Thread.id == thread_id, Thread.project_id == project_id))
    if row is None:
        raise HTTPException(404, "Обсуждение недоступно")
    result = thread_json(db, row, principal, role)
    if not result["comments"]:
        raise HTTPException(404, "Обсуждение недоступно")
    return result


@router.post("/threads", status_code=201)
def create(
    project_id: str,
    body: CreateThread,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    role = project_role(db, principal, project_id)
    require_scope(principal, "comments:write")
    return thread_json(db, add_message(db, project_id, principal, body), principal, role)


@router.post("/threads/{thread_id}/comments", status_code=201)
def reply(
    project_id: str,
    thread_id: str,
    body: Reply,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    role = project_role(db, principal, project_id)
    require_scope(principal, "comments:write")
    return thread_json(db, add_message(db, project_id, principal, body, thread_id), principal, role)


@router.delete("/comments/{comment_id}", status_code=204)
def remove(
    project_id: str,
    comment_id: str,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    """Удаление сообщения сразу закрывает доступ к файлам; физическая очистка фоновая."""
    role = project_role(db, principal, project_id)
    require_scope(principal, "comments:write")
    comment = db.scalar(
        select(Comment)
        .join(Thread)
        .where(
            Comment.id == comment_id, Thread.project_id == project_id, Comment.expires_at > utcnow()
        )
        .with_for_update()
    )
    if comment is None:
        raise HTTPException(404, "Сообщение недоступно")
    if comment.user_id != principal.user.id and role not in {"owner", "moderator"}:
        raise HTTPException(403, "Можно удалить только своё сообщение")
    for attachment in db.scalars(select(Attachment).where(Attachment.comment_id == comment.id)):
        attachment.state = "deleted"
    db.delete(comment)
    db.commit()


@router.post("/attachments", status_code=201)
def upload(
    project_id: str,
    request: Request,
    file: UploadFile = File(),
    context: str = Form(default="{}", max_length=8000),
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    """Принимает только изображение до 5 МиБ. Неиспользованный upload живёт час."""
    project_role(db, principal, project_id)
    require_scope(principal, "comments:write")
    try:
        metadata = CaptureContext.model_validate_json(context).model_dump(
            mode="json", by_alias=True, exclude_none=True
        )
        metadata = safe_context(db, project_id, metadata)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "Неверный контекст снимка") from error
    raw = file.file.read(MAX_UPLOAD + 1)
    normalized, width, height = normalize_image(raw)
    row = Attachment(
        id=identifier(),
        project_id=project_id,
        user_id=principal.user.id,
        width=width,
        height=height,
        size=len(normalized),
        checksum=hashlib.sha256(normalized).hexdigest(),
        context=metadata,
    )
    request.app.state.storage.put(row.id, normalized)
    try:
        db.add(row)
        db.commit()
    except Exception:
        request.app.state.storage.delete(row.id)
        raise
    return attachment_json(row)


@router.get("/attachments/{attachment_id}")
def attachment(
    project_id: str,
    attachment_id: str,
    request: Request,
    principal: Principal = Depends(authenticate),
    db: Session = Depends(db_session),
):
    """Каждая выдача проверяет проект, scope, статус и срок исходного сообщения."""
    project_role(db, principal, project_id)
    require_scope(principal, "screenshots:read")
    row = db.get(Attachment, attachment_id)
    if row is None or row.project_id != project_id or row.state == "deleted":
        raise HTTPException(404, "Снимок недоступен")
    if row.comment_id:
        comment = db.get(Comment, row.comment_id)
        if comment is None or comment.expires_at <= utcnow():
            raise HTTPException(404, "Снимок недоступен")
    elif (
        row.state != "uploaded"
        or row.user_id != principal.user.id
        or row.created_at < utcnow() - timedelta(hours=1)
    ):
        raise HTTPException(404, "Снимок недоступен")
    try:
        value = request.app.state.storage.get(row.id)
    except FileNotFoundError as error:
        raise HTTPException(404, "Снимок недоступен") from error
    return Response(
        value,
        media_type="image/webp",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
