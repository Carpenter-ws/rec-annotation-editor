import type { JSX } from "react";
import type { ImageInfo } from "../domain/types";

export interface StatusBarProps {
  image: ImageInfo | null;
  annotationCount: number;
  notice: string | null;
  scale: number;
}

export function StatusBar({
  image,
  annotationCount,
  notice,
  scale,
}: StatusBarProps): JSX.Element {
  return (
    <footer className="status-bar" role="status">
      <span>
        {image ? `${image.width} × ${image.height}` : "No image loaded"}
      </span>
      <span>
        {annotationCount} {annotationCount === 1 ? "annotation" : "annotations"}
      </span>
      {image ? <span>Zoom {Math.round(scale * 100)}%</span> : null}
      <span className="status-notice" aria-live="polite" data-testid="editor-notice">
        {notice}
      </span>
    </footer>
  );
}
