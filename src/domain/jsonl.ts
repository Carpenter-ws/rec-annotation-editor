import type { Annotation, BBox, ParseIssue, ParseResult } from "./types";

type JsonlBox = [number, number, number, number];

interface JsonlLine {
  expression: string;
  targets: JsonlBox[];
}

/** Targets are stored as integers on a [0, 1000] grid, not as pixels. */
export const JSONL_NORMALIZED_MAX = 1000;

/** Image size the normalized targets refer to. */
export interface JsonlScale {
  width: number;
  height: number;
}

/**
 * REC JSONL format (one REC document per line):
 *   {"expression": "...", "level": "L1", "targets": [[x1, y1, x2, y2], ...]}
 * `bbox`: [x1, y1, x2, y2] is accepted as a single-target alternative.
 * Every target becomes one box annotation sharing the line's expression.
 * Coordinates are normalized to [0, 1000] over the image size; pass a
 * `JsonlScale` to convert them to pixels (and back on export).
 */
export function isJsonlLabelFile(fileName: string): boolean {
  return /\.jsonl$/i.test(fileName);
}

function normalizedToPixels(value: number, extent: number): number {
  return (value / JSONL_NORMALIZED_MAX) * extent;
}

function pixelToNormalized(value: number, extent: number): number {
  if (!Number.isFinite(value) || extent <= 0) return 0;
  return Math.min(
    JSONL_NORMALIZED_MAX,
    Math.max(0, Math.round((value / extent) * JSONL_NORMALIZED_MAX)),
  );
}

/** Converts one normalized [0, 1000] box into image pixels. */
export function normalizedBoxToPixels(box: BBox, scale: JsonlScale): BBox {
  return {
    x1: normalizedToPixels(box.x1, scale.width),
    y1: normalizedToPixels(box.y1, scale.height),
    x2: normalizedToPixels(box.x2, scale.width),
    y2: normalizedToPixels(box.y2, scale.height),
  };
}

/** Converts annotations that still carry normalized boxes into pixels. */
export function scaleAnnotationsToPixels(
  annotations: readonly Annotation[],
  scale: JsonlScale,
): Annotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    bbox: normalizedBoxToPixels(annotation.bbox, scale),
  }));
}

/**
 * Converts one pixel box into the rounded [0, 1000] grid, guaranteeing a
 * positive extent so the file stays parseable.
 */
export function pixelBoxToNormalized(box: BBox, scale: JsonlScale): JsonlBox {
  const x1 = pixelToNormalized(box.x1, scale.width);
  const y1 = pixelToNormalized(box.y1, scale.height);
  let x2 = pixelToNormalized(box.x2, scale.width);
  let y2 = pixelToNormalized(box.y2, scale.height);
  if (x2 <= x1) x2 = Math.min(JSONL_NORMALIZED_MAX, x1 + 1);
  if (y2 <= y1) y2 = Math.min(JSONL_NORMALIZED_MAX, y1 + 1);
  return [x1, y1, x2, y2];
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBox(value: unknown): JsonlBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(toFiniteNumber);
  if (box.some((entry) => entry === null)) return null;
  return box as unknown as JsonlBox;
}

function readTargets(line: Record<string, unknown>): JsonlBox[] | null {
  const rawTargets =
    line.targets !== undefined ? line.targets : line.bbox !== undefined ? [line.bbox] : null;
  if (!Array.isArray(rawTargets)) return null;
  const targets: JsonlBox[] = [];
  for (const entry of rawTargets) {
    const box = readBox(entry);
    if (box === null) return null;
    targets.push(box);
  }
  return targets;
}

function parseLine(source: string): JsonlLine | ParseIssue {
  const lineNumberSource = source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lineNumberSource);
  } catch {
    return { line: 0, reason: "invalid JSON line", source };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { line: 0, reason: "invalid JSON line", source };
  }
  const record = parsed as Record<string, unknown>;
  const expression =
    typeof record.expression === "string" ? record.expression.trim() : "";
  if (!expression) {
    return { line: 0, reason: "expression cannot be empty", source };
  }
  const targets = readTargets(record);
  if (targets === null || targets.length === 0) {
    return { line: 0, reason: "invalid bounding box", source };
  }
  return { expression, targets };
}

export function parseJsonlAnnotations(
  text: string,
  scale?: JsonlScale | null,
): ParseResult {
  const issues: ParseIssue[] = [];
  const annotations: Annotation[] = [];

  text.split(/\r?\n/).forEach((source, index) => {
    const lineNumber = index + 1;
    if (!source.trim()) return;

    const line = parseLine(source);
    if ("reason" in line) {
      issues.push({ ...line, line: lineNumber });
      return;
    }

    for (const [x1, y1, x2, y2] of line.targets) {
      if (x2 <= x1 || y2 <= y1) {
        issues.push({
          line: lineNumber,
          reason: "invalid bounding box",
          source,
        });
        return;
      }
    }

    for (const [x1, y1, x2, y2] of line.targets) {
      const bbox: BBox = scale
        ? normalizedBoxToPixels({ x1, y1, x2, y2 }, scale)
        : { x1, y1, x2, y2 };
      annotations.push({
        id: `ann_${String(annotations.length + 1).padStart(3, "0")}`,
        bbox,
        label: line.expression,
        reservedField: null,
      });
    }
  });

  return { annotations: issues.length ? [] : annotations, issues };
}

/**
 * Inverse of the parser: boxes sharing a label are regrouped into one line
 * with a targets array, preserving first-appearance order of each label.
 */
export function serializeAnnotationsJsonl(
  annotations: readonly Annotation[],
  scale?: JsonlScale | null,
): string {
  const grouped = new Map<string, JsonlBox[]>();
  for (const { bbox, label } of annotations) {
    const targets = grouped.get(label);
    const box: JsonlBox = scale
      ? pixelBoxToNormalized(bbox, scale)
      : [bbox.x1, bbox.y1, bbox.x2, bbox.y2];
    if (targets) targets.push(box);
    else grouped.set(label, [box]);
  }

  const lines = [...grouped.entries()].map(([expression, targets]) =>
    JSON.stringify({ expression, targets }),
  );
  return lines.length ? `${lines.join("\n")}\n` : "";
}
