import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  fitTransform,
  zoomAroundPoint,
  type Point,
  type ViewTransform,
} from "../domain/coordinates";
import type { Annotation, ImageInfo } from "../domain/types";
import type { EditorAction } from "../state/editorReducer";

const DEFAULT_TRANSFORM: ViewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

function clampScale(scale: number): number {
  return Math.min(32, Math.max(0.05, scale));
}

function clampedFitTransform(
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): ViewTransform {
  const fitted = fitTransform(image, viewport);
  const scale = clampScale(fitted.scale);
  if (scale === fitted.scale) return fitted;

  return {
    scale,
    offsetX: (viewport.width - image.width * scale) / 2,
    offsetY: (viewport.height - image.height * scale) / 2,
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'button, a[href], input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [role]:not([role="none"]):not([role="presentation"])',
    ) !== null
  );
}

export interface ViewportProps {
  image: ImageInfo;
  annotations: readonly Annotation[];
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
  onZoomChange: (scale: number) => void;
  initialTransform?: ViewTransform;
}

export interface ViewportHandle {
  fit(): void;
  centerAnnotation(id: string): void;
  zoomBy(factor: number): void;
}

interface AnnotationBoxProps {
  annotation: Annotation;
  selected: boolean;
  scale: number;
  onSelect: (event: MouseEvent<SVGGElement>) => void;
}

function AnnotationBox({
  annotation,
  selected,
  scale,
  onSelect,
}: AnnotationBoxProps): JSX.Element {
  const { x1, y1, x2, y2 } = annotation.bbox;
  const width = x2 - x1;
  const height = y2 - y1;

  return (
    <g onClick={onSelect}>
      <rect
        x={x1}
        y={y1}
        width={width}
        height={height}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        pointerEvents="stroke"
        vectorEffect="non-scaling-stroke"
      />
      <rect
        data-testid={`bbox-${annotation.id}`}
        x={x1}
        y={y1}
        width={width}
        height={height}
        fill="none"
        stroke={selected ? "#facc15" : "#22d3ee"}
        strokeWidth={selected ? 2 : 1.5}
        vectorEffect="non-scaling-stroke"
      />
      {selected ? (
        <text x={x1} y={y1} dy={-6 / scale} fontSize={14 / scale}>
          {annotation.label}
        </text>
      ) : null}
    </g>
  );
}

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(
  {
    image,
    annotations,
    selectedId,
    dispatch,
    onZoomChange,
    initialTransform,
  },
  ref,
): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{
    pointerId: number;
    last: Point;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);
  const fitModeRef = useRef(initialTransform === undefined);
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  const imageIdentityRef = useRef(image.url);
  const [transform, setTransform] = useState<ViewTransform>(
    initialTransform ?? DEFAULT_TRANSFORM,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      spacePressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    const clearSpace = () => {
      spacePressedRef.current = false;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") clearSpace();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearSpace);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearSpace);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    if (imageIdentityRef.current !== image.url) {
      imageIdentityRef.current = image.url;
      fitModeRef.current = true;
    }

    const updateSize = ({ width, height }: { width: number; height: number }) => {
      viewportSizeRef.current = { width, height };
      if (fitModeRef.current && width > 0 && height > 0) {
        setTransform(
          clampedFitTransform(
            { width: image.width, height: image.height },
            { width, height },
          ),
        );
      }
    };

    if (typeof ResizeObserver === "undefined") {
      updateSize(svg.getBoundingClientRect());
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateSize(entry.contentRect);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [image.height, image.url, image.width]);

  useEffect(() => {
    onZoomChange(transform.scale);
  }, [onZoomChange, transform.scale]);

  useImperativeHandle(ref, () => ({
    fit() {
      fitModeRef.current = true;
      const viewport = viewportSizeRef.current;
      if (viewport.width <= 0 || viewport.height <= 0) return;
      setTransform(
        clampedFitTransform(
          { width: image.width, height: image.height },
          viewport,
        ),
      );
    },
    centerAnnotation(id) {
      const annotation = annotations.find((candidate) => candidate.id === id);
      const viewport = viewportSizeRef.current;
      if (!annotation || viewport.width <= 0 || viewport.height <= 0) return;

      const { x1, y1, x2, y2 } = annotation.bbox;
      const width = x2 - x1;
      const height = y2 - y1;
      const currentRatio = Math.max(
        (width * transform.scale) / viewport.width,
        (height * transform.scale) / viewport.height,
      );
      let nextScale = transform.scale;
      if (currentRatio < 0.12) {
        const targetScale = Math.min(
          (viewport.width * 0.35) / width,
          (viewport.height * 0.35) / height,
        );
        nextScale = Math.max(transform.scale, Math.min(8, targetScale));
      }

      setTransform({
        scale: nextScale,
        offsetX: viewport.width / 2 - ((x1 + x2) / 2) * nextScale,
        offsetY: viewport.height / 2 - ((y1 + y2) / 2) * nextScale,
      });
      fitModeRef.current = false;
    },
    zoomBy(factor) {
      const viewport = viewportSizeRef.current;
      if (viewport.width <= 0 || viewport.height <= 0) return;
      const nextScale = clampScale(transform.scale * factor);
      setTransform(
        zoomAroundPoint(
          transform,
          { x: viewport.width / 2, y: viewport.height / 2 },
          nextScale,
        ),
      );
      fitModeRef.current = false;
    },
  }));

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const nextScale = clampScale(
      transform.scale * Math.exp(-event.deltaY * 0.0015),
    );
    setTransform(zoomAroundPoint(transform, localPoint(event), nextScale));
    fitModeRef.current = false;
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const startsPan =
      event.button === 1 || (event.button === 0 && spacePressedRef.current);
    if (!startsPan) return;
    event.preventDefault();
    panRef.current = {
      pointerId: event.pointerId,
      last: localPoint(event),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    fitModeRef.current = false;
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;

    const point = localPoint(event);
    const deltaX = point.x - pan.last.x;
    const deltaY = point.y - pan.last.y;
    if (deltaX !== 0 || deltaY !== 0) pan.moved = true;
    pan.last = point;
    setTransform((current) => ({
      ...current,
      offsetX: current.offsetX + deltaX,
      offsetY: current.offsetY + deltaY,
    }));
  };

  const stopPan = (event: PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.type === "pointerup" && pan.moved) {
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 0);
    }
    panRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture !== "function" ||
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onLostPointerCapture = (event: PointerEvent<SVGSVGElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };

  return (
    <svg
      ref={svgRef}
      className="viewport-svg"
      aria-label="Annotation canvas"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onLostPointerCapture={onLostPointerCapture}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        if (suppressClickTimerRef.current !== null) {
          window.clearTimeout(suppressClickTimerRef.current);
          suppressClickTimerRef.current = null;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.button === 0) dispatch({ type: "SELECT", id: null });
      }}
    >
      <g
        data-testid="image-space"
        data-scale={transform.scale}
        data-offset-x={transform.offsetX}
        data-offset-y={transform.offsetY}
        transform={`translate(${transform.offsetX} ${transform.offsetY}) scale(${transform.scale})`}
      >
        <image
          href={image.url}
          width={image.width}
          height={image.height}
          aria-label={image.name}
          role="img"
        />
        {annotations.map((annotation) => (
          <AnnotationBox
            key={annotation.id}
            annotation={annotation}
            selected={annotation.id === selectedId}
            scale={transform.scale}
            onSelect={(event) => {
              event.stopPropagation();
              dispatch({ type: "SELECT", id: annotation.id });
            }}
          />
        ))}
      </g>
    </svg>
  );
});
