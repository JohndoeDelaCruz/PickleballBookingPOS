"use client";
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
export function Modal({
  title,
  onClose,
  children,
  closing = false,
  className,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  closing?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = bodyOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={className ? `panel modal ${className}` : "panel modal"}
      data-closing={closing || undefined}
      inert={closing}
      onCancel={(e) => {
        e.preventDefault();
        if (!closing) onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !closing) onClose();
      }}
      style={{
        position: "fixed",
        margin: "auto",
        border: "1px solid var(--line)",
        color: "var(--ink)",
      }}
      aria-labelledby={titleId}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
