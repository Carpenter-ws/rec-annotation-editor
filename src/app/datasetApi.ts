import { isJsonlLabelFile } from "../domain/jsonl";

export interface DatasetItem {
  /** Basename without extension; pairs one image with one label file. */
  stem: string;
  /** File name inside the dataset's images/ folder, once uploaded. */
  image: string | null;
  /** File name inside the dataset's labels/ folder, once uploaded. */
  labels: string | null;
}

export interface DatasetSummary {
  name: string;
  items: DatasetItem[];
}

/**
 * One item of an upload batch. Batches may carry only images, only labels, or
 * both; the server merges them by stem so users can upload in several passes.
 */
export interface DatasetUploadItem {
  stem: string;
  image?: File;
  labels?: File;
}

export interface DatasetUploadPlan {
  items: DatasetUploadItem[];
  unsupported: File[];
}

const IMAGE_FILE_PATTERN =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jfif|jpe?g|png|svg|tiff?|webp)$/i;
const LABEL_FILE_PATTERN = /\.(?:txt|jsonl)$/i;

/**
 * Groups one upload batch by file stem. Images and labels may arrive in
 * separate batches — the caller uploads whatever it gets and the server merges
 * halves that share a stem.
 */
export function planDatasetUpload(files: readonly File[]): DatasetUploadPlan {
  const stemOf = (name: string) => name.replace(/\.[^./\\]+$/, "");
  const keyOf = (stem: string) => stem.toLocaleLowerCase();

  const items = new Map<string, DatasetUploadItem>();
  const unsupported: File[] = [];

  for (const file of files) {
    const stem = stemOf(file.name);
    const key = keyOf(stem);

    if (IMAGE_FILE_PATTERN.test(file.name)) {
      const item = items.get(key) ?? { stem };
      if (item.image) {
        unsupported.push(file);
        continue;
      }
      item.image = file;
      items.set(key, item);
      continue;
    }
    if (LABEL_FILE_PATTERN.test(file.name)) {
      const item = items.get(key) ?? { stem };
      if (item.labels) {
        unsupported.push(file);
        continue;
      }
      item.labels = file;
      items.set(key, item);
      continue;
    }
    unsupported.push(file);
  }

  return { items: [...items.values()], unsupported };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep the status-line detail
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunk),
    );
  }
  return btoa(binary);
}

async function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function fileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export async function listDatasets(): Promise<DatasetSummary[]> {
  return request<DatasetSummary[]>("/api/datasets");
}

export async function createDataset(name: string): Promise<void> {
  await request<void>("/api/datasets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteDataset(name: string): Promise<void> {
  await request<void>(`/api/datasets/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function deleteDatasetItem(
  name: string,
  stem: string,
): Promise<void> {
  await request<void>(
    `/api/datasets/${encodeURIComponent(name)}/items/${encodeURIComponent(stem)}`,
    { method: "DELETE" },
  );
}

export interface DatasetUploadPayload {
  stem: string;
  image?: { name: string; data: string };
  labels?: { name: string; text: string };
}

export async function uploadDatasetItems(
  name: string,
  items: readonly DatasetUploadItem[],
): Promise<DatasetSummary> {
  const payload: DatasetUploadPayload[] = [];
  for (const item of items) {
    payload.push({
      stem: item.stem,
      ...(item.image
        ? {
            image: {
              name: item.image.name,
              data: bytesToBase64(await fileBytes(item.image)),
            },
          }
        : {}),
      ...(item.labels
        ? {
            labels: {
              name: item.labels.name,
              text: await fileText(item.labels),
            },
          }
        : {}),
    });
  }

  return request<DatasetSummary>(`/api/datasets/${encodeURIComponent(name)}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: payload }),
  });
}

export async function saveDatasetLabels(
  name: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await request<void>(
    `/api/datasets/${encodeURIComponent(name)}/labels/${encodeURIComponent(fileName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: contents,
    },
  );
}

export function datasetImageUrl(name: string, fileName: string): string {
  return `/datasets/${encodeURIComponent(name)}/images/${encodeURIComponent(fileName)}`;
}

export function datasetLabelsUrl(name: string, fileName: string): string {
  return `/datasets/${encodeURIComponent(name)}/labels/${encodeURIComponent(fileName)}`;
}

export function labelFileKind(fileName: string): "jsonl" | "txt" {
  return isJsonlLabelFile(fileName) ? "jsonl" : "txt";
}
