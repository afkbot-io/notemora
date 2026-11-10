"""Невалидный ввод отклоняется до записи в PostgreSQL."""

from .conftest import new_comment


def test_token_and_origin_lengths_do_not_reach_database(api, project):
    client, _ = api
    response = client.post(
        "/api/tokens",
        json={
            "name": "x" * 101,
            "projectIds": [project["id"]],
            "scopes": ["comments:read"],
            "expiresInDays": 1,
        },
    )
    assert response.status_code == 422
    assert (
        client.post(
            "/api/projects", json={"name": "Сайт", "origins": ["https://" + "x" * 450 + ".test"]}
        ).status_code
        == 422
    )


def test_nul_in_user_content_is_a_validation_error(api, project):
    client, _ = api
    data = {**new_comment(), "body": "Текст\0с NUL"}
    assert client.post(f"/api/v1/projects/{project['id']}/threads", json=data).status_code == 422
    assert (
        client.post("/api/users", json={"name": "Имя", "email": "x\0@example.test"}).status_code
        == 422
    )
