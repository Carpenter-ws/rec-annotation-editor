import { useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";

export interface ToolbarProps {
  /** Back to the dataset home. */
  onHome: () => void;
  imageName: string | null;
  labelFileName: string | null;
  dirty: boolean;
  scale: number;
  onOpenImage: (file: File) => void;
  onOpenLabels: (file: File) => void;
  onPickLabels: () => void;
  /** Original annotations, loaded as a pool to pick new boxes from. */
  onOpenOriginals: (file: File) => void;
  /** True while any originals are loaded: only then do the two toggles apply. */
  originalsLoaded: boolean;
  /** Whether the originals are drawn on the canvas. */
  originalsVisible: boolean;
  /** Whether the originals themselves may be moved, relabeled, or deleted. */
  originalsEditing: boolean;
  onToggleOriginalsVisible: () => void;
  onToggleOriginalsEditing: () => void;
  /** The original selected while editing, edited right here in the toolbar. */
  selectedOriginal: { id: string; label: string } | null;
  onRenameOriginal: (label: string) => void;
  onDeleteOriginal: () => void;
  onOpenDatasets: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  undoDisabled: boolean;
  redoDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExportTxt: () => void;
  onExportJson: () => void;
  onExportJsonl: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  mode: "select" | "add";
  addBoxDisabled: boolean;
  onAddBox: () => void;
  labelPickerBlocked: boolean;
  panelToggleVisible: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Present only while a dataset item is open. */
  datasetNavigation: {
    position: number;
    total: number;
    canGoPrevious: boolean;
    canGoNext: boolean;
  } | null;
  onPreviousItem: () => void;
  onNextItem: () => void;
}

export function Toolbar({
  onHome,
  imageName,
  labelFileName,
  dirty,
  scale,
  onOpenImage,
  onOpenLabels,
  onPickLabels,
  onOpenOriginals,
  originalsLoaded,
  originalsVisible,
  originalsEditing,
  onToggleOriginalsVisible,
  onToggleOriginalsEditing,
  selectedOriginal,
  onRenameOriginal,
  onDeleteOriginal,
  onOpenDatasets,
  onSave,
  onSaveAs,
  undoDisabled,
  redoDisabled,
  onUndo,
  onRedo,
  onExportTxt,
  onExportJson,
  onExportJsonl,
  onZoomOut,
  onZoomIn,
  onFit,
  mode,
  addBoxDisabled,
  onAddBox,
  labelPickerBlocked,
  panelToggleVisible,
  panelOpen,
  onTogglePanel,
  datasetNavigation,
  onPreviousItem,
  onNextItem,
}: ToolbarProps): JSX.Element {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const originalInputRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  /** Expression draft of the original being relabelled in the toolbar. */
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const selectedOriginalId = selectedOriginal?.id ?? null;

  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [selectedOriginalId]);

  const commitDraft = () => {
    const value = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (value === null || !selectedOriginal) return;
    const label = value.trim();
    if (label === "" || label === selectedOriginal.label) return;
    onRenameOriginal(label);
  };

  const forwardFile = (
    event: ChangeEvent<HTMLInputElement>,
    callback: (file: File) => void,
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) callback(file);
  };

  return (
    <header className="toolbar">
      <h1>REC Annotation Editor</h1>
      <div className="toolbar-files">
        <button type="button" aria-label="Home" onClick={onHome}>
          Home
        </button>
        <button type="button" onClick={() => imageInputRef.current?.click()}>
          Open image
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*,.apng,.avif,.bmp,.gif,.heic,.heif,.ico,.jfif,.jpg,.jpeg,.png,.svg,.tif,.tiff,.webp"
          aria-label="Open image"
          hidden
          onChange={(event) => forwardFile(event, onOpenImage)}
        />
        <button
          type="button"
          onClick={() => {
            if (window.showOpenFilePicker && !labelPickerBlocked) {
              onPickLabels();
              return;
            }
            labelInputRef.current?.click();
          }}
        >
          Open labels
        </button>
        <input
          ref={labelInputRef}
          type="file"
          accept=".txt,.jsonl,text/plain"
          aria-label="Open labels"
          hidden
          onChange={(event) => forwardFile(event, onOpenLabels)}
        />
        <button
          type="button"
          title="Load the original annotations and pick boxes from them"
          onClick={() => originalInputRef.current?.click()}
        >
          Open originals
        </button>
        <input
          ref={originalInputRef}
          type="file"
          accept=".txt,.jsonl,text/plain"
          aria-label="Open original annotations"
          hidden
          onChange={(event) => forwardFile(event, onOpenOriginals)}
        />
        <button
          type="button"
          aria-pressed={originalsVisible}
          disabled={!originalsLoaded}
          title={
            originalsVisible
              ? "Hide the original annotations (adding a box brings them back)"
              : "Show the original annotations again"
          }
          onClick={onToggleOriginalsVisible}
        >
          {originalsVisible ? "Hide originals" : "Show originals"}
        </button>
        <button
          type="button"
          aria-pressed={originalsEditing}
          disabled={!originalsLoaded}
          title="Move, resize, relabel, add or delete the original annotations"
          onClick={onToggleOriginalsEditing}
        >
          {originalsEditing ? "Done editing originals" : "Edit originals"}
        </button>
        {originalsEditing ? (
          selectedOriginal ? (
            <span className="originals-editor">
              <label>
                Expression
                <input
                  type="text"
                  aria-label={`Expression of ${selectedOriginal.id}`}
                  value={draft ?? selectedOriginal.label}
                  onChange={(event) => {
                    draftRef.current = event.currentTarget.value;
                    setDraft(draftRef.current);
                  }}
                  onBlur={commitDraft}
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
                    commitDraft();
                    event.currentTarget.blur();
                  }}
                />
              </label>
              <button
                type="button"
                aria-label={`Delete original ${selectedOriginal.id}`}
                onClick={onDeleteOriginal}
              >
                Delete box
              </button>
            </span>
          ) : (
            <span className="originals-hint">
              Click an original to edit it — drag to move, drag a handle to resize
            </span>
          )
        ) : null}
        <button type="button" onClick={onOpenDatasets}>
          Datasets
        </button>
      </div>
      {datasetNavigation ? (
        <div className="dataset-nav" aria-label="Dataset navigation">
          <button
            type="button"
            aria-label="Previous image"
            disabled={!datasetNavigation.canGoPrevious}
            onClick={onPreviousItem}
          >
            ‹ Previous
          </button>
          <span
            className="dataset-position"
            data-testid="dataset-position"
            aria-label="Dataset position"
          >
            {datasetNavigation.position} / {datasetNavigation.total}
          </span>
          <button
            type="button"
            aria-label="Next image"
            disabled={!datasetNavigation.canGoNext}
            onClick={onNextItem}
          >
            Next ›
          </button>
        </div>
      ) : null}
      <div className="toolbar-file-names" aria-label="Open files">
        <span>{imageName ?? "No image"}</span>
        <span>{labelFileName ?? "No labels"}</span>
        <span aria-label="Save status">
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
      </div>
      <button type="button" onClick={onSave}>
        Save
      </button>
      <button type="button" onClick={onSaveAs}>
        Save As
      </button>
      <button type="button" disabled={undoDisabled} onClick={onUndo}>
        Undo
      </button>
      <button type="button" disabled={redoDisabled} onClick={onRedo}>
        Redo
      </button>
      <div className="export-controls">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          onClick={() => setExportOpen((open) => !open)}
        >
          Export
        </button>
        {exportOpen ? (
          <div role="menu" aria-label="Export annotations">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setExportOpen(false);
                onExportTxt();
              }}
            >
              Export TXT
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setExportOpen(false);
                onExportJson();
              }}
            >
              Export JSON
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setExportOpen(false);
                onExportJsonl();
              }}
            >
              Export JSONL
            </button>
          </div>
        ) : null}
      </div>
      <div className="zoom-controls" aria-label="Zoom controls">
        <button type="button" aria-label="Zoom out" onClick={onZoomOut}>
          −
        </button>
        <output role="presentation" data-testid="zoom-percent">
          {Math.round(scale * 100)}%
        </output>
        <button type="button" aria-label="Zoom in" onClick={onZoomIn}>
          +
        </button>
        <button type="button" onClick={onFit}>
          Fit
        </button>
      </div>
      <button
        type="button"
        aria-pressed={mode === "add"}
        disabled={addBoxDisabled}
        onClick={onAddBox}
      >
        Add box
      </button>
      {panelToggleVisible ? (
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          aria-controls="annotation-panel"
          onClick={onTogglePanel}
        >
          Annotations
        </button>
      ) : null}
    </header>
  );
}
