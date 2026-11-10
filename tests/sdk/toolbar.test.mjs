import { test } from "node:test";
import assert from "node:assert/strict";
import { placeToolbar } from "../../packages/sdk/src/toolbar.ts";

test("mobile review entry leaves the product close button clickable", () => {
  const placement = placeToolbar(
    { width: 140, height: 44 },
    { width: 390, height: 844 },
    12,
    [{ left: 338, top: 31, width: 32, height: 32 }],
  );
  assert.equal(placement.top, 12);
  assert.ok(placement.left + 140 < 338 - 4);
});
test("a full row of actions moves the review entry below it", () => {
  const placement = placeToolbar(
    { width: 140, height: 44 },
    { width: 320, height: 844 },
    12,
    [{ left: 0, top: 0, width: 320, height: 60 }],
  );
  assert.ok(placement.top >= 64);
  assert.ok(placement.left >= 12 && placement.left + 140 <= 308);
});
