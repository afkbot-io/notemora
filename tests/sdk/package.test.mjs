import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

test("public SDK archive includes code, types and license without private configuration", () => {
  const result = spawnSync(process.execPath, ["scripts/pack-sdk.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const archive = JSON.parse(result.stdout);
  assert.ok(existsSync(archive.path));
  assert.match(archive.integrity, /^sha512-/);
  assert.ok(archive.files.includes("dist/review.js"));
  assert.ok(archive.files.includes("dist/index.d.ts"));
  assert.ok(archive.files.includes("LICENSE"));
  assert.ok(
    archive.files.every(
      (path) =>
        path.startsWith("dist/") ||
        ["package.json", "LICENSE", "README.md"].includes(path),
    ),
  );
});
