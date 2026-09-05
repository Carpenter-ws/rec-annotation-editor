import { useRef, useState, type ChangeEvent, type JSX } from "react";

export interface ToolbarProps {
  imageName: string | null;
  labelFileName: string | null;
  dirty: boolean;
  scale: number;
  onOpenImage: (file: File) => void;
  onOpenLabels: (file: File) => void;
  onPickLabels: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  undoDisabled: boolean;
  redoDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExportTxt: () => void;
  onExportJson: () => void;
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
}

export function Toolbar({
  imageName,
  labelFileName,
  dirty,
  scale,
  onOpenImage,
  onOpenLabels,
  onPickLabels,
  onSave,
  onSaveAs,
  undoDisabled,
  redoDisabled,
  onUndo,
  onRedo,
  onExportTxt,
  onExportJson,
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
}: ToolbarProps): JSX.Element {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);

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
          accept=".txt,text/plain"
          aria-label="Open labels"
          hidden
          onChange={(event) => forwardFile(event, onOpenLabels)}
        />
      </div>
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
