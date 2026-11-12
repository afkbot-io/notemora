import { expect, test } from "@playwright/test";
import { expectAligned, openWidget } from "./widget-fixture.mjs";

test("picking previews the exact block under the mouse without activating the page", async ({
  page,
  context,
}) => {
  const { widget, panel, target, confirm } = await openWidget(page, context);
  await widget.getByRole("button", { name: /Выбрать блок/ }).click();
  await page.locator("#nested").hover();
  const preview = widget.locator('[data-review-highlight="pick"]');
  await expectAligned(preview, target);
  await expect(widget.locator(".target-label")).toHaveText("Способ получения");
  await confirm.hover();
  await expectAligned(preview, confirm);
  await widget
    .getByRole("button", { name: "Отменить выбор", exact: true })
    .hover();
  await expect(preview).toBeHidden();
  await confirm.hover();
  await confirm.click();
  await expect(
    panel.getByRole("textbox", { name: "Комментарий", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("header strong").first()).toHaveText(
    "Подтвердить заказ",
  );
  await expectAligned(
    widget.locator('[data-review-highlight="selected"]'),
    confirm,
  );
  await expect(page.locator("body")).not.toHaveAttribute("data-activated");
});

test("show block temporarily uncovers and highlights its target, then restores the draft", async ({
  page,
  context,
}) => {
  const { widget, panel, target } = await openWidget(page, context, {
    existing: true,
    belowFold: true,
  });
  await panel.locator(".row").click();
  await panel
    .getByRole("textbox", { name: "Ответить", exact: true })
    .fill("Сохранить черновик");
  await page.clock.install();
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  await expect(panel).toBeHidden();
  const reveal = widget.locator('[data-review-highlight="reveal"]');
  await expectAligned(reveal, target);
  await page.evaluate(() => window.scrollBy(0, 60));
  await expectAligned(reveal, target);
  await page.clock.fastForward(1000);
  await expect(reveal).toBeVisible();
  await page.clock.fastForward(4000);
  await expect(reveal).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", { name: "Ответить", exact: true }),
  ).toHaveValue("Сохранить черновик");
});

test("canceling a reveal or changing page never reopens the old discussion", async ({
  page,
  context,
}) => {
  const { widget, panel } = await openWidget(page, context, { existing: true });
  await panel.locator(".row").click();
  await page.clock.install();
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  await widget.getByRole("button", { name: /^Комментарии/ }).click();
  await page.clock.fastForward(5000);
  await expect(panel).toHaveCount(0);
  await expect(widget.locator(".target-highlight")).toBeHidden();
  await widget.getByRole("button", { name: /^Комментарии/ }).click();
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  await page.evaluate(() => {
    window.pageKey = "other-page";
    window.review.refreshContext();
  });
  await page.clock.fastForward(5000);
  await expect(widget.locator(".target-highlight")).toBeHidden();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(() => window.review.destroy());
  await page.clock.fastForward(5000);
  await expect(widget).toHaveCount(0);
});

test("keyboard picking and Escape keep the focused block and existing draft", async ({
  page,
  context,
}) => {
  const { widget, panel, confirm } = await openWidget(page, context);
  await panel.getByRole("button", { name: "Закрыть комментарии" }).click();
  await confirm.focus();
  await page.keyboard.press("c");
  await expectAligned(
    widget.locator('[data-review-highlight="pick"]'),
    confirm,
  );
  await page.keyboard.press("Enter");
  await expect(panel.locator("header strong").first()).toHaveText(
    "Подтвердить заказ",
  );
  await expect(page.locator("body")).not.toHaveAttribute("data-activated");
  await panel.getByRole("textbox").fill("Черновик");
  await page.clock.install();
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("textbox")).toHaveValue("Черновик");
  await page.clock.fastForward(5000);
  await expect(panel.getByRole("textbox")).toHaveValue("Черновик");
});

