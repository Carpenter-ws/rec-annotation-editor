import { parseAnnotationText } from "./parser";

describe("parseAnnotationText", () => {
  it("parses labels containing spaces and a reserved zero", () => {
    const result = parseAnnotationText(
      "855.04 544.45 970.75 724.67 the red car near the truck 0",
    );

    expect(result.issues).toEqual([]);
    expect(result.annotations[0]).toEqual({
      id: "ann_001",
      bbox: { x1: 855.04, y1: 544.45, x2: 970.75, y2: 724.67 },
      label: "the red car near the truck",
      reservedField: "0",
    });
  });

  it("does not merge duplicate labels", () => {
    const result = parseAnnotationText(
      "0 0 10 10 person 0\n20 20 30 30 person 0",
    );

    expect(result.annotations.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "ann_001", label: "person" },
      { id: "ann_002", label: "person" },
    ]);
  });

  it("supports a line without a reserved field", () => {
    const result = parseAnnotationText("1 2 11 22 person on the left");

    expect(result.annotations[0]?.label).toBe("person on the left");
    expect(result.annotations[0]?.reservedField).toBeNull();
  });

  it('keeps "0" as a legal label when it is the whole tail', () => {
    const result = parseAnnotationText("1 2 11 22 0");

    expect(result.issues).toEqual([]);
    expect(result.annotations[0]?.label).toBe("0");
    expect(result.annotations[0]?.reservedField).toBeNull();
  });

  it("accepts decimal and scientific-notation coordinates", () => {
    const result = parseAnnotationText(".5 -2e0 1.5 +3E1 target 0");

    expect(result.issues).toEqual([]);
    expect(result.annotations[0]?.bbox).toEqual({
      x1: 0.5,
      y1: -2,
      x2: 1.5,
      y2: 30,
    });
  });

  it("rejects non-finite coordinate tokens", () => {
    const result = parseAnnotationText(
      "NaN 0 2 3 bad nan 0\n0 0 Infinity 3 bad infinity 0",
    );

    expect(result.annotations).toEqual([]);
    expect(result.issues.map((issue) => issue.line)).toEqual([1, 2]);
  });

  it("returns every bad line without throwing", () => {
    const result = parseAnnotationText(
      "x 0 2 3 bad number 0\n1 1 1 5 invalid width 0\n1 1 5 5    ",
    );

    expect(result.annotations).toEqual([]);
    expect(result.issues.map((issue) => issue.line)).toEqual([1, 2, 3]);
  });
});
