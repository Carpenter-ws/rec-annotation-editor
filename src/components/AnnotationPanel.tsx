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
  /** Rename every box of one expression; the caller applies it atomically. */
  onRenameCategory?: (label: string, nextLabel: string) => void;
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

/** The REC levels the shipped datasets use; the field stays free-text. */
const LEVEL_OPTIONS_ID = "annotation-level-options";
const LEVEL_OPTIONS = ["L1", "L2", "L3"];

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
  onRenameCategory,
}: AnnotationPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  // Categories start collapsed: the panel shows the expressions first, and a
  // category reveals its boxes only when it is expanded.
  const [expandedLabels, setExpandedLabels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Expression being retyped on its header; `null` while nothing is edited. */
  const [renameDraft, setRenameDraft] = useState<{
    from: string;
    value: string;
  } | null>(null);
  /** Level being retyped on a header, committed for the whole category. */
  const [levelDraft, setLevelDraft] = useState<{
    from: string;
    value: string;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrolledForIdRef = useRef<string | null>(null);
  /** Committed exactly once, even when Enter is followed by a blur. */
  const draftRef = useRef<{ from: string; value: string } | null>(null);
  const levelDraftRef = useRef<{ from: string; value: string } | null>(null);

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

  // Boxes are grouped by their exact text label. A header that is being retyped
  // keeps its original label until the edit commits, so the input never
  // remounts under the cursor and equal labels never merge mid-typing.
  const groups = useMemo<LabelGroup[]>(() => {
    const map = new Map<string, LabelGroup>();
    for (const entry of annotationEntries) {
      const label = entry.annotation.label;
      let group = map.get(label);
      if (!group) {
        group = {
          label,
          entries: [],
          labelMatches: label.toLocaleLowerCase().includes(normalizedQuery),
        };
        map.set(label, group);
      }
      group.entries.push(entry);
    }
    return [...map.values()];
  }, [annotationEntries, normalizedQuery]);

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          group,
          visibleEntries: group.entries.filter(({ matches }) => matches),
        }))
        .filter(({ group, visibleEntries }) =>
          normalizedQuery
            ? group.labelMatches || visibleEntries.length > 0
            : true,
        ),
    [groups, normalizedQuery],
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

  // Retyping the expression of a category renames all of its boxes at once.
  // The draft is local: nothing is dispatched until it is committed, so the
  // header cannot remount or merge with an equal label under the cursor.
  const beginRename = useCallback((label: string) => {
    draftRef.current = { from: label, value: label };
    setRenameDraft(draftRef.current);
  }, []);

  // Enter commits and then blurs, so the draft is tracked in a ref: the commit
  // runs exactly once no matter how React batches the state updates.
  const dropRenameDraft = useCallback(() => {
    draftRef.current = null;
    setRenameDraft(null);
  }, []);

  /** Grows the editor to the wrapped height of the expression being retyped. */
  const sizeExpressionEditor = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element || element.scrollHeight <= 0) return;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    },
    [],
  );

  const commitRename = useCallback(() => {
    const draft = draftRef.current;
    dropRenameDraft();
    if (!draft) return;
    const nextLabel = draft.value.trim();
    if (nextLabel === "" || nextLabel === draft.from) return;
    // Keep the category unfolded under its new name.
    setExpandedLabels((current) => {
      if (!current.has(draft.from)) return current;
      const next = new Set(current);
      next.delete(draft.from);
      next.add(nextLabel);
      return next;
    });
    onRenameCategory?.(draft.from, nextLabel);
  }, [dropRenameDraft, onRenameCategory]);

  // The level belongs to the expression too: it is edited on the header and
  // written to every box of that category in one step.
  const dropLevelDraft = useCallback(() => {
    levelDraftRef.current = null;
    setLevelDraft(null);
  }, []);

  const commitLevel = useCallback(() => {
    const draft = levelDraftRef.current;
    dropLevelDraft();
    if (!draft) return;
    const level = draft.value.trim();
    dispatch({
      type: "SET_LABEL_LEVEL",
      label: draft.from,
      level: level === "" ? null : level,
    });
  }, [dispatch, dropLevelDraft]);

  // Activation replaces the hover preview, so clicking a category and clicking
  // it again really does show and then hide its boxes. It deliberately leaves
  // the panel folded: unfolding belongs to the arrow left of the expression.
  const activateGroup = useCallback(
    (group: LabelGroup) => {
      onHighlightLabel?.(null);
      onActivateLabel?.(group.label);
    },
    [onActivateLabel, onHighlightLabel],
  );

  // Folding only affects the box cards: the header (and its expression editor)
  // stays mounted, so an unfolding/collapsing click never interrupts a rename.
  const toggleGroup = useCallback((group: LabelGroup) => {
    setExpandedLabels((current) => {
      const next = new Set(current);
      if (next.has(group.label)) next.delete(group.label);
      else next.add(group.label);
      return next;
    });
  }, []);

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
        <datalist id={LEVEL_OPTIONS_ID}>
          {LEVEL_OPTIONS.map((level) => (
            <option key={level} value={level} />
          ))}
        </datalist>
      ) : null}
      {visibleGroups.length > 0 ? (
        <div className="annotation-groups">
          {visibleGroups.flatMap(({ group, visibleEntries }) => {
            // While searching, matching categories show their cards right away.
            const collapsed =
              normalizedQuery === "" && !expandedLabels.has(group.label);
            const levelValue =
              levelDraft?.from === group.label
                ? levelDraft.value
                : group.entries[0]?.annotation.level ?? "";
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
                {renameDraft?.from === group.label ? (
                  <textarea
                    autoFocus
                    rows={1}
                    ref={sizeExpressionEditor}
                    className="annotation-group-expression"
                    data-panel-draft="expression"
                    aria-label="Expression"
                    title="Renames every box of this expression"
                    value={renameDraft.value}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => {
                      sizeExpressionEditor(event.currentTarget);
                      draftRef.current = {
                        from: group.label,
                        value: event.currentTarget.value,
                      };
                      setRenameDraft(draftRef.current);
                    }}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        dropRenameDraft();
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key !== "Enter" || event.shiftKey) return;
                      event.preventDefault();
                      commitRename();
                      event.currentTarget.blur();
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="annotation-group-label"
                    aria-pressed={activeLabel === group.label}
                    title="Select and highlight this category (use its Edit control to retype the expression)"
                    onClick={() => activateGroup(group)}
                  >
                    {group.label}
                  </button>
                )}
                <span className="annotation-group-count">
                  {group.entries.length}
                </span>
                <input
                  type="text"
                  list={LEVEL_OPTIONS_ID}
                  className="annotation-group-level"
                  data-panel-draft="level"
                  aria-label={`Level for "${group.label}"`}
                  title={
                    levelValue
                      ? `REC level of every "${group.label}" box`
                      : `This label file has no level for "${group.label}"; type L1, L2 or L3 to add one`
                  }
                  placeholder="L?"
                  value={levelValue}
                  onChange={(event) => {
                    levelDraftRef.current = {
                      from: group.label,
                      value: event.currentTarget.value,
                    };
                    setLevelDraft(levelDraftRef.current);
                  }}
                  onBlur={commitLevel}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      dropLevelDraft();
                      event.currentTarget.blur();
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    commitLevel();
                    event.currentTarget.blur();
                  }}
                />
                {onRenameCategory && renameDraft?.from !== group.label ? (
                  <button
                    type="button"
                    className="annotation-group-edit"
                    aria-label={`Edit "${group.label}" expression`}
                    title={`Retype the expression of every "${group.label}" box`}
                    onClick={() => beginRename(group.label)}
                  >
                    Edit
                  </button>
                ) : null}
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
