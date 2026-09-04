import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type JSX,
} from "react";
import type { Annotation, ImageBounds } from "../domain/types";
import type { EditorAction } from "../state/editorReducer";
import { AnnotationCard } from "./AnnotationCard";

export interface AnnotationPanelProps {
  annotations: readonly Annotation[];
  selectedId: string | null;
  bounds: ImageBounds | null;
  dispatch: Dispatch<EditorAction>;
  onLocate: (id: string) => void;
  onCoordinateDraftChange?: (id: string, pending: boolean) => void;
}

export function AnnotationPanel({
  annotations,
  selectedId,
  bounds,
  dispatch,
  onLocate,
  onCoordinateDraftChange,
}: AnnotationPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeExpressionId, setActiveExpressionId] = useState<string | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const annotationEntries = useMemo(
    () =>
      annotations.map((annotation, index) => ({
        annotation,
        index: index + 1,
        matches: annotation.label
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      })),
    [annotations, normalizedQuery],
  );
  const matchingCount = useMemo(
    () => annotationEntries.filter(({ matches }) => matches).length,
    [annotationEntries],
  );
  const visibleAnnotations = useMemo(
    () =>
      annotationEntries.filter(
        ({ annotation, matches }) =>
          matches || annotation.id === activeExpressionId,
      ),
    [activeExpressionId, annotationEntries],
  );
  const selectAnnotation = useCallback(
    (id: string) => dispatch({ type: "SELECT", id }),
    [dispatch],
  );
  const handleExpressionEditingChange = useCallback((id: string | null) => {
    setActiveExpressionId(id);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const selectedCard = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>(
        "[data-annotation-id]",
      ) ?? []),
    ].find((element) => element.dataset.annotationId === selectedId);
    selectedCard?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  return (
    <div ref={panelRef} className="annotation-panel">
      <label>
        Search annotations
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <p aria-label="Total annotations">
        <span>{annotations.length}</span>{" "}
        <span>{annotations.length === 1 ? "annotation" : "annotations"}</span>
      </p>
      {normalizedQuery ? (
        <p aria-label="Matching annotations">
          <span>{matchingCount}</span>{" "}
          <span>{matchingCount === 1 ? "match" : "matches"}</span>
        </p>
      ) : null}
      <div>
        {visibleAnnotations.map(({ annotation, index }) => (
          <AnnotationCard
            key={annotation.id}
            annotation={annotation}
            index={index}
            bounds={bounds}
            selected={annotation.id === selectedId}
            dispatch={dispatch}
            onSelect={selectAnnotation}
            onLocate={onLocate}
            onExpressionEditingChange={handleExpressionEditingChange}
            onCoordinateDraftChange={onCoordinateDraftChange}
          />
        ))}
      </div>
    </div>
  );
}
