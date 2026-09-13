import type { Annotation } from "./types";

export interface CanvasVisibility {
  /** Category isolated from the panel, if any. */
  activeLabel: string | null;
  /** Category previewed while its panel header is hovered. */
  highlightedLabel: string | null;
  selectedId: string | null;
}

/**
 * Boxes stay off the canvas until a category is picked: only the isolated
 * category, a hovered category, and the selected box are drawn. Everything
 * else would just clutter an image with hundreds of boxes.
 */
export function visibleCanvasAnnotations(
  annotations: readonly Annotation[],
  { activeLabel, highlightedLabel, selectedId }: CanvasVisibility,
): Annotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.id === selectedId ||
      (activeLabel !== null && annotation.label === activeLabel) ||
      (highlightedLabel !== null && annotation.label === highlightedLabel),
  );
}
