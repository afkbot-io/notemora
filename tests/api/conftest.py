"""Каждый тест использует отдельную схему настоящего PostgreSQL."""

import os
import uuid

import pytest
from fastapi.testclient import TestClient
from review_platform.app import create_app
from review_platform.auth import bootstrap_owner
from review_platform.config import Settings
from review_platform.models import Base
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


@pytest.fixture
def api(tmp_path):
    url = os.getenv(
        "REVIEW_TEST_DATABASE_URL", "postgresql+psycopg://review:review@127.0.0.1:55581/review_test"
    )
    schema = "test_" + uuid.uuid4().hex
    admin = create_engine(url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = make_url(url).update_query_dict({"options": f"-csearch_path={schema}"})
    settings = Settings(
        database_url=scoped.render_as_string(hide_password=False),
        storage_dir=tmp_path,
        web_origin="http://testserver",
        cookie_secure=False,
        environment="test",
    )
    app = create_app(settings)
    Base.metadata.create_all(app.state.engine)
    secret = bootstrap_owner(app.state.engine, "owner@example.test", "Владелец")
    with TestClient(app, headers={"Origin": "http://testserver"}) as client:
        response = client.post(
            "/api/auth/activate", json={"token": secret, "password": "Synthetic-test-password-42"}
        )
        assert response.status_code == 200, response.text
        client.headers["X-CSRF-Token"] = response.json()["csrfToken"]
        yield client, app
    app.state.engine.dispose()
    with admin.begin() as connection:
        connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


@pytest.fixture
def project(api):
    client, _ = api
    response = client.post(
        "/api/projects", json={"name": "Example", "origins": ["http://127.0.0.1:5291"]}
    )
    assert response.status_code == 201, response.text
    return response.json()


def new_comment():
    return {
        "requestId": str(uuid.uuid4()),
        "body": "Увеличить область нажатия",
        "captureState": "failed",
        "context": {
            "surface": "storybook",
            "pageKey": "button--default",
            "pageTitle": "Кнопка",
            "build": "abc123",
            "viewport": {"width": 390, "height": 844},
            "locale": "ru",
            "url": "http://127.0.0.1:5291/",
        },
        "anchor": {
            "key": "id:submit",
            "selector": "[data-review-id=submit]",
            "label": "Кнопка",
            "x": 0.4,
            "y": 0.5,
        },
    }