test("a delayed host refresh preserves a block already selected on the new page", async ({
  page,
  context,
}) => {
  const { widget, panel, confirm } = await openWidget(page, context);
  await page.evaluate(() => {
    window.pageKey = "next-page";
  });
  await widget.getByRole("button", { name: /Выбрать блок/ }).click();
  await confirm.click();
  await panel.getByRole("textbox").fill("Черновик новой страницы");
  await page.evaluate(() => window.review.refreshContext());
  await expect(panel.getByRole("textbox")).toHaveValue(
    "Черновик новой страницы",
  );
});

test("a hidden source block reports the problem without closing the discussion", async ({
  page,
  context,
}) => {
  const { panel, target } = await openWidget(page, context, { existing: true });
  await panel.locator(".row").click();
  await target.evaluate((node) => {
    node.hidden = true;
  });
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("скрыт");
  await expect(
    panel.getByRole("textbox", { name: "Ответить", exact: true }),
  ).toBeVisible();
});

test("normal motion pulses the reveal and keyboard focus returns to the same action", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { widget, panel } = await openWidget(page, context, { existing: true });
  await panel.locator(".row").click();
  const show = panel.getByRole("button", {
    name: "Показать блок",
    exact: true,
  });
  await show.focus();
  await page.keyboard.press("Enter");
  const reveal = widget.locator('[data-review-highlight="reveal"]');
  await expect(reveal).toBeVisible();
  await expect(reveal).toHaveCSS("animation-name", "review-locate");
  await expect
    .poll(() =>
      reveal.evaluate((node) => Number(getComputedStyle(node).opacity)),
    )
    .toBeLessThan(0.9);
  await expect(show).toBeFocused({ timeout: 10_000 });
});

test("interacting with the page cancels the temporary return without interrupting input", async ({
  page,
  context,
}) => {
  const { panel } = await openWidget(page, context, { existing: true });
  await panel.locator(".row").click();
  await page.clock.install();
  await panel
    .getByRole("button", { name: "Показать блок", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "Поле страницы",
    exact: true,
  });
  await input.click();
  await input.fill("Текст страницы");
  await page.clock.fastForward(5000);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Текст страницы");
  await expect(panel).toHaveCount(0);
});

for (const width of [320, 390, 480]) {
  test(`toolbar and reveal remain usable at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { widget, panel, target } = await openWidget(page, context, {
      existing: true,
    });
    const toolbar = widget.getByRole("toolbar", { name: "Режим комментариев" });
    await expect
      .poll(async () => {
        const bounds = await toolbar.boundingBox();
        return (
          bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width
        );
      })
      .toBe(true);
    await expect
      .poll(() =>
        toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth),
      )
      .toBe(true);
    await panel.locator(".row").click();
    await panel
      .getByRole("button", { name: "Показать блок", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expectAligned(
      widget.locator('[data-review-highlight="reveal"]'),
      target,
    );
    await expect(widget.locator('[data-review-highlight="reveal"]')).toHaveCSS(
      "animation-name",
      "none",
    );
  });
}

test.describe("touch selection", () => {
  test.use({ hasTouch: true });
  test("drag preview and release select the block under the finger", async ({
    page,
    context,
  }) => {
    const { widget, panel, target, confirm } = await openWidget(page, context);
    await widget.getByRole("button", { name: /Выбрать блок/ }).click();
    const first = await target.boundingBox();
    await target.dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: first.x + 30,
      clientY: first.y + 30,
    });
    await expectAligned(
      widget.locator('[data-review-highlight="pick"]'),
      target,
    );
    await target.dispatchEvent("pointercancel", { pointerType: "touch" });
    await expect(widget.locator('[data-review-highlight="pick"]')).toBeHidden();
    const second = await confirm.boundingBox();
    await target.dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: first.x + 30,
      clientY: first.y + 30,
    });
    await target.dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: second.x + 20,
      clientY: second.y + 20,
    });
    await expectAligned(
      widget.locator('[data-review-highlight="pick"]'),
      confirm,
    );
    await target.dispatchEvent("pointerup", {
      pointerType: "touch",
      clientX: second.x + 20,
      clientY: second.y + 20,
    });
    await expect(panel.locator("header strong").first()).toHaveText(
      "Подтвердить заказ",
    );
    await expect(page.locator("body")).not.toHaveAttribute("data-activated");
  });
});
