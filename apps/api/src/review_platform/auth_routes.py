"""HTTP-вход кабинета, одноразовые PKCE-коды виджета и личные токены."""

import base64
import hashlib
import hmac
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .auth import (
    DUMMY_HASH,
    PASSWORDS,
    Principal,
    authenticate,
    cabinet,
    db_session,
    digest,
    new_session,
    project_role,
    secret,
    user_json,
)
from .models import AuthorizationCode, Credential, Invitation, LoginAttempt, ProjectOrigin, User
from .schemas import Activate, Authorize, Exchange, Login, TokenCreate
from .time import utcnow

router = APIRouter(prefix="/api")


@router.delete("/auth/widget-session", status_code=204)
def logout_widget(principal: Principal = Depends(authenticate), db: Session = Depends(db_session)):
    """Отзывает только текущий доступ виджета, сохраняя вход в кабинет."""
    if principal.cookie or principal.credential.kind != "widget":
        raise HTTPException(403, "Нужен доступ виджета")
    principal.credential.revoked = True
    db.commit()


def login_origin(request: Request) -> None:
    if request.headers.get("Origin") != request.app.state.settings.web_origin:
        raise HTTPException(403, "Вход доступен на домене сервиса")


def session_response(request: Request, response: Response, db: Session, user: User) -> dict:
    credential, raw = new_session(db, user)
    db.commit()
    response.set_cookie(
        request.app.state.settings.cookie_name,
        raw,
        max_age=14 * 86400,
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return {"user": user_json(user), "csrfToken": credential.csrf}


@router.post("/auth/activate")
def activate(
    body: Activate, request: Request, response: Response, db: Session = Depends(db_session)
):
    """Активирует приглашённого пользователя один раз, сразу выдаёт кабинетную сессию."""
    login_origin(request)
    invitation = db.scalar(
        select(Invitation).where(Invitation.digest == digest(body.token)).with_for_update()
    )
    if invitation is None or invitation.used or invitation.expires_at <= utcnow():
        raise HTTPException(400, "Ссылка активации истекла или уже использована")
    user = db.get(User, invitation.user_id)
    if user is None or user.active:
        raise HTTPException(400, "Активация недоступна")
    db.execute(update(Credential).where(Credential.user_id == user.id).values(revoked=True))
    invitation.used = True
    user.password_hash = PASSWORDS.hash(body.password)
    user.active = True
    return session_response(request, response, db, user)


@router.post("/auth/login")
def login(body: Login, request: Request, response: Response, db: Session = Depends(db_session)):
    """Проверяет пароль с серверным ограничением частоты; не раскрывает наличие email."""
    login_origin(request)
    email = body.email.strip().casefold()
    key = digest(email)
    db.execute(
        insert(LoginAttempt)
        .values(key=key, failures=0, window_start=utcnow())
        .on_conflict_do_nothing()
    )
    attempt = db.scalar(select(LoginAttempt).where(LoginAttempt.key == key).with_for_update())
    if attempt.window_start < utcnow() - timedelta(minutes=10):
        attempt.failures = 0
        attempt.window_start = utcnow()
    if attempt.failures >= 5:
        raise HTTPException(429, "Слишком много попыток. Повторите через 10 минут")
    user = db.scalar(select(User).where(User.email == email))
    valid = PASSWORDS.verify(
        body.password, user.password_hash if user and user.password_hash else DUMMY_HASH
    )
    if not valid or user is None or not user.active:
        attempt.failures += 1
        db.commit()
        raise HTTPException(401, "Неверный email или пароль")
    attempt.failures = 0
    return session_response(request, response, db, user)


@router.get("/auth/me")
def me(principal: Principal = Depends(cabinet)):
    return {"user": user_json(principal.user), "csrfToken": principal.credential.csrf}


@router.post("/auth/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    principal: Principal = Depends(cabinet),
    db: Session = Depends(db_session),
):
    """Завершает сессию и выданные из неё доступы виджета."""
    principal.credential.revoked = True
    db.execute(
        update(Credential)
        .where(Credential.parent_id == principal.credential.id)
        .values(revoked=True)
    )
    db.commit()
    response.delete_cookie(request.app.state.settings.cookie_name, path="/")


@router.get("/auth/sessions")
def sessions(principal: Principal = Depends(cabinet), db: Session = Depends(db_session)):
    return [
        {
            "id": row.id,
            "createdAt": row.created_at,
            "lastUsedAt": row.last_used_at,
            "expiresAt": row.expires_at,
            "current": row.id == principal.credential.id,
        }
        for row in db.scalars(
            select(Credential)
            .where(
                Credential.user_id == principal.user.id,
                Credential.kind == "session",
                ~Credential.revoked,
                Credential.expires_at > utcnow(),
            )
            .order_by(Credential.created_at.desc())
        )
    ]


@router.delete("/auth/sessions/{session_id}", status_code=204)
def revoke_session(
    session_id: str, principal: Principal = Depends(cabinet), db: Session = Depends(db_session)
):
    row = db.get(Credential, session_id)
    if row is None or row.user_id != principal.user.id or row.kind != "session":
        raise HTTPException(404, "Сессия недоступна")
    row.revoked = True
    db.execute(update(Credential).where(Credential.parent_id == row.id).values(revoked=True))
    db.commit()


@router.post("/auth/authorize")
def authorize(
    body: Authorize, principal: Principal = Depends(cabinet), db: Session = Depends(db_session)
):
    """Выдаёт двухминутный код только участнику и зарегистрированному origin проекта."""
    project_id = str(body.project_id)
    project_role(db, principal, project_id)
    if db.get(ProjectOrigin, (project_id, body.origin)) is None:
        raise HTTPException(403, "Этот origin не подключён к проекту")
    raw = secret("rv_code_")
    db.add(
        AuthorizationCode(
            digest=digest(raw),
            user_id=principal.user.id,
            project_id=project_id,
            parent_id=principal.credential.id,
            origin=body.origin,
            challenge=body.challenge,
            expires_at=utcnow() + timedelta(minutes=2),
        )
    )
    db.commit()
    return {"code": raw}


@router.post("/auth/exchange")
def exchange(body: Exchange, request: Request, db: Session = Depends(db_session)):
    """Атомарно обменивает PKCE-код один раз; origin и проект изменить нельзя."""
    code = db.scalar(
        select(AuthorizationCode)
        .where(AuthorizationCode.digest == digest(body.code))
        .with_for_update()
    )
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(body.verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    if (
        code is None
        or code.used
        or code.expires_at <= utcnow()
        or code.project_id != str(body.project_id)
        or code.origin != body.origin
        or request.headers.get("Origin") != code.origin
        or not hmac.compare_digest(challenge, code.challenge)
    ):
        raise HTTPException(400, "Код входа недействителен")
    parent = db.get(Credential, code.parent_id)
    user = db.get(User, code.user_id)
    if (
        parent is None
        or parent.revoked
        or parent.expires_at <= utcnow()
        or user is None
        or not user.active
    ):
        raise HTTPException(400, "Сессия входа завершена")
    project_role(db, Principal(user, parent, True), code.project_id)
    if db.get(ProjectOrigin, (code.project_id, code.origin)) is None:
        raise HTTPException(400, "Origin проекта отключён")
    code.used = True
    raw = secret("rv_widget_")
    credential = Credential(
        digest=digest(raw),
        user_id=user.id,
        kind="widget",
        parent_id=parent.id,
        origin=code.origin,
        project_ids=[code.project_id],
        scopes=["comments:read", "comments:write", "screenshots:read"],
        expires_at=utcnow() + timedelta(minutes=15),
    )
    db.add(credential)
    db.commit()
    return {
        "accessToken": raw,
        "expiresAt": credential.expires_at,
        "user": {"id": user.id, "name": user.name},
    }


def token_json(row: Credential) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "projectIds": row.project_ids,
        "scopes": row.scopes,
        "expiresAt": row.expires_at,
        "createdAt": row.created_at,
        "lastUsedAt": row.last_used_at,
        "revoked": row.revoked,
    }


@router.post("/tokens", status_code=201)
def create_token(
    body: TokenCreate, principal: Principal = Depends(cabinet), db: Session = Depends(db_session)
):
    """Показывает PAT один раз. Полномочия не превышают текущие права владельца."""
    projects = sorted({str(value) for value in body.project_ids})
    for project_id in projects:
        project_role(db, principal, project_id)
    scopes = sorted(set(body.scopes))
    if "comments:write" in scopes and "comments:read" not in scopes:
        raise HTTPException(422, "Запись комментариев требует также разрешение чтения")
    raw = secret("rv_pat_")
    credential = Credential(
        digest=digest(raw),
        user_id=principal.user.id,
        kind="pat",
        name=body.name,
        project_ids=projects,
        scopes=scopes,
        expires_at=utcnow() + timedelta(days=body.expires_in_days),
    )
    db.add(credential)
    db.commit()
    return {**token_json(credential), "secret": raw}


@router.get("/tokens")
def tokens(principal: Principal = Depends(cabinet), db: Session = Depends(db_session)):
    return [
        token_json(row)
        for row in db.scalars(
            select(Credential)
            .where(Credential.user_id == principal.user.id, Credential.kind == "pat")
            .order_by(Credential.created_at.desc())
        )
    ]


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(
    token_id: str, principal: Principal = Depends(cabinet), db: Session = Depends(db_session)
):
    row = db.get(Credential, token_id)
    if row is None or row.user_id != principal.user.id or row.kind != "pat":
        raise HTTPException(404, "Токен недоступен")
    row.revoked = True
    db.commit()
