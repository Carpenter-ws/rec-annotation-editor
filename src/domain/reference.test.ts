import { describe, expect, it } from "vitest";
import {
  isReferenceId,
  nextReferenceId,
  parseReferenceBoxes,
} from "./reference";
import type { ReferenceBox } from "./types";

describe("parseReferenceBoxes", () => {
  it("scales a TXT original annotation file from the normalized grid", () => {
    const result = parseReferenceBoxes(
      "222 462 321 575 boat\n78 598 193 698 boat\n",
      "DJI_0133.txt",
      { width: 1920, height: 1080 },
    );

    expect(result.issues).toEqual([]);
    expect(result.boxes).toHaveLength(2);
    expect(result.boxes[0]).toMatchObject({ id: "ref_001", label: "boat" });
    expect(result.boxes[0]?.bbox.x1).toBeCloseTo(426.24, 6);
    expect(result.boxes[0]?.bbox.y1).toBeCloseTo(498.96, 6);
    expect(result.boxes[0]?.bbox.x2).toBeCloseTo(616.32, 6);
    expect(result.boxes[0]?.bbox.y2).toBeCloseTo(621, 6);
    expect(result.boxes[1]?.bbox.x1).toBeCloseTo(149.76, 6);
    expect(result.boxes[1]?.bbox.y2).toBeCloseTo(753.84, 6);
  });

  it("keeps the raw TXT values while the image size is unknown", () => {
    const result = parseReferenceBoxes("10 20 30 40 boat\n", "DJI_0133.txt");

    expect(result.boxes[0]?.bbox).toEqual({ x1: 10, y1: 20, x2: 30, y2: 40 });
  });

  it("scales a normalized JSONL original annotation file like a label file", () => {
    const result = parseReferenceBoxes(
      '{"expression": "boat", "targets": [[500, 500, 1000, 1000]]}',
      "DJI_0133.jsonl",
      { width: 800, height: 400 },
    );

    expect(result.boxes).toEqual([
      {
        id: "ref_001",
        bbox: { x1: 400, y1: 200, x2: 800, y2: 400 },
        label: "boat",
      },
    ]);
  });

  it("reports broken lines instead of dropping them silently", () => {
    const result = parseReferenceBoxes(
      "222 462 321 575 boat\nnot a box\n",
      "DJI_0133.txt",
    );

    expect(result.boxes).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ line: 2 }),
    ]);
  });
});

describe("reference ids", () => {
  const boxes = (ids: readonly string[]): ReferenceBox[] =>
    ids.map((id) => ({
      id,
      bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      label: "boat",
    }));

  it("recognizes ids that belong to the reference layer", () => {
    expect(isReferenceId("ref_001")).toBe(true);
    expect(isReferenceId("ann_001")).toBe(false);
  });

  it("never reuses an id after a box was deleted", () => {
    expect(nextReferenceId(boxes(["ref_001", "ref_003"]))).toBe("ref_004");
    expect(nextReferenceId(boxes([]))).toBe("ref_001");
  });
});
