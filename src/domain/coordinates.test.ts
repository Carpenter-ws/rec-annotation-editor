import {
  fitTransform,
  imageToViewport,
  viewportToImage,
  zoomAroundPoint,
} from "./coordinates";

describe("coordinate transforms", () => {
  it("fits and centers a 1920x1080 image in a 1000x700 viewport", () => {
    expect(
      fitTransform(
        { width: 1920, height: 1080 },
        { width: 1000, height: 700 },
      ),
    ).toEqual({
      scale: 1000 / 1920,
      offsetX: 0,
      offsetY: (700 - 1080 * (1000 / 1920)) / 2,
    });
  });

  it("round-trips original image coordinates", () => {
    const transform = { scale: 0.625, offsetX: 31, offsetY: 47 };
    const source = { x: 855.04, y: 544.45 };
    const restored = viewportToImage(
      imageToViewport(source, transform),
      transform,
    );

    expect(restored.x).toBeCloseTo(source.x, 10);
    expect(restored.y).toBeCloseTo(source.y, 10);
  });

  it("keeps the image point under the cursor fixed while zooming", () => {
    const transform = { scale: 0.75, offsetX: 21, offsetY: 43 };
    const cursor = { x: 420, y: 300 };
    const before = viewportToImage(cursor, transform);
    const next = zoomAroundPoint(transform, cursor, 2);

    expect(viewportToImage(cursor, next)).toEqual(before);
  });
});
