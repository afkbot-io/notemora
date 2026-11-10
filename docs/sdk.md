# JS SDK

Сначала создайте проект и зарегистрируйте **точный origin** приложения или
Storybook в кабинете. Project ID публичен. PAT и пароль в приложение не передаются.

## Обычная страница

Собранный SDK и его chunks доступны на `/sdk/` сервиса. Если файлы раздаёт сам API,
CORS действует для зарегистрированных origins проекта. Если reverse proxy раздаёт
`/sdk/*` самостоятельно, настройте для них CORS отдельно. Можно также установить
локальный пакет в сборку приложения или раздавать SDK на origin приложения.

```ts
import { initReview } from "@notemora/sdk";

const review = initReview({
  serviceUrl: "https://review.example.com",
  projectId: "<ID проекта>",
  surface: "app",
  build: "preview-42",
  commitSha: "<SHA из CI>",
  page: () => ({ key: location.pathname, title: document.title }),
});

// При размонтировании интеграции:
review.destroy();
```

SDK — workspace `@notemora/sdk`. Для использования в другом репозитории:

```sh
npm run pack:sdk
# В приложении-потребителе:
npm install /путь/к/notemora/output/sdk/notemora-sdk-0.1.0.tgz
```

Пакет содержит собранный JS, типы и MIT license. Приватные credentials и registry
не требуются. Отдельной публикации npm пока нет; workspace имеет `private: true`.
CLI `pack:sdk` проверяет состав архива. Все chunks `dist` нужно сохранять вместе.

При `screenshots: false` автоматические снимки отключаются. Кнопка «Комментарии»
появляется при вызове `initReview`; ваш dev-флаг должен управлять этим вызовом.

## React

Монтируйте один виджет на приложение. Функция `page` должна читать актуальный
маршрут, а не замыкать старое значение:

```tsx
useEffect(() => {
  const widget = initReview({
    serviceUrl: reviewOrigin,
    projectId,
    surface: "app",
    page: () => ({ key: location.pathname, title: document.title }),
  });
  return () => widget.destroy();
}, [reviewOrigin, projectId]);
```

Ставьте стабильную привязку на осмысленные блоки:

```html
<button data-review-id="checkout.confirm" data-review-label="Подтвердить заказ">
  Подтвердить
</button>
<section data-review-private>
  Содержимое, которое нельзя сохранять на снимке
</section>
```

`data-review-id` должен быть уникален на странице. Без него используется CSS-путь
с `nth-of-type`; после перестановки DOM он может перестать совпадать. Виджет
открывает исходный снимок, даже когда блок уже не найден. Значения полей и
`innerText` автоматически не используются как названия блоков.

## Storybook

Подключайте виджет в **preview iframe**, а не в manager. Один экземпляр на
документ; `page()` возвращает текущий `context.id` story и её название. Можно
обновлять эти значения из существующего глобального decorator, сохраняя их в
модульной переменной. Нельзя пересоздавать SDK при каждом рендере story.

```ts
let currentStory = { key: "initial", title: "Storybook" };
const widget = initReview({
  serviceUrl: reviewOrigin,
  projectId,
  surface: "storybook",
  build: buildId,
  commitSha,
  page: () => currentStory,
});

// В decorator перед рендером:
currentStory = { key: context.id, title: `${context.title} / ${context.name}` };
// При HMR/dispose:
// widget.destroy();
```

Это схема интеграции. Перенос этого репозитория не меняет конфигурацию SDK в приложениях-потребителях. В каталоге
историй и экспортируемых прототипах должен использоваться один serviceUrl и
стабильный Project ID. Прямой URL `iframe.html?id=…` SDK определяет автоматически,
если `page` не задан.

## Как работает вход

Нажатие «Войти» открывает платформу как top-level popup. Там участник входит
в собственный аккаунт и подтверждает доступ проекту/сайту. SDK проверяет origin,
источник окна и state, затем обменивает одноразовый код с PKCE. Bearer живёт
15 минут и хранится только в памяти. После истечения нужен повторный вход.
Cookies платформы не пересылаются из приложения-потребителя.

CSP сайта должна разрешать `connect-src` к сервису и `img-src blob:` для закрытых
снимков. Если сайт включает `Cross-Origin-Opener-Policy: same-origin`, popup может
потерять opener; для этой интеграции нужен `same-origin-allow-popups` либо другой
согласованный способ входа. Сам кабинет не разрывает opener. Во встроенном
sandbox iframe нужно разрешить popup и top-level переходы, если они нужны браузеру.

## Ограничения снимков

Снимок создаётся из DOM viewport при выборе блока; это не захват браузерного
экрана. Внешние iframe, WebGL, некоторые CSS-эффекты и картинки без CORS могут
отсутствовать. Для чувствительных областей ставьте `data-review-private`:
автоматическая маска не распознаёт произвольные персональные данные в тексте.
При ошибке рендера сообщение можно отправить с `captureState=failed`. Ошибка
загрузки готового снимка сохраняет черновик для повторной отправки.
