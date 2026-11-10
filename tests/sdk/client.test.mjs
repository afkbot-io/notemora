import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReviewClient,
  createProof,
  safePageUrl,
  anchorSchema,
} from "../../packages/sdk/dist/review.js";

test("PKCE uses fresh S256 proofs and page metadata strips URL secrets", async () => {
  const first = await createProof(),
    second = await createProof();
  assert.equal(first.verifier.length, 43);
  assert.equal(
    first.challenge,
    Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(first.verifier),
      ),
    ).toString("base64url"),
  );
  assert.notEqual(first.state, second.state);
  assert.equal(
    safePageUrl("https://example.test/checkout?token=private#secret"),
    "https://example.test/checkout",
  );
  assert.equal(
    anchorSchema.safeParse({
      key: "x",
      selector: "button",
      label: "Кнопка",
      x: NaN,
      y: 0.5,
    }).success,
    false,
  );
});

test("SDK omits browser cookies, authenticates with its own bearer, and refuses cursor loops", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ threads: [], nextCursor: "repeat" });
  };
  try {
    const client = new ReviewClient(
      "https://review.example.test",
      "project",
      () => "short-lived-widget-token",
    );
    await assert.rejects(client.list("app"), /Слишком большой список/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(
      calls[0].options.headers.Authorization,
      "Bearer short-lived-widget-token",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("SDK abort preserves cancellation and does not turn it into a retry instruction", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => {
    throw controller.signal.reason;
  };
  try {
    const client = new ReviewClient(
      "https://review.example.test",
      "project",
      () => "widget",
    );
    await assert.rejects(
      client.list("app", controller.signal),
      (error) => error === controller.signal.reason,
    );
  } finally {
    globalThis.fetch = original;
  }
});
