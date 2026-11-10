import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Упаковывает собранный SDK без доступа к registry и без публикации пакета.
await mkdir("output/sdk", { recursive: true });
const result = spawnSync(
  "npm",
  [
    "pack",
    "--workspace",
    "@notemora/sdk",
    "--ignore-scripts",
    "--pack-destination",
    "output/sdk",
    "--json",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0) throw new Error("Не удалось упаковать SDK");
const [archive] = JSON.parse(result.stdout);
if (
  !archive.files.some((file) => file.path === "dist/review.js") ||
  !archive.files.some((file) => file.path === "dist/index.d.ts") ||
  !archive.files.some((file) => file.path === "LICENSE") ||
  archive.files.some(
    (file) =>
      !file.path.startsWith("dist/") &&
      !["package.json", "LICENSE", "README.md"].includes(file.path),
  )
) {
  throw new Error("Состав SDK archive не соответствует публичной поставке");
}
console.log(
  JSON.stringify(
    {
      path: `output/sdk/${archive.filename}`,
      integrity: archive.integrity,
      files: archive.files.map((file) => file.path),
    },
    null,
    2,
  ),
);
