import { useEffect, useRef, useState, type DragEvent, type JSX } from "react";
import {
  loadImageFile,
  partitionDroppedFiles,
  readTextFile,
} from "./app/fileIO";
import { ErrorDialog, type ErrorDialogIssue } from "./components/ErrorDialog";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { Viewport, type ViewportHandle } from "./components/Viewport";
import { clampBBox } from "./domain/bbox";
import { parseAnnotationText } from "./domain/parser";
import type { Annotation, ImageBounds, ImageInfo } from "./domain/types";
import {
  EditorProvider,
  useEditorDispatch,
  useEditorState,
} from "./state/EditorContext";

interface ImportFiles {
  image?: File;
  labels?: File;
}

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

function EditorWorkspace(): JSX.Element {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const viewportRef = useRef<ViewportHandle>(null);
  const stateRef = useRef(state);
  const importGenerationRef = useRef(0);
  const dragDepthRef = useRef(0);
  const mountedRef = useRef(true);
  const acceptedImageUrlRef = useRef<string | null>(null);
  stateRef.current = state;

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

  const importFiles = async (
    files: ImportFiles,
    rejected: readonly File[] = [],
  ): Promise<void> => {
    const generation = ++importGenerationRef.current;
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

    setNotice(clampNotice(clamped.count));
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

  return (
    <div className="app-shell">
      <Toolbar
        imageName={state.image?.name ?? null}
        labelFileName={state.labelFileName}
        scale={zoomScale}
        onOpenImage={(file) => void importFiles({ image: file })}
        onOpenLabels={(file) => void importFiles({ labels: file })}
        onZoomOut={() => viewportRef.current?.zoomBy(1 / 1.2)}
        onZoomIn={() => viewportRef.current?.zoomBy(1.2)}
        onFit={() => viewportRef.current?.fit()}
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
              dispatch={dispatch}
              onZoomChange={setZoomScale}
            />
          ) : (
            <p>
              {dragActive
                ? "Drop files to import"
                : "Drop an image and label file here"}
            </p>
          )}
        </section>
        <aside aria-label="Annotations">
          {state.annotations.map((annotation) => (
            <p key={annotation.id}>{annotation.label}</p>
          ))}
        </aside>
      </main>
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
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <EditorProvider>
      <EditorWorkspace />
    </EditorProvider>
  );
}
