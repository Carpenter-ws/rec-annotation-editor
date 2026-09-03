import { useState, type JSX } from "react";

export interface NewAnnotationDialogProps {
  onAdd: (label: string) => void;
  onCancel: () => void;
}

export function NewAnnotationDialog({
  onAdd,
  onCancel,
}: NewAnnotationDialogProps): JSX.Element {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      role="dialog"
      aria-labelledby="new-annotation-title"
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <h2 id="new-annotation-title">New annotation</h2>
      <label>
        Expression
        <input
          type="text"
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (label.trim().length === 0) {
              setError("Expression cannot be empty.");
              return;
            }
            onAdd(label.trim());
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
