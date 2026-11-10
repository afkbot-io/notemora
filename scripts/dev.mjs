import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";

if (!existsSync(".env")) {
  console.error("Сначала скопируйте .env.example в .env и примените миграции.");
  process.exit(1);
}
const build = spawnSync("npm", ["run", "build", "-w", "@notemora/sdk"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync("apps/web/public/sdk", { recursive: true });
cpSync("packages/sdk/dist", "apps/web/public/sdk", { recursive: true });
const children = [
  spawn("uv", ["run", "review-api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@notemora/web"], {
    stdio: "inherit",
  }),
  spawn(
    "node_modules/.bin/vite",
    ["apps/demo", "--host", "127.0.0.1", "--port", "5291", "--strictPort"],
    { stdio: "inherit" },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children)
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
