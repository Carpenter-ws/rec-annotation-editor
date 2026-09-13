import { isJsonlLabelFile, parseJsonlAnnotations } from "../domain/jsonl";
import { parseAnnotationText } from "../domain/parser";
import {
  classifyDatasetFile,
  datasetFileStem,
  type DatasetUploadItem,
} from "./datasetApi";

export type StagedFileKind = "image" | "labels";
export type StagedFileStatus = "reading" | "ready" | "error";

/**
 * A file the user picked for a dataset but has not committed yet. Files are
 * read and validated in the browser first, so the dialog can show per-file
 * progress and the batch is only sent to the backend on "Confirm import".
 */
export interface StagedDatasetFile {
  id: string;
  file: File;
  name: string;
  stem: string;
  /** `null` for unsupported files. */
  kind: StagedFileKind | null;
  status: StagedFileStatus;
  /** Short summary shown next to the file, e.g. "3840 × 2160" or "12 boxes". */
  detail: string | null;
  error: string | null;
  /** Thumbnail URL for images; must be revoked when the file is dropped. */
  previewUrl: string | null;
}

const UNSUPPORTED_MESSAGE =
  "Unsupported file type — use an image or a .txt/.jsonl label file.";

function boxesDetail(count: number): string {
  return `${count} ${count === 1 ? "box" : "boxes"}`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Creates the "reading" placeholder shown the moment a file is chosen. */
export function createStagedFile(file: File, id: string): StagedDatasetFile {
  const kind = classifyDatasetFile(file.name);
  return {
    id,
    file,
    name: file.name,
    stem: datasetFileStem(file.name),
    kind,
    status: kind === null ? "error" : "reading",
    detail: null,
    error: kind === null ? UNSUPPORTED_MESSAGE : null,
    previewUrl: null,
  };
}

/** `File.text()` is missing in some environments (jsdom), so keep a fallback. */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read this file."));
    reader.readAsText(file);
  });
}

function decodeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
        return;
      }
      reject(new Error("Could not decode this image."));
    };
    image.onerror = () => reject(new Error("Could not decode this image."));
    image.src = url;
  });
}

/**
 * Reads one staged file: images are decoded (which doubles as the visual
 * loading step) and label files are parsed so mistakes surface before upload.
 */
export async function readStagedDatasetFile(
  staged: StagedDatasetFile,
): Promise<StagedDatasetFile> {
  if (staged.kind === null || staged.status === "error") return staged;

  if (staged.kind === "image") {
    const previewUrl = URL.createObjectURL(staged.file);
    try {
      const size = await decodeImage(previewUrl);
      return {
        ...staged,
        status: "ready",
        detail: `${size.width} × ${size.height}`,
        error: null,
        previewUrl,
      };
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      return {
        ...staged,
        status: "error",
        detail: null,
        error: messageOf(error, "Could not decode this image."),
        previewUrl: null,
      };
    }
  }

  try {
    const text = await readFileText(staged.file);
    const parsed = isJsonlLabelFile(staged.name)
      ? parseJsonlAnnotations(text)
      : parseAnnotationText(text);
    const issue = parsed.issues[0];
    if (issue) {
      return {
        ...staged,
        status: "error",
        detail: null,
        error: `Line ${issue.line}: ${issue.reason}`,
      };
    }
    return {
      ...staged,
      status: "ready",
      detail: boxesDetail(parsed.annotations.length),
      error: null,
    };
  } catch (error) {
    return {
      ...staged,
      status: "error",
      detail: null,
      error: messageOf(error, "Could not read this file."),
    };
  }
}

/** Flags a second image (or a second label file) for the same item. */
export function markDuplicateStems(
  files: readonly StagedDatasetFile[],
): StagedDatasetFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    if (file.status === "error" || file.kind === null) return file;
    const key = `${file.kind}:${file.stem.toLocaleLowerCase()}`;
    if (seen.has(key)) {
      return {
        ...file,
        status: "error" as const,
        detail: null,
        error: `Another ${
          file.kind === "image" ? "image" : "label file"
        } of this item is already in the list.`,
      };
    }
    seen.add(key);
    return file;
  });
}

/** Groups ready files by stem into the payload the backend expects. */
export function stagedFilesToUploadItems(
  files: readonly StagedDatasetFile[],
): DatasetUploadItem[] {
  const items = new Map<string, DatasetUploadItem>();
  for (const file of files) {
    if (file.status !== "ready" || file.kind === null) continue;
    const key = file.stem.toLocaleLowerCase();
    const item = items.get(key) ?? { stem: file.stem };
    if (file.kind === "image") item.image = file.file;
    else item.labels = file.file;
    items.set(key, item);
  }
  return [...items.values()];
}

/** One-line status for the staged batch, e.g. "2 files ready to import". */
export function stagedFilesSummary(
  files: readonly StagedDatasetFile[],
): string | null {
  if (files.length === 0) return null;
  const reading = files.filter((file) => file.status === "reading").length;
  const ready = files.filter((file) => file.status === "ready").length;
  const failed = files.filter((file) => file.status === "error").length;

  const parts: string[] = [];
  if (reading > 0) parts.push("Reading files…");
  if (ready > 0) {
    parts.push(
      reading > 0 || failed > 0
        ? `${ready} ready`
        : `${ready} ${ready === 1 ? "file" : "files"} ready to import`,
    );
  }
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? "needs" : "need"} attention`);
  return parts.join(" · ");
}

/** Releases the object URLs held by staged image previews. */
export function revokeStagedFiles(
  files: readonly StagedDatasetFile[],
): void {
  for (const file of files) {
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
  }
}
