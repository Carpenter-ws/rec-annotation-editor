import {
  useEffect,
  useId,
  useRef,
  type JSX,
} from "react";
import type { ParseIssue } from "../domain/types";

export type ErrorDialogIssue = ParseIssue | string;

export interface ErrorDialogProps {
  title: string;
  issues: readonly ErrorDialogIssue[];
  onClose: () => void;
}

function issueText(issue: ErrorDialogIssue): string {
  return typeof issue === "string"
    ? issue
    : `Line ${issue.line}: ${issue.reason}`;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ErrorDialog({
  title,
  issues,
  onClose,
}: ErrorDialogProps): JSX.Element | null {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const open = issues.length > 0;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const previouslyFocused =
      active instanceof HTMLElement &&
      active !== document.body &&
      !active.closest("[hidden]")
        ? active
        : null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="error-dialog-backdrop">
      <div
        ref={panelRef}
        className="error-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        <p>
          {issues.length} {issues.length === 1 ? "problem" : "problems"} found.
        </p>
        <ul>
          {issues.map((issue, index) => (
            <li key={`${index}-${issueText(issue)}`}>{issueText(issue)}</li>
          ))}
        </ul>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close error"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
