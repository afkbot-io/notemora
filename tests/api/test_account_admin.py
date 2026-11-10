"""CLI-аккаунты, отзыв доступа и поиск замечаний."""

import os
import subprocess
import sys

from fastapi.testclient import TestClient
from review_platform.models import Credential, User
from sqlalchemy import select
from sqlalchemy.orm import Session

from .conftest import new_comment

PASSWORD = "Synthetic-new-account-password-42"


def cli(app, *arguments, password=PASSWORD):
    result = subprocess.run(
        [sys.executable, "-m", "review_platform.cli", *arguments, "--password-stdin"],
        input=password + "\n",
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "REVIEW_DATABASE_URL": app.state.settings.database_url,
            "REVIEW_ENVIRONMENT": "test",
        },
    )
    assert password not in result.stdout + result.stderr
    return result


def test_cli_creates_active_member_and_rejects_duplicate(api, project):
    _, app = api
    args = (
        "create-user",
        "--email",
        "NEW@example.test",
        "--name",
        "Дизайнер",
        "--project",
        project["id"],
        "--role",
        "member",
    )
    result = cli(app, *args)
    assert result.returncode == 0, result.stderr
    assert cli(app, *args).returncode != 0
    with TestClient(app, headers={"Origin": "http://testserver"}) as client:
        response = client.post(
            "/api/auth/login", json={"email": "new@example.test", "password": PASSWORD}
        )
        assert response.status_code == 200
        assert response.json()["user"]["owner"] is False
        assert response.json()["user"]["state"] == "active"
        assert client.get("/api/projects").json()[0]["id"] == project["id"]


def test_cli_reset_revokes_sessions_and_tokens_without_printing_password(api):
    client, app = api
    result = cli(app, "set-password", "--email", "owner@example.test")
    assert result.returncode == 0, result.stderr
    assert client.get("/api/auth/me").status_code == 401
    with Session(app.state.engine) as db:
        assert all(row.revoked for row in db.scalars(select(Credential)))
    assert (
        client.post(
            "/api/auth/login", json={"email": "owner@example.test", "password": PASSWORD}
        ).status_code
        == 200
    )


def test_cli_checks_password_and_project_before_creating_account(api):
    _, app = api
    assert (
        cli(
            app, "create-user", "--email", "short@example.test", "--name", "Имя", password="short"
        ).returncode
        != 0
    )
    assert (
        cli(
            app,
            "create-user",
            "--email",
            "missing@example.test",
            "--name",
            "Имя",
            "--project",
            "00000000-0000-0000-0000-000000000000",
        ).returncode
        != 0
    )
    with Session(app.state.engine) as db:
        assert (
            db.scalar(
                select(User).where(User.email.in_(["short@example.test", "missing@example.test"]))
            )
            is None
        )


def test_disabled_and_reenabled_account_loses_previous_session(api):
    owner, app = api
    invitation = owner.post(
        "/api/users", json={"name": "Участник", "email": "member@example.test"}
    ).json()
    with TestClient(app, headers={"Origin": "http://testserver"}) as member:
        response = member.post(
            "/api/auth/activate",
            json={"token": invitation["activationToken"], "password": PASSWORD},
        )
        assert response.status_code == 200
        owner.patch("/api/users/" + invitation["id"], json={"active": False})
        owner.patch("/api/users/" + invitation["id"], json={"active": True})
        assert member.get("/api/auth/me").status_code == 401


def test_search_finds_block_label_and_rejects_nul(api, project):
    client, _ = api
    path = f"/api/v1/projects/{project['id']}/threads"
    client.post(
        path, json={**new_comment(), "anchor": {**new_comment()["anchor"], "label": "Панель даты"}}
    )
    response = client.get(path, params={"search": "Панель даты"})
    assert len(response.json()["threads"]) == 1
    assert client.get(path, params={"search": "bad\0text"}).status_code == 422
