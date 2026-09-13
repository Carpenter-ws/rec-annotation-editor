import type { Annotation, ParseIssue, ParseResult } from "./types";

type JsonlBox = [number, number, number, number];

interface JsonlLine {
  expression: string;
  targets: JsonlBox[];
}

/**
 * REC JSONL format (one REC document per line):
 *   {"expression": "...", "level": "L1", "targets": [[x1, y1, x2, y2], ...]}
 * `bbox`: [x1, y1, x2, y2] is accepted as a single-target alternative.
 * Every target becomes one box annotation sharing the line's expression.
 */
export function isJsonlLabelFile(fileName: string): boolean {
  return /\.jsonl$/i.test(fileName);
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

export function parseJsonlAnnotations(text: string): ParseResult {
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
      annotations.push({
        id: `ann_${String(annotations.length + 1).padStart(3, "0")}`,
        bbox: { x1, y1, x2, y2 },
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
): string {
  const grouped = new Map<string, number[][]>();
  for (const { bbox, label } of annotations) {
    const targets = grouped.get(label);
    const box = [bbox.x1, bbox.y1, bbox.x2, bbox.y2];
    if (targets) targets.push(box);
    else grouped.set(label, [box]);
  }

  const lines = [...grouped.entries()].map(([expression, targets]) =>
    JSON.stringify({ expression, targets }),
  );
  return lines.length ? `${lines.join("\n")}\n` : "";
}
