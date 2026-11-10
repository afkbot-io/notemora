import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { date, message, request, tokenSchema } from "./api";
import type { Project, Token } from "./api";
import { Empty, Modal, Notice } from "./ui";

export function Tokens({ projects }: { projects: Project[] }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const reload = useCallback(
    async () => setTokens(await request("/tokens", z.array(tokenSchema))),
    [],
  );
  useEffect(() => {
    void reload().catch((error) => setError(message(error)));
  }, [reload]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await request(
        "/tokens",
        tokenSchema.extend({ secret: z.string() }),
        {
          method: "POST",
          body: {
            name: data.get("name"),
            projectIds: data.getAll("projects"),
            scopes: [
              "comments:read",
              "screenshots:read",
              ...(data.get("write") ? ["comments:write"] : []),
            ],
            expiresInDays: Number(data.get("days")),
          },
        },
      );
      setSecret(result.secret);
      setCreating(false);
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await request("/tokens/" + id, z.undefined(), { method: "DELETE" });
      setConfirm("");
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-toolbar">
        <button
          className="primary"
          disabled={!projects.length}
          onClick={() => {
            setError("");
            setCreating(true);
          }}
        >
          Выпустить токен
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      {tokens.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Токен</th>
                <th>Доступ</th>
                <th>Срок и использование</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <strong>{token.name}</strong>
                    <span className="table-sub">
                      {token.projectIds
                        .map(
                          (id) =>
                            projects.find((p) => p.id === id)?.name ??
                            "Проект недоступен",
                        )
                        .join(", ")}
                    </span>
                  </td>
                  <td>
                    {token.scopes.includes("comments:write")
                      ? "Чтение и ответы"
                      : "Только чтение"}
                    <span className="table-sub">Снимки включены</span>
                  </td>
                  <td>
                    {token.revoked ? (
                      <span className="badge">Отозван</span>
                    ) : (
                      date(token.expiresAt)
                    )}
                    <span className="table-sub">
                      {token.lastUsedAt
                        ? "Использован " + date(token.lastUsedAt)
                        : "Ещё не использован"}
                    </span>
                  </td>
                  <td>
                    {!token.revoked &&
                      (confirm === token.id ? (
                        <div className="inline-actions">
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => void revoke(token.id)}
                          >
                            Подтвердить отзыв
                          </button>
                          <button onClick={() => setConfirm("")}>Отмена</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirm(token.id)}>
                          Отозвать
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Нет токенов" />
      )}
      <details className="setup-panel">
        <summary>Подключить MCP</summary>
        <pre>
          <code>
            {"REVIEW_SERVICE_URL=" +
              location.origin +
              "\nREVIEW_TOKEN=<токен>\nreview-mcp"}
          </code>
        </pre>
      </details>
      <Sessions />
      {creating && (
        <Modal
          title="Новый персональный токен"
          close={() => setCreating(false)}
        >
          <form onSubmit={submit}>
            <label>
              Название
              <input
                name="name"
                required
                maxLength={100}
                placeholder="Рабочий агент"
                autoFocus
              />
            </label>
            <fieldset>
              <legend>Проекты</legend>
              {projects.map((project) => (
                <label className="check" key={project.id}>
                  <input type="checkbox" name="projects" value={project.id} />
                  {project.name}
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input type="checkbox" name="write" />
              Чтение и ответы
            </label>
            <label>
              Срок действия
              <select name="days" defaultValue="30">
                <option value="7">7 дней</option>
                <option value="30">30 дней</option>
                <option value="90">90 дней</option>
                <option value="365">365 дней</option>
              </select>
            </label>
            {error && <Notice>{error}</Notice>}
            <button disabled={busy} className="primary full">
              Выпустить токен
            </button>
          </form>
        </Modal>
      )}
      {secret && (
        <Modal title="Сохраните токен" close={() => setSecret("")}>
          <p>Токен показывается один раз.</p>
          <textarea
            readOnly
            rows={3}
            value={secret}
            aria-label="Новый персональный токен"
            data-review-private
          />
          <button
            className="primary full"
            onClick={() =>
              void navigator.clipboard
                .writeText(secret)
                .catch((error) => setError(message(error)))
            }
          >
            Копировать токен
          </button>
        </Modal>
      )}
    </>
  );
}

export function Sessions() {
  const schema = z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      expiresAt: z.string(),
      lastUsedAt: z.string().nullable(),
      current: z.boolean(),
    }),
  );
  const [rows, setRows] = useState<z.infer<typeof schema>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void request("/auth/sessions", schema)
      .then(setRows)
      .catch((error) => setError(message(error)));
  }, []);
  async function revoke(id: string) {
    try {
      await request("/auth/sessions/" + id, z.undefined(), {
        method: "DELETE",
      });
      setRows((value) => value.filter((row) => row.id !== id));
    } catch (error) {
      setError(message(error));
    }
  }
  return (
    <section className="setup-panel">
      <h2>Сессии аккаунта</h2>
      {rows.map((row) => (
        <div className="person-row" key={row.id}>
          <span>
            {row.current ? "Текущая сессия" : "Другой вход"}
            <span className="table-sub">Вход {date(row.createdAt)}</span>
          </span>
          {!row.current && (
            <button onClick={() => void revoke(row.id)}>Завершить</button>
          )}
        </div>
      ))}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}
