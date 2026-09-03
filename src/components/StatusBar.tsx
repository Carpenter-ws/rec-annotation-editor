import type { JSX } from "react";
import type { ImageInfo } from "../domain/types";

export interface StatusBarProps {
  image: ImageInfo | null;
  annotationCount: number;
  notice: string | null;
}

export function StatusBar({
  image,
  annotationCount,
  notice,
}: StatusBarProps): JSX.Element {
  return (
    <footer className="status-bar" role="status">
      <span>
        {image ? `${image.width} × ${image.height}` : "No image loaded"}
      </span>
      <span>
        {annotationCount} {annotationCount === 1 ? "annotation" : "annotations"}
      </span>
      {notice ? <span>{notice}</span> : null}
    </footer>
  );
}
