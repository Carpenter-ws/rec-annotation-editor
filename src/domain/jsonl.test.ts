import { describe, expect, it } from "vitest";
import {
  isJsonlLabelFile,
  parseJsonlAnnotations,
  serializeAnnotationsJsonl,
} from "./jsonl";
import type { Annotation } from "./types";

const sample = [
  '{"expression": "the red-and-white boats", "level": "L1", "targets": [[3, 46, 117, 62], [317, 482, 368, 550]]}',
  '{"expression": "the white boats", "level": "L1", "targets": [[636, 790, 665, 837]]}',
].join("\n");

describe("isJsonlLabelFile", () => {
  it("recognizes .jsonl files case-insensitively", () => {
    expect(isJsonlLabelFile("aerial.jsonl")).toBe(true);
    expect(isJsonlLabelFile("AERIAL.JSONL")).toBe(true);
    expect(isJsonlLabelFile("aerial.txt")).toBe(false);
  });
});

describe("parseJsonlAnnotations", () => {
  it("expands every target into its own annotation sharing the expression", () => {
    const result = parseJsonlAnnotations(sample);

    expect(result.issues).toEqual([]);
    expect(result.annotations).toHaveLength(3);
    expect(result.annotations[0]).toEqual({
      id: "ann_001",
      bbox: { x1: 3, y1: 46, x2: 117, y2: 62 },
      label: "the red-and-white boats",
      reservedField: null,
    });
    expect(result.annotations[1]?.label).toBe("the red-and-white boats");
    expect(result.annotations[1]?.bbox).toEqual({
      x1: 317,
      y1: 482,
      x2: 368,
      y2: 550,
    });
    expect(result.annotations[2]?.label).toBe("the white boats");
  });

  it("accepts a single bbox array as an alternative to targets", () => {
    const result = parseJsonlAnnotations(
      '{"expression": "the white boat with a mast", "bbox": [501, 582, 568, 650]}',
    );

    expect(result.issues).toEqual([]);
    expect(result.annotations).toEqual([
      {
        id: "ann_001",
        bbox: { x1: 501, y1: 582, x2: 568, y2: 650 },
        label: "the white boat with a mast",
        reservedField: null,
      },
    ]);
  });

  it("reports the line number for malformed JSON lines", () => {
    const result = parseJsonlAnnotations(
      `{"expression": "ok", "targets": [[0, 0, 5, 5]]}\nnot json\n`,
    );

    expect(result.annotations).toEqual([]);
    expect(result.issues).toEqual([
      { line: 2, reason: "invalid JSON line", source: "not json" },
    ]);
  });

  it("rejects lines whose targets are invalid with the exact line number", () => {
    const result = parseJsonlAnnotations(
      [
        '{"expression": "good", "targets": [[0, 0, 5, 5]]}',
        '{"expression": "bad shape", "targets": [[5, 5, 0, 0]]}',
        '{"expression": "bad number", "targets": [[0, 0, "x", 5]]}',
        '{"expression": "no boxes", "targets": []}',
      ].join("\n"),
    );

    expect(result.annotations).toEqual([]);
    expect(result.issues.map((issue) => issue.line)).toEqual([2, 3, 4]);
  });

  it("rejects an empty expression with the exact line number", () => {
    const result = parseJsonlAnnotations(
      '{"expression": "   ", "targets": [[0, 0, 5, 5]]}',
    );

    expect(result.issues).toEqual([
      { line: 1, reason: "expression cannot be empty", source: expect.any(String) },
    ]);
  });

  it("fails atomically when any line is invalid", () => {
    const result = parseJsonlAnnotations(
      [
        '{"expression": "good", "targets": [[0, 0, 5, 5]]}',
        '{"expression": "bad", "targets": [[0, 0, 5, 5], [9, 9, 2, 2]]}',
      ].join("\n"),
    );

    expect(result.annotations).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });
});

describe("serializeAnnotationsJsonl", () => {
  const boxes: Annotation[] = [
    {
      id: "ann_001",
      bbox: { x1: 3, y1: 46, x2: 117.5, y2: 62 },
      label: "the red-and-white boats",
      reservedField: null,
    },
    {
      id: "ann_002",
      bbox: { x1: 317, y1: 482, x2: 368, y2: 550.25 },
      label: "the red-and-white boats",
      reservedField: null,
    },
    {
      id: "ann_003",
      bbox: { x1: 636, y1: 790, x2: 665, y2: 837 },
      label: "the white boats",
      reservedField: null,
    },
  ];

  it("regroups boxes sharing a label into one targets line", () => {
    const lines = serializeAnnotationsJsonl(boxes).trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.expression).toBe("the red-and-white boats");
    expect(first.targets).toEqual([
      [3, 46, 117.5, 62],
      [317, 482, 368, 550.25],
    ]);

    const second = JSON.parse(lines[1]!);
    expect(second.expression).toBe("the white boats");
    expect(second.targets).toEqual([[636, 790, 665, 837]]);
  });

  it("preserves first-appearance order and ends with a newline", () => {
    const output = serializeAnnotationsJsonl([boxes[2]!, boxes[0]!]);
    const lines = output.trim().split("\n");
    expect(JSON.parse(lines[0]!).expression).toBe("the white boats");
    expect(JSON.parse(lines[1]!).expression).toBe("the red-and-white boats");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("returns an empty string for an empty document", () => {
    expect(serializeAnnotationsJsonl([])).toBe("");
  });
});
