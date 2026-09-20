export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function fitTransform(image: Size, viewport: Size): ViewTransform {
  const widthScale = viewport.width / image.width;
  const heightScale = viewport.height / image.height;
  const scale = Math.min(widthScale, heightScale);

  return {
    scale,
    offsetX:
      widthScale <= heightScale
        ? 0
        : (viewport.width - image.width * scale) / 2,
    offsetY:
      heightScale <= widthScale
        ? 0
        : (viewport.height - image.height * scale) / 2,
  };
}

export function imageToViewport(point: Point, t: ViewTransform): Point {
  return {
    x: point.x * t.scale + t.offsetX,
    y: point.y * t.scale + t.offsetY,
  };
}

export function viewportToImage(point: Point, t: ViewTransform): Point {
  return {
    x: (point.x - t.offsetX) / t.scale,
    y: (point.y - t.offsetY) / t.scale,
  };
}

export function zoomAroundPoint(
  t: ViewTransform,
  anchor: Point,
  nextScale: number,
): ViewTransform {
  const imagePoint = viewportToImage(anchor, t);

  return {
    scale: nextScale,
    offsetX: anchor.x - imagePoint.x * nextScale,
    offsetY: anchor.y - imagePoint.y * nextScale,
  };
}
