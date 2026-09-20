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

/** The half that is still missing for an item. */
export type StagedItemState = "complete" | "missing-labels" | "missing-image";

/** One dataset item as shown in the dialog: at most one image and one label file. */
export interface StagedItem {
  stem: string;
  /** Staged image, when the user picked one in this batch. */
  image: StagedDatasetFile | null;
  /** Staged label file, when the user picked one in this batch. */
  labels: StagedDatasetFile | null;
  /** The dataset already stores an image for this item. */
  imageOnServer: boolean;
  /** The dataset already stores a label file for this item. */
  labelsOnServer: boolean;
  hasImage: boolean;
  hasLabels: boolean;
  state: StagedItemState;
  /** Hard failures: unsupported, duplicate, unreadable, or unparsable. */
  issues: string[];
  status: "reading" | "ready" | "error";
}

/**
 * Collapses the staged files into one row per item and pairs them with the
 * halves the dataset already stores, so an image alone reads as
 * "missing labels" only when nothing is stored for it yet.
 */
export function groupStagedItems(
  files: readonly StagedDatasetFile[],
  storedItems: readonly {
    stem: string;
    image: string | null;
    labels: string | null;
  }[],
): StagedItem[] {
  interface Group {
    image: StagedDatasetFile | null;
    labels: StagedDatasetFile | null;
    /** Every file of this item, in the order the user picked them. */
    files: StagedDatasetFile[];
  }

  const order: string[] = [];
  const groups = new Map<string, Group>();
  for (const file of files) {
    const key = file.stem.toLocaleLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { image: null, labels: null, files: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.files.push(file);
    if (file.kind === "image" && !group.image) group.image = file;
    else if (file.kind === "labels" && !group.labels) group.labels = file;
  }

  const storedByStem = new Map(
    storedItems.map((item) => [item.stem.toLocaleLowerCase(), item]),
  );

  return order.map((key) => {
    const group = groups.get(key)!;
    const stored = storedByStem.get(key);
    const imageOnServer = Boolean(stored?.image);
    const labelsOnServer = Boolean(stored?.labels);
    const hasImage = group.image !== null || imageOnServer;
    const hasLabels = group.labels !== null || labelsOnServer;

    const issues = group.files
      .filter((file) => file.status === "error")
      .map((file) => `${file.name}: ${file.error}`);

    const reading = [group.image, group.labels].some(
      (file) => file?.status === "reading",
    );

    return {
      stem: group.image?.stem ?? group.labels?.stem ?? stored?.stem ?? key,
      image: group.image,
      labels: group.labels,
      imageOnServer,
      labelsOnServer,
      hasImage,
      hasLabels,
      state: hasImage
        ? hasLabels
          ? "complete"
          : "missing-labels"
        : "missing-image",
      issues,
      status: issues.length > 0 ? "error" : reading ? "reading" : "ready",
    };
  });
}

/** One-line status for the staged batch, e.g. "2 items to import". */
export function stagedItemsSummary(
  items: readonly StagedItem[],
): string | null {
  if (items.length === 0) return null;
  const reading = items.filter((item) => item.status === "reading").length;
  const failed = items.filter((item) => item.status === "error").length;
  const importable = items.length - failed;

  const parts: string[] = [];
  if (reading > 0) parts.push("Reading files…");
  if (importable > 0) {
    parts.push(`${importable} ${importable === 1 ? "item" : "items"} to import`);
  }
  if (failed > 0) {
    parts.push(`${failed} ${failed === 1 ? "needs" : "need"} attention`);
  }
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
