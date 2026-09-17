import type { ImageInfo } from "../domain/types";

export interface DroppedFiles {
  image?: File;
  labels?: File;
  /** A second label file in the same drop is the original annotations. */
  reference?: File;
  rejected: File[];
}

export type SaveResult = "saved" | "cancelled" | "downloaded";

/**
 * Embedded frames, sandboxed pages, and some IDE previews expose the File
 * System Access API but refuse to use it. Treat those as "unavailable" so the
 * app can fall back to classic dialogs and downloads.
 */
export function isFileSystemAccessBlockedError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

const pendingHandleWrites = new WeakMap<FileSystemFileHandle, Promise<void>>();

const IMAGE_EXTENSION =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jfif|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith("image/") || IMAGE_EXTENSION.test(file.name);
}

function isLabelFile(file: File): boolean {
  return /\.(?:txt|jsonl)$/i.test(file.name);
}

export function downloadText(
  contents: string,
  fileName: string,
  mime: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

async function commitTextToHandle(
  handle: FileSystemFileHandle,
  contents: string,
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

export function writeTextToHandle(
  handle: FileSystemFileHandle,
  contents: string,
): Promise<void> {
  const previous = pendingHandleWrites.get(handle) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => commitTextToHandle(handle, contents));
  pendingHandleWrites.set(handle, pending);
  void pending.then(
    () => {
      if (pendingHandleWrites.get(handle) === pending) {
        pendingHandleWrites.delete(handle);
      }
    },
    () => {
      if (pendingHandleWrites.get(handle) === pending) {
        pendingHandleWrites.delete(handle);
      }
    },
  );
  return pending;
}

export async function saveTextAs(
  contents: string,
  suggestedName: string,
  mime: string,
): Promise<SaveResult> {
  if (!window.showSaveFilePicker) {
    downloadText(contents, suggestedName, mime);
    return "downloaded";
  }

  try {
    const handle = await window.showSaveFilePicker({ suggestedName });
    await writeTextToHandle(handle, contents);
    return "saved";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "cancelled";
    }
    if (isFileSystemAccessBlockedError(error)) {
      downloadText(contents, suggestedName, mime);
      return "downloaded";
    }
    throw error;
  }
}

export async function pickTextFile(): Promise<{
  file: File;
  handle: FileSystemFileHandle;
} | null> {
  if (!window.showOpenFilePicker) return null;
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "Text files",
          accept: { "text/plain": [".txt"] },
        },
      ],
    });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

export function partitionDroppedFiles(files: readonly File[]): DroppedFiles {
  const result: DroppedFiles = {
    image: undefined,
    labels: undefined,
    reference: undefined,
    rejected: [],
  };

  for (const file of files) {
    if (isImageFile(file) && !result.image) {
      result.image = file;
    } else if (isLabelFile(file) && !result.labels) {
      result.labels = file;
    } else if (isLabelFile(file) && !result.reference) {
      // Dropping image + labels + originals at once loads the picking pool too.
      result.reference = file;
    } else {
      result.rejected.push(file);
    }
  }

  return result;
}

export function readTextFile(file: File): Promise<string> {
  return file.text();
}

export async function loadImageFile(file: File): Promise<ImageInfo> {
  const url = URL.createObjectURL(file);

  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(`Could not decode image "${file.name}".`));
      image.src = url;
    });

    if (
      !Number.isFinite(image.naturalWidth) ||
      !Number.isFinite(image.naturalHeight) ||
      image.naturalWidth <= 0 ||
      image.naturalHeight <= 0
    ) {
      throw new Error(`Could not decode image "${file.name}".`);
    }

    return {
      name: file.name,
      width: image.naturalWidth,
      height: image.naturalHeight,
      url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Loads image dimensions from a persistent URL (e.g. a dataset asset). */
export async function loadImageFromUrl(
  url: string,
  name: string,
): Promise<ImageInfo> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error(`Could not decode image "${name}".`));
    image.src = url;
  });

  if (
    !Number.isFinite(image.naturalWidth) ||
    !Number.isFinite(image.naturalHeight) ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  ) {
    throw new Error(`Could not decode image "${name}".`);
  }

  return {
    name,
    width: image.naturalWidth,
    height: image.naturalHeight,
    url,
  };
}
