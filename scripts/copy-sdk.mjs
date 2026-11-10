import { cp, mkdir, rm } from "node:fs/promises";
await rm("apps/web/dist/sdk", { recursive: true, force: true });
await mkdir("apps/web/dist/sdk", { recursive: true });
await cp("packages/sdk/dist", "apps/web/dist/sdk", { recursive: true });
