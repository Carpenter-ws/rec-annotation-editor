import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
} from "react";
import {
  downloadText,
  isFileSystemAccessBlockedError,
  loadImageFile,
  partitionDroppedFiles,
  pickTextFile,
  readTextFile,
  saveTextAs,
  writeTextToHandle,
} from "./app/fileIO";
import { SaveQueue } from "./app/saveQueue";
import { ReviewBeforeNavigateDialog } from "./components/ReviewBeforeNavigateDialog";
import { ImageWindow } from "./app/imageWindow";
import { usePageHistory } from "./app/usePageHistory";
import { useMediaQuery } from "./app/useMediaQuery";
import { nextReferenceId, parseReferenceBoxes } from "./domain/reference";
import {
  REVIEW_LABELS,
  nextItemAfterReview,
  reviewStatusOf,
  type ReviewStatus,
} from "./domain/review";
import {
  listDatasets,
  datasetImageUrl,
  datasetLabelsUrl,
  datasetOriginalsUrl,
  saveDatasetLabels,
  saveDatasetReview,
  type DatasetItem,
} from "./app/datasetApi";
import {
  isEditableTarget,
  useKeyboardShortcuts,
} from "./app/useKeyboardShortcuts";
import { useUnsavedWarning } from "./app/useUnsavedWarning";
import { EditorErrorBoundary } from "./components/EditorErrorBoundary";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DatasetDialog } from "./components/DatasetDialog";
import { DatasetHome } from "./components/DatasetHome";
import { ErrorDialog, type ErrorDialogIssue } from "./components/ErrorDialog";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { NewAnnotationDialog } from "./components/NewAnnotationDialog";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { Viewport, type ViewportHandle } from "./components/Viewport";
import { clampBBox } from "./domain/bbox";
import {
  isJsonlLabelFile,
  parseJsonlAnnotations,
  scaleAnnotationsToPixels,
  serializeAnnotationsJsonl,
} from "./domain/jsonl";
import { parseAnnotationText } from "./domain/parser";
import {
  serializeAnnotationsTxt,
  serializeDocumentJson,
} from "./domain/serializer";
import type {
  Annotation,
  BBox,
  ImageBounds,
  ImageInfo,
  ReferenceBox,
} from "./domain/types";
import { visibleCanvasAnnotations } from "./domain/visibility";
import {
  EditorProvider,
  useEditorDispatch,
  useEditorState,
} from "./state/EditorContext";

interface ImportFiles {
  image?: File;
  labels?: File;
  /** Notice to surface after a successful import (e.g. fallback explanations). */
  notice?: string;
}

const PICKER_BLOCKED_NOTICE =
  "Direct file access is blocked in this context — use the classic file dialog.";

/** A review decision is retried a couple of times before it is called lost. */
const REVIEW_PROMPT_KEY = "rec-annotation-editor:skip-pending-review";
const REVIEW_WRITE_ATTEMPTS = 3;
const REVIEW_WRITE_RETRY_MS = 500;

interface ErrorReport {
  title: string;
  issues: readonly ErrorDialogIssue[];
}

/**
 * Commits a half-typed draft before a global action takes over: a box coordinate
 * inside a card, or an expression/level on a category header. Returns whether
 * anything was blurred, so callers can run their action after the commit.
 */
function blurPendingDraft(): boolean {
  const activeElement = document.activeElement;
  if (
    !isEditableTarget(activeElement) ||
    !(activeElement instanceof HTMLElement)
  ) {
    return false;
  }
  if (
    activeElement.closest("[data-annotation-id]") === null &&
    !activeElement.hasAttribute("data-panel-draft")
  ) {
    return false;
  }
  activeElement.blur();
  return true;
}

interface ClampedAnnotations {
  annotations: Annotation[];
  count: number;
  invalid: Annotation | null;
}

/** The dataset item currently open in the editor, plus its siblings. */
interface DatasetView {
  dataset: string;
  stem: string;
  labelsFile: string;
  items: readonly DatasetItem[];
  /** Review state of this image, kept with it while it stays open. */
  review: ReviewStatus;
}

interface DatasetNavigation {
  position: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
}

function sameBBox(a: Annotation["bbox"], b: Annotation["bbox"]): boolean {
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}

function sameAnnotations(a: readonly Annotation[], b: readonly Annotation[]): boolean {
  return (
    a.length === b.length &&
    a.every((annotation, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        annotation.id === other.id &&
        annotation.label === other.label &&
        annotation.reservedField === other.reservedField &&
        sameBBox(annotation.bbox, other.bbox)
      );
    })
  );
}

function clampAnnotations(
  annotations: readonly Annotation[],
  bounds: ImageBounds,
): ClampedAnnotations {
  const candidate: Annotation[] = [];
  let count = 0;

  for (const annotation of annotations) {
    const bbox = clampBBox(annotation.bbox, bounds);
    if (bbox.x2 <= bbox.x1 || bbox.y2 <= bbox.y1) {
      return { annotations: [], count: 0, invalid: annotation };
    }
    const unchanged = sameBBox(bbox, annotation.bbox);
    if (!unchanged) count += 1;
    candidate.push(unchanged ? annotation : { ...annotation, bbox });
  }

  return { annotations: candidate, count, invalid: null };
}

