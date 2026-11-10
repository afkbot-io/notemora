"""Проверяет вход, изоляцию, повтор отправки, вложения и отзыв токенов через HTTP."""

import base64
import hashlib
import io
import uuid
from datetime import timedelta

from fastapi.testclient import TestClient
from PIL import Image
from review_platform.models import Comment
from review_platform.time import utcnow
from sqlalchemy import select
from sqlalchemy.orm import Session

from .conftest import new_comment


def test_login_csrf_and_invitation_are_not_reusable(api):
    """Приглашение одноразовое; cookie-запись требует CSRF и доверенный Origin."""
    client, app = api
    invitation = client.post(
        "/api/users", json={"email": "designer@example.test", "name": "Дизайнер"}
    ).json()
    with TestClient(app, headers={"Origin": "http://testserver"}) as guest:
        payload = {
            "token": invitation["activationToken"],
            "password": "Another-synthetic-password-42",
        }
        assert guest.post("/api/auth/activate", json=payload).status_code == 200
        assert guest.post("/api/auth/activate", json=payload).status_code == 400
        assert guest.post("/api/auth/logout").status_code == 403
        me = guest.get("/api/auth/me").json()
        assert (
            guest.post("/api/auth/logout", headers={"X-CSRF-Token": me["csrfToken"]}).status_code
            == 204
        )
        assert guest.get("/api/auth/me").status_code == 401
        assert (
            guest.post(
                "/api/auth/login",
                json={"email": "designer@example.test", "password": payload["password"]},
                headers={"Origin": "https://untrusted.invalid"},
            ).status_code
            == 403
        )


def test_widget_pkce_is_project_origin_bound_and_one_use(api, project):
    """Код привязан к проекту, Origin и PKCE; повтор обмена отклоняется."""
    client, app = api
    verifier = "v" * 43
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    data = {"projectId": project["id"], "origin": project["origins"][0], "challenge": challenge}
    denied = client.post(
        "/api/auth/authorize", json={**data, "origin": "https://untrusted.invalid"}
    )
    assert denied.status_code == 403
    code = client.post("/api/auth/authorize", json=data).json()["code"]
    exchange = {
        "code": code,
        "verifier": verifier,
        "projectId": project["id"],
        "origin": data["origin"],
    }
    with TestClient(app, headers={"Origin": data["origin"]}) as widget:
        assert (
            widget.post("/api/auth/exchange", json={**exchange, "verifier": "x" * 43}).status_code
            == 400
        )
        token = widget.post("/api/auth/exchange", json=exchange)
        assert token.status_code == 200, token.text
        assert widget.post("/api/auth/exchange", json=exchange).status_code == 400
        widget.headers["Authorization"] = "Bearer " + token.json()["accessToken"]
        assert widget.get(f"/api/v1/projects/{project['id']}/threads").status_code == 200
        assert (
            widget.get(
                f"/api/v1/projects/{project['id']}/threads",
                headers={"Origin": "https://untrusted.invalid"},
            ).status_code
            == 403
        )
        assert widget.post("/api/tokens", json={}).status_code == 403


def test_create_reply_delete_idempotency_and_scope(api, project):
    """Повтор не дублирует сообщение; после удаления не воскресит его."""
    client, _ = api
    path = f"/api/v1/projects/{project['id']}"
    payload = new_comment()
    first = client.post(path + "/threads", json=payload)
    assert first.status_code == 201, first.text
    thread = first.json()
    repeated = client.post(path + "/threads", json=payload)
    assert repeated.status_code == 201
    assert repeated.json()["comments"][0]["id"] == thread["comments"][0]["id"]
    assert (
        client.post(path + "/threads", json={**payload, "body": "Другой текст"}).status_code == 409
    )
    assert len(client.get(path + "/threads").json()["threads"]) == 1
    reply = client.post(
        path + f"/threads/{thread['id']}/comments",
        json={"requestId": str(uuid.uuid4()), "body": "Согласовано", "captureState": "failed"},
    )
    assert reply.status_code == 201
    assert len(reply.json()["comments"]) == 2
    assert client.delete(path + "/comments/" + thread["comments"][0]["id"]).status_code == 204
    assert client.post(path + "/threads", json=payload).status_code == 409
    assert len(client.get(path + "/threads").json()["threads"][0]["comments"]) == 1


def test_personal_token_limits_and_immediate_revoke(api, project):
    """Read-only токен не пишет, не читает другой проект и сразу отзывается."""
    client, app = api
    other = client.post("/api/projects", json={"name": "Другой", "origins": []}).json()
    token = client.post(
        "/api/tokens",
        json={
            "name": "Агент",
            "projectIds": [project["id"]],
            "scopes": ["comments:read", "screenshots:read"],
            "expiresInDays": 30,
        },
    )
    assert token.status_code == 201, token.text
    item = token.json()
    assert "secret" not in str(client.get("/api/tokens").json())
    with TestClient(app, headers={"Authorization": "Bearer " + item["secret"]}) as agent:
        assert len(agent.get("/api/projects").json()) == 1
        assert agent.get(f"/api/v1/projects/{other['id']}/threads").status_code == 404
        assert (
            agent.post(f"/api/v1/projects/{project['id']}/threads", json=new_comment()).status_code
            == 403
        )
        assert client.delete("/api/tokens/" + item["id"]).status_code == 204
        assert agent.get("/api/projects").status_code == 401


def test_image_attachment_is_private_validated_and_expires_with_comment(api, project):
    """Изображение доступно только участнику, не произвольный файл; TTL по сообщению."""
    client, app = api
    path = f"/api/v1/projects/{project['id']}"
    assert (
        client.post(
            path + "/attachments", files={"file": ("x.png", b"not an image", "image/png")}
        ).status_code
        == 422
    )
    image = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(image, "PNG")
    uploaded = client.post(
        path + "/attachments", files={"file": ("capture.png", image.getvalue(), "image/png")}
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment = uploaded.json()
    payload = {**new_comment(), "captureState": "captured", "attachmentIds": [attachment["id"]]}
    thread = client.post(path + "/threads", json=payload).json()
    assert thread["comments"][0]["attachments"][0]["width"] == 40
    assert (
        client.get(path + "/attachments/" + attachment["id"]).headers["content-type"]
        == "image/webp"
    )
    with TestClient(app) as anonymous:
        assert anonymous.get(path + "/attachments/" + attachment["id"]).status_code == 401
    with Session(app.state.engine) as db:
        row = db.scalar(select(Comment))
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.get(path + "/threads").json()["threads"] == []
    assert client.get(path + "/attachments/" + attachment["id"]).status_code == 404
