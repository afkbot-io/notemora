# Свой сервер Notemora

Нужны Docker Compose v2, свой домен и HTTPS reverse proxy. Готового публичного
серверного образа пока нет: собирайте его из этого репозитория.

## Docker и HTTPS

1. Направьте DNS на сервер и настройте HTTPS reverse proxy на `http://127.0.0.1:5292`.
   API, кабинет, `/sdk/` и `/api/` обслуживаются одним origin.
2. Создайте приватный файл вне Git с правами `0600`:

   ```ini
   POSTGRES_PASSWORD=<свой случайный пароль>
   REVIEW_DATABASE_URL=postgresql+psycopg://review:<URL-encoded пароль>@db:5432/review
   REVIEW_WEB_ORIGIN=https://review.example.com
   ```

   Пароль в URI соответствует `POSTGRES_PASSWORD`; специальные символы кодируются.
   Значения выше — placeholders, их нужно заменить.

3. Запустите production override:

   ```sh
   docker compose --env-file /private/path/notemora.env \
     -f compose.yaml -f deploy/compose.production.example.yaml up --build -d
   ```

4. Проверьте `/healthz`, `/readyz`, `/version` через свой HTTPS-домен. Создайте администратора:

   ```sh
   docker compose --env-file /private/path/notemora.env \
     -f compose.yaml -f deploy/compose.production.example.yaml \
     exec api review-admin create-user --email owner@example.com --name 'Владелец' --admin
   ```

   Пароль вводится скрыто.

Override включает production, Secure cookies и обязательные собственные credentials.
Порты остаются на loopback. `compose.yaml` предназначен для локальной разработки.
Не включайте `Cross-Origin-Opener-Policy: same-origin`: он разрывает popup-вход
виджета; при необходимости используйте `same-origin-allow-popups`.

## Kubernetes

Нужны Traefik, cert-manager и StorageClass с постоянными volumes. Создайте namespace,
свой ClusterIssuer и Secret `notemora-env` с `POSTGRES_PASSWORD` и `REVIEW_DATABASE_URL`.
В Kubernetes адрес базы в URI: `review-postgres:5432/review`.

```sh
kubectl create namespace notemora
kubectl -n notemora create secret generic notemora-env --from-env-file=/private/path/runtime.env
```

Соберите образ, опубликуйте в своём registry и получите настоящий digest:

```sh
helm upgrade --install notemora deploy/chart --namespace notemora \
  --set-string host=review.example.com \
  --set-string image.repository=registry.example.com/notemora \
  --set-string image.tag=<ваш-tag> \
  --set-string image.digest=sha256:<настоящий-digest> \
  --set-string storageClass=<ваш-storage-class> \
  --set-string ingress.clusterIssuer=<ваш-issuer> \
  --rollback-on-failure --wait --wait-for-jobs --timeout 8m
```

Замените placeholders. Для закрытого registry передайте `pullSecret` со своим reader
Secret. По умолчанию credentials registry не требуются. Chart использует одну
реплику, Recreate, миграционный Job, PostgreSQL/PVC и отдельный PVC для снимков.
Это не HA; резервное копирование и проверка восстановления настраиваются отдельно.

## Аккаунты и данные

`review-admin create-user` создаёт пользователя; `--admin` назначает администратора,
`--project <UUID> --role member` добавляет в проект. `set-password` меняет пароль
и отзывает прежние сессии, токены и приглашения. Для автоматизации есть `--password-stdin`.

Сообщения живут 7 суток. API сразу скрывает истёкшие данные, фоновая задача удаляет
их раз в минуту. Явная очистка: `review-admin purge` в окружении приложения.
Очистка не удаляет данные из внешних backups.

Снимки находятся в закрытом filesystem volume. Для S3 задайте `REVIEW_S3_BUCKET`,
`REVIEW_S3_ENDPOINT_URL`, `REVIEW_S3_REGION`; credentials берутся из стандартной AWS
chain. Реальный S3 нужно проверить в своём контуре отдельно. Не записывайте
Authorization, cookies, пароли и одноразовые ссылки в журналы.
