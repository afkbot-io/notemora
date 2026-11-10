"""Проверяемый wire-контракт кабинета и SDK. Имена JSON — camelCase."""

import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from pydantic.alias_generators import to_camel

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Body = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
Scope = Literal["comments:read", "comments:write", "screenshots:read"]


def clean_origin(value: str) -> str:
    """Нормализует точный HTTPS origin; HTTP разрешён только для loopback."""
    if len(value) > 400 or "\x00" in value:
        raise ValueError("Origin слишком длинный или содержит NUL")
    parts = urlsplit(value)
    if (
        parts.scheme not in {"https", "http"}
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise ValueError("Нужен origin без пути, query и логина")
    if parts.scheme == "http" and parts.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("HTTP разрешён только на loopback")
    host = parts.hostname.encode("idna").decode().lower()
    if ":" in host:
        host = "[" + host + "]"
    port = parts.port
    suffix = f":{port}" if port and port != (443 if parts.scheme == "https" else 80) else ""
    return f"{parts.scheme}://{host}{suffix}"


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    @field_validator("*", mode="before")
    @classmethod
    def no_nul(cls, value):
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("NUL недопустим в тексте")
        return value


class UserCreate(Wire):
    email: str = Field(max_length=254)
    name: ShortText

    @field_validator("email")
    @classmethod
    def email_address(cls, value: str) -> str:
        value = value.strip().casefold()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Укажите email")
        return value


class Login(Wire):
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=128)


class Activate(Wire):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=12, max_length=128)


class ProjectCreate(Wire):
    name: ShortText
    origins: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("origins")
    @classmethod
    def allowed_origins(cls, values: list[str]) -> list[str]:
        return sorted({clean_origin(value) for value in values})


class MemberCreate(Wire):
    email: str = Field(max_length=254)
    role: Literal["owner", "moderator", "member"] = "member"


class TokenCreate(Wire):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    project_ids: list[UUID] = Field(min_length=1, max_length=50)
    scopes: list[Scope] = Field(min_length=1, max_length=3)
    expires_in_days: int = Field(default=30, ge=1, le=365)


class Authorize(Wire):
    project_id: UUID
    origin: str = Field(max_length=400)
    challenge: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class Exchange(Wire):
    project_id: UUID
    origin: str = Field(max_length=400)
    code: str = Field(min_length=20, max_length=200)
    verifier: str = Field(pattern=r"^[A-Za-z0-9._~-]{43,128}$")


class Viewport(Wire):
    width: int = Field(gt=0, le=20000)
    height: int = Field(gt=0, le=20000)


class Context(Wire):
    surface: Literal["app", "storybook"]
    page_key: str = Field(min_length=1, max_length=300)
    page_title: str = Field(min_length=1, max_length=300)
    build: str = Field(default="", max_length=100)
    viewport: Viewport
    locale: str = Field(default="ru", max_length=20)
    url: str = Field(default="", max_length=1500)
    commit_sha: str = Field(default="", max_length=64)


class Anchor(Wire):
    key: str = Field(min_length=1, max_length=1500)
    selector: str = Field(min_length=1, max_length=1500)
    label: str = Field(min_length=1, max_length=160)
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class Reply(Wire):
    request_id: UUID
    body: Body
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=2)
    capture_state: Literal["captured", "failed", "none"] = "none"


class CreateThread(Reply):
    context: Context
    anchor: Anchor


class UserState(Wire):
    active: bool


class CaptureContext(Wire):
    url: str = Field(default="", max_length=1500)
    viewport: Viewport | None = None
    captured_at: datetime | None = None
    device_pixel_ratio: float = Field(default=1, gt=0, le=8, allow_inf_nan=False)
    scroll_x: float = Field(default=0, ge=-1_000_000, le=1_000_000, allow_inf_nan=False)
    scroll_y: float = Field(default=0, ge=-1_000_000, le=1_000_000, allow_inf_nan=False)
    target_visible: bool = False
    method: Literal["dom-render", "manual"] = "manual"
