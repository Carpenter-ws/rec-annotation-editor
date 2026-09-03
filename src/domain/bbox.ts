import type { Point } from "./coordinates";
import type { BBox, ImageBounds } from "./types";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const MIN_BOX_SIZE = 1;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function clampBBox(bbox: BBox, bounds: ImageBounds): BBox {
  return {
    x1: clamp(bbox.x1, 0, bounds.width),
    y1: clamp(bbox.y1, 0, bounds.height),
    x2: clamp(bbox.x2, 0, bounds.width),
    y2: clamp(bbox.y2, 0, bounds.height),
  };
}

export function moveBBox(
  bbox: BBox,
  delta: Point,
  bounds: ImageBounds,
): BBox {
  const width = bbox.x2 - bbox.x1;
  const height = bbox.y2 - bbox.y1;
  const x1 = clamp(bbox.x1 + delta.x, 0, bounds.width - width);
  const y1 = clamp(bbox.y1 + delta.y, 0, bounds.height - height);

  return { x1, y1, x2: x1 + width, y2: y1 + height };
}

function resizeAxis(
  low: number,
  high: number,
  point: number,
  moveLow: boolean,
  moveHigh: boolean,
  maximum: number,
): [number, number] {
  if (moveLow) return [clamp(point, 0, high - MIN_BOX_SIZE), high];
  if (moveHigh) return [low, clamp(point, low + MIN_BOX_SIZE, maximum)];
  return [low, high];
}

export function resizeBBox(
  bbox: BBox,
  handle: ResizeHandle,
  point: Point,
  bounds: ImageBounds,
): BBox {
  const [x1, x2] = resizeAxis(
    bbox.x1,
    bbox.x2,
    point.x,
    handle.includes("w"),
    handle.includes("e"),
    bounds.width,
  );
  const [y1, y2] = resizeAxis(
    bbox.y1,
    bbox.y2,
    point.y,
    handle.includes("n"),
    handle.includes("s"),
    bounds.height,
  );

  return { x1, y1, x2, y2 };
}

export function bboxFromPoints(
  a: Point,
  b: Point,
  bounds: ImageBounds,
): BBox {
  return clampBBox(
    {
      x1: Math.min(a.x, b.x),
      y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x),
      y2: Math.max(a.y, b.y),
    },
    bounds,
  );
}
