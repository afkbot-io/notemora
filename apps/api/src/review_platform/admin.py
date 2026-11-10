"""Администрирование аккаунтов из доверенной серверной консоли."""

from sqlalchemy import Engine, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import PASSWORDS, user_json
from .models import Credential, Invitation, Membership, Project, User
from .schemas import UserCreate


def password_hash(password: str) -> str:
    """Проверяет пароль без отражения исходного значения в исключениях."""
    if not 12 <= len(password) <= 128 or "\0" in password:
        raise ValueError("Пароль: от 12 до 128 символов, без NUL")
    return PASSWORDS.hash(password)


def create_user(
    engine: Engine,
    identity: UserCreate,
    password: str,
    *,
    admin: bool = False,
    project_id: str | None = None,
    role: str = "member",
) -> dict:
    """Атомарно создаёт активный аккаунт и членство. Существующие аккаунты не меняет."""
    hashed = password_hash(password)
    if role not in {"owner", "moderator", "member"}:
        raise ValueError("Неизвестная роль")
    with Session(engine) as db:
        if project_id and db.get(Project, project_id) is None:
            raise ValueError("Проект не найден")
        if db.scalar(select(User.id).where(User.email == identity.email)):
            raise ValueError("Аккаунт с этим email уже существует")
        user = User(
            email=identity.email, name=identity.name, password_hash=hashed, active=True, owner=admin
        )
        db.add(user)
        try:
            db.flush()
            if project_id:
                db.add(Membership(project_id=project_id, user_id=user.id, role=role))
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise ValueError("Аккаунт или членство уже существует") from error
        return user_json(user)


def set_password(engine: Engine, email: str, password: str) -> dict:
    """Меняет пароль и отзывает все прежние доступы/приглашения; отключённый аккаунт не включает."""
    hashed = password_hash(password)
    with Session(engine) as db:
        user = db.scalar(
            select(User).where(User.email == email.strip().casefold()).with_for_update()
        )
        if user is None:
            raise ValueError("Аккаунт не найден")
        if not user.password_hash:
            raise ValueError("Аккаунт ещё не активирован; используйте ссылку приглашения")
        user.password_hash = hashed
        db.execute(update(Credential).where(Credential.user_id == user.id).values(revoked=True))
        db.execute(update(Invitation).where(Invitation.user_id == user.id).values(used=True))
        db.commit()
        return user_json(user)
