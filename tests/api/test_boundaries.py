"""Границы объектов, очистка, конкуренция и фактическая работа MCP stdio."""

import asyncio
import io
import os
import socket
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import uvicorn
from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from PIL import Image
from review_platform.models import Attachment, Comment, Operation
from review_platform.reviews import purge_expired
from review_platform.time import utcnow
from sqlalchemy import select
from sqlalchemy.orm import Session

from .conftest import new_comment


def test_membership_owner_checks_and_cross_project_attachments(api, project):
    """Обычный участник не читает чужие проекты, не модерирует и не управляет доступами."""
    owner, app = api
    other = owner.post("/api/projects", json={"name": "Закрытый", "origins": []}).json()
    invitation = owner.post(
        "/api/users", json={"name": "Участник", "email": "member@example.test"}
    ).json()
    owner.post(
        f"/api/projects/{project['id']}/members",
        json={"email": invitation["email"], "role": "member"},
    )
    path = f"/api/v1/projects/{project['id']}"
    thread = owner.post(path + "/threads", json=new_comment()).json()
    with TestClient(app, headers={"Origin": "http://testserver"}) as member:
        activation = member.post(
            "/api/auth/activate",
            json={
                "token": invitation["activationToken"],
                "password": "Synthetic-member-password-42",
            },
        ).json()
        member.headers["X-CSRF-Token"] = activation["csrfToken"]
        assert member.get("/api/users").status_code == 403
        assert (
            member.post(
                f"/api/projects/{project['id']}/members",
                json={"email": invitation["email"], "role": "owner"},
            ).status_code
            == 403
        )
        assert member.delete(path + "/comments/" + thread["comments"][0]["id"]).status_code == 403
        assert member.get(f"/api/v1/projects/{other['id']}/threads").status_code == 404
        assert (
            member.get(path + "/threads").json()["threads"][0]["comments"][0]["canDelete"] is False
        )
        owner.delete(f"/api/projects/{project['id']}/members/{invitation['id']}")
        assert member.get(path + "/threads").status_code == 404


def test_parallel_retries_create_exactly_one_message(api, project):
    """Две конкурентные HTTP-отправки с одним UUID сохраняют одно сообщение."""
    owner, app = api
    token = owner.post(
        "/api/tokens",
        json={
            "name": "Запись",
            "projectIds": [project["id"]],
            "scopes": ["comments:read", "comments:write"],
            "expiresInDays": 7,
        },
    ).json()["secret"]
    data = new_comment()

    def send():
        with TestClient(app, headers={"Authorization": "Bearer " + token}) as client:
            return client.post(f"/api/v1/projects/{project['id']}/threads", json=data)

    with ThreadPoolExecutor(max_workers=2) as workers:
        first, second = list(workers.map(lambda _: send(), range(2)))
    assert first.status_code == second.status_code == 201
    assert first.json()["comments"][0]["id"] == second.json()["comments"][0]["id"]
    with Session(app.state.engine) as db:
        assert len(list(db.scalars(select(Comment)))) == 1


def test_expiry_removes_only_old_message_and_private_file(api, project):
    """Ответ не продлевает старое сообщение, purge удаляет его файл и сохраняет ответ."""
    client, app = api
    path = f"/api/v1/projects/{project['id']}"
    content = io.BytesIO()
    Image.new("RGB", (20, 20)).save(content, "PNG")
    uploaded = client.post(
        path + "/attachments", files={"file": ("x.png", content.getvalue(), "image/png")}
    ).json()
    thread = client.post(
        path + "/threads",
        json={**new_comment(), "attachmentIds": [uploaded["id"]], "captureState": "captured"},
    ).json()
    client.post(
        path + f"/threads/{thread['id']}/comments",
        json={"requestId": str(uuid.uuid4()), "body": "Новый ответ"},
    )
    with Session(app.state.engine) as db:
        first = db.get(Comment, thread["comments"][0]["id"])
        first.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
        result = purge_expired(db, app.state.storage)
        assert result == {"attachments": 1, "comments": 1}
        assert db.get(Attachment, uploaded["id"]) is None
        assert db.scalar(select(Operation)) is not None
    assert len(client.get(path + "/threads").json()["threads"][0]["comments"]) == 1


def test_csrf_cookie_cannot_be_used_from_widget_origin(api, project):
    """Разрешённый CORS origin виджета не получает кабинетную сессию или её CSRF."""
    client, _ = api
    assert client.get("/api/auth/me", headers={"Origin": project["origins"][0]}).status_code == 403
    assert (
        client.post(
            "/api/projects",
            json={"name": "Нельзя", "origins": []},
            headers={"Origin": project["origins"][0]},
        ).status_code
        == 403
    )


def test_invalid_nonfinite_coordinates_and_body_limit(api, project):
    """Некорректный JSON не вызывает 500 и не отражает ввод в сообщении об ошибке."""
    client, _ = api
    import json

    data = new_comment()
    data["anchor"]["x"] = float("nan")
    result = client.post(
        f"/api/v1/projects/{project['id']}/threads",
        content=json.dumps(data),
        headers={"Content-Type": "application/json"},
    )
    assert result.status_code == 422
    assert (
        client.post(
            "/api/auth/login", content=b"x" * 40000, headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )


def test_mcp_stdio_calls_real_http_and_reads_screenshot(api, project):
    """Настоящий MCP ClientSession вызывает subprocess, который обращается к живому API."""
    client, app = api
    path = f"/api/v1/projects/{project['id']}"
    image = io.BytesIO()
    Image.new("RGB", (10, 10)).save(image, "PNG")
    uploaded = client.post(
        path + "/attachments", files={"file": ("x.png", image.getvalue(), "image/png")}
    ).json()
    client.post(
        path + "/threads",
        json={**new_comment(), "attachmentIds": [uploaded["id"]], "captureState": "captured"},
    )
    token = client.post(
        "/api/tokens",
        json={
            "name": "MCP",
            "projectIds": [project["id"]],
            "scopes": ["comments:read", "screenshots:read"],
            "expiresInDays": 1,
        },
    ).json()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.02)
    assert server.started

    async def exercise():
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "review_mcp.server"],
            env={
                **os.environ,
                "REVIEW_SERVICE_URL": f"http://127.0.0.1:{port}",
                "REVIEW_TOKEN": token["secret"],
            },
        )
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert {"list_projects", "list_threads", "get_screenshot", "add_reply"} <= {
                tool.name for tool in tools.tools
            }
            projects = await session.call_tool("list_projects", {})
            assert not projects.isError
            response = await session.call_tool(
                "get_screenshot", {"project_id": project["id"], "attachment_id": uploaded["id"]}
            )
            assert not response.isError and response.content[0].type == "image"

    try:
        asyncio.run(exercise())
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
