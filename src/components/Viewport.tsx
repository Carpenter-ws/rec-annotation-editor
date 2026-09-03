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
  viewportToImage,
  zoomAroundPoint,
  type Point,
  type ViewTransform,
} from "../domain/coordinates";
import {
  bboxFromPoints,
  moveBBox,
  resizeBBox,
  type ResizeHandle,
} from "../domain/bbox";
import type { Annotation, BBox, ImageInfo } from "../domain/types";
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

function blurActiveExpressionTransactionOwner(): void {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLElement) ||
    !activeElement.hasAttribute("data-expression-transaction-owner")
  ) {
    return;
  }
  activeElement.blur();
}

export interface ViewportProps {
  image: ImageInfo;
  annotations: readonly Annotation[];
  selectedId: string | null;
  dispatch: Dispatch<EditorAction>;
  onZoomChange: (scale: number) => void;
  mode: "select" | "add";
  onDraftBox: (bbox: BBox) => void;
  initialTransform?: ViewTransform;
}

export interface ViewportHandle {
  fit(): void;
  centerAnnotation(id: string): void;
  zoomBy(factor: number): void;
}

type PointerInteraction =
  | {
      type: "pan";
      pointerId: number;
      startViewport: Point;
      startTransform: ViewTransform;
    }
  | {
      type: "move";
      pointerId: number;
      id: string;
      startImage: Point;
      startBBox: BBox;
    }
  | {
      type: "resize";
      pointerId: number;
      id: string;
      handle: ResizeHandle;
      startBBox: BBox;
    }
  | {
      type: "draw";
      pointerId: number;
      startImage: Point;
      currentImage: Point;
    };

interface AnnotationBoxProps {
  annotation: Annotation;
  selected: boolean;
  scale: number;
  onSelect: (event: MouseEvent<SVGGElement>) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  onResizePointerDown: (
    event: PointerEvent<SVGRectElement>,
    handle: ResizeHandle,
  ) => void;
}

