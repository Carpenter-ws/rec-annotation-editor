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
  onHighlightLabel?: (label: string | null) => void;
  /** The currently isolated category, whose boxes are shown alone on canvas. */
  activeLabel?: string | null;
  onActivateLabel?: (label: string) => void;
  onReset?: () => void;
}

interface AnnotationEntry {
  annotation: Annotation;
  index: number;
  matches: boolean;
}

interface LabelGroup {
  label: string;
  entries: AnnotationEntry[];
  labelMatches: boolean;
}

export function AnnotationPanel({
  annotations,
  selectedId,
  bounds,
  dispatch,
  onLocate,
  onCoordinateDraftChange,
  onHighlightLabel,
  activeLabel = null,
  onActivateLabel,
  onReset,
}: AnnotationPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeExpressionId, setActiveExpressionId] = useState<string | null>(
    null,
  );
  const [collapsedLabels, setCollapsedLabels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const annotationsRef = useRef(annotations);
  const editingStartRef = useRef<{ id: string; label: string } | null>(null);
  const scrolledForIdRef = useRef<string | null>(null);
  annotationsRef.current = annotations;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const annotationEntries = useMemo(
    () =>
      annotations.map((annotation, index) => ({
        annotation,
        index: index + 1,
        matches: annotation.label
          .toLocaleLowerCase()
          .includes(normalizedQuery) ||
          annotation.id.toLocaleLowerCase().includes(normalizedQuery),
      })),
    [annotations, normalizedQuery],
  );
  const matchingCount = useMemo(
    () => annotationEntries.filter(({ matches }) => matches).length,
    [annotationEntries],
  );

  // Boxes are grouped by their exact text label. While an expression is being
  // edited, its box stays in the category it started in so the focused card
  // never remounts; it regroups once the edit commits.
  const groups = useMemo<LabelGroup[]>(() => {
    const map = new Map<string, LabelGroup>();
    for (const entry of annotationEntries) {
      const key =
        entry.annotation.id === activeExpressionId &&
        editingStartRef.current !== null
          ? editingStartRef.current.label
          : entry.annotation.label;
      let group = map.get(key);
      if (!group) {
        group = {
          label: key,
          entries: [],
          labelMatches: key.toLocaleLowerCase().includes(normalizedQuery),
        };
        map.set(key, group);
      }
      group.entries.push(entry);
    }
    return [...map.values()];
  }, [activeExpressionId, annotationEntries, normalizedQuery]);

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          group,
          visibleEntries: group.entries.filter(
            ({ annotation, matches }) =>
              matches || annotation.id === activeExpressionId,
          ),
        }))
        .filter(({ group, visibleEntries }) =>
          normalizedQuery
            ? group.labelMatches || visibleEntries.length > 0
            : true,
        ),
    [activeExpressionId, groups, normalizedQuery],
  );

  const ensureExpanded = useCallback((label: string) => {
    setCollapsedLabels((current) => {
      if (!current.has(label)) return current;
      const next = new Set(current);
      next.delete(label);
      return next;
    });
  }, []);

  const selectAnnotation = useCallback(
    (id: string) => dispatch({ type: "SELECT", id }),
    [dispatch],
  );

  const handleExpressionEditingChange = useCallback(
    (id: string | null) => {
      if (id) {
        const annotation = annotationsRef.current.find(
          (candidate) => candidate.id === id,
        );
        editingStartRef.current = { id, label: annotation?.label ?? "" };
        ensureExpanded(editingStartRef.current.label);
        setActiveExpressionId(id);
        return;
      }
      const finished = editingStartRef.current;
      editingStartRef.current = null;
      setActiveExpressionId(null);
      if (finished) {
        const annotation = annotationsRef.current.find(
          (candidate) => candidate.id === finished.id,
        );
        if (annotation) ensureExpanded(annotation.label);
      }
    },
    [ensureExpanded],
  );

  const activateGroup = useCallback(
    (group: LabelGroup) => {
      onHighlightLabel?.(group.label);
      onActivateLabel?.(group.label);
    },
    [onActivateLabel, onHighlightLabel],
  );

  const toggleGroup = useCallback(
    (group: LabelGroup) => {
      const keepsEditingCard = group.entries.some(
        ({ annotation }) => annotation.id === activeExpressionId,
      );
      setCollapsedLabels((current) => {
        const isCollapsed = current.has(group.label);
        if (!isCollapsed && keepsEditingCard) return current;
        const next = new Set(current);
        if (isCollapsed) next.delete(group.label);
        else next.add(group.label);
        return next;
      });
    },
    [activeExpressionId],
  );

  const allExpanded = collapsedLabels.size === 0;
  const toggleAllGroups = useCallback(() => {
    setCollapsedLabels(
      allExpanded
        ? new Set(groups.map(({ label }) => label))
        : () => new Set<string>(),
    );
  }, [allExpanded, groups]);

  // Selecting a box anywhere always reveals its category.
  useEffect(() => {
    if (!selectedId) {
      scrolledForIdRef.current = null;
      return;
    }
    const annotation = annotations.find(
      (candidate) => candidate.id === selectedId,
    );
    if (annotation) ensureExpanded(annotation.label);
  }, [annotations, ensureExpanded, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const selectedCard = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>(
        "[data-annotation-id]",
      ) ?? []),
    ].find((element) => element.dataset.annotationId === selectedId);
    if (!selectedCard || scrolledForIdRef.current === selectedId) return;
    scrolledForIdRef.current = selectedId;
    selectedCard?.scrollIntoView?.({ block: "nearest" });
  }, [collapsedLabels, selectedId]);

  return (
    <div ref={panelRef} id="annotation-panel" className="annotation-panel">
      <label className="annotation-search">
        Search annotations
        <input
          type="search"
          value={query}
          placeholder="Search expressions..."
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="annotation-panel-summary">
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
        {groups.length > 0 ? (
          <>
            <button
              type="button"
              className="panel-groups-toggle"
              title="Clear selection, show every box, and fit the image"
              onClick={onReset}
            >
              Reset
            </button>
            <button
              type="button"
              className="panel-groups-toggle"
              onClick={toggleAllGroups}
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          </>
        ) : null}
      </div>
      {visibleGroups.length > 0 ? (
        <div className="annotation-groups">
          {visibleGroups.flatMap(({ group, visibleEntries }) => {
            const collapsed = collapsedLabels.has(group.label);
            const rows: JSX.Element[] = [
              <header
                key={`header:${group.label}`}
                className={
                  activeLabel === group.label
                    ? "annotation-group-header is-active"
                    : "annotation-group-header"
                }
                data-group-label={group.label}
                onMouseEnter={() => onHighlightLabel?.(group.label)}
                onMouseLeave={() => onHighlightLabel?.(null)}
              >
                <button
                  type="button"
                  className="annotation-group-toggle"
                  aria-expanded={!collapsed}
                  aria-label={`Toggle ${group.label} boxes`}
                  onClick={() => toggleGroup(group)}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
                <button
                  type="button"
                  className="annotation-group-label"
                  title="Select and highlight this category"
                  onClick={() => activateGroup(group)}
                >
                  {group.label}
                </button>
                <span className="annotation-group-count">
                  {group.entries.length}
                </span>
              </header>,
            ];
            if (!collapsed) {
              for (const { annotation, index } of visibleEntries) {
                rows.push(
                  <div
                    key={annotation.id}
                    className="annotation-group-card"
                    data-group-label={group.label}
                  >
                    <AnnotationCard
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
                  </div>,
                );
              }
            }
            return rows;
          })}
        </div>
      ) : null}
    </div>
  );
}
