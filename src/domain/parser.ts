import type { Annotation, ParseIssue, ParseResult } from "./types";

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const LINE = new RegExp(
  `^\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(.+?)\\s*$`,
);

export function parseAnnotationText(text: string): ParseResult {
  const annotations: Annotation[] = [];
  const issues: ParseIssue[] = [];

  text.split(/\r?\n/).forEach((source, index) => {
    if (!source.trim()) return;

    const match = LINE.exec(source);
    if (!match) {
      issues.push({
        line: index + 1,
        reason: "expected four coordinates and a label",
        source,
      });
      return;
    }

    const x1 = Number(match[1]!);
    const y1 = Number(match[2]!);
    const x2 = Number(match[3]!);
    const y2 = Number(match[4]!);
    if (
      ![x1, y1, x2, y2].every(Number.isFinite) ||
      x2 <= x1 ||
      y2 <= y1
    ) {
      issues.push({ line: index + 1, reason: "invalid bounding box", source });
      return;
    }

    const tail = match[5]!.trim();
    const reserved = /^(.*\S)\s+0$/.exec(tail);
    const label = (reserved?.[1] ?? tail).trim();
    if (!label) {
      issues.push({
        line: index + 1,
        reason: "expression cannot be empty",
        source,
      });
      return;
    }

    annotations.push({
      id: `ann_${String(annotations.length + 1).padStart(3, "0")}`,
      bbox: { x1, y1, x2, y2 },
      label,
      reservedField: reserved ? "0" : null,
    });
  });

  return { annotations: issues.length ? [] : annotations, issues };
}
