import { useEffect, useRef, useState, type JSX } from "react";
import type { ReferenceBox } from "../domain/types";

export interface ReferenceBarProps {
  /** Name of the loaded original-annotation file, for the record. */
  fileName: string | null;
  boxes: readonly ReferenceBox[];
  acceptedCount: number;
  /** True while the originals themselves may be changed. */
  editing: boolean;
  selected: ReferenceBox | null;
  onToggleEditing: () => void;
  onRenameSelected: (label: string) => void;
  onDeleteSelected: () => void;
  onClear: () => void;
}

/**
 * Controls for the original annotations, above the canvas: how many have been
 * accepted, the switch that unlocks editing them, and the editor of the box
 * that is currently picked.
 */
export function ReferenceBar({
  fileName,
  boxes,
  acceptedCount,
  editing,
  selected,
  onToggleEditing,
  onRenameSelected,
  onDeleteSelected,
  onClear,
}: ReferenceBarProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [selectedId]);

  const commit = () => {
    const value = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (value === null || !selected) return;
    const label = value.trim();
    if (label === "" || label === selected.label) return;
    onRenameSelected(label);
  };

  return (
    <div
      className={editing ? "reference-bar is-editing" : "reference-bar"}
      role="group"
      aria-label="Original annotations"
    >
      <span className="reference-count" aria-label="Original annotations added">
        Original <b>{acceptedCount}</b> / {boxes.length} added
      </span>
      {fileName ? (
        <span className="reference-file" title={fileName}>
          {fileName}
        </span>
      ) : null}
      <button
        type="button"
        className="reference-edit-toggle"
        aria-pressed={editing}
        title="Move, resize, relabel, add or delete the original annotations"
        onClick={onToggleEditing}
      >
        {editing ? "Done editing originals" : "Edit original annotations"}
      </button>
      {editing ? (
        selected ? (
          <span className="reference-selected">
            <span className="reference-selected-id">{selected.id}</span>
            <label>
              Expression
              <input
                type="text"
                aria-label={`Expression of ${selected.id}`}
                value={draft ?? selected.label}
                onChange={(event) => {
                  draftRef.current = event.currentTarget.value;
                  setDraft(draftRef.current);
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    draftRef.current = null;
                    setDraft(null);
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commit();
                  event.currentTarget.blur();
                }}
              />
            </label>
            <button
              type="button"
              aria-label={`Delete original ${selected.id}`}
              onClick={onDeleteSelected}
            >
              Delete box
            </button>
          </span>
        ) : (
          <span className="reference-hint">
            Click an original to edit it — drag to move, drag a handle to resize
          </span>
        )
      ) : null}
      <button type="button" className="reference-clear" onClick={onClear}>
        Clear originals
      </button>
    </div>
  );
}
