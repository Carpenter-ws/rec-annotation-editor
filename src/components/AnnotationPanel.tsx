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
}

export function AnnotationPanel({
  annotations,
  selectedId,
  bounds,
  dispatch,
  onLocate,
}: AnnotationPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAnnotations = useMemo(
    () =>
      annotations.flatMap((annotation, index) =>
        annotation.label.toLocaleLowerCase().includes(normalizedQuery)
          ? [{ annotation, index: index + 1 }]
          : [],
      ),
    [annotations, normalizedQuery],
  );
  const selectAnnotation = useCallback(
    (id: string) => dispatch({ type: "SELECT", id }),
    [dispatch],
  );

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
          <span>{visibleAnnotations.length}</span>{" "}
          <span>{visibleAnnotations.length === 1 ? "match" : "matches"}</span>
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
          />
        ))}
      </div>
    </div>
  );
}
