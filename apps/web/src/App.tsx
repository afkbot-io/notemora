import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  ApiError,
  meSchema,
  message,
  projectSchema,
  request,
  setCsrf,
} from "./api";
import type { Me, Project } from "./api";
import { Notice } from "./ui";
import { SignIn, AuthorizeWidget } from "./Auth";
import { Projects } from "./Projects";
import { People } from "./People";
import { Tokens } from "./Access";
import { Discussions } from "./Discussions";
type Tab = "threads" | "projects" | "people" | "tokens";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("threads");
  const [projects, setProjects] = useState<Project[]>([]);
  const loadProjects = useCallback(async () => {
    setProjects(await request("/projects", z.array(projectSchema)));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void request("/auth/me", meSchema, { signal: controller.signal })
      .then((value) => {
        setCsrf(value.csrfToken);
        setMe(value);
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof ApiError && error.status === 401)
        )
          setError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (me) void loadProjects().catch((error) => setError(message(error)));
  }, [me, loadProjects]);
  if (loading)
    return (
      <main className="loading-page" role="status">
        Загружаем Notemora…
      </main>
    );
  if (!me || location.pathname === "/activate")
    return (
      <>
        {error && (
          <div className="connection-error" role="alert">
            {error}
          </div>
        )}
        <SignIn complete={setMe} />
      </>
    );
  if (location.pathname === "/authorize")
    return <AuthorizeWidget me={me} signedOut={() => setMe(null)} />;
  const labels: Record<Tab, string> = {
    threads: "Обсуждения",
    projects: "Проекты",
    people: "Участники",
    tokens: "Токены",
  };
  async function logout() {
    try {
      await request("/auth/logout", z.undefined(), { method: "POST" });
      setMe(null);
      setProjects([]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setProjects([]);
        setCsrf("");
      } else setError(message(error));
    }
  }
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">n</span>Notemora
        </a>
        <nav aria-label="Разделы">
          {(
            [
              "threads",
              "projects",
              ...(me.user.owner ? ["people"] : []),
              "tokens",
            ] as Tab[]
          ).map((key) => (
            <button
              key={key}
              aria-current={tab === key ? "page" : undefined}
              className={tab === key ? "nav-item active" : "nav-item"}
              onClick={() => {
                setTab(key);
                setError("");
              }}
            >
              {labels[key]}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <strong>{me.user.name}</strong>
          <span>{me.user.email}</span>
          <button className="text-button" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="page-header">
          <div>
            <h1>{labels[tab]}</h1>
          </div>
          <span className="retention">Хранение: 7 дней</span>
        </header>
        {error && <Notice>{error}</Notice>}
        {tab === "threads" && (
          <Discussions
            projects={projects}
            openProjects={() => setTab("projects")}
          />
        )}
        {tab === "projects" && (
          <Projects
            projects={projects}
            userId={me.user.id}
            owner={me.user.owner}
            reload={loadProjects}
          />
        )}
        {tab === "people" && me.user.owner && <People />}
        {tab === "tokens" && <Tokens projects={projects} />}
      </main>
    </div>
  );
}
