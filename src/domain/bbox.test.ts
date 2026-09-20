import {
  bboxFromPoints,
  clampBBox,
  moveBBox,
  resizeBBox,
} from "./bbox";

const bounds = { width: 120, height: 110 };
const box = { x1: 10, y1: 10, x2: 30, y2: 40 };

describe("bbox geometry", () => {
  it("clamps coordinates to image bounds", () => {
    expect(
      clampBBox({ x1: -5, y1: -8, x2: 130, y2: 140 }, bounds),
    ).toEqual({ x1: 0, y1: 0, x2: 120, y2: 110 });
  });

  it("moves a box without allowing it outside image bounds", () => {
    expect(
      moveBBox(
        { x1: 80, y1: 80, x2: 100, y2: 100 },
        { x: 25, y: 30 },
        bounds,
      ),
    ).toEqual({ x1: 100, y1: 90, x2: 120, y2: 110 });
  });

  it.each([
    ["nw", { x: 5, y: 8 }, { x1: 5, y1: 8, x2: 30, y2: 40 }],
    ["n", { x: 20, y: 8 }, { x1: 10, y1: 8, x2: 30, y2: 40 }],
    ["ne", { x: 50, y: 8 }, { x1: 10, y1: 8, x2: 50, y2: 40 }],
    ["e", { x: 50, y: 20 }, { x1: 10, y1: 10, x2: 50, y2: 40 }],
    ["se", { x: 50, y: 55 }, { x1: 10, y1: 10, x2: 50, y2: 55 }],
    ["s", { x: 20, y: 55 }, { x1: 10, y1: 10, x2: 30, y2: 55 }],
    ["sw", { x: 5, y: 55 }, { x1: 5, y1: 10, x2: 30, y2: 55 }],
    ["w", { x: 5, y: 20 }, { x1: 5, y1: 10, x2: 30, y2: 40 }],
  ] as const)("resizes handle %s", (handle, point, expected) => {
    expect(resizeBBox(box, handle, point, bounds)).toEqual(expected);
  });

  it("clamps invalid cross-over to a one-pixel minimum", () => {
    expect(resizeBBox(box, "w", { x: 99, y: 0 }, bounds).x1).toBe(
      box.x2 - 1,
    );
  });

  it.each([
    [
      "nw",
      { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 },
      { x: 0.2, y: 0.2 },
      { x1: 0, y1: 0, x2: 1, y2: 1 },
    ],
    [
      "n",
      { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 },
      { x: 0.2, y: 0.2 },
      { x1: 0, y1: 0, x2: 1, y2: 1 },
    ],
    [
      "ne",
      { x1: 119.5, y1: 0.1, x2: 120, y2: 0.5 },
      { x: 119.8, y: 0.2 },
      { x1: 119, y1: 0, x2: 120, y2: 1 },
    ],
    [
      "e",
      { x1: 119.5, y1: 0.1, x2: 120, y2: 0.5 },
      { x: 119.8, y: 0.2 },
      { x1: 119, y1: 0, x2: 120, y2: 1 },
    ],
    [
      "se",
      { x1: 119.5, y1: 109.5, x2: 120, y2: 110 },
      { x: 119.8, y: 109.8 },
      { x1: 119, y1: 109, x2: 120, y2: 110 },
    ],
    [
      "s",
      { x1: 119.5, y1: 109.5, x2: 120, y2: 110 },
      { x: 119.8, y: 109.8 },
      { x1: 119, y1: 109, x2: 120, y2: 110 },
    ],
    [
      "sw",
      { x1: 0.1, y1: 109.5, x2: 0.5, y2: 110 },
      { x: 0.2, y: 109.8 },
      { x1: 0, y1: 109, x2: 1, y2: 110 },
    ],
    [
      "w",
      { x1: 0.1, y1: 109.5, x2: 0.5, y2: 110 },
      { x: 0.2, y: 109.8 },
      { x1: 0, y1: 109, x2: 1, y2: 110 },
    ],
  ] as const)(
    "repairs subpixel axes within bounds when resizing handle %s",
    (handle, source, point, expected) => {
      expect(resizeBBox(source, handle, point, bounds)).toEqual(expected);
    },
  );

  it("normalizes two points before clamping them to image bounds", () => {
    expect(
      bboxFromPoints({ x: 130, y: 90 }, { x: -5, y: 20 }, bounds),
    ).toEqual({ x1: 0, y1: 20, x2: 120, y2: 90 });
  });
});
