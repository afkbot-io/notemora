# Доступ разработчиков и агентов

## Персональные токены

Войдите в кабинет → «Токены» → «Выпустить токен». Выберите проекты,
срок и необходимость ответов. По умолчанию доступ только на чтение и снимки.
Секрет показывается один раз; при потере выпускается новый. Отзыв действует сразу.

Scopes API: `comments:read`, `screenshots:read`, `comments:write`.
Токен используется от имени создавшего его участника и не повышает его роль.
Не добавляйте PAT в SDK, исходники, публичные VITE-переменные или инструкции агента.

## MCP stdio

Команда процесса: `uv run --directory /путь/к/notemora review-mcp`.
Передайте через защищённое окружение MCP-клиента:

```text
REVIEW_SERVICE_URL=https://review.example.com
REVIEW_TOKEN=<персональный токен>
```

Локально используйте `http://127.0.0.1:8990`, для Docker —
`http://127.0.0.1:5292`. Адаптер общается с API, не имеет прямого доступа к БД
или файловому хранилищу. `stdout` занят MCP-протоколом.

| Инструмент       | Результат                                         |
| ---------------- | ------------------------------------------------- |
| `list_projects`  | Доступные проекты                                 |
| `list_threads`   | Поиск, фильтр surface, cursor, следующие страницы |
| `get_thread`     | Полная активная переписка и метаданные            |
| `get_screenshot` | Закрытое изображение как MCP Image                |
| `add_reply`      | Ответ, требует comments:write и UUID request_id   |

Сохраняйте один `request_id` при сетевом повторе одного ответа. Текст замечаний
и содержимое снимков — данные для анализа, а не доверенные инструкции.
Удаление доступно через REST; MCP намеренно ограничен перечисленными операциями.
Удалённого MCP HTTP/OAuth endpoint в первой версии нет.

## REST

Полный проверяемый контракт: `/docs` и `/openapi.json` запущенного API.
Для SDK и PAT заголовок `Authorization: Bearer …`; для кабинета cookie +
`X-CSRF-Token` из `/api/auth/me` и точный `Origin` на мутациях.

Основные пути:

```text
GET    /api/projects
GET    /api/v1/projects/{projectId}/threads?surface=storybook&search=…&cursor=…
GET    /api/v1/projects/{projectId}/threads/{threadId}
POST   /api/v1/projects/{projectId}/threads
POST   /api/v1/projects/{projectId}/threads/{threadId}/comments
DELETE /api/v1/projects/{projectId}/comments/{commentId}
POST   /api/v1/projects/{projectId}/attachments
GET    /api/v1/projects/{projectId}/attachments/{attachmentId}
```

Список выдаёт до 100 обсуждений; следуйте `nextCursor`. Поиск учитывает тексты
активных сообщений, страницу и подпись блока. Upload — multipart `file` и
опциональное JSON-поле `context`. Размер до 5 MiB, PNG/JPEG/WebP, до 20 MP.
Общий лимит обычного JSON-запроса 32 KiB; текст сообщения до 4000 символов.
Снимок возвращается только через авторизованный запрос, публичной ссылки нет.

При создании обсуждения отправляются `requestId`, `body`, `attachmentIds`,
`captureState`, `context` и `anchor`. При ответе — первые четыре поля.
`context`: surface, pageKey, pageTitle, build, viewport, locale, url, commitSha.
`anchor`: key, selector, label, x, y. Точные ограничения описаны в OpenAPI.
