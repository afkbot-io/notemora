# Локальная проверка · 10 ноября 2026

- Python/PostgreSQL: 30 тестов и 4 subtests прошли; схемы изолированы от рабочих данных.
- SDK: 6 тестов, включая состав настоящего npm archive и MIT license.
- Chromium/WebKit: 24 сценария — выбор блока, черновик, возврат к элементу, клавиатура,
  касания и ширины 320/390/480 px.
- TypeScript, Ruff check/format, Prettier и production build прошли.
- Helm: проверены свой домен/registry/Secret, optional pull credentials, nonroot,
  persistent volumes, обязательный digest и отклонение некорректных значений.
- Docker Compose: образ собран, миграция завершилась, API/статика/SDK доступны.
  Создан синтетический пользователь, проверены вход, cookie Notemora и создание проекта.
- Production Compose override проверен с синтетическими credentials.

GitHub Actions повторяет API, UI, Helm и Docker build. Текущий серверный статус CI
смотрите на странице Actions репозитория. Исходники не требуют private registry.

Не проверялись публичный production-домен, реальный S3 и настоящие мобильные устройства.
Есть предупреждение Starlette TestClient о будущей замене httpx на httpx2;
оно не скрывается. Локальные данные, credentials, caches и отчёты в Git не входят.
