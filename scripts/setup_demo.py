"""Явно создаёт только локальную синтетическую демонстрацию; не сбрасывает чужой аккаунт."""

import json
import secrets
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from review_platform.auth import bootstrap_owner
from review_platform.config import Settings
from sqlalchemy import create_engine


def main() -> None:
    settings = Settings()
    if (
        settings.environment != "development"
        or urlsplit(settings.web_origin).hostname != "127.0.0.1"
    ):
        raise SystemExit("Демонстрация разрешена только в локальном development")
    root = Path(".local")
    root.mkdir(exist_ok=True)
    access_file = root / "access.json"
    if access_file.exists():
        access = json.loads(access_file.read_text())
    else:
        engine = create_engine(settings.database_url)
        try:
            raw = bootstrap_owner(engine, "owner@review.local", "Локальный владелец")
        finally:
            engine.dispose()
        access = {"email": "owner@review.local", "password": secrets.token_urlsafe(24)}
        with httpx.Client(
            base_url=f"http://127.0.0.1:{settings.api_port}",
            headers={"Origin": settings.web_origin},
        ) as client:
            response = client.post(
                "/api/auth/activate", json={"token": raw, "password": access["password"]}
            )
            response.raise_for_status()
        access_file.write_text(json.dumps(access, ensure_ascii=False, indent=2))
        access_file.chmod(0o600)
    with httpx.Client(
        base_url=f"http://127.0.0.1:{settings.api_port}", headers={"Origin": settings.web_origin}
    ) as client:
        response = client.post("/api/auth/login", json=access)
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrfToken"]
        projects = client.get("/api/projects").json()
        project = next((row for row in projects if row["name"] == "Демонстрация SDK"), None)
        if project is None:
            response = client.post(
                "/api/projects",
                json={"name": "Демонстрация SDK", "origins": ["http://127.0.0.1:5291"]},
            )
            response.raise_for_status()
            project = response.json()
        cookies = [
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "expires": cookie.expires or -1,
                "httpOnly": True,
                "secure": cookie.secure,
                "sameSite": "Lax",
            }
            for cookie in client.cookies.jar
        ]
        state = root / "browser-state.json"
        state.write_text(json.dumps({"cookies": cookies, "origins": []}))
        state.chmod(0o600)
    info = root / "demo.json"
    info.write_text(
        json.dumps(
            {"projectId": project["id"], "url": "http://127.0.0.1:5291/?project=" + project["id"]},
            ensure_ascii=False,
            indent=2,
        )
    )
    print("Кабинет: " + settings.web_origin)
    print("Демонстрация: http://127.0.0.1:5291/?project=" + project["id"])
    print("Локальный аккаунт записан в .local/access.json (0600); секрет не выводится.")


if __name__ == "__main__":
    main()
