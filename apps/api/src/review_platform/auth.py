"""Отдельные учётные записи, серверные сессии и ограниченные персональные токены."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, HTTPException, Request
from pwdlib import PasswordHash
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from .models import Credential, Invitation, Membership, Project, User
from .time import utcnow

PASSWORDS = PasswordHash.recommended()
DUMMY_HASH = PASSWORDS.hash("unusable-synthetic-password-for-timing")
TTL = timedelta(days=7)


def digest(value: str) -> str:
    """Хеширует случайный bearer-секрет; исходное значение в БД не хранится."""
    return hashlib.sha256(value.encode()).hexdigest()


def secret(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def db_session(request: Request):
    """Владеет Session запроса. Незавершённая запись откатывается при закрытии."""
    with Session(request.app.state.engine) as db:
        yield db


@dataclass
class Principal:
    user: User
    credential: Credential
    cookie: bool


def authenticate(request: Request, db: Session = Depends(db_session)) -> Principal:
    """Проверяет отзыв/TTL/аккаунт при каждом запросе; cookie-записи требуют CSRF."""
    header = request.headers.get("Authorization", "")
    cookie = not header
    raw = (
        request.cookies.get(request.app.state.settings.cookie_name, "")
        if cookie
        else header.removeprefix("Bearer ")
    )
    if not raw or (not cookie and not header.startswith("Bearer ")):
        raise HTTPException(401, "Войдите в сервис комментариев")
    credential = db.scalar(select(Credential).where(Credential.digest == digest(raw)))
    if credential is None or credential.revoked or credential.expires_at <= utcnow():
        raise HTTPException(401, "Доступ истёк или отозван")
    if cookie and credential.kind != "session":
        raise HTTPException(401, "Неверная сессия")
    user = db.get(User, credential.user_id)
    if user is None or not user.active:
        raise HTTPException(401, "Аккаунт недоступен")
    if cookie and request.headers.get("Origin") not in {
        None,
        request.app.state.settings.web_origin,
    }:
        raise HTTPException(403, "Cookie-сессия предназначена для кабинета")
    if credential.parent_id:
        parent = db.get(Credential, credential.parent_id)
        if parent is None or parent.revoked or parent.expires_at <= utcnow():
            raise HTTPException(401, "Основная сессия завершена")
    if credential.kind == "widget" and request.headers.get("Origin") != credential.origin:
        raise HTTPException(403, "Доступ выдан другому origin")
    if cookie and request.method not in {"GET", "HEAD", "OPTIONS"}:
        if request.headers.get(
            "Origin"
        ) != request.app.state.settings.web_origin or not hmac.compare_digest(
            request.headers.get("X-CSRF-Token", ""), credential.csrf
        ):
            raise HTTPException(403, "Проверка CSRF не пройдена")
    if credential.last_used_at is None or credential.last_used_at < utcnow() - timedelta(minutes=1):
        credential.last_used_at = utcnow()
        db.commit()
    return Principal(user, credential, cookie)


def cabinet(principal: Principal = Depends(authenticate)) -> Principal:
    """Виджет и PAT не могут управлять аккаунтами или выпускать другие токены."""
    if not principal.cookie or principal.credential.kind != "session":
        raise HTTPException(403, "Откройте личный кабинет")
    return principal


def owner(principal: Principal = Depends(cabinet)) -> Principal:
    if not principal.user.owner:
        raise HTTPException(403, "Нужны права администратора")
    return principal


def require_scope(principal: Principal, scope: str) -> None:
    if not principal.cookie and scope not in principal.credential.scopes:
        raise HTTPException(403, "У токена нет нужного разрешения")


def project_role(db: Session, principal: Principal, project_id: str) -> str:
    """Проверяет и область токена, и актуальное членство. Чужие ID отвечают 404."""
    if not principal.cookie and project_id not in principal.credential.project_ids:
        raise HTTPException(404, "Проект недоступен")
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Проект недоступен")
    if principal.user.owner:
        return "owner"
    membership = db.get(Membership, (project_id, principal.user.id))
    if membership is None:
        raise HTTPException(404, "Проект недоступен")
    return membership.role


def create_invitation(db: Session, user: User) -> str:
    """Создаёт одноразовую активацию на сутки; сохранение транзакции у вызывающего."""
    raw = secret("rv_inv_")
    db.add(Invitation(digest=digest(raw), user_id=user.id, expires_at=utcnow() + timedelta(days=1)))
    return raw


def bootstrap_owner(engine: Engine, email: str, name: str) -> str:
    """Создаёт единственного первого владельца; возвращает одноразовый секрет активации."""
    with Session(engine) as db:
        # Один bootstrap на PostgreSQL, включая конкурентные команды.
        from sqlalchemy import text

        db.execute(text("SELECT pg_advisory_xact_lock(791748315)"))
        if db.scalar(select(User.id).where(User.owner)):
            raise ValueError("Первый владелец уже создан")
        user = User(email=email.strip().casefold(), name=name, owner=True)
        db.add(user)
        db.flush()
        raw = create_invitation(db, user)
        db.commit()
        return raw


def new_session(db: Session, user: User) -> tuple[Credential, str]:
    """Выдаёт 14-дневную cookie-сессию и отдельный CSRF-токен."""
    raw = secret("rv_session_")
    credential = Credential(
        digest=digest(raw),
        user_id=user.id,
        kind="session",
        csrf=secrets.token_urlsafe(32),
        expires_at=utcnow() + timedelta(days=14),
    )
    db.add(credential)
    db.flush()
    return credential, raw


def user_json(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "active": user.active,
        "owner": user.owner,
        "state": "active" if user.active else "disabled" if user.password_hash else "invited",
    }
