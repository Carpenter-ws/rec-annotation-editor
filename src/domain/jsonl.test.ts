import { describe, expect, it } from "vitest";
import {
  isJsonlLabelFile,
  parseJsonlAnnotations,
  scaleAnnotationsToPixels,
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

describe("normalized [0, 1000] coordinates", () => {
  const image = { width: 1920, height: 1080 };

  it("scales normalized targets to pixels while parsing", () => {
    const result = parseJsonlAnnotations(
      '{"expression": "the white boats", "targets": [[0, 0, 1000, 1000], [3, 46, 117, 62]]}',
      image,
    );

    expect(result.issues).toEqual([]);
    expect(result.annotations[0]?.bbox).toEqual({
      x1: 0,
      y1: 0,
      x2: 1920,
      y2: 1080,
    });
    const scaled = result.annotations[1]!.bbox;
    expect(scaled.x1).toBeCloseTo(5.76, 10);
    expect(scaled.y1).toBeCloseTo(49.68, 10);
    expect(scaled.x2).toBeCloseTo(224.64, 10);
    expect(scaled.y2).toBeCloseTo(66.96, 10);
  });

  it("scales an existing annotation list to pixels", () => {
    const scaled = scaleAnnotationsToPixels(
      [
        {
          id: "ann_001",
          bbox: { x1: 0, y1: 0, x2: 500, y2: 500 },
          label: "person",
          reservedField: null,
        },
      ],
      image,
    );

    expect(scaled[0]?.bbox).toEqual({ x1: 0, y1: 0, x2: 960, y2: 540 });
    expect(scaled[0]?.id).toBe("ann_001");
  });

  it("writes pixels back as rounded normalized integers", () => {
    const output = serializeAnnotationsJsonl(
      [
        {
          id: "ann_001",
          bbox: { x1: 5.76, y1: 49.68, x2: 224.64, y2: 66.96 },
          label: "the white boats",
          reservedField: null,
        },
      ],
      image,
    );

    expect(JSON.parse(output.trim())).toEqual({
      expression: "the white boats",
      targets: [[3, 46, 117, 62]],
    });
  });

  it("clamps saved targets into [0, 1000] and keeps them non-degenerate", () => {
    const output = serializeAnnotationsJsonl(
      [
        {
          id: "ann_001",
          bbox: { x1: -50, y1: -50, x2: 5000, y2: 5000 },
          label: "huge",
          reservedField: null,
        },
        {
          id: "ann_002",
          bbox: { x1: 1000, y1: 1000, x2: 1000.2, y2: 1000.3 },
          label: "tiny",
          reservedField: null,
        },
      ],
      image,
    );

    const lines = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0].targets).toEqual([[0, 0, 1000, 1000]]);
    const [x1, y1, x2, y2] = lines[1].targets[0];
    expect(x1).toBeGreaterThanOrEqual(0);
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeGreaterThan(y1);
    expect(x2).toBeLessThanOrEqual(1000);
    expect(y2).toBeLessThanOrEqual(1000);
  });

  it("keeps raw coordinates when no image size is known yet", () => {
    const parsed = parseJsonlAnnotations(
      '{"expression": "person", "targets": [[0, 0, 500, 500]]}',
    );
    expect(parsed.annotations[0]?.bbox).toEqual({
      x1: 0,
      y1: 0,
      x2: 500,
      y2: 500,
    });

    const output = serializeAnnotationsJsonl([
      {
        id: "ann_001",
        bbox: { x1: 0, y1: 0, x2: 500, y2: 500 },
        label: "person",
        reservedField: null,
      },
    ]);
    expect(JSON.parse(output.trim()).targets).toEqual([[0, 0, 500, 500]]);
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
