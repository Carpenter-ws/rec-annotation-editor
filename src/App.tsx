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
import { useMediaQuery } from "./app/useMediaQuery";
import {
  isEditableTarget,
  useKeyboardShortcuts,
} from "./app/useKeyboardShortcuts";
import { useUnsavedWarning } from "./app/useUnsavedWarning";
import { EditorErrorBoundary } from "./components/EditorErrorBoundary";
import { ErrorDialog, type ErrorDialogIssue } from "./components/ErrorDialog";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { NewAnnotationDialog } from "./components/NewAnnotationDialog";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { Viewport, type ViewportHandle } from "./components/Viewport";
import { clampBBox } from "./domain/bbox";
import { parseAnnotationText } from "./domain/parser";
import {
  serializeAnnotationsTxt,
  serializeDocumentJson,
} from "./domain/serializer";
import type { Annotation, BBox, ImageBounds, ImageInfo } from "./domain/types";
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

function editedTxtName(labelFileName: string | null, imageName: string | null) {
  const stem = fileStem(labelFileName ?? imageName ?? "annotations");
  return `${stem}-edited.txt`;
}

function exportFileName(
  labelFileName: string | null,
  imageName: string | null,
  extension: "txt" | "json",
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
  const pendingCenterIdRef = useRef<string | null>(null);
  stateRef.current = state;
  const effectiveDirty = state.dirty || pendingCoordinateIds.size > 0;
  useUnsavedWarning(effectiveDirty);
  const imageBounds = useMemo<ImageBounds | null>(
    () =>
      state.image
        ? { width: state.image.width, height: state.image.height }
        : null,
    [state.image?.height, state.image?.width],
  );
  const locateAnnotation = useCallback((id: string) => {
    viewportRef.current?.centerAnnotation(id);
  }, []);
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
    };
  }, []);

  useEffect(() => {
    const id = pendingCenterIdRef.current;
    if (
      id === null ||
      state.selectedId !== id ||
      !state.annotations.some((annotation) => annotation.id === id)
    ) {
      return;
    }

    viewportRef.current?.centerAnnotation(id);
    pendingCenterIdRef.current = null;
  }, [state.annotations, state.selectedId]);

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
      pendingCenterIdRef.current = null;
      setHighlightedLabel(null);
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

      const parsed = parseAnnotationText(text);
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
    const annotations = importedAnnotations ?? latestState.annotations;
    const labelFileName = files.labels?.name ?? latestState.labelFileName;
    const image = loadedImage ?? latestState.image;

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
    const id = nextAnnotationId(state.nextAnnotationNumber);
    pendingCenterIdRef.current = id;
    dispatch({
      type: "ADD_ANNOTATION",
      annotation: { id, bbox: draftBBox, label, reservedField: "0" },
    });
    dispatch({ type: "SELECT", id });
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

  const save = async () => {
    const latestState = stateRef.current;
    const snapshot = latestState.annotations;
    const fileName = editedTxtName(
      latestState.labelFileName,
      latestState.image?.name ?? null,
    );
    try {
      const contents = serializeAnnotationsTxt(snapshot);
      if (labelHandleRef.current) {
        try {
          await writeTextToHandle(labelHandleRef.current, contents);
          setNotice(
            `Saved "${latestState.labelFileName ?? "annotations"}" in place.`,
          );
        } catch (error) {
          if (!isFileSystemAccessBlockedError(error)) throw error;
          downloadText(contents, fileName, "text/plain");
          setNotice(
            `Downloaded "${fileName}". Direct file access is blocked in this context.`,
          );
        }
      } else {
        downloadText(contents, fileName, "text/plain");
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
    try {
      const result = await saveTextAs(
        serializeAnnotationsTxt(snapshot),
        editedTxtName(latestState.labelFileName, latestState.image?.name ?? null),
        "text/plain",
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

  const exportAnnotations = (format: "txt" | "json") => {
    const latestState = stateRef.current;
    try {
      const contents =
        format === "txt"
          ? serializeAnnotationsTxt(latestState.annotations)
          : serializeDocumentJson(latestState);
      downloadText(
        contents,
        exportFileName(
          latestState.labelFileName,
          latestState.image?.name ?? null,
          format,
        ),
        format === "txt" ? "text/plain" : "application/json",
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
        onZoomOut={() => viewportRef.current?.zoomBy(1 / 1.2)}
        onZoomIn={() => viewportRef.current?.zoomBy(1.2)}
        onFit={() => viewportRef.current?.fit()}
        mode={state.mode}
        addBoxDisabled={state.image === null}
        onAddBox={() => dispatch({ type: "SET_MODE", mode: "add" })}
        panelToggleVisible={narrowLayout}
        panelOpen={panelVisible}
        onTogglePanel={() => setPanelOpen((open) => !open)}
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
          {state.image ? (
            <Viewport
              ref={viewportRef}
              image={state.image}
              annotations={state.annotations}
              selectedId={state.selectedId}
              highlightedLabel={highlightedLabel}
              dispatch={dispatch}
              onZoomChange={setZoomScale}
              mode={state.mode}
              onDraftBox={setDraftBBox}
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
      <input
        ref={fallbackLabelInputRef}
        type="file"
        accept=".txt,text/plain"
        aria-label="Open labels (fallback)"
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
