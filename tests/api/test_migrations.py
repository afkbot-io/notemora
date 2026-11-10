"""Схема разворачивается из сохранённой миграции, а не только create_all теста."""

import os
import uuid

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from review_platform.models import Base
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url


def test_clean_upgrade_matches_models_and_downgrade_is_complete(monkeypatch):
    """Проверяет настоящий upgrade/downgrade на отдельной чистой схеме PostgreSQL."""
    monkeypatch.setenv("REVIEW_ENVIRONMENT", "test")
    monkeypatch.setenv("REVIEW_WEB_ORIGIN", "http://testserver")
    monkeypatch.setenv("REVIEW_COOKIE_SECURE", "false")
    url = os.getenv(
        "REVIEW_TEST_DATABASE_URL", "postgresql+psycopg://review:review@127.0.0.1:55581/review_test"
    )
    schema = "migration_" + uuid.uuid4().hex
    admin = create_engine(url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(url)
        .update_query_dict({"options": "-csearch_path=" + schema})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("REVIEW_DATABASE_URL", scoped)
    engine = create_engine(scoped)
    try:
        config = Config("alembic.ini")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
        command.downgrade(config, "base")
        assert inspect(engine).get_table_names() == ["alembic_version"]
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
