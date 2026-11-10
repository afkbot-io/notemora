# Notemora

Обратная связь для веб-интерфейсов и Storybook: комментарии к элементам страницы,
снимки, кабинет и MCP для разработчиков и ИИ-агентов.

[SDK и React](docs/sdk.md) · [MCP и REST](docs/agents-api.md) · [Свой сервер](docs/operations.md) · [Архитектура](docs/architecture.md) · [MIT](LICENSE)

## Возможности

- Выбор элемента мышью, клавиатурой или касанием и предварительная подсветка.
- Обсуждения, ответы, снимки и переход к исходному элементу с восстановлением черновика.
- Shadow DOM SDK для обычных страниц, React и Storybook.
- Аккаунты, одноразовые приглашения, проекты и роли участников.
- Персональные токены и MCP stdio для чтения замечаний и ответов агента.
- Приватные вложения, PostgreSQL, filesystem/S3 и срок хранения сообщений 7 суток.

## Быстрый старт

Нужны Node.js **22.12+**, Python **3.13/3.14**, [uv](https://docs.astral.sh/uv/) и PostgreSQL **14+** с `initdb`, `pg_ctl`, `psql`. Вариант Docker — ниже.

```sh
git clone https://github.com/afkbot-io/notemora.git
cd notemora
cp .env.example .env
uv sync --frozen
npm ci
uv run python scripts/local_postgres.py
uv run review-admin migrate
uv run review-admin create-user --email owner@example.com --name 'Владелец' --admin
npm run dev
```

Пароль администратора вводится скрыто, дважды. Готового публичного аккаунта нет.

| Адрес                                             | Назначение              |
| ------------------------------------------------- | ----------------------- |
| [127.0.0.1:5290](http://127.0.0.1:5290)           | Кабинет                 |
| [127.0.0.1:8990/docs](http://127.0.0.1:8990/docs) | API и Swagger           |
| [127.0.0.1:5291](http://127.0.0.1:5291)           | Пример сайта с виджетом |

Войдите, создайте проект и добавьте origin `http://127.0.0.1:5291`. Откройте
`http://127.0.0.1:5291/?project=<UUID проекта>`, нажмите «Комментарии» и войдите
через popup. **C** включает выбор блока, **Escape** отменяет его.

PostgreSQL использует собственный `.local/postgres`, порт **55581** на loopback
и базы `review`/`review_test`. Скрипт не останавливает чужие процессы и отказывается
занимать чужой порт. После изменений API/SDK перезапустите dev. Настройки
`REVIEW_*` находятся в [`.env.example`](.env.example).

## Docker Compose

```sh
docker compose up --build -d
docker compose exec api review-admin create-user --email owner@example.com --name 'Владелец' --admin
```

Кабинет: [127.0.0.1:5292](http://127.0.0.1:5292). Миграция выполняется перед API,
данные сохраняются в volumes проекта `notemora`. Это локальная конфигурация;
HTTPS и собственные credentials — в [инструкции сервера](docs/operations.md).
Остановка без удаления данных: `docker compose down`.

## Подключение к приложению

Зарегистрируйте точный origin сайта в настройках проекта Notemora.
SDK собирается и упаковывается локально; приватный registry не нужен:

```sh
npm run pack:sdk
# В другом приложении:
npm install /путь/к/notemora/output/sdk/notemora-sdk-0.1.0.tgz
```

```ts
import { initReview } from "@notemora/sdk";

const widget = initReview({
  serviceUrl: "https://review.example.com",
  projectId: "<UUID проекта>",
  surface: "app",
  page: () => ({ key: location.pathname, title: document.title }),
});

// При размонтировании:
widget.destroy();
```

Project ID публичен; пароль и персональный токен не передаются в SDK.
Пакет пока не опубликован в npm. Подробнее: [SDK](docs/sdk.md), [MCP](docs/agents-api.md).

## Проверки

```sh
sh scripts/ci/install-tools.sh helm
uv run ruff check .
uv run ruff format --check .
uv run pytest
npm run typecheck
npm run format:check
npm test
npx playwright install chromium webkit
npm run test:browser
npm run build
npm run pack:sdk
```

HTTP-тесты используют временные схемы настоящего PostgreSQL на 55581;
`REVIEW_TEST_DATABASE_URL` позволяет выбрать отдельную тестовую БД. Браузерные
тесты используют синтетический API в Chromium/WebKit. GitHub Actions проверяет
API, SDK, браузеры, Helm и Docker build без production-секретов и автодеплоя.

## Границы версии

Нет SMTP, SSO/MFA и самостоятельного восстановления пароля: аккаунт восстанавливает
администратор через CLI. MCP работает через stdio; HTTP/OAuth endpoint пока нет.
DOM-снимок может отличаться для iframe, WebGL и внешних изображений.
Чувствительный текст размечается `data-review-private`. Подробнее — [состояние](docs/status.md).

## Другие проекты

[Gitmora](https://github.com/afkbot-io/gitmora) — контекст работы агентов;
[Tasktopia](https://github.com/afkbot-io/tasktopia) — управление задачами;
[UCaseLab](https://github.com/afkbot-io/ucaselab) — пользовательские сценарии.
Notemora отвечает за замечания к интерфейсу. Общей авторизации или автоматической
синхронизации между этими проектами в текущей версии нет.
