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
  loadImageFromUrl,
  partitionDroppedFiles,
  pickTextFile,
  readTextFile,
  saveTextAs,
  writeTextToHandle,
} from "./app/fileIO";
import { useMediaQuery } from "./app/useMediaQuery";
import {
  datasetImageUrl,
  datasetLabelsUrl,
  saveDatasetLabels,
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
import type { Annotation, BBox, ImageBounds, ImageInfo } from "./domain/types";
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

interface ErrorReport {
  title: string;
  issues: readonly ErrorDialogIssue[];
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
  const [datasetView, setDatasetView] = useState<DatasetView | null>(null);
  /** Mirrors `datasetView` for callbacks that must not wait for a render. */
  const datasetViewRef = useRef<DatasetView | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<DatasetItem | null>(null);
  /** JSONL labels whose normalized targets still await an image size. */
  const normalizedSourceRef = useRef(false);
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
  useUnsavedWarning(effectiveDirty);
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
    (bbox: BBox, label: string) => {
      const id = nextAnnotationId(stateRef.current.nextAnnotationNumber);
      dispatch({
        type: "ADD_ANNOTATION",
        annotation: { id, bbox, label, reservedField: "0" },
      });
      dispatch({ type: "SELECT", id });
      // Deliberately no camera movement: the view stays where the user drew.
      showToast(`Added "${label}" (${id}).`);
    },
    [dispatch, showToast],
  );
  // While a category "Add" is armed, every drawn box joins that category
  // without opening the dialog, so several boxes can be added in a row.
  const handleDraftBox = useCallback(
    (bbox: BBox) => {
      const label = draftLabelRef.current;
      if (label !== null) {
        addAnnotation(bbox, label);
        return;
      }
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
      const generation = ++importGenerationRef.current;
      const isCurrent = () =>
        mountedRef.current && importGenerationRef.current === generation;
      try {
        const activeElement = document.activeElement;
        if (
          isEditableTarget(activeElement) &&
          activeElement instanceof HTMLElement &&
          activeElement.closest("[data-annotation-id]")
        ) {
          activeElement.blur();
        }
        setDraftBBox(null);
        setHighlightedLabel(null);
        setActiveLabel(null);
        setDraftLabel(null);
        dispatch({ type: "SET_MODE", mode: "select" });
        setErrorReport(null);
        setNotice(null);

        let annotations: Annotation[] = [];
        if (labelsFile) {
          const labelsResponse = await fetch(
            datasetLabelsUrl(datasetName, labelsFile),
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

        const image = await loadImageFromUrl(
          datasetImageUrl(datasetName, imageFile),
          imageFile,
        );
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

        // Without labels the item opens as an empty document; saving creates
        // the matching label file next to the image.
        const labelFileName =
          labelsFile ?? `${item.stem}${preferredLabelExtension(siblings)}`;
        const view: DatasetView = {
          dataset: datasetName,
          stem: item.stem,
          labelsFile: labelFileName,
          items: siblings.length > 0 ? siblings : [item],
        };
        datasetViewRef.current = view;
        setDatasetView(view);
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
        setDatasetDialogOpen(false);
      } catch (error) {
        if (!isCurrent()) return;
        setErrorReport({
          title: "Could not open dataset item",
          issues: [errorMessage(error)],
        });
      }
    },
    [dispatch],
  );
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
      const activeElement = document.activeElement;
      if (
        isEditableTarget(activeElement) &&
        activeElement instanceof HTMLElement &&
        activeElement.closest("[data-annotation-id]")
      ) {
        activeElement.blur();
      }
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

    if (files.labels) {
      labelHandleRef.current = labelHandle;
      datasetViewRef.current = null;
      setDatasetView(null);
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
    void importFiles(
      { image: dropped.image, labels: dropped.labels },
      dropped.rejected,
    );
  };

  const addDraftAnnotation = (label: string) => {
    if (!draftBBox) return;
    addAnnotation(draftBBox, label);
    dispatch({ type: "SET_MODE", mode: "select" });
    setDraftBBox(null);
  };

  const cancelDraftAnnotation = () => {
    setDraftBBox(null);
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
  // the selected box — a fresh document starts with a clean image.
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
    () =>
      datasetView
        ? datasetView.items.filter((item) => item.image && item.labels)
        : [],
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
  const stepDatasetItem = useCallback(
    (direction: -1 | 1) => {
      const view = datasetViewRef.current;
      if (!view) return;
      const ready = view.items.filter((item) => item.image && item.labels);
      const index = ready.findIndex((item) => item.stem === view.stem);
      if (index < 0) return;
      const target = ready[index + direction];
      if (!target) return;
      // Unsaved edits are never dropped silently.
      if (effectiveDirtyRef.current) {
        setPendingSwitch(target);
        return;
      }
      setPendingSwitch(null);
      void openDatasetItem(view.dataset, target, view.items);
    },
    [openDatasetItem],
  );

  const save = async () => {
    const latestState = stateRef.current;
    const snapshot = latestState.annotations;
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
      if (datasetViewRef.current) {
        const { dataset, labelsFile } = datasetViewRef.current;
        try {
          await saveDatasetLabels(dataset, labelsFile, contents);
          setNotice(`Saved "${labelsFile}" to dataset "${dataset}".`);
        } catch (error) {
          setErrorReport({
            title: "Could not save annotations",
            issues: [errorMessage(error)],
          });
          return;
        }
      } else if (labelHandleRef.current) {
        try {
          await writeTextToHandle(labelHandleRef.current, contents);
          setNotice(
            `Saved "${latestState.labelFileName ?? "annotations"}" in place.`,
          );
        } catch (error) {
          if (!isFileSystemAccessBlockedError(error)) throw error;
          downloadText(
            contents,
            fileName,
            saveJsonl ? "application/x-ndjson" : "text/plain",
          );
          setNotice(
            `Downloaded "${fileName}". Direct file access is blocked in this context.`,
          );
        }
      } else {
        downloadText(
          contents,
          fileName,
          saveJsonl ? "application/x-ndjson" : "text/plain",
        );
        setNotice(
          `Downloaded "${fileName}". This browser cannot write back to the imported file.`,
        );
      }
      if (stateRef.current.annotations === snapshot) {
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
    const activeElement = document.activeElement;
    if (
      isEditableTarget(activeElement) &&
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-annotation-id]")
    ) {
      activeElement.blur();
      window.setTimeout(action, 0);
      return;
    }
    action();
  };

  useKeyboardShortcuts({
    onPreviousItem: () => runAfterEditorBlur(() => stepDatasetItem(-1)),
    onNextItem: () => runAfterEditorBlur(() => stepDatasetItem(1)),
    onUndo: () =>
      runAfterEditorBlur(() => dispatch({ type: "UNDO" })),
    onRedo: () =>
      runAfterEditorBlur(() => dispatch({ type: "REDO" })),
    onSave: () => runAfterEditorBlur(() => void save()),
    onDelete: () => {
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
      <Toolbar
        imageName={state.image?.name ?? null}
        labelFileName={state.labelFileName}
        dirty={effectiveDirty}
        scale={zoomScale}
        labelPickerBlocked={labelPickerBlocked}
        onOpenImage={(file) => void importFiles({ image: file })}
        onOpenLabels={(file) => void importFiles({ labels: file })}
        onPickLabels={() => void pickLabels()}
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
          />
        </aside>
      </main>
      {draftBBox ? (
        <NewAnnotationDialog
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
      <ErrorDialog
        title={errorReport?.title ?? "Import error"}
        issues={errorReport?.issues ?? []}
        onClose={() => setErrorReport(null)}
      />
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
        onClose={() => setDatasetDialogOpen(false)}
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
