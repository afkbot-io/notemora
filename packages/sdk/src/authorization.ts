import { z } from "zod";

const responseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  user: z.object({ id: z.string(), name: z.string() }),
});
export type WidgetSession = z.infer<typeof responseSchema>;

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Генерирует PKCE S256. Секрет verifier не передаётся через URL или postMessage. */
export async function createProof() {
  const verifier = encoded(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encoded(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  return {
    verifier,
    challenge,
    state: encoded(crypto.getRandomValues(new Uint8Array(24))),
  };
}

/** Открывается непосредственно из клика; проверяет origin, WindowProxy и state, освобождает таймеры. */
export async function signIn(
  serviceUrl: string,
  projectId: string,
  signal: AbortSignal,
): Promise<WidgetSession> {
  const popup = window.open(
    "about:blank",
    "review-" + crypto.randomUUID(),
    "popup,width=500,height=680",
  );
  if (!popup)
    throw new Error("Разрешите всплывающее окно для входа в Notemora");
  let proof: Awaited<ReturnType<typeof createProof>>;
  try {
    proof = await createProof();
  } catch (error) {
    popup.close();
    throw error;
  }
  if (signal.aborted) {
    popup.close();
    signal.throwIfAborted();
  }
  const origin = new URL(serviceUrl).origin;
  const url = new URL("/authorize", serviceUrl);
  url.search = new URLSearchParams({
    project: projectId,
    origin: location.origin,
    challenge: proof.challenge,
    state: proof.state,
  }).toString();
  const code = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearInterval(closed);
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      popup.close();
    };
    const abort = () => {
      cleanup();
      reject(new Error("Вход отменён"));
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== origin || event.source !== popup) return;
      const data = z
        .object({
          type: z.literal("review:authorization"),
          state: z.string(),
          code: z.string(),
        })
        .safeParse(event.data);
      if (!data.success || data.data.state !== proof.state) return;
      cleanup();
      resolve(data.data.code);
    };
    const closed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("Окно входа закрыто"));
      }
    }, 500);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Время входа истекло. Повторите."));
    }, 180000);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    popup.location.replace(url.toString());
  });
  const response = await fetch(new URL("/api/auth/exchange", serviceUrl), {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      verifier: proof.verifier,
      projectId,
      origin: location.origin,
    }),
  });
  if (!response.ok) throw new Error("Не удалось завершить вход. Повторите.");
  return responseSchema.parse(await response.json());
}