function AnnotationBox({
  annotation,
  selected,
  scale,
  onSelect,
  onPointerDown,
  onResizePointerDown,
}: AnnotationBoxProps): JSX.Element {
  const { x1, y1, x2, y2 } = annotation.bbox;
  const width = x2 - x1;
  const height = y2 - y1;
  const handleSize = 10 / scale;
  const handles: readonly [ResizeHandle, Point][] = [
    ["nw", { x: x1, y: y1 }],
    ["n", { x: (x1 + x2) / 2, y: y1 }],
    ["ne", { x: x2, y: y1 }],
    ["e", { x: x2, y: (y1 + y2) / 2 }],
    ["se", { x: x2, y: y2 }],
    ["s", { x: (x1 + x2) / 2, y: y2 }],
    ["sw", { x: x1, y: y2 }],
    ["w", { x: x1, y: (y1 + y2) / 2 }],
  ];

  return (
    <g onClick={onSelect} onPointerDown={onPointerDown}>
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
        <>
          <text x={x1} y={y1} dy={-6 / scale} fontSize={14 / scale}>
            {annotation.label}
          </text>
          {handles.map(([handle, center]) => (
            <rect
              key={handle}
              data-testid={`handle-${handle}`}
              x={center.x - handleSize / 2}
              y={center.y - handleSize / 2}
              width={handleSize}
              height={handleSize}
              fill="#facc15"
              stroke="#111827"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              onPointerDown={(event) => onResizePointerDown(event, handle)}
            />
          ))}
        </>
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
    mode,
    onDraftBox,
    initialTransform,
  },
  ref,
): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const interactionMovedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);
  const fitModeRef = useRef(initialTransform === undefined);
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  const imageIdentityRef = useRef(image.url);
  const [transform, setTransform] = useState<ViewTransform>(
    initialTransform ?? DEFAULT_TRANSFORM,
  );
  const [draftBBox, setDraftBBox] = useState<BBox | null>(null);

  const releasePointerCapture = (pointerId: number) => {
    const svg = svgRef.current;
    if (
      typeof svg?.releasePointerCapture === "function" &&
      (typeof svg.hasPointerCapture !== "function" ||
        svg.hasPointerCapture(pointerId))
    ) {
      svg.releasePointerCapture(pointerId);
    }
  };

  const cancelActiveInteraction = () => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    if (interaction.type === "move" || interaction.type === "resize") {
      dispatch({ type: "CANCEL_TRANSACTION" });
    }
    if (interaction.type === "draw") setDraftBBox(null);
    interactionRef.current = null;
    interactionMovedRef.current = false;
    releasePointerCapture(interaction.pointerId);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelActiveInteraction();
        return;
      }
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
    if (startsPan) {
      event.preventDefault();
      interactionRef.current = {
        type: "pan",
        pointerId: event.pointerId,
        startViewport: localPoint(event),
        startTransform: transform,
      };
      interactionMovedRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      fitModeRef.current = false;
      return;
    }

    if (
      mode === "add" &&
      event.button === 0 &&
      interactionRef.current === null
    ) {
      event.preventDefault();
      const startImage = viewportToImage(localPoint(event), transform);
      interactionRef.current = {
        type: "draw",
        pointerId: event.pointerId,
        startImage,
        currentImage: startImage,
      };
      interactionMovedRef.current = false;
      setDraftBBox(
        bboxFromPoints(startImage, startImage, {
          width: image.width,
          height: image.height,
        }),
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    if (interaction.type === "pan") {
      const point = localPoint(event);
      const deltaX = point.x - interaction.startViewport.x;
      const deltaY = point.y - interaction.startViewport.y;
      if (deltaX !== 0 || deltaY !== 0) interactionMovedRef.current = true;
      setTransform({
        ...interaction.startTransform,
        offsetX: interaction.startTransform.offsetX + deltaX,
        offsetY: interaction.startTransform.offsetY + deltaY,
      });
      return;
    }

    if (interaction.type === "move") {
      const point = viewportToImage(localPoint(event), transform);
      const delta = {
        x: point.x - interaction.startImage.x,
        y: point.y - interaction.startImage.y,
      };
      if (delta.x !== 0 || delta.y !== 0) interactionMovedRef.current = true;
      dispatch({
        type: "PREVIEW_PATCH",
        id: interaction.id,
        patch: {
          bbox: moveBBox(interaction.startBBox, delta, {
            width: image.width,
            height: image.height,
          }),
        },
      });
      return;
    }

    if (interaction.type === "resize") {
      const bbox = resizeBBox(
        interaction.startBBox,
        interaction.handle,
        viewportToImage(localPoint(event), transform),
        { width: image.width, height: image.height },
      );
      interactionMovedRef.current =
        interactionMovedRef.current ||
        bbox.x1 !== interaction.startBBox.x1 ||
        bbox.y1 !== interaction.startBBox.y1 ||
        bbox.x2 !== interaction.startBBox.x2 ||
        bbox.y2 !== interaction.startBBox.y2;
      dispatch({
        type: "PREVIEW_PATCH",
        id: interaction.id,
        patch: { bbox },
      });
      return;
    }

    if (interaction.type === "draw") {
      const currentImage = viewportToImage(localPoint(event), transform);
      interactionRef.current = { ...interaction, currentImage };
      interactionMovedRef.current =
        interactionMovedRef.current ||
        currentImage.x !== interaction.startImage.x ||
        currentImage.y !== interaction.startImage.y;
      setDraftBBox(
        bboxFromPoints(interaction.startImage, currentImage, {
          width: image.width,
          height: image.height,
        }),
      );
    }
  };

  const stopInteraction = (event: PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const editsAnnotation =
      interaction.type === "move" || interaction.type === "resize";
    if (event.type === "pointerup" && interaction.type === "draw") {
      const endImage = viewportToImage(localPoint(event), transform);
      interactionMovedRef.current =
        interactionMovedRef.current ||
        endImage.x !== interaction.startImage.x ||
        endImage.y !== interaction.startImage.y;
      const bbox = bboxFromPoints(interaction.startImage, endImage, {
        width: image.width,
        height: image.height,
      });
      if (
        (bbox.x2 - bbox.x1) * transform.scale >= 3 &&
        (bbox.y2 - bbox.y1) * transform.scale >= 3
      ) {
        onDraftBox(bbox);
      }
      setDraftBBox(null);
    }
    if (event.type === "pointerup" && editsAnnotation) {
      dispatch({ type: "COMMIT_TRANSACTION" });
    }
    if (event.type === "pointercancel" && editsAnnotation) {
      dispatch({ type: "CANCEL_TRANSACTION" });
    }
    if (event.type === "pointercancel" && interaction.type === "draw") {
      setDraftBBox(null);
    }
    if (
      event.type === "pointerup" &&
      interactionMovedRef.current
    ) {
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 0);
    }
    interactionRef.current = null;
    interactionMovedRef.current = false;
    releasePointerCapture(event.pointerId);
  };

  const onLostPointerCapture = (event: PointerEvent<SVGSVGElement>) => {
    if (interactionRef.current?.pointerId === event.pointerId) {
      cancelActiveInteraction();
    }
  };

  const startMove = (
    event: PointerEvent<SVGGElement>,
    annotation: Annotation,
  ) => {
    if (
      mode !== "select" ||
      event.button !== 0 ||
      spacePressedRef.current ||
      interactionRef.current !== null
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    blurActiveExpressionTransactionOwner();
    interactionRef.current = {
      type: "move",
      pointerId: event.pointerId,
      id: annotation.id,
      startImage: viewportToImage(localPoint(event), transform),
      startBBox: annotation.bbox,
    };
    interactionMovedRef.current = false;
    svgRef.current?.setPointerCapture?.(event.pointerId);
    dispatch({ type: "BEGIN_TRANSACTION" });
  };

  const startResize = (
    event: PointerEvent<SVGRectElement>,
    annotation: Annotation,
    handle: ResizeHandle,
  ) => {
    if (
      mode !== "select" ||
      event.button !== 0 ||
      spacePressedRef.current ||
      interactionRef.current !== null
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    blurActiveExpressionTransactionOwner();
    interactionRef.current = {
      type: "resize",
      pointerId: event.pointerId,
      id: annotation.id,
      handle,
      startBBox: annotation.bbox,
    };
    interactionMovedRef.current = false;
    svgRef.current?.setPointerCapture?.(event.pointerId);
    dispatch({ type: "BEGIN_TRANSACTION" });
  };

  return (
    <svg
      ref={svgRef}
      className="viewport-svg"
      aria-label="Annotation canvas"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopInteraction}
      onPointerCancel={stopInteraction}
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
            onPointerDown={(event) => startMove(event, annotation)}
            onResizePointerDown={(event, handle) =>
              startResize(event, annotation, handle)
            }
          />
        ))}
        {draftBBox ? (
          <rect
            data-testid="draft-box"
            x={draftBBox.x1}
            y={draftBBox.y1}
            width={draftBBox.x2 - draftBBox.x1}
            height={draftBBox.y2 - draftBBox.y1}
            fill="none"
            stroke="#facc15"
            strokeWidth={2}
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ) : null}
      </g>
    </svg>
  );
});
