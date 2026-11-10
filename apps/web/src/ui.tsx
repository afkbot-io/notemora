import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="notice" role="alert">
      {children}
    </p>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} aria-labelledby={id} onCancel={close}>
      <header className="modal-header">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" aria-label="Закрыть" onClick={close}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
