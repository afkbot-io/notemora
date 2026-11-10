import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { message, request, userSchema } from "./api";
import type { User } from "./api";
import { Modal, Notice } from "./ui";

export function People() {
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [activation, setActivation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(
    async () => setUsers(await request("/users", z.array(userSchema))),
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
        "/users",
        userSchema.extend({ activationToken: z.string() }),
        {
          method: "POST",
          body: { name: data.get("name"), email: data.get("email") },
        },
      );
      setActivation(
        location.origin +
          "/activate#token=" +
          encodeURIComponent(result.activationToken),
      );
      setAdding(false);
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(user: User) {
    setBusy(true);
    setError("");
    try {
      await request("/users/" + user.id, userSchema, {
        method: "PATCH",
        body: { active: !user.active },
      });
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function renew(user: User) {
    setBusy(true);
    setError("");
    try {
      const value = await request(
        `/users/${user.id}/invitation`,
        z.object({ activationToken: z.string() }),
        { method: "POST" },
      );
      setActivation(
        location.origin +
          "/activate#token=" +
          encodeURIComponent(value.activationToken),
      );
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
          onClick={() => {
            setError("");
            setAdding(true);
          }}
        >
          Пригласить участника
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Участник</th>
              <th>Состояние</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.name}</strong>
                  <span className="table-sub">{user.email}</span>
                </td>
                <td>
                  <span className={"badge " + (user.active ? "success" : "")}>
                    {
                      {
                        active: "Активен",
                        invited: "Приглашён",
                        disabled: "Отключён",
                      }[user.state]
                    }
                  </span>
                  {user.owner && <span className="badge">Администратор</span>}
                </td>
                <td>
                  {!user.owner && (
                    <>
                      {user.state !== "invited" && (
                        <button
                          disabled={busy}
                          onClick={() => void toggle(user)}
                        >
                          {user.active ? "Отключить" : "Включить"}
                        </button>
                      )}
                      {!user.active && (
                        <button
                          disabled={busy}
                          onClick={() => void renew(user)}
                        >
                          Новая ссылка
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Пригласить участника" close={() => setAdding(false)}>
          <form onSubmit={submit}>
            <label>
              Имя
              <input name="name" required maxLength={160} autoFocus />
            </label>
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <p className="muted small">Скопируйте ссылку после создания.</p>
            {error && <Notice>{error}</Notice>}
            <button className="primary full" disabled={busy}>
              Создать приглашение
            </button>
          </form>
        </Modal>
      )}
      {activation && (
        <Modal title="Ссылка активации" close={() => setActivation("")}>
          <p>Одноразовая ссылка на 24 часа.</p>
          <textarea
            readOnly
            rows={4}
            value={activation}
            data-review-private
            aria-label="Одноразовая ссылка активации"
          />
          <button
            className="primary full"
            onClick={() =>
              void navigator.clipboard
                .writeText(activation)
                .catch((error) => setError(message(error)))
            }
          >
            Копировать ссылку
          </button>
        </Modal>
      )}
    </>
  );
}
