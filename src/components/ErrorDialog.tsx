import { useId, type JSX } from "react";
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

export function ErrorDialog({
  title,
  issues,
  onClose,
}: ErrorDialogProps): JSX.Element | null {
  const titleId = useId();

  if (issues.length === 0) return null;

  return (
    <div
      className="error-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="error-dialog-panel">
        <h2 id={titleId}>{title}</h2>
        <p>
          {issues.length} {issues.length === 1 ? "problem" : "problems"} found.
        </p>
        <ul>
          {issues.map((issue, index) => (
            <li key={`${index}-${issueText(issue)}`}>{issueText(issue)}</li>
          ))}
        </ul>
        <button type="button" aria-label="Close error" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