function clampNotice(count: number): string | null {
  if (count === 0) return null;
  return `Clamped ${count} bounding ${count === 1 ? "box" : "boxes"} to the image bounds.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The file could not be imported.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function nextAnnotationId(nextAnnotationNumber: number): string {
  return `ann_${String(nextAnnotationNumber).padStart(3, "0")}`;
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

/**
 * Items the canvas can show. An image is enough — labels are optional, so an
 * image without labels is still reachable from the dataset and from the
 * previous/next navigation.
 */
function openableDatasetItems(items: readonly DatasetItem[]): DatasetItem[] {
  return items.filter((item) => item.image !== null);
}

/** A new label file follows the convention the dataset already uses. */
function preferredLabelExtension(items: readonly DatasetItem[]): string {
  return items.some((item) => item.labels?.toLowerCase().endsWith(".jsonl"))
    ? ".jsonl"
    : ".txt";
}

function editedTxtName(labelFileName: string | null, imageName: string | null) {
  const stem = fileStem(labelFileName ?? imageName ?? "annotations");
  const extension =
    labelFileName && /\.(?:txt|jsonl)$/i.test(labelFileName)
      ? (labelFileName.match(/\.[^.]+$/)?.[0] ?? ".txt")
      : ".txt";
  return `${stem}-edited${extension}`;
}

function exportFileName(
  labelFileName: string | null,
  imageName: string | null,
  extension: "txt" | "json" | "jsonl",
) {
  return `${fileStem(labelFileName ?? imageName ?? "annotations")}.${extension}`;
}

function EditorWorkspace(): JSX.Element {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [draftBBox, setDraftBBox] = useState<BBox | null>(null);
  /** Expression the dialog opens with when a box came from an original. */
  const [draftInitialLabel, setDraftInitialLabel] = useState<string | null>(null);
  /** Original the draft box was taken from, kept so the link survives the dialog. */
  const [draftReferenceId, setDraftReferenceId] = useState<string | null>(null);
  const [pendingCoordinateIds, setPendingCoordinateIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [highlightedLabel, setHighlightedLabel] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const draftLabelRef = useRef(draftLabel);
  draftLabelRef.current = draftLabel;
  const [datasetDialogOpen, setDatasetDialogOpen] = useState(false);
  /** Dataset the file manager should expand when it opens. */
  const [managedDataset, setManagedDataset] = useState<string | null>(null);
  /** The editor opens on the dataset home so imports are one click away. */
  const [view, setView] = useState<"home" | "editor">(
    () => window.location.pathname === "/editor" ? "editor" : "home",
  );
  const [loadingItem, setLoadingItem] = useState<string | null>(null);
  const imageWindowRef = useRef(new ImageWindow());
  const itemAbortRef = useRef<AbortController | null>(null);
  const restorePageRef = useRef<(url: URL) => void>(() => {});
  const [homeRefreshToken, setHomeRefreshToken] = useState(0);
  const [datasetView, setDatasetView] = useState<DatasetView | null>(null);
  /** Mirrors `datasetView` for callbacks that must not wait for a render. */
  const datasetViewRef = useRef<DatasetView | null>(null);
  const saveQueueRef = useRef(new SaveQueue());
  const saveRef = useRef<(automatic?: boolean) => Promise<boolean>>(async () => true);
  const flushSaveRef = useRef<() => Promise<boolean>>(async () => true);
  const navigationBusyRef = useRef(false);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [reviewPrompt, setReviewPrompt] = useState<DatasetItem | null>(null);
  const reviewSuppressedRef = useRef(false);
  const [pendingSwitch, setPendingSwitch] = useState<DatasetItem | null>(null);
  /** Expression whose boxes the user asked to delete, awaiting confirmation. */
  const [pendingCategoryDelete, setPendingCategoryDelete] = useState<
    string | null
  >(null);
  /** JSONL labels whose normalized targets still await an image size. */
  const normalizedSourceRef = useRef(false);
  /**
   * Original annotations the annotator picks from. They are deliberately not
   * part of the document: only the picked boxes are saved and exported, and the
   * originals can only be changed while `referenceEditing` is on.
   */
  const [referenceBoxes, setReferenceBoxes] = useState<readonly ReferenceBox[]>(
    [],
  );
  const [referenceEditing, setReferenceEditing] = useState(false);
  /**
   * Originals start hidden for every image. They are a reference for
   * adding boxes, so hiding them is always reversible and adding a box brings
   * them back on its own.
   */
  const [referenceVisible, setReferenceVisible] = useState(false);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(
    null,
  );
  const referenceBoxesRef = useRef<readonly ReferenceBox[]>([]);
  referenceBoxesRef.current = referenceBoxes;
  const selectedReference = useMemo(
    () => referenceBoxes.find((box) => box.id === selectedReferenceId) ?? null,
    [referenceBoxes, selectedReferenceId],
  );
  // Adding a box is when the reference matters most, so drawing one (or arming
  // a category) puts the originals back on screen by itself. Hiding them again
  // stays possible while the add gesture is still on.
  const addingBox = state.mode === "add" || draftBBox !== null;
  useEffect(() => {
    if (!addingBox) return;
    if (referenceBoxesRef.current.length === 0) return;
    setReferenceVisible(true);
  }, [addingBox]);
  const [toast, setToast] = useState<{ key: number; message: string } | null>(
    null,
  );
  const toastTimerRef = useRef<number | null>(null);
  const [labelPickerBlocked, setLabelPickerBlocked] = useState(false);
  const fallbackLabelInputRef = useRef<HTMLInputElement>(null);
  const narrowLayout = useMediaQuery("(max-width: 900px)");
  const panelVisible = !narrowLayout || panelOpen;
  const viewportRef = useRef<ViewportHandle>(null);
  const stateRef = useRef(state);
  const importGenerationRef = useRef(0);
  const dragDepthRef = useRef(0);
  const mountedRef = useRef(true);
  const acceptedImageUrlRef = useRef<string | null>(null);
  const labelHandleRef = useRef<FileSystemFileHandle | null>(null);
  stateRef.current = state;
  const effectiveDirty = state.dirty || pendingCoordinateIds.size > 0;
  const effectiveDirtyRef = useRef(false);
  effectiveDirtyRef.current = effectiveDirty;
  const leaveDirtyRef = useRef(false);
  leaveDirtyRef.current = effectiveDirty || autoSaveStatus === "saving";
  useUnsavedWarning(leaveDirtyRef.current);
  const recordPage = usePageHistory(restorePageRef, leaveDirtyRef);
  const imageBounds = useMemo<ImageBounds | null>(
    () =>
      state.image
        ? { width: state.image.width, height: state.image.height }
        : null,
    [state.image?.height, state.image?.width],
  );
  /** A locate request that must wait until its box is actually on the canvas. */
  const pendingLocateIdRef = useRef<string | null>(null);
  const locateAnnotation = useCallback((id: string) => {
    pendingLocateIdRef.current = id;
    viewportRef.current?.centerAnnotation(id);
  }, []);
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ key: Date.now(), message });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 4000);
  }, []);
  const addAnnotation = useCallback(
    (bbox: BBox, label: string, referenceId: string | null = null) => {
      const id = nextAnnotationId(stateRef.current.nextAnnotationNumber);
      // A new box joins the expression it names, level included.
      const level =
        stateRef.current.annotations.find(
          (annotation) => annotation.label === label,
        )?.level ?? null;
      dispatch({
        type: "ADD_ANNOTATION",
        annotation: { id, bbox, label, level, referenceId, reservedField: "0" },
      });
      dispatch({ type: "SELECT", id });
      // Deliberately no camera movement: the view stays where the user drew.
      showToast(
        referenceId === null
          ? `Added "${label}" (${id}).`
          : `Added "${label}" (${id}) from the originals.`,
      );
    },
    [dispatch, showToast],
  );
  const clearReference = useCallback(() => {
    setReferenceBoxes([]);
    setReferenceEditing(false);
    setReferenceVisible(false);
    setSelectedReferenceId(null);
  }, []);

  const toggleReferenceVisible = useCallback(() => {
    setReferenceVisible((current) => !current);
  }, []);

  const toggleReferenceEditing = useCallback(() => {
    setReferenceEditing((current) => !current);
    setSelectedReferenceId(null);
    setNotice(null);
    // Editing a box that is not on screen makes no sense.
    setReferenceVisible(true);
  }, []);

  /** Turns original-annotation text into the picking pool. */
  const applyReference = useCallback(
    (
      name: string,
      text: string,
      image: { width: number; height: number } | null,
    ) => {
      const parsed = parseReferenceBoxes(text, name, image);
      if (parsed.issues.length > 0) {
        setErrorReport({
          title: "Could not read the original annotations",
          issues: [...parsed.issues],
        });
        return;
      }
      setReferenceBoxes(parsed.boxes);
      setReferenceEditing(false);
      setReferenceVisible(false);
      setSelectedReferenceId(null);
      setNotice(
        `Loaded ${parsed.boxes.length} original ${
          parsed.boxes.length === 1 ? "annotation" : "annotations"
        } from "${name}". Click the ones to add.`,
      );
    },
    [],
  );

  /** Reads an original-annotation file into the picking pool. */
  const loadReference = useCallback(
    async (file: File) => {
      try {
        const text = await readTextFile(file);
        if (!mountedRef.current) return;
        const image = stateRef.current.image;
        applyReference(
          file.name,
          text,
          image ? { width: image.width, height: image.height } : null,
        );
      } catch (error) {
        setErrorReport({
          title: "Could not read the original annotations",
          issues: [errorMessage(error)],
        });
      }
    },
    [applyReference],
  );

  /**
   * A reference only ever feeds the add-box flow. With a category armed the
   * click joins that expression; without one it opens the dialog for a box
   * prefilled with the expression the reference carries. Nothing is added on
   * its own, and outside add mode the layer is inert.
   */
  const pickReference = useCallback(
    (referenceId: string) => {
      if (referenceEditing) return;
      if (stateRef.current.mode !== "add") return;
      const box = referenceBoxesRef.current.find(
        (candidate) => candidate.id === referenceId,
      );
      if (!box) return;

      if (
        stateRef.current.annotations.some(
          (annotation) => annotation.referenceId === referenceId,
        )
      ) {
        showToast("This original is already in the document.");
        return;
      }

      const label = draftLabelRef.current;
      if (label === null) {
        // No expression armed yet: ask for it, keeping the link to the original.
        setDraftInitialLabel(box.label);
        setDraftReferenceId(referenceId);
        setDraftBBox(box.bbox);
        dispatch({ type: "SET_MODE", mode: "select" });
        return;
      }
      addAnnotation(box.bbox, label, referenceId);
    },
    [addAnnotation, dispatch, referenceEditing, showToast],
  );

  const changeReference = useCallback((id: string, bbox: BBox) => {
    setReferenceBoxes((boxes) =>
      boxes.map((box) => (box.id === id ? { ...box, bbox } : box)),
    );
  }, []);

  const renameReference = useCallback((label: string) => {
    setSelectedReferenceId((current) => {
      if (current === null) return current;
      setReferenceBoxes((boxes) =>
        boxes.map((box) => (box.id === current ? { ...box, label } : box)),
      );
      return current;
    });
  }, []);

  const deleteSelectedReference = useCallback(() => {
    setSelectedReferenceId((current) => {
      if (current === null) return current;
      setReferenceBoxes((boxes) => boxes.filter((box) => box.id !== current));
      return null;
    });
  }, []);

  // While a category "Add" is armed, every drawn box joins that category
  // without opening the dialog, so several boxes can be added in a row.
  const handleDraftBox = useCallback(
    (bbox: BBox) => {
      const label = draftLabelRef.current;
      if (label !== null) {
        addAnnotation(bbox, label);
        return;
      }
      setDraftInitialLabel(null);
      setDraftReferenceId(null);
      setDraftBBox(bbox);
    },
    [addAnnotation],
  );
  const handleAddToCategory = useCallback(
    (label: string) => {
      setDraftLabel(label);
      setDraftBBox(null);
      dispatch({ type: "SET_MODE", mode: "add" });
      setNotice(null);
    },
    [dispatch],
  );
  const pendingCategoryCount =
    pendingCategoryDelete === null
      ? 0
      : state.annotations.filter(
          (annotation) => annotation.label === pendingCategoryDelete,
        ).length;
  const confirmCategoryDelete = useCallback(() => {
    const label = pendingCategoryDelete;
    setPendingCategoryDelete(null);
    if (label === null) return;
    dispatch({ type: "DELETE_LABEL", label });
    // Isolation and hover must not outlive the category they point at.
    setActiveLabel((current) => (current === label ? null : current));
    setHighlightedLabel((current) => (current === label ? null : current));
  }, [dispatch, pendingCategoryDelete]);

  const handleRenameCategory = useCallback(
    (label: string, nextLabel: string) => {
      dispatch({ type: "RENAME_LABEL", label, nextLabel });
      // Isolation and hover follow the category they point at.
      setActiveLabel((current) => (current === label ? nextLabel : current));
      setHighlightedLabel((current) =>
        current === label ? nextLabel : current,
      );
    },
    [dispatch],
  );

  const handleActivateLabel = useCallback(
    (label: string) => {
      setActiveLabel((current) => {
        const nextActive = current === label ? null : label;
        if (nextActive) {
          const selected = stateRef.current.selectedId;
          if (selected) {
            const selectedAnnotation = stateRef.current.annotations.find(
              (candidate) => candidate.id === selected,
            );
            if (selectedAnnotation && selectedAnnotation.label !== nextActive) {
              dispatch({ type: "SELECT", id: null });
            }
          }
        }
        return nextActive;
      });
    },
    [dispatch],
  );
  const handleResetView = useCallback(() => {
    setActiveLabel(null);
    setHighlightedLabel(null);
    if (stateRef.current.selectedId) {
      dispatch({ type: "SELECT", id: null });
    }
    viewportRef.current?.fit();
  }, [dispatch]);
  const openDatasetItem = useCallback(
    async (
      datasetName: string,
      item: DatasetItem,
      siblings: readonly DatasetItem[] = [],
      historyMode: "record" | "restore" = "record",
    ) => {
      const labelsFile = item.labels;
      const imageFile = item.image;
      if (!imageFile) {
        setErrorReport({
          title: "Could not open dataset item",
          issues: [
            `"${item.stem}" has no image yet, so there is nothing to annotate. Add its image first.`,
          ],
        });
        return;
      }
      const previousDataset = datasetViewRef.current;
      const previousUrl = previousDataset
        ? `/editor?${new URLSearchParams({ dataset: previousDataset.dataset, image: previousDataset.stem })}`
        : "/editor";
      let committed = false;
      const generation = ++importGenerationRef.current;
      itemAbortRef.current?.abort();
      const controller = new AbortController();
      itemAbortRef.current = controller;
      setView("editor");
      setLoadingItem(item.stem);
      setDatasetDialogOpen(false);
      if (historyMode === "record") {
        recordPage(`/editor?${new URLSearchParams({ dataset: datasetName, image: item.stem })}`,
          window.location.pathname === "/editor" && !!datasetViewRef.current);
      }
      const isCurrent = () =>
        mountedRef.current && importGenerationRef.current === generation;
      try {
        blurPendingDraft();
        setDraftBBox(null);
        setHighlightedLabel(null);
        setActiveLabel(null);
        setDraftLabel(null);
        dispatch({ type: "SET_MODE", mode: "select" });
        setErrorReport(null);
        setNotice(null);

        const ready = openableDatasetItems(siblings.length ? siblings : [item]);
        const imagePromise = imageWindowRef.current.focus(
          ready.map(entry => ({ url: datasetImageUrl(datasetName, entry.image!), name: entry.image! })),
          ready.findIndex(entry => entry.stem === item.stem),
        );
        const originalsPromise = item.originals
          ? fetch(datasetOriginalsUrl(datasetName, item.originals), { signal: controller.signal })
              .then(response => response.ok ? response.text() : null).catch(() => null)
          : Promise.resolve(null);
        let annotations: Annotation[] = [];
        if (labelsFile) {
          const labelsResponse = await fetch(
            datasetLabelsUrl(datasetName, labelsFile),
            { signal: controller.signal },
          );
          if (!labelsResponse.ok) {
            throw new Error(
              `Could not load labels for "${item.stem}" (${labelsResponse.status}).`,
            );
          }
          const text = await labelsResponse.text();
          if (!isCurrent()) return;

          const parsed = isJsonlLabelFile(labelsFile)
            ? parseJsonlAnnotations(text)
            : parseAnnotationText(text);
          if (parsed.issues.length > 0) {
            setErrorReport({
              title: "Could not open dataset item",
              issues: [...parsed.issues],
            });
            return;
          }
          annotations = parsed.annotations;
        }

        const image = await imagePromise;
        if (!isCurrent()) return;

        // Dataset JSONL files store normalized [0, 1000] targets.
        const scaled =
          labelsFile && isJsonlLabelFile(labelsFile)
            ? scaleAnnotationsToPixels(annotations, {
                width: image.width,
                height: image.height,
              })
            : annotations;
        normalizedSourceRef.current = false;
        // The picking pool belongs to the item that was open.
        clearReference();

        const originalsText = await originalsPromise;
        if (!isCurrent()) return;
        if (item.originals && originalsText !== null) {
          applyReference(item.originals, originalsText, { width: image.width, height: image.height });
        }

        // Without labels the item opens as an empty document; saving creates
        // the matching label file next to the image.
        const labelFileName =
          labelsFile ?? `${item.stem}${preferredLabelExtension(siblings)}`;
        const datasetViewValue: DatasetView = {
          dataset: datasetName,
          stem: item.stem,
          labelsFile: labelFileName,
          items: siblings.length > 0 ? siblings : [item],
          review: reviewStatusOf(item),
        };
        labelHandleRef.current = null;
        const localImageUrl = acceptedImageUrlRef.current;
        acceptedImageUrlRef.current = null;
        if (localImageUrl) URL.revokeObjectURL(localImageUrl);
        datasetViewRef.current = datasetViewValue;
        setDatasetView(datasetViewValue);
        setView("editor");
        dispatch({
          type: "COMMIT_IMPORT",
          image,
          annotationBaseline: {
            annotations: scaled,
            fileName: labelFileName,
          },
        });
        if (!labelsFile) {
          setNotice(
            `No label file yet for "${item.stem}" — draw boxes and Save to create one.`,
          );
        }
        committed = true;
        imageWindowRef.current.prefetch();
      } catch (error) {
        if (!isCurrent()) return;
        setErrorReport({
          title: "Could not open dataset item",
          issues: [errorMessage(error)],
        });
      } finally {
        if (isCurrent()) {
          setLoadingItem(null);
          if (!committed) {
            controller.abort();
            imageWindowRef.current.clear();
            if (previousDataset || stateRef.current.image) recordPage(previousUrl, true);
          }
        }
      }
    },
    [dispatch, recordPage],
  );
  const goHome = async () => {
    // Once saving has finished, Home may cancel a slow image request.
    if (loadingItem !== null) {
      recordPage("/");
      restorePageRef.current(new URL(window.location.href));
      return;
    }
    if (navigationBusyRef.current) return;
    const generation = importGenerationRef.current;
    navigationBusyRef.current = true;
    setNavigationBusy(true);
    try {
      const writable = datasetViewRef.current || labelHandleRef.current;
      if (writable && !(await flushSaveRef.current())) return;
      if (importGenerationRef.current !== generation) return;
      if (!writable && effectiveDirtyRef.current && !window.confirm("Discard unsaved changes and leave this page?")) return;
      recordPage("/");
      restorePageRef.current(new URL(window.location.href));
    } finally {
      navigationBusyRef.current = false;
      setNavigationBusy(false);
    }
  };
  restorePageRef.current = (url) => {
    const generation = ++importGenerationRef.current;
    itemAbortRef.current?.abort();
    imageWindowRef.current.clear();
    setLoadingItem(null);
    setDatasetDialogOpen(false);
    setErrorReport(null);
    setPendingSwitch(null);
    setReviewPrompt(null);
    setAutoSaveStatus("idle");
    // A page transition discards the prior document only after the leave guard.
    labelHandleRef.current = null;
    normalizedSourceRef.current = false;
    const localImageUrl = acceptedImageUrlRef.current;
    acceptedImageUrlRef.current = null;
    if (localImageUrl) URL.revokeObjectURL(localImageUrl);
    setDraftBBox(null);
    setDraftLabel(null);
    setActiveLabel(null);
    setHighlightedLabel(null);
    setNotice(null);
    setPendingCoordinateIds(new Set());
    datasetViewRef.current = null;
    setDatasetView(null);
    if (stateRef.current.image || stateRef.current.labelFileName || stateRef.current.annotations.length) {
      dispatch({ type: "SET_IMAGE", image: null });
      dispatch({ type: "LOAD_ANNOTATIONS", annotations: [], fileName: null });
    }
    clearReference();
    if (url.pathname !== "/editor") {
      reviewSuppressedRef.current = false;
      try { sessionStorage.removeItem(REVIEW_PROMPT_KEY); } catch {}
      setView("home");
      if (view !== "home") setHomeRefreshToken(token => token + 1);
      return;
    }
    setView("editor");
    const dataset = url.searchParams.get("dataset");
    const stem = url.searchParams.get("image");
    if (!dataset || !stem) return;
    setLoadingItem(stem);
    void listDatasets().then(datasets => {
      if (!mountedRef.current || importGenerationRef.current !== generation) return;
      const items = datasets.find(entry => entry.name === dataset)?.items ?? [];
      const item = items.find(entry => entry.stem === stem);
      if (!item?.image) throw new Error("This dataset image no longer exists.");
      void openDatasetItem(dataset, item, items, "restore");
    }).catch(error => {
      if (!mountedRef.current || importGenerationRef.current !== generation) return;
      setLoadingItem(null);
      setErrorReport({ title: "Could not open dataset item", issues: [errorMessage(error)] });
    });
  };
  const handleCoordinateDraftChange = useCallback(
    (id: string, pending: boolean) => {
      setPendingCoordinateIds((current) => {
        if (pending ? current.has(id) : !current.has(id)) return current;
        const next = new Set(current);
        if (pending) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      itemAbortRef.current?.abort();
      imageWindowRef.current.clear();
      importGenerationRef.current += 1;
      const acceptedUrl = acceptedImageUrlRef.current;
      acceptedImageUrlRef.current = null;
      if (acceptedUrl) URL.revokeObjectURL(acceptedUrl);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const annotationIds = new Set(
      state.annotations.map((annotation) => annotation.id),
    );
    setPendingCoordinateIds((current) => {
      if ([...current].every((id) => annotationIds.has(id))) return current;
      return new Set([...current].filter((id) => annotationIds.has(id)));
    });
  }, [state.annotations]);

  const importFiles = async (
    files: ImportFiles,
    rejected: readonly File[] = [],
    labelHandle: FileSystemFileHandle | null = null,
    requestedGeneration?: number,
  ): Promise<void> => {
    if (files.image || files.labels) {
      setView("editor");
      blurPendingDraft();
      // The picking pool belongs to the document that was open.
      clearReference();
      setDraftBBox(null);
      setHighlightedLabel(null);
      setActiveLabel(null);
      setDraftLabel(null);
      dispatch({ type: "SET_MODE", mode: "select" });
    }
    const generation = requestedGeneration ?? ++importGenerationRef.current;
    const isCurrent = () =>
      mountedRef.current && importGenerationRef.current === generation;
    setErrorReport(null);
    setNotice(null);

    const rejectedIssues = rejected.map(
      (file) => `Rejected "${file.name}": unsupported or extra file.`,
    );
    let importedAnnotations: Annotation[] | undefined;
    let labelsNormalized = false;

    if (files.labels) {
      let text: string;
      try {
        text = await readTextFile(files.labels);
      } catch (error) {
        if (!isCurrent()) return;
        setErrorReport({
          title: "Could not import labels",
          issues: [errorMessage(error), ...rejectedIssues],
        });
        return;
      }

      if (!isCurrent()) return;

      // JSONL targets live on a normalized [0, 1000] grid; they are scaled to
      // pixels below, once the image size of this import is known.
      labelsNormalized = isJsonlLabelFile(files.labels.name);
      const parsed = labelsNormalized
        ? parseJsonlAnnotations(text)
        : parseAnnotationText(text);
      if (parsed.issues.length > 0) {
        setErrorReport({
          title: "Could not import labels",
          issues: [...parsed.issues, ...rejectedIssues],
        });
        return;
      }

      importedAnnotations = parsed.annotations;
    }

    let loadedImage: ImageInfo | null = null;

    if (files.image) {
      try {
        loadedImage = await loadImageFile(files.image);
      } catch (error) {
        if (!isCurrent()) return;
        setErrorReport({
          title: "Could not import image",
          issues: [errorMessage(error), ...rejectedIssues],
        });
        return;
      }
    }

    if (!isCurrent()) {
      if (loadedImage) URL.revokeObjectURL(loadedImage.url);
      return;
    }

    const latestState = stateRef.current;
    let annotations = importedAnnotations ?? latestState.annotations;
    const labelFileName = files.labels?.name ?? latestState.labelFileName;
    const image = loadedImage ?? latestState.image;

    if (labelsNormalized && image) {
      annotations = scaleAnnotationsToPixels(annotations, {
        width: image.width,
        height: image.height,
      });
      normalizedSourceRef.current = false;
    } else if (labelsNormalized) {
      // No image yet: keep the normalized grid and scale it when one arrives.
      normalizedSourceRef.current = true;
    } else if (importedAnnotations) {
      normalizedSourceRef.current = false;
    } else if (loadedImage && normalizedSourceRef.current) {
      annotations = scaleAnnotationsToPixels(annotations, {
        width: loadedImage.width,
        height: loadedImage.height,
      });
      normalizedSourceRef.current = false;
    }

    let clamped: ClampedAnnotations = {
      annotations: [...annotations],
      count: 0,
      invalid: null,
    };
    if (image) {
      clamped = clampAnnotations(annotations, {
        width: image.width,
        height: image.height,
      });
    }

    if (clamped.invalid) {
      if (loadedImage) URL.revokeObjectURL(loadedImage.url);
      setErrorReport({
        title: files.image ? "Could not import image" : "Could not import labels",
        issues: [
          `The bounding box for "${clamped.invalid.label}" is outside the image bounds.`,
          ...rejectedIssues,
        ],
      });
      return;
    }

    if (files.labels) labelHandleRef.current = labelHandle;
    if (files.labels || loadedImage) {
      datasetViewRef.current = null;
      setDatasetView(null);
      itemAbortRef.current?.abort();
      imageWindowRef.current.clear();
      recordPage("/editor", true);
    }

    if (loadedImage) {
      const previousUrl = acceptedImageUrlRef.current;
      acceptedImageUrlRef.current = loadedImage.url;
      if (previousUrl && previousUrl !== loadedImage.url) {
        URL.revokeObjectURL(previousUrl);
      }
    }

    const annotationsChanged = !sameAnnotations(
      clamped.annotations,
      latestState.annotations,
    );
    const annotationBaseline =
      files.labels || annotationsChanged
        ? { annotations: clamped.annotations, fileName: labelFileName }
        : undefined;
    if (loadedImage || annotationBaseline) {
      dispatch({
        type: "COMMIT_IMPORT",
        ...(loadedImage ? { image: loadedImage } : {}),
        ...(annotationBaseline ? { annotationBaseline } : {}),
      });
    }

    setNotice(clampNotice(clamped.count) ?? files.notice ?? null);
    if (rejectedIssues.length > 0) {
      setErrorReport({
        title: "Some dropped files were rejected",
        issues: rejectedIssues,
      });
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const dropped = partitionDroppedFiles(Array.from(event.dataTransfer.files));
    // The originals are read after the import, so a JSONL original is scaled
    // against the image that just arrived.
    void importFiles(
      { image: dropped.image, labels: dropped.labels },
      dropped.rejected,
    ).then(() => {
      if (dropped.reference) void loadReference(dropped.reference);
    });
  };

  const addDraftAnnotation = (label: string) => {
    const referenceId = draftReferenceId;
    setDraftInitialLabel(null);
    setDraftReferenceId(null);
    if (!draftBBox) return;
    if (referenceEditing) {
      // While the originals are being edited, a drawn box joins them.
      setReferenceBoxes((boxes) => [
        ...boxes,
        { id: nextReferenceId(boxes), bbox: draftBBox, label },
      ]);
      setNotice(`Added an original annotation "${label}".`);
    } else {
      addAnnotation(draftBBox, label, referenceId);
    }
    dispatch({ type: "SET_MODE", mode: "select" });
    setDraftBBox(null);
  };

  const cancelDraftAnnotation = () => {
    setDraftBBox(null);
    setDraftInitialLabel(null);
    dispatch({ type: "SET_MODE", mode: "select" });
  };

  const pickLabels = async () => {
    const generation = ++importGenerationRef.current;
    try {
      const picked = await pickTextFile();
      if (
        !picked ||
        !mountedRef.current ||
        importGenerationRef.current !== generation
      ) {
        return;
      }
      await importFiles({ labels: picked.file }, [], picked.handle, generation);
    } catch (error) {
      if (
        !mountedRef.current ||
        importGenerationRef.current !== generation
      ) {
        return;
      }
      if (isFileSystemAccessBlockedError(error)) {
        setLabelPickerBlocked(true);
        setNotice(PICKER_BLOCKED_NOTICE);
        fallbackLabelInputRef.current?.click();
        return;
      }
      setErrorReport({
        title: "Could not open labels",
        issues: [errorMessage(error)],
      });
    }
  };

  // Boxes only reach the canvas for a picked category, a hovered category, or
  // the selected box — a fresh document starts with a clean image. A box copied
  // from an original follows the same rule as any other box: the link to its
  // reference is bookkeeping, never a reason to stay on the canvas.
  const visibleAnnotations = useMemo(
    () =>
      visibleCanvasAnnotations(state.annotations, {
        activeLabel,
        highlightedLabel,
        selectedId: state.selectedId,
      }),
    [state.annotations, activeLabel, highlightedLabel, state.selectedId],
  );
  useEffect(() => {
    const id = pendingLocateIdRef.current;
    if (id === null) return;
    // Locating a box that the canvas has not drawn yet (no category picked,
    // selection not applied) is retried once it becomes visible.
    if (!visibleAnnotations.some((annotation) => annotation.id === id)) return;
    pendingLocateIdRef.current = null;
    viewportRef.current?.centerAnnotation(id);
  }, [visibleAnnotations]);
  const readyDatasetItems = useMemo(
    () => openableDatasetItems(datasetView?.items ?? []),
    [datasetView],
  );
  const datasetNavigation = useMemo<DatasetNavigation | null>(() => {
    if (!datasetView) return null;
    const index = readyDatasetItems.findIndex(
      (item) => item.stem === datasetView.stem,
    );
    if (index < 0) return null;
    return {
      position: index + 1,
      total: readyDatasetItems.length,
      canGoPrevious: index > 0,
      canGoNext: index < readyDatasetItems.length - 1,
    };
  }, [datasetView, readyDatasetItems]);
  const switchToDatasetItem = useCallback(
    (target: DatasetItem) => {
      const view = datasetViewRef.current;
      if (!view) return;
      setPendingSwitch(null);
      void openDatasetItem(view.dataset, target, view.items);
    },
    [openDatasetItem],
  );
  /** Moves to another item of the same dataset, unless that would drop edits. */
  const openItemWithGuard = useCallback(
    async (target: DatasetItem) => {
      const view = datasetViewRef.current;
      if (!view || navigationBusyRef.current) return;
      navigationBusyRef.current = true;
      setNavigationBusy(true);
      try {
        if (!(await flushSaveRef.current())) return;
        if (datasetViewRef.current?.stem !== view.stem || datasetViewRef.current?.dataset !== view.dataset) return;
        setPendingSwitch(null);
        await openDatasetItem(view.dataset, target, datasetViewRef.current.items);
      } finally {
        navigationBusyRef.current = false;
        setNavigationBusy(false);
      }
    },
    [openDatasetItem],
  );

  /**
   * Writes a review decision from behind the editor. A dev server that
   * restarts under the page fails for a moment, so the write is retried a
   * couple of times first. Only when it keeps failing is the decision given
   * up on: that image goes back to the state the server still has and the
   * reason is shown — a choice that never reached the disk must not look
   * saved, whichever image the editor has moved on to meanwhile.
   */
  const persistReview = useCallback(
    async (write: {
      dataset: string;
      stem: string;
      status: ReviewStatus;
      previous: ReviewStatus;
    }): Promise<boolean> => {
      for (let attempt = 1; attempt <= REVIEW_WRITE_ATTEMPTS; attempt += 1) {
        try {
          await saveDatasetReview(write.dataset, write.stem, write.status);
          return true;
        } catch (error) {
          if (attempt < REVIEW_WRITE_ATTEMPTS) {
            await new Promise((resolve) => {
              setTimeout(resolve, REVIEW_WRITE_RETRY_MS * attempt);
            });
            continue;
          }
          const current = datasetViewRef.current;
          if (current) {
            // Roll back that one decision: a newer choice on the same image,
            // or anything done meanwhile, is left alone.
            const items = current.items.map((item) =>
              item.stem === write.stem && item.review === write.status
                ? { ...item, review: write.previous }
                : item,
            );
            const rolled =
              current.stem === write.stem && current.review === write.status
                ? { ...current, review: write.previous, items }
                : { ...current, items };
            datasetViewRef.current = rolled;
            setDatasetView(rolled);
          }
          setNotice(
            `Could not save the review status for "${write.stem}" (${errorMessage(
              error,
            )}). It is still ${REVIEW_LABELS[write.previous]}.`,
          );
        }
      }
      return false;
    },
    [],
  );

  /**
   * Records the review decision of the open image: the toolbar flips at once
   * and the write happens behind it. A failure rolls the choice back and says
   * why, so a decision is never lost silently. Deciding is the end of an
   * image's turn, so the editor moves on to the next one still waiting for
   * review; "待审核" is not a decision and stays where it is.
   */
  const handleReviewChange = useCallback(
    (status: ReviewStatus) => {
      const view = datasetViewRef.current;
      if (!view || view.review === status) return;
      // Keep the local list truthful, the next decision walks from it.
      const items = view.items.map((item) =>
        item.stem === view.stem ? { ...item, review: status } : item,
      );
      const decided = { ...view, review: status, items };
      datasetViewRef.current = decided;
      setDatasetView(decided);
      void persistReview({
        dataset: view.dataset,
        stem: view.stem,
        status,
        previous: view.review,
      });
      if (status === "pending") return;
      const target = nextItemAfterReview(items, view.stem);
      if (!target) {
        showToast("No other image is waiting for review.");
        return;
      }
      openItemWithGuard(target);
    },
    [openItemWithGuard, persistReview, showToast],
  );

  const stepDatasetItem = useCallback(
    (direction: -1 | 1) => {
      const view = datasetViewRef.current;
      if (!view) return;
      const ready = openableDatasetItems(view.items);
      const index = ready.findIndex((item) => item.stem === view.stem);
      if (index < 0) return;
      const target = ready[index + direction];
      if (!target || navigationBusyRef.current) return;
      try { reviewSuppressedRef.current = sessionStorage.getItem(REVIEW_PROMPT_KEY) === "1"; } catch {}
      if (view.review === "pending" && !reviewSuppressedRef.current) {
        setReviewPrompt(target);
        return;
      }
      void openItemWithGuard(target);
    },
    [openItemWithGuard],
  );

  const confirmReviewNavigation = async (status: ReviewStatus, suppress: boolean) => {
    const view = datasetViewRef.current;
    const target = reviewPrompt;
    if (!view || !target) return;
    if (!(await flushSaveRef.current())) { setReviewPrompt(null); return; }
    if (status !== view.review) {
      const saved = await persistReview({ dataset: view.dataset, stem: view.stem, status, previous: view.review });
      if (!saved) { setReviewPrompt(null); return; }
      if (datasetViewRef.current !== view) return;
      const updated = { ...view, review: status,
        items: view.items.map(item => item.stem === view.stem ? { ...item, review: status } : item) };
      datasetViewRef.current = updated;
      setDatasetView(updated);
    }
    reviewSuppressedRef.current = suppress;
    try {
      if (suppress) sessionStorage.setItem(REVIEW_PROMPT_KEY, "1");
      else sessionStorage.removeItem(REVIEW_PROMPT_KEY);
    } catch {}
    setReviewPrompt(null);
    await openItemWithGuard(target);
  };

  const save = async (automatic = false): Promise<boolean> => {
    const latestState = stateRef.current;
    const snapshot = latestState.annotations;
    const datasetTarget = datasetViewRef.current;
    const handleTarget = labelHandleRef.current;
    const generation = importGenerationRef.current;
    if (automatic && !datasetTarget && !handleTarget) return false;
    return saveQueueRef.current.run(async () => {
    const isCurrent = () => mountedRef.current && importGenerationRef.current === generation;
    if (isCurrent()) setAutoSaveStatus("saving");
    const fileName = editedTxtName(
      latestState.labelFileName,
      latestState.image?.name ?? null,
    );
    const saveJsonl = isJsonlLabelFile(fileName);
    const jsonlScale = latestState.image
      ? { width: latestState.image.width, height: latestState.image.height }
      : null;
    try {
      const contents = saveJsonl
        ? serializeAnnotationsJsonl(snapshot, jsonlScale)
        : serializeAnnotationsTxt(snapshot);
      if (datasetTarget) {
        const { dataset, labelsFile } = datasetTarget;
        try {
          await saveDatasetLabels(dataset, labelsFile, contents);
          if (isCurrent()) setNotice(`Saved "${labelsFile}" to dataset "${dataset}".`);
        } catch (error) {
          if (isCurrent()) setErrorReport({
            title: "Could not save annotations",
            issues: [errorMessage(error)],
          });
          if (isCurrent()) setAutoSaveStatus("error");
          return false;
        }
      } else if (handleTarget) {
        try {
          await writeTextToHandle(handleTarget, contents);
          if (isCurrent()) setNotice(
            `Saved "${latestState.labelFileName ?? "annotations"}" in place.`,
          );
        } catch (error) {
          if (automatic || !isFileSystemAccessBlockedError(error)) throw error;
          downloadText(
            contents,
            fileName,
            saveJsonl ? "application/x-ndjson" : "text/plain",
          );
          if (isCurrent()) setNotice(
            `Downloaded "${fileName}". Direct file access is blocked in this context.`,
          );
        }
      } else {
        downloadText(
          contents,
          fileName,
          saveJsonl ? "application/x-ndjson" : "text/plain",
        );
        if (isCurrent()) setNotice(
          `Downloaded "${fileName}". This browser cannot write back to the imported file.`,
        );
      }
      if (isCurrent()) dispatch({ type: "MARK_SAVED_SNAPSHOT", annotations: snapshot });
      if (isCurrent()) setAutoSaveStatus("idle");
      return true;
    } catch (error) {
      if (isCurrent()) setAutoSaveStatus("error");
      if (isAbortError(error)) return false;
      if (isCurrent()) setErrorReport({
        title: "Could not save annotations",
        issues: [errorMessage(error)],
      });
      return false;
    }
    });
  };
  saveRef.current = save;
  flushSaveRef.current = async () => {
    const generation = importGenerationRef.current;
    blurPendingDraft();
    while (importGenerationRef.current === generation) {
      await saveQueueRef.current.idle();
      // Let React apply the persisted baseline, including an Undo during a write.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (importGenerationRef.current !== generation) return false;
      if (pendingCoordinateIds.size > 0 || stateRef.current.transactionBase !== null) {
        setNotice("Please finish the current annotation edit before switching images.");
        return false;
      }
      if (!stateRef.current.dirty) return true;
      if (!(await saveRef.current(true))) return false;
    }
    return false;
  };
  useEffect(() => {
    if (!state.dirty || state.transactionBase !== null || pendingCoordinateIds.size > 0 ||
        loadingItem !== null || view !== "editor" || (!datasetView && !labelHandleRef.current)) return;
    const timer = window.setTimeout(() => { void saveRef.current(true); }, 600);
    return () => window.clearTimeout(timer);
  }, [state.annotations, state.dirty, state.savedFingerprint, state.transactionBase, pendingCoordinateIds, datasetView, loadingItem, view]);

  const saveAs = async () => {
    const latestState = stateRef.current;
    const snapshot = latestState.annotations;
    const saveJsonl = isJsonlLabelFile(
      editedTxtName(latestState.labelFileName, latestState.image?.name ?? null),
    );
    const jsonlScale = latestState.image
      ? { width: latestState.image.width, height: latestState.image.height }
      : null;
    try {
      const result = await saveTextAs(
        saveJsonl
          ? serializeAnnotationsJsonl(snapshot, jsonlScale)
          : serializeAnnotationsTxt(snapshot),
        editedTxtName(latestState.labelFileName, latestState.image?.name ?? null),
        saveJsonl ? "application/x-ndjson" : "text/plain",
      );
      if (
        result !== "cancelled" &&
        stateRef.current.annotations === snapshot
      ) {
        dispatch({ type: "MARK_SAVED" });
      }
    } catch (error) {
      if (isAbortError(error)) return;
      setErrorReport({
        title: "Could not save annotations",
        issues: [errorMessage(error)],
      });
    }
  };

  const exportAnnotations = (format: "txt" | "json" | "jsonl") => {
    const latestState = stateRef.current;
    try {
      const contents =
        format === "txt"
          ? serializeAnnotationsTxt(latestState.annotations)
          : format === "jsonl"
            ? serializeAnnotationsJsonl(
                latestState.annotations,
                latestState.image
                  ? {
                      width: latestState.image.width,
                      height: latestState.image.height,
                    }
                  : null,
              )
            : serializeDocumentJson(latestState);
      downloadText(
        contents,
        exportFileName(
          latestState.labelFileName,
          latestState.image?.name ?? null,
          format,
        ),
        format === "txt"
          ? "text/plain"
          : format === "jsonl"
            ? "application/x-ndjson"
            : "application/json",
      );
    } catch (error) {
      setErrorReport({
        title: "Could not export annotations",
        issues: [errorMessage(error)],
      });
    }
  };

  const runAfterEditorBlur = (action: () => void) => {
    if (blurPendingDraft()) {
      window.setTimeout(action, 0);
      return;
    }
    action();
  };

  useKeyboardShortcuts({
    enabled: view === "editor" && loadingItem === null && reviewPrompt === null && !navigationBusy,
    onPreviousItem: () => runAfterEditorBlur(() => stepDatasetItem(-1)),
    onNextItem: () => runAfterEditorBlur(() => stepDatasetItem(1)),
    onUndo: () =>
      runAfterEditorBlur(() => dispatch({ type: "UNDO" })),
    onRedo: () =>
      runAfterEditorBlur(() => dispatch({ type: "REDO" })),
    onSave: () => runAfterEditorBlur(() => void save()),
    onDelete: () => {
      // While the originals are being edited, Delete removes the selected one;
      // the document is never touched by that.
      if (referenceEditing && selectedReferenceId !== null) {
        deleteSelectedReference();
        return;
      }
      const selectedId = stateRef.current.selectedId;
      if (selectedId) {
        dispatch({ type: "DELETE_ANNOTATION", id: selectedId });
      }
    },
    onEscape: () => {
      if (draftBBox === null && stateRef.current.mode === "add") {
        setDraftLabel(null);
        setNotice(null);
        dispatch({ type: "SET_MODE", mode: "select" });
      }
    },
  });

  return (
    <div className="app-shell">
      {view === "home" ? (
        <DatasetHome
          refreshToken={homeRefreshToken}
          onOpenEditor={() => { recordPage("/editor"); setView("editor"); }}
          onOpenItem={(datasetName, item, items) =>
            void openDatasetItem(datasetName, item, items)
          }
          onManage={(datasetName) => {
            setManagedDataset(datasetName);
            setDatasetDialogOpen(true);
          }}
        />
      ) : (
        <>
      {loadingItem !== null && !state.image ? (
        <main className="workspace-empty" aria-busy="true">
          <p role="status">Loading image: {loadingItem}…</p>
          <button type="button" onClick={goHome}>Back to datasets</button>
        </main>
      ) : <>
      {loadingItem !== null ? (
        <div role="status" style={{ position: "fixed", inset: 0, zIndex: 1000,
          display: "grid", placeContent: "center", background: "rgba(20, 24, 30, 0.8)", color: "white" }}>
          <p>Loading image: {loadingItem}…</p>
          <button type="button" onClick={goHome}>Back to datasets</button>
        </div>
      ) : null}
      <div style={{ display: "contents" }} {...(loadingItem !== null || reviewPrompt !== null || navigationBusy ? { inert: "" } : {})}>
      <Toolbar
        onHome={goHome}
        imageName={state.image?.name ?? null}
        labelFileName={state.labelFileName}
        dirty={effectiveDirty}
        autoSaveStatus={autoSaveStatus}
        autoSaveEnabled={datasetView !== null || labelHandleRef.current !== null}
        scale={zoomScale}
        labelPickerBlocked={labelPickerBlocked}
        onOpenImage={(file) => void importFiles({ image: file })}
        onOpenLabels={(file) => void importFiles({ labels: file })}
        onPickLabels={() => void pickLabels()}
        onOpenOriginals={(file) => void loadReference(file)}
        originalsLoaded={referenceBoxes.length > 0}
        originalsVisible={referenceVisible}
        originalsEditing={referenceEditing}
        onToggleOriginalsVisible={toggleReferenceVisible}
        onToggleOriginalsEditing={toggleReferenceEditing}
        selectedOriginal={selectedReference}
        onRenameOriginal={renameReference}
        onDeleteOriginal={deleteSelectedReference}
        onOpenDatasets={() => setDatasetDialogOpen(true)}
        onSave={() => void save()}
        onSaveAs={() => void saveAs()}
        undoDisabled={
          state.past.length === 0 &&
          (state.transactionBase === null ||
            sameAnnotations(state.transactionBase, state.annotations))
        }
        redoDisabled={state.future.length === 0}
        onUndo={() =>
          runAfterEditorBlur(() => dispatch({ type: "UNDO" }))
        }
        onRedo={() =>
          runAfterEditorBlur(() => dispatch({ type: "REDO" }))
        }
        onExportTxt={() => exportAnnotations("txt")}
        onExportJson={() => exportAnnotations("json")}
        onExportJsonl={() => exportAnnotations("jsonl")}
        onZoomOut={() => viewportRef.current?.zoomBy(1 / 1.2)}
        onZoomIn={() => viewportRef.current?.zoomBy(1.2)}
        onFit={() => viewportRef.current?.fit()}
        mode={state.mode}
        addBoxDisabled={state.image === null}
        onAddBox={() => {
          setDraftLabel(null);
          setNotice(null);
          dispatch({ type: "SET_MODE", mode: "add" });
        }}
        panelToggleVisible={narrowLayout}
        panelOpen={panelVisible}
        onTogglePanel={() => setPanelOpen((open) => !open)}
        datasetNavigation={datasetNavigation}
        onPreviousItem={() => stepDatasetItem(-1)}
        onNextItem={() => stepDatasetItem(1)}
        reviewStatus={datasetView?.review ?? null}
        onReviewChange={handleReviewChange}
      />
      <main className="editor-layout">
        <section
          className={dragActive ? "image-workspace is-drag-active" : "image-workspace"}
          aria-label="Image workspace"
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepthRef.current += 1;
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => {
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDragActive(false);
          }}
          onDrop={handleDrop}
        >
          {state.mode === "add" ? (
            <div className="add-mode-banner" data-testid="add-mode-banner">
              {draftLabel
                ? `Draw a rectangle on the image to add a "${draftLabel}" box — press Esc to exit`
                : "Draw a rectangle on the image to add a box — press Esc to exit"}
            </div>
          ) : null}
          {toast ? (
            <div
              key={toast.key}
              className="add-toast"
              aria-live="polite"
              data-testid="add-toast"
            >
              {toast.message}
            </div>
          ) : null}
          {state.image ? (
            <Viewport
              ref={viewportRef}
              image={state.image}
              annotations={visibleAnnotations}
              selectedId={state.selectedId}
              highlightedLabel={highlightedLabel ?? activeLabel}
              dispatch={dispatch}
              onZoomChange={setZoomScale}
              mode={state.mode}
              onDraftBox={handleDraftBox}
              referenceBoxes={referenceBoxes}
              referenceVisible={referenceVisible}
              referenceEditing={referenceEditing}
              selectedReferenceId={selectedReferenceId}
              onReferencePick={pickReference}
              onReferenceSelect={setSelectedReferenceId}
              onReferenceChange={changeReference}
            />
          ) : (
            <div className="workspace-empty">
              <p>
                {dragActive
                  ? "Drop files to import"
                  : "Drop an image and label file here"}
              </p>
              <p className="workspace-examples">
                Or start from the bundled fixtures:{" "}
                <a href="/examples/rec-aerial-scene.svg" download>
                  Example image
                </a>{" "}
                <a href="/examples/rec-aerial-scene.txt" download>
                  Example labels
                </a>
              </p>
            </div>
          )}
        </section>
        <aside
          className="annotation-side"
          aria-label="Annotations"
          aria-hidden={draftBBox !== null ? true : undefined}
          hidden={!panelVisible}
        >
          <AnnotationPanel
            annotations={state.annotations}
            selectedId={state.selectedId}
            bounds={imageBounds}
            dispatch={dispatch}
            onLocate={locateAnnotation}
            onCoordinateDraftChange={handleCoordinateDraftChange}
            onHighlightLabel={setHighlightedLabel}
            activeLabel={activeLabel}
            onActivateLabel={handleActivateLabel}
            onReset={handleResetView}
            onAddToCategory={handleAddToCategory}
            onDeleteCategory={setPendingCategoryDelete}
            onRenameCategory={handleRenameCategory}
          />
        </aside>
      </main>
      {draftBBox ? (
        <NewAnnotationDialog
          initialLabel={draftInitialLabel ?? undefined}
          onAdd={addDraftAnnotation}
          onCancel={cancelDraftAnnotation}
        />
      ) : null}
      <StatusBar
        image={state.image}
        annotationCount={state.annotations.length}
        notice={notice}
        scale={zoomScale}
      />
      </div>
      </>}
        </>
      )}
      {reviewPrompt ? <ReviewBeforeNavigateDialog initialStatus={datasetViewRef.current?.review ?? "pending"} onConfirm={confirmReviewNavigation} onCancel={() => setReviewPrompt(null)} /> : null}
      <ErrorDialog
        title={errorReport?.title ?? "Import error"}
        issues={errorReport?.issues ?? []}
        onClose={() => setErrorReport(null)}
      />
      {pendingCategoryDelete !== null ? (
        <ConfirmDialog
          title={`Delete every "${pendingCategoryDelete}" box?`}
          message={`Removes ${pendingCategoryCount} ${
            pendingCategoryCount === 1 ? "box" : "boxes"
          } with this expression from the document. Undo brings them back.`}
          confirmLabel="Delete boxes"
          cancelLabel="Keep them"
          onConfirm={confirmCategoryDelete}
          onCancel={() => setPendingCategoryDelete(null)}
        />
      ) : null}
      {pendingSwitch && datasetView ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={`"${datasetView.stem}" has unsaved changes. Switching to "${pendingSwitch.stem}" discards them.`}
          confirmLabel="Discard and switch"
          cancelLabel="Keep editing"
          onConfirm={() => switchToDatasetItem(pendingSwitch)}
          onCancel={() => setPendingSwitch(null)}
        />
      ) : null}
      <DatasetDialog
        open={datasetDialogOpen}
        initialExpandedName={managedDataset}
        onClose={() => {
          setDatasetDialogOpen(false);
          setManagedDataset(null);
        }}
        onOpenItem={(datasetName, item, items) =>
          void openDatasetItem(datasetName, item, items)
        }
      />
      <input
        ref={fallbackLabelInputRef}
        type="file"
        accept=".txt,.jsonl,text/plain"
        aria-label="Fallback label file"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            void importFiles({ labels: file, notice: PICKER_BLOCKED_NOTICE });
          }
        }}
      />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <EditorErrorBoundary>
      <EditorProvider>
        <EditorWorkspace />
      </EditorProvider>
    </EditorErrorBoundary>
  );
}
