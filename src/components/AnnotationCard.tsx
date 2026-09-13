import {
  memo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type JSX,
} from "react";
import { clampBBox } from "../domain/bbox";
import type { Annotation, ImageBounds } from "../domain/types";
import type { EditorAction } from "../state/editorReducer";

type Coordinate = keyof Annotation["bbox"];

const coordinateLabels: Record<Coordinate, string> = {
  x1: "X1",
  y1: "Y1",
  x2: "X2",
  y2: "Y2",
};

/** Keeps converted coordinates readable (1831.6799999999998 -> 1831.68). */
function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}

function bboxStrings(bbox: Annotation["bbox"]): Record<Coordinate, string> {
  return {
    x1: formatCoordinate(bbox.x1),
    y1: formatCoordinate(bbox.y1),
    x2: formatCoordinate(bbox.x2),
    y2: formatCoordinate(bbox.y2),
  };
}

export interface AnnotationCardProps {
  annotation: Annotation;
  index: number;
  bounds: ImageBounds | null;
  selected: boolean;
  dispatch: Dispatch<EditorAction>;
  onSelect: (id: string) => void;
  onLocate: (id: string) => void;
  onExpressionEditingChange: (id: string | null) => void;
  onCoordinateDraftChange?: (id: string, pending: boolean) => void;
}

