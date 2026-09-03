import { serializeAnnotationsTxt, serializeDocumentJson } from "./serializer";
import type { Annotation, AnnotationDocument } from "./types";

const annotation: Annotation = {
  id: "ann_001",
  bbox: { x1: 855.04, y1: 544.45, x2: 970.75, y2: 724.67 },
  label: "the red car near the truck",
  reservedField: "0",
};

const document: AnnotationDocument = {
  image: { name: "scene.jpg", width: 1920, height: 1080, url: "blob:scene" },
  labelFileName: "scene.txt",
  annotations: [annotation],
};

describe("serializeAnnotationsTxt", () => {
  it("exports arbitrary expressions with two-decimal coordinates and reserved zero", () => {
    expect(serializeAnnotationsTxt([annotation])).toBe(
      "855.04 544.45 970.75 724.67 the red car near the truck 0\n",
    );
  });

  it("normalizes missing reserved fields on TXT export", () => {
    expect(
      serializeAnnotationsTxt([{ ...annotation, reservedField: null }]),
    ).toMatch(/ 0\n$/);
  });
});

describe("serializeDocumentJson", () => {
  it("exports image metadata and stable annotation IDs to JSON", () => {
    const json = JSON.parse(serializeDocumentJson(document));

    expect(json).toMatchObject({
      image: "scene.jpg",
      width: 1920,
      height: 1080,
      annotations: [{ id: "ann_001", label: "the red car near the truck" }],
    });
  });
});
