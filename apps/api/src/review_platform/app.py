"""Фабрика API; миграции схемы выполняются отдельной командой."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse, JSONResponse
from starlette.staticfiles import StaticFiles

from . import auth_routes, project_routes, review_routes
from .config import Settings
from .models import ProjectOrigin
from .reviews import purge_expired
from .storage import Storage

LOGGER = logging.getLogger(__name__)


class PlatformMiddleware:
    """Ограничивает тело и CORS. Origin проекта не даёт никаких прав сам по себе."""

    def __init__(self, app, engine, settings):
        self.app, self.engine, self.settings = app, engine, settings

    def origin_allowed(self, origin):
        if origin == self.settings.web_origin:
            return True
        with Session(self.engine) as db:
            return (
                db.scalar(
                    select(ProjectOrigin.origin).where(ProjectOrigin.origin == origin).limit(1)
                )
                is not None
            )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        origin = headers.get(b"origin", b"").decode("latin1")
        allowed = bool(origin) and await run_in_threadpool(self.origin_allowed, origin)
        if scope["method"] == "OPTIONS" and origin:
            response_headers = {"Vary": "Origin"}
            if allowed:
                response_headers.update(
                    {
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-CSRF-Token",
                        "Access-Control-Max-Age": "300",
                    }
                )
                if origin == self.settings.web_origin:
                    response_headers["Access-Control-Allow-Credentials"] = "true"
            return await JSONResponse(
                {}, status_code=200 if allowed else 403, headers=response_headers
            )(scope, receive, send)
        received = 0
        limit = 6 * 1024 * 1024 if scope["path"].endswith("/attachments") else 32 * 1024

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > limit:
                raise BodyTooLarge
            return message

        async def secured_send(message):
            if message["type"] == "http.response.start":
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                ]
                if scope["path"].startswith("/api/"):
                    extra.append((b"cache-control", b"private, no-store"))
                if allowed:
                    extra.extend(
                        [(b"access-control-allow-origin", origin.encode()), (b"vary", b"Origin")]
                    )
                    if origin == self.settings.web_origin:
                        extra.append((b"access-control-allow-credentials", b"true"))
                message["headers"] = message.get("headers", []) + extra
            await send(message)

        try:
            if int(headers.get(b"content-length", b"0")) > limit:
                raise BodyTooLarge
            await self.app(scope, limited_receive, secured_send)
        except BodyTooLarge:
            await JSONResponse({"detail": "Запрос слишком большой"}, status_code=413)(
                scope, receive, secured_send
            )


class BodyTooLarge(HTTPException):
    def __init__(self):
        super().__init__(413, "Запрос слишком большой")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Создаёт независимый engine. Таблицы применяются только Alembic/CLI, не startup."""
    settings = settings or Settings()
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    storage = Storage(settings)

    async def cleanup_loop():
        while True:
            await asyncio.sleep(60)
            try:

                def cleanup():
                    with Session(engine) as db:
                        purge_expired(db, storage)

                await run_in_threadpool(cleanup)
            except Exception:
                LOGGER.exception("Очистка не завершена; повтор через минуту")

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(cleanup_loop())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        engine.dispose()

    app = FastAPI(
        title="Notemora",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None if settings.environment == "production" else "/docs",
        redoc_url=None if settings.environment == "production" else "/redoc",
    )
    app.state.settings, app.state.engine, app.state.storage = settings, engine, storage

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # Не отражаем пароль/токен и не сериализуем NaN из ошибочного input.
        return JSONResponse(
            {
                "detail": "Проверьте поля запроса",
                "fields": [{"path": item["loc"], "type": item["type"]} for item in error.errors()],
            },
            status_code=422,
        )

    app.add_middleware(PlatformMiddleware, engine=engine, settings=settings)
    app.include_router(auth_routes.router)
    app.include_router(project_routes.router)
    app.include_router(review_routes.router)

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/version")
    def version():
        return {"service": "notemora", "commit": settings.commit_sha}

    @app.get("/readyz")
    def ready():
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1 FROM users LIMIT 1"))
        except Exception as error:
            raise HTTPException(503, "База данных недоступна") from error
        return {"status": "ok"}

    dist = settings.web_dist
    if (dist / "index.html").exists():
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"))
        if (dist / "sdk").exists():
            app.mount("/sdk", StaticFiles(directory=dist / "sdk"))

        @app.get("/favicon.svg", include_in_schema=False)
        def favicon():
            return FileResponse(dist / "favicon.svg")

        @app.get("/")
        @app.get("/activate")
        @app.get("/authorize")
        def index():
            return FileResponse(
                dist / "index.html",
                headers={
                    "Cache-Control": "no-cache",
                },
            )

    return app
