"""Список обсуждений не делает отдельный запрос на автора и снимки каждого сообщения."""

from sqlalchemy import event

from .conftest import new_comment


def test_thread_list_batches_comments_authors_and_images(api, project):
    client, app = api
    path = f"/api/v1/projects/{project['id']}/threads"
    for index in range(10):
        body = new_comment()
        body["anchor"]["key"] = "block-" + str(index)
        client.post(path, json=body)
    statements = []

    def record(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(app.state.engine, "before_cursor_execute", record)
    try:
        result = client.get(path)
        assert len(result.json()["threads"]) == 10
        assert len(statements) <= 8
    finally:
        event.remove(app.state.engine, "before_cursor_execute", record)
