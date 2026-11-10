import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { expect } from "@playwright/test";

const origin = "http://127.0.0.1:5999";
const service = "https://review.example.test";

/** Подключает настоящий собранный SDK к странице и синтетическому API без внешней сети. */
export async function openWidget(
  page,
  context,
  { existing = false, belowFold = false } = {},
) {
  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
  const thread = {
    id: "thread-delivery",
    context: {
      surface: "app",
      pageKey: "checkout-fixture",
      pageTitle: "Оформление заказа",
      build: "fixture",
      viewport: { width: 1280, height: 900 },
      locale: "ru",
    },
    anchor: {
      key: "id:delivery",
      selector: '[data-review-id="delivery"]',
      label: "Способ получения",
      x: 0.5,
      y: 0.5,
    },
    comments: [
      {
        id: "comment-delivery",
        body: "Проверить отступы в блоке доставки",
        author: { id: "designer", name: "Дизайнер" },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        canDelete: true,
        captureState: "none",
        attachments: [],
      },
    ],
  };
  await context.route(`${service}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname === "/authorize") {
      return route.fulfill({
        contentType: "text/html",
        body: `<script>opener.postMessage({type:'review:authorization',state:${JSON.stringify(url.searchParams.get("state"))},code:'synthetic-code'},${JSON.stringify(origin)})</script>`,
      });
    }
    if (url.pathname === "/api/auth/exchange")
      return route.fulfill({
        headers,
        json: {
          accessToken: "synthetic-widget-token",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: "designer", name: "Дизайнер" },
        },
      });
    expect(request.headers().authorization).toBe(
      "Bearer synthetic-widget-token",
    );
    expect(request.headers().cookie).toBeUndefined();
    if (request.method() === "GET" && url.pathname.endsWith("/threads")) {
      return route.fulfill({
        headers,
        json: { threads: existing ? [thread] : [], nextCursor: null },
      });
    }
    throw new Error(
      `Unexpected fixture request: ${request.method()} ${url.pathname}`,
    );
  });
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/sdk/")) {
      return route.fulfill({
        contentType: "text/javascript",
        body: await readFile(
          new URL(
            `../../packages/sdk/dist/${basename(url.pathname)}`,
            import.meta.url,
          ),
        ),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SDK fixture</title>
      <style>body{margin:0;background:#f5f7fb;font:16px/1.5 system-ui;color:#182438;min-height:2200px}main{margin:96px 24px;width:min(340px,calc(100vw - 48px))}article{padding:24px;background:white;border:1px solid #dce3ef;border-radius:14px;margin:24px 0}h1{font-size:24px}button{padding:12px;border:1px solid #bcc9de;border-radius:10px;background:white;font:inherit;cursor:pointer}#delivery{margin-top:${belowFold ? 1400 : 24}px}#confirm{margin-top:48px}input{display:block;padding:12px;margin-top:32px;width:100%;box-sizing:border-box}</style>
      <main><h1>Оформление заказа</h1><article id="delivery" data-review-id="delivery" data-review-label="Способ получения"><h2>Доставка</h2><button id="nested">Изменить адрес</button></article><button id="confirm" data-review-id="confirm" data-review-label="Подтвердить заказ">Подтвердить заказ</button><input aria-label="Поле страницы"></main>
      <script type="module">import{initReview}from'/sdk/review.js';window.pageKey='checkout-fixture';window.review=initReview({serviceUrl:${JSON.stringify(service)},projectId:'synthetic-ui',surface:'app',build:'fixture',screenshots:false,page:()=>({key:window.pageKey,title:'Оформление заказа'})});document.querySelector('#confirm').addEventListener('click',()=>{document.body.dataset.activated='true'});</script></html>`,
    });
  });
  await page.goto(origin);
  const widget = page.locator("[data-review-widget]");
  await widget
    .getByRole("button", { name: "Комментарии", exact: true })
    .click();
  const panel = widget.getByRole("dialog", {
    name: "Комментарии к интерфейсу",
  });
  await panel.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  return {
    widget,
    panel,
    target: page.locator("#delivery"),
    confirm: page.locator("#confirm"),
  };
}

/** Сравнивает видимую рамку с границами реального блока, а не с координатой фикстуры. */
export async function expectAligned(overlay, target) {
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await overlay.boundingBox();
      const block = await target.boundingBox();
      if (!bounds || !block) return false;
      return ["x", "y", "width", "height"].every(
        (key) => Math.abs(bounds[key] - block[key]) < 1,
      );
    })
    .toBe(true);
}