export const AnnotationCard = memo(function AnnotationCard({
  annotation,
  index,
  bounds,
  selected,
  dispatch,
  onSelect,
  onLocate,
  onExpressionEditingChange,
  onCoordinateDraftChange,
}: AnnotationCardProps): JSX.Element {
  const [expression, setExpression] = useState(annotation.label);
  const [expressionError, setExpressionError] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState(() =>
    bboxStrings(annotation.bbox),
  );
  const [coordinateError, setCoordinateError] = useState<string | null>(null);
  const editingExpressionRef = useRef(false);
  const focusStartLabelRef = useRef(annotation.label);
  const activeCoordinateRef = useRef<Coordinate | null>(null);
  const legalBBoxRef = useRef(annotation.bbox);

  useEffect(() => {
    if (editingExpressionRef.current) return;
    setExpression(annotation.label);
    focusStartLabelRef.current = annotation.label;
  }, [annotation.label]);

  useEffect(() => {
    legalBBoxRef.current = annotation.bbox;
    const next = bboxStrings(annotation.bbox);
    setCoordinates((current) => ({
      x1: activeCoordinateRef.current === "x1" ? current.x1 : next.x1,
      y1: activeCoordinateRef.current === "y1" ? current.y1 : next.y1,
      x2: activeCoordinateRef.current === "x2" ? current.x2 : next.x2,
      y2: activeCoordinateRef.current === "y2" ? current.y2 : next.y2,
    }));
  }, [
    annotation.bbox.x1,
    annotation.bbox.y1,
    annotation.bbox.x2,
    annotation.bbox.y2,
  ]);

  // A card that unmounts (collapse, search filter, import) can no longer
  // commit its numeric draft, so its pending marker must be released.
  const unmountCleanupRef = useRef(onCoordinateDraftChange);
  unmountCleanupRef.current = onCoordinateDraftChange;
  const annotationIdRef = useRef(annotation.id);
  annotationIdRef.current = annotation.id;
  useEffect(
    () => () => {
      unmountCleanupRef.current?.(annotationIdRef.current, false);
    },
    [],
  );

  const finishExpression = () => {
    if (!editingExpressionRef.current) return;
    editingExpressionRef.current = false;
    const label = expression.trim();
    if (label.length === 0) {
      setExpression(focusStartLabelRef.current);
      setExpressionError("Expression cannot be empty.");
      dispatch({ type: "CANCEL_TRANSACTION" });
      onExpressionEditingChange(null);
      return;
    }
    setExpressionError(null);
    if (label !== expression) {
      setExpression(label);
      dispatch({
        type: "PREVIEW_PATCH",
        id: annotation.id,
        patch: { label },
      });
    }
    dispatch({ type: "COMMIT_TRANSACTION" });
    onExpressionEditingChange(null);
  };

  const cancelExpression = () => {
    if (!editingExpressionRef.current) return;
    editingExpressionRef.current = false;
    setExpression(focusStartLabelRef.current);
    setExpressionError(null);
    dispatch({ type: "CANCEL_TRANSACTION" });
    onExpressionEditingChange(null);
  };

  const commitCoordinates = () => {
    if (!bounds) return;
    const parsed = {
      x1: Number(coordinates.x1),
      y1: Number(coordinates.y1),
      x2: Number(coordinates.x2),
      y2: Number(coordinates.y2),
    };
    if (
      Object.values(coordinates).some((value) => value.trim() === "") ||
      Object.values(parsed).some((value) => !Number.isFinite(value))
    ) {
      setCoordinateError("All coordinates must be finite numbers.");
      setCoordinates(bboxStrings(legalBBoxRef.current));
      onCoordinateDraftChange?.(annotation.id, false);
      return;
    }
    const bbox = clampBBox(parsed, bounds);
    if (bbox.x2 <= bbox.x1) {
      setCoordinateError("X2 must be greater than X1.");
      setCoordinates(bboxStrings(legalBBoxRef.current));
      onCoordinateDraftChange?.(annotation.id, false);
      return;
    }
    if (bbox.y2 <= bbox.y1) {
      setCoordinateError("Y2 must be greater than Y1.");
      setCoordinates(bboxStrings(legalBBoxRef.current));
      onCoordinateDraftChange?.(annotation.id, false);
      return;
    }
    setCoordinateError(null);
    legalBBoxRef.current = bbox;
    setCoordinates(bboxStrings(bbox));
    onCoordinateDraftChange?.(annotation.id, false);
    dispatch({
      type: "UPDATE_ANNOTATION",
      id: annotation.id,
      patch: { bbox },
    });
  };

  return (
    <article
      className={selected ? "annotation-card is-selected" : "annotation-card"}
      data-annotation-id={annotation.id}
      data-annotation-label={annotation.label}
      aria-current={selected ? "true" : undefined}
      onClick={() => {
        onSelect(annotation.id);
        onLocate(annotation.id);
      }}
    >
      <header>
        <div>
          <strong>Annotation {index}</strong>
          <span className="annotation-id">{annotation.id}</span>
        </div>
        <button
          type="button"
          aria-label="Delete annotation"
          onClick={(event) => {
            event.stopPropagation();
            dispatch({ type: "DELETE_ANNOTATION", id: annotation.id });
          }}
        >
          Delete
        </button>
      </header>
      <label onClick={(event) => event.stopPropagation()}>
        Expression
        <input
          type="text"
          data-expression-transaction-owner="true"
          value={expression}
          onFocus={() => {
            onSelect(annotation.id);
            if (editingExpressionRef.current) return;
            editingExpressionRef.current = true;
            focusStartLabelRef.current = expression;
            onExpressionEditingChange(annotation.id);
            dispatch({ type: "BEGIN_TRANSACTION" });
          }}
          onChange={(event) => {
            const label = event.currentTarget.value;
            setExpression(label);
            setExpressionError(null);
            dispatch({
              type: "PREVIEW_PATCH",
              id: annotation.id,
              patch: { label },
            });
          }}
          onBlur={finishExpression}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelExpression();
              event.currentTarget.blur();
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            finishExpression();
            event.currentTarget.blur();
          }}
        />
      </label>
      {expressionError ? <p role="alert">{expressionError}</p> : null}
      <div>
        {(Object.keys(coordinateLabels) as Coordinate[]).map((coordinate) => (
          <label key={coordinate} onClick={(event) => event.stopPropagation()}>
            {coordinateLabels[coordinate]}
            <input
              type="text"
              inputMode="decimal"
              disabled={bounds === null}
              value={coordinates[coordinate]}
              onFocus={() => {
                onSelect(annotation.id);
                activeCoordinateRef.current = coordinate;
              }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const nextCoordinates = {
                  ...coordinates,
                  [coordinate]: value,
                };
                const legalCoordinates = bboxStrings(legalBBoxRef.current);
                setCoordinateError(null);
                setCoordinates(nextCoordinates);
                onCoordinateDraftChange?.(
                  annotation.id,
                  (Object.keys(coordinateLabels) as Coordinate[]).some(
                    (name) => nextCoordinates[name] !== legalCoordinates[name],
                  ),
                );
              }}
              onBlur={() => {
                if (activeCoordinateRef.current !== coordinate) return;
                activeCoordinateRef.current = null;
                commitCoordinates();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                activeCoordinateRef.current = null;
                commitCoordinates();
                event.currentTarget.blur();
              }}
            />
          </label>
        ))}
      </div>
      {coordinateError ? <p role="alert">{coordinateError}</p> : null}
    </article>
  );
});
