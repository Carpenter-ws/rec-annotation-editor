import type { Annotation } from "./types";
import { visibleCanvasAnnotations } from "./visibility";

const person: Annotation = {
  id: "ann_001",
  bbox: { x1: 10, y1: 20, x2: 70, y2: 90 },
  label: "person",
  reservedField: "0",
};
const personTwo: Annotation = {
  id: "ann_002",
  bbox: { x1: 100, y1: 110, x2: 180, y2: 200 },
  label: "person",
  reservedField: "0",
};
const bicycle: Annotation = {
  id: "ann_003",
  bbox: { x1: 200, y1: 200, x2: 260, y2: 280 },
  label: "bicycle",
  reservedField: null,
};
const annotations = [person, personTwo, bicycle];

const idle = { activeLabel: null, highlightedLabel: null, selectedId: null };

describe("visibleCanvasAnnotations", () => {
  it("keeps every box off the canvas until a category is picked", () => {
    expect(visibleCanvasAnnotations(annotations, idle)).toEqual([]);
  });

  it("shows only the boxes of the selected category", () => {
    const visible = visibleCanvasAnnotations(annotations, {
      ...idle,
      activeLabel: "person",
    });

    expect(visible.map((annotation) => annotation.id)).toEqual([
      "ann_001",
      "ann_002",
    ]);
  });

  it("keeps the selected box visible so a card click can locate it", () => {
    const visible = visibleCanvasAnnotations(annotations, {
      ...idle,
      selectedId: "ann_003",
    });

    expect(visible.map((annotation) => annotation.id)).toEqual(["ann_003"]);
  });

  it("adds the selected box of another category to the isolated one", () => {
    const visible = visibleCanvasAnnotations(annotations, {
      ...idle,
      activeLabel: "person",
      selectedId: "ann_003",
    });

    expect(visible.map((annotation) => annotation.id)).toEqual([
      "ann_001",
      "ann_002",
      "ann_003",
    ]);
  });

  it("previews a hovered category", () => {
    const visible = visibleCanvasAnnotations(annotations, {
      ...idle,
      highlightedLabel: "bicycle",
    });

    expect(visible.map((annotation) => annotation.id)).toEqual(["ann_003"]);
  });

  it("returns the same annotation objects it was given", () => {
    const visible = visibleCanvasAnnotations(annotations, {
      ...idle,
      activeLabel: "person",
    });

    expect(visible[0]).toBe(person);
  });
});
