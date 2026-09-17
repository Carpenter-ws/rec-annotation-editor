import { describe, expect, it } from "vitest";
import {
  isReferenceId,
  nextReferenceId,
  parseReferenceBoxes,
} from "./reference";
import type { ReferenceBox } from "./types";

describe("parseReferenceBoxes", () => {
  it("reads a TXT original annotation file as pixel boxes", () => {
    const result = parseReferenceBoxes(
      "222 462 321 575 boat\n78 598 193 698 boat\n",
      "DJI_0133.txt",
    );

    expect(result.issues).toEqual([]);
    expect(result.boxes).toEqual([
      { id: "ref_001", bbox: { x1: 222, y1: 462, x2: 321, y2: 575 }, label: "boat" },
      { id: "ref_002", bbox: { x1: 78, y1: 598, x2: 193, y2: 698 }, label: "boat" },
    ]);
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
