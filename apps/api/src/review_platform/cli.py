"""Локальный запуск, однократный bootstrap и явное обслуживание сервиса."""

import argparse
import getpass
import sys
from urllib.parse import quote
from uuid import UUID

import uvicorn
from alembic import command
from alembic.config import Config
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .admin import create_user, set_password
from .auth import bootstrap_owner
from .config import Settings
from .reviews import purge_expired
from .schemas import UserCreate
from .storage import Storage


def serve() -> None:
    """Запускает API только на заданном адресе, без автоматических миграций."""
    settings = Settings()
    uvicorn.run(
        "review_platform.app:create_app",
        factory=True,
        host=settings.api_host,
        port=settings.api_port,
    )


def main() -> None:
    """Печатает приглашение только по явной команде bootstrap; секрет не хранится в Git."""
    parser = argparse.ArgumentParser(description="Управление Notemora")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate")
    commands.add_parser("purge")
    bootstrap = commands.add_parser("bootstrap")
    bootstrap.add_argument("--email", required=True)
    bootstrap.add_argument("--name", required=True)
    create = commands.add_parser("create-user")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--admin", action="store_true")
    create.add_argument("--project", type=UUID)
    create.add_argument("--role", choices=["member", "moderator", "owner"], default="member")
    create.add_argument("--password-stdin", action="store_true")
    reset = commands.add_parser("set-password")
    reset.add_argument("--email", required=True)
    reset.add_argument("--password-stdin", action="store_true")
    args = parser.parse_args()
    if args.command == "migrate":
        command.upgrade(Config("alembic.ini"), "head")
        return
    settings = Settings()
    engine = create_engine(settings.database_url)
    try:
        if args.command == "bootstrap":
            user = UserCreate(email=args.email, name=args.name)
            raw = bootstrap_owner(engine, user.email, user.name)
            print(settings.web_origin + "/activate#token=" + quote(raw))
        elif args.command in {"create-user", "set-password"}:
            if args.password_stdin:
                password = sys.stdin.readline(1024).removesuffix("\n").removesuffix("\r")
            else:
                if not sys.stdin.isatty():
                    parser.error("Используйте --password-stdin для неинтерактивного запуска")
                password = getpass.getpass("Пароль: ")
                if password != getpass.getpass("Повторите пароль: "):
                    raise ValueError("Пароли не совпадают")
            if args.command == "create-user":
                result = create_user(
                    engine,
                    UserCreate(email=args.email, name=args.name),
                    password,
                    admin=args.admin,
                    project_id=str(args.project) if args.project else None,
                    role=args.role,
                )
            else:
                result = set_password(engine, args.email, password)
            print(result["email"] + " · " + result["id"])
        else:
            with Session(engine) as db:
                print(purge_expired(db, Storage(settings)))
    except ValidationError:
        parser.exit(2, "Проверьте email и имя\n")
    except ValueError as error:
        parser.exit(2, str(error) + "\n")
    except SQLAlchemyError:
        parser.exit(1, "Ошибка подключения или записи в БД\n")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
