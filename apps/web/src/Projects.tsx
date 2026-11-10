import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";
import { message, projectSchema, request, userSchema } from "./api";
import type { Project } from "./api";
import { Empty, Modal, Notice } from "./ui";

export function Projects({
  projects,
  owner,
  userId,
  reload,
}: {
  projects: Project[];
  owner: boolean;
  userId: string;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [members, setMembers] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request(
        editing === "new" ? "/projects" : "/projects/" + editing?.id,
        projectSchema,
        {
          method: editing === "new" ? "POST" : "PUT",
          body: {
            name: form.get("name"),
            origins: String(form.get("origins")).split(/\s+/).filter(Boolean),
          },
        },
      );
      await reload();
      setEditing(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-toolbar">
        {owner && (
          <button
            className="primary"
            onClick={() => {
              setError("");
              setEditing("new");
            }}
          >
            Создать проект
          </button>
        )}
      </div>
      {projects.length ? (
        <div className="project-grid">
          {projects.map((project) => (
            <article className="project-card" key={project.id}>
              <h2>{project.name}</h2>
              <p className="muted">
                {project.origins.length
                  ? project.origins.join(", ")
                  : "Сайты ещё не подключены"}
              </p>
              <details>
                <summary>Подключить виджет</summary>
                <p>Project ID</p>
                <code className="break-all">{project.id}</code>
                <p>Адрес сервиса</p>
                <code>{location.origin}</code>
              </details>
              <div className="card-actions">
                <button onClick={() => setMembers(project)}>Участники</button>
                {project.role === "owner" && (
                  <button
                    onClick={() => {
                      setError("");
                      setEditing(project);
                    }}
                  >
                    Настроить
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="Нет проектов" />
      )}
      {editing && (
        <Modal
          title={editing === "new" ? "Новый проект" : "Настройки проекта"}
          close={() => setEditing(null)}
        >
          <form onSubmit={submit}>
            <label>
              Название
              <input
                name="name"
                required
                maxLength={160}
                defaultValue={editing === "new" ? "" : editing.name}
                autoFocus
              />
            </label>
            <label>
              Разрешённые сайты
              <textarea
                name="origins"
                rows={4}
                placeholder={
                  "https://web.example.com\nhttps://storybook.example.com"
                }
                defaultValue={
                  editing === "new" ? "" : editing.origins.join("\n")
                }
              />
            </label>
            <p className="muted small">По одному адресу на строку, без пути.</p>
            {error && <Notice>{error}</Notice>}
            <button className="primary full" disabled={busy}>
              Сохранить
            </button>
          </form>
        </Modal>
      )}
      {members && (
        <Members
          project={members}
          userId={userId}
          close={() => setMembers(null)}
        />
      )}
    </>
  );
}

export function Members({
  project,
  userId,
  close,
}: {
  project: Project;
  userId: string;
  close: () => void;
}) {
  const schema = z.array(userSchema.extend({ role: z.string() }));
  const [rows, setRows] = useState<z.infer<typeof schema>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState("");
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await request(`/projects/${project.id}/members/${id}`, z.undefined(), {
        method: "DELETE",
      });
      setRemoving("");
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  const reload = useCallback(
    async () =>
      setRows(await request(`/projects/${project.id}/members`, schema)),
    [project.id],
  );
  useEffect(() => {
    void reload().catch((error) => setError(message(error)));
  }, [reload]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await request(
        `/projects/${project.id}/members`,
        userSchema.extend({ role: z.string() }),
        {
          method: "POST",
          body: { email: data.get("email"), role: data.get("role") },
        },
      );
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={"Участники · " + project.name} close={close}>
      {rows.map((row) => (
        <div className="person-row" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <span className="muted">{row.email}</span>
          </div>
          <span className="badge">
            {{ owner: "Владелец", moderator: "Модератор", member: "Участник" }[
              row.role
            ] ?? row.role}
          </span>
          {project.role === "owner" && row.id !== userId && !row.owner && (
            <div className="inline-actions">
              {removing === row.id ? (
                <>
                  <button
                    disabled={busy}
                    className="danger"
                    onClick={() => void remove(row.id)}
                  >
                    Удалить из проекта
                  </button>
                  <button disabled={busy} onClick={() => setRemoving("")}>
                    Отмена
                  </button>
                </>
              ) : (
                <button disabled={busy} onClick={() => setRemoving(row.id)}>
                  Удалить
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {project.role === "owner" && (
        <form className="form-divider" onSubmit={submit}>
          <label>
            Email участника
            <input name="email" type="email" required />
          </label>
          <label>
            Роль
            <select name="role">
              <option value="member">Участник</option>
              <option value="moderator">Модератор</option>
              <option value="owner">Владелец проекта</option>
            </select>
          </label>
          <button disabled={busy} className="primary full">
            Сохранить участника
          </button>
        </form>
      )}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
