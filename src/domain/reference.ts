import { isJsonlLabelFile, parseJsonlAnnotations, type JsonlScale } from "./jsonl";
import { parseAnnotationText } from "./parser";
import type { ParseIssue, ReferenceBox } from "./types";

/** Prefix that keeps original boxes out of the document's `ann_` id space. */
export const REFERENCE_ID_PREFIX = "ref_";

export interface ReferenceParseResult {
  boxes: ReferenceBox[];
  issues: ParseIssue[];
}

export function isReferenceId(id: string): boolean {
  return id.startsWith(REFERENCE_ID_PREFIX);
}

export function referenceIdFrom(index: number): string {
  return `${REFERENCE_ID_PREFIX}${String(index).padStart(3, "0")}`;
}

/** Ids are never reused, so a deleted original cannot come back as another. */
export function nextReferenceId(boxes: readonly ReferenceBox[]): string {
  const largest = boxes.reduce((current, box) => {
    const match = /^ref_(\d+)$/.exec(box.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return referenceIdFrom(largest + 1);
}

/**
 * Reads an original-annotation file. A TXT line holds pixel coordinates, while
 * a JSONL target is normalized, so the image size is needed for the latter.
 */
export function parseReferenceBoxes(
  text: string,
  fileName: string,
  scale?: JsonlScale | null,
): ReferenceParseResult {
  const parsed = isJsonlLabelFile(fileName)
    ? parseJsonlAnnotations(text, scale)
    : parseAnnotationText(text);

  return {
    boxes: parsed.annotations.map((annotation, index) => ({
      id: referenceIdFrom(index + 1),
      bbox: annotation.bbox,
      label: annotation.label,
    })),
    issues: parsed.issues,
  };
}
