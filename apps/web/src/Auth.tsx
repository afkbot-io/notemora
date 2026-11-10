import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { meSchema, message, request, setCsrf } from "./api";
import type { Me } from "./api";
import { Notice } from "./ui";

export function SignIn({ complete }: { complete: (me: Me) => void }) {
  const activation = useRef(
    new URLSearchParams(location.hash.slice(1)).get("token"),
  );
  const activating = location.pathname === "/activate";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (activating) history.replaceState(null, "", "/activate");
  }, [activating]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const password = String(data.get("password"));
      if (activating && password !== data.get("repeat"))
        throw new Error("Пароли не совпадают");
      const me = await request(
        activating ? "/auth/activate" : "/auth/login",
        meSchema,
        {
          method: "POST",
          body: activating
            ? { token: activation.current, password }
            : { email: data.get("email"), password },
        },
      );
      if (activating) history.replaceState(null, "", "/");
      setCsrf(me.csrfToken);
      complete(me);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-form">
        <div className="brand auth-brand">
          <span className="brand-mark">n</span>Notemora
        </div>
        <h2>{activating ? "Активация" : "Вход"}</h2>
        <form onSubmit={submit}>
          {!activating && (
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
              />
            </label>
          )}
          <label>
            {activating ? "Новый пароль" : "Пароль"}
            <input
              name="password"
              type="password"
              autoComplete={activating ? "new-password" : "current-password"}
              required
              minLength={activating ? 12 : 1}
              maxLength={128}
              autoFocus={activating}
            />
          </label>
          {activating && (
            <label>
              Повторите пароль
              <input
                name="repeat"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
              />
            </label>
          )}
          {error && <Notice>{error}</Notice>}
          <button
            className="primary full"
            disabled={busy || (activating && !activation.current)}
          >
            {busy
              ? "Подождите…"
              : activating
                ? "Активировать и войти"
                : "Войти"}
          </button>
        </form>
        {activating && <p className="auth-help">От 12 символов.</p>}
        {activating && !activation.current && (
          <Notice>Ссылка недействительна. Запросите новую.</Notice>
        )}
      </section>
    </main>
  );
}

export function AuthorizeWidget({
  me,
  signedOut,
}: {
  me: Me;
  signedOut: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") ?? "";
  const state = params.get("state") ?? "";
  async function switchAccount() {
    setBusy(true);
    setError("");
    try {
      await request("/auth/logout", z.undefined(), { method: "POST" });
      setCsrf("");
      signedOut();
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  async function authorize() {
    setBusy(true);
    setError("");
    try {
      if (
        !window.opener ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
        new URL(origin).origin !== origin
      )
        throw new Error("Откройте вход кнопкой в виджете");
      const result = await request(
        "/auth/authorize",
        z.object({ code: z.string() }),
        {
          method: "POST",
          body: {
            projectId: params.get("project"),
            origin,
            challenge: params.get("challenge"),
          },
        },
      );
      window.opener.postMessage(
        { type: "review:authorization", state, code: result.code },
        origin,
      );
      window.close();
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  return (
    <main className="authorize-box">
      <div className="brand">
        <span className="brand-mark">n</span>Notemora
      </div>
      <h1>Вход в комментарии</h1>
      <code className="origin">{origin}</code>
      <p className="muted">Доступ к проекту на 15 минут.</p>
      {error && <Notice>{error}</Notice>}
      <button
        className="primary full"
        onClick={() => void authorize()}
        disabled={busy}
      >
        Продолжить как {me.user.name}
      </button>
      <button
        className="full"
        onClick={() => void switchAccount()}
        disabled={busy}
      >
        Войти в другой аккаунт
      </button>
    </main>
  );
}
