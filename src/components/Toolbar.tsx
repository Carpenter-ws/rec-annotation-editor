import { useRef, type ChangeEvent, type JSX } from "react";

export interface ToolbarProps {
  imageName: string | null;
  labelFileName: string | null;
  scale: number;
  onOpenImage: (file: File) => void;
  onOpenLabels: (file: File) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
}

export function Toolbar({
  imageName,
  labelFileName,
  scale,
  onOpenImage,
  onOpenLabels,
  onZoomOut,
  onZoomIn,
  onFit,
}: ToolbarProps): JSX.Element {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

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
        <button type="button" onClick={() => labelInputRef.current?.click()}>
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
    </header>
  );
}
