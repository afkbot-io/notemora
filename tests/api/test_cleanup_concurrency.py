"""Очистка не ждёт редактируемый блок и не теряет новые сообщения."""

from concurrent.futures import ThreadPoolExecutor

from review_platform.models import Comment, Operation, Thread
from review_platform.reviews import purge_expired
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .conftest import new_comment


def test_cleanup_skips_thread_locked_by_writer(api, project):
    client, app = api
    thread = client.post(f"/api/v1/projects/{project['id']}/threads", json=new_comment()).json()
    with Session(app.state.engine) as writer:
        writer.execute(delete(Comment))
        writer.commit()
        writer.scalar(select(Thread).where(Thread.id == thread["id"]).with_for_update())

        def clean():
            with Session(app.state.engine) as db:
                return purge_expired(db, app.state.storage)

        with ThreadPoolExecutor(max_workers=1) as workers:
            result = workers.submit(clean)
            try:
                assert result.result(timeout=1) == {"attachments": 0, "comments": 0}
            finally:
                writer.rollback()
        assert writer.get(Thread, thread["id"]) is not None
        purge_expired(writer, app.state.storage)
        assert writer.scalar(select(Thread)) is None


def test_idempotency_lasts_until_message_expiry(api, project):
    client, app = api
    client.post(f"/api/v1/projects/{project['id']}/threads", json=new_comment())
    with Session(app.state.engine) as db:
        assert db.scalar(select(Operation)).expires_at == db.scalar(select(Comment)).expires_at
