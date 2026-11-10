FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS frontend
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci
COPY apps/web apps/web
COPY packages/sdk packages/sdk
COPY scripts/copy-sdk.mjs scripts/copy-sdk.mjs
RUN npm run build

FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72 AS backend
COPY --from=ghcr.io/astral-sh/uv:0.12.8@sha256:d1cbaeadc234fe19c0d93daabcf5e98738cd93c6d1dd4918ef6aa30735feb23a /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock LICENSE ./
COPY apps/api/src apps/api/src
COPY packages/mcp/src packages/mcp/src
RUN umask 022 && uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
ARG VCS_REF=local
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 REVIEW_API_HOST=0.0.0.0 REVIEW_API_PORT=8990 REVIEW_COMMIT_SHA=$VCS_REF
COPY --from=backend /app/.venv /app/.venv
COPY apps/api/alembic apps/api/alembic
COPY alembic.ini ./
COPY LICENSE ./LICENSE
COPY --from=frontend /build/apps/web/dist apps/web/dist
RUN useradd --uid 10001 --create-home review && mkdir -p .local/attachments && chown -R review:review .local
USER 10001:10001
RUN python -c "import os, shutil; import review_platform.cli; from pathlib import Path; assert os.geteuid() == 10001; assert shutil.which('review-api') and shutil.which('review-admin'); assert Path('apps/web/dist/index.html').is_file(); assert Path('apps/web/dist/sdk/review.js').is_file()"
EXPOSE 8990
CMD ["review-api"]
