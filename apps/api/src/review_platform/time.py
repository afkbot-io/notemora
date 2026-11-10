"""Единый UTC для сроков сессий, токенов и сообщений."""

from datetime import UTC, datetime


def utcnow() -> datetime:
    """Возвращает aware datetime; сроки хранятся в UTC."""
    return datetime.now(UTC)
