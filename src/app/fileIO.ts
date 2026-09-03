import type { ImageInfo } from "../domain/types";

export interface DroppedFiles {
  image?: File;
  labels?: File;
  rejected: File[];
}

const IMAGE_EXTENSION =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jfif|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith("image/") || IMAGE_EXTENSION.test(file.name);
}

function isLabelFile(file: File): boolean {
  return /\.txt$/i.test(file.name);
}

export function partitionDroppedFiles(files: readonly File[]): DroppedFiles {
  const result: DroppedFiles = {
    image: undefined,
    labels: undefined,
    rejected: [],
  };

  for (const file of files) {
    if (isImageFile(file) && !result.image) {
      result.image = file;
    } else if (isLabelFile(file) && !result.labels) {
      result.labels = file;
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
