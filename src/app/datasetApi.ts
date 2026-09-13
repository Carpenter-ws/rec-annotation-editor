import { isJsonlLabelFile } from "../domain/jsonl";

export interface DatasetItem {
  /** Basename without extension; pairs one image with one label file. */
  stem: string;
  /** File name inside the dataset's images/ folder. */
  image: string;
  /** File name inside the dataset's labels/ folder, when present. */
  labels: string | null;
}

export interface DatasetSummary {
  name: string;
  items: DatasetItem[];
}

export interface DatasetUploadPair {
  stem: string;
  image?: File;
  labels?: File;
}

export interface DatasetUploadPlan {
  pairs: DatasetUploadPair[];
  unpaired: File[];
}

const IMAGE_FILE_PATTERN =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jfif|jpe?g|png|svg|tiff?|webp)$/i;
const LABEL_FILE_PATTERN = /\.(?:txt|jsonl)$/i;

/** Groups a batch of files into image+label pairs by basename. */
export function pairDatasetFiles(files: readonly File[]): DatasetUploadPlan {
  const stemOf = (name: string) => name.replace(/\.[^./\\]+$/, "");
  const keyOf = (stem: string) => stem.toLocaleLowerCase();

  const images = new Map<string, File>();
  const labels = new Map<string, File>();
  const order: string[] = [];

  for (const file of files) {
    const stem = stemOf(file.name);
    const key = keyOf(stem);
    if (IMAGE_FILE_PATTERN.test(file.name)) {
      if (!images.has(key)) {
        images.set(key, file);
        if (!order.includes(key)) order.push(key);
      }
      continue;
    }
    if (LABEL_FILE_PATTERN.test(file.name)) {
      if (!labels.has(key)) {
        labels.set(key, file);
        if (!order.includes(key)) order.push(key);
      }
    }
  }

  const pairs: DatasetUploadPair[] = [];
  const consumed = new Set<File>();
  for (const key of order) {
    const image = images.get(key);
    const labelsFile = labels.get(key);
    if (!image || !labelsFile) continue;
    pairs.push({ stem: stemOf(image.name), image, labels: labelsFile });
    consumed.add(image);
    consumed.add(labelsFile);
  }

  const unpaired = files.filter((file) => !consumed.has(file));
  return { pairs, unpaired };
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
  image: { name: string; data: string };
  labels: { name: string; text: string };
}

export async function uploadDatasetItems(
  name: string,
  pairs: readonly DatasetUploadPair[],
): Promise<DatasetSummary> {
  const items: DatasetUploadPayload[] = [];
  for (const pair of pairs) {
    if (!pair.image || !pair.labels) continue;
    items.push({
      image: {
        name: pair.image.name,
        data: bytesToBase64(await fileBytes(pair.image)),
      },
      labels: { name: pair.labels.name, text: await fileText(pair.labels) },
    });
  }

  return request<DatasetSummary>(`/api/datasets/${encodeURIComponent(name)}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
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
