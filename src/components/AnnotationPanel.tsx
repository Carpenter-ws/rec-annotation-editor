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
  /** Arm add-box mode so the next drawn box joins this category. */
  onAddToCategory?: (label: string) => void;
  /** Remove every box of one expression (the caller confirms it first). */
  onDeleteCategory?: (label: string) => void;
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
  onAddToCategory,
  onDeleteCategory,
}: AnnotationPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeExpressionId, setActiveExpressionId] = useState<string | null>(
    null,
  );
  // Categories start collapsed: the panel shows the expressions first, and a
  // category reveals its boxes only when it is expanded.
  const [expandedLabels, setExpandedLabels] = useState<ReadonlySet<string>>(
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
    setExpandedLabels((current) => {
      if (current.has(label)) return current;
      const next = new Set(current);
      next.add(label);
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

  // Activation replaces the hover preview, so clicking a category and clicking
  // it again really does show and then hide its boxes. Picking a category also
  // reveals its boxes in the panel.
  const activateGroup = useCallback(
    (group: LabelGroup) => {
      onHighlightLabel?.(null);
      onActivateLabel?.(group.label);
      ensureExpanded(group.label);
    },
    [ensureExpanded, onActivateLabel, onHighlightLabel],
  );

  const toggleGroup = useCallback(
    (group: LabelGroup) => {
      const keepsEditingCard = group.entries.some(
        ({ annotation }) => annotation.id === activeExpressionId,
      );
      setExpandedLabels((current) => {
        const isExpanded = current.has(group.label);
        // Never unmount the card that currently owns the text edit.
        if (isExpanded && keepsEditingCard) return current;
        const next = new Set(current);
        if (isExpanded) next.delete(group.label);
        else next.add(group.label);
        return next;
      });
    },
    [activeExpressionId],
  );

  const allExpanded =
    groups.length > 0 &&
    groups.every(({ label }) => expandedLabels.has(label));
  const toggleAllGroups = useCallback(() => {
    setExpandedLabels(
      allExpanded ? new Set<string>() : new Set(groups.map(({ label }) => label)),
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
  }, [expandedLabels, selectedId]);

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
              title="Clear the selected category, hide every box, and fit the image"
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
            // While searching, matching categories show their cards right away.
            const collapsed =
              normalizedQuery === "" && !expandedLabels.has(group.label);
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
                <button
                  type="button"
                  className="annotation-group-add"
                  aria-label={`Add ${group.label} box`}
                  title={`Draw a new "${group.label}" box on the image`}
                  disabled={bounds === null}
                  onClick={() => onAddToCategory?.(group.label)}
                >
                  Add
                </button>
                {onDeleteCategory ? (
                  <button
                    type="button"
                    className="annotation-group-delete"
                    aria-label={`Delete "${group.label}" boxes`}
                    title={`Delete every "${group.label}" box`}
                    onClick={() => onDeleteCategory(group.label)}
                  >
                    ×
                  </button>
                ) : null}
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
