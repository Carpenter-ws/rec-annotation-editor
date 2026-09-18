import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

export interface ManifestItem {
  stem: string;
  /** File name once uploaded, or null while only labels exist. */
  image: string | null;
  /** File name once uploaded, or null while only the image exists. */
  labels: string | null;
  /**
   * Original annotations paired by stem, read from the dataset's `originals/`
   * folder. They are a picking pool, so they can also be dropped in by hand.
   */
  originals?: string | null;
}

export interface Manifest {
  name: string;
  items: ManifestItem[];
}

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

const LABEL_EXTENSIONS = new Set([".jsonl", ".txt"]);

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jfif": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

/** Rejects path separators, traversal, and other unsafe characters. */
export function isValidSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 180 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0") &&
    !segment.includes("..")
  );
}

export function resolveWithin(
  rootDir: string,
  ...segments: string[]
): string | null {
  if (segments.some((segment) => !isValidSegment(segment))) return null;
  const normalizedRoot = path.resolve(rootDir);
  const target = path.resolve(normalizedRoot, ...segments);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep))
    return null;
  return target;
}

export function readManifest(datasetDir: string, name: string): Manifest {
  try {
    // Hand-edited manifests often carry a BOM (Notepad and PowerShell write
    // one); JSON.parse rejects it, which would empty the whole dataset.
    const raw = fs
      .readFileSync(path.join(datasetDir, "dataset.json"), "utf8")
      .replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed && parsed.name === name && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt manifest: start from scratch.
  }
  return { name, items: [] };
}

export function writeManifest(datasetDir: string, manifest: Manifest): void {
  fs.writeFileSync(
    path.join(datasetDir, "dataset.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function sendFile(res: ServerResponse, filePath: string): void {
  const contentType =
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Recursive removal without `fs.rmSync`: some Windows setups replace rm with
 * a "move to trash" shim that fails inside dev servers, so walk the tree and
 * unlink/rmdir entry by entry.
 */
export function removeDirectoryRecursive(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) removeDirectoryRecursive(child);
    else fs.unlinkSync(child);
  }
  fs.rmdirSync(dir);
}

function stemOf(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

/** Folders a dataset exposes over HTTP, each holding one role of the item. */
const DATASET_FOLDERS = ["images", "labels", "originals"] as const;

type DatasetFolder = (typeof DATASET_FOLDERS)[number];

const FOLDER_EXTENSIONS: Record<DatasetFolder, ReadonlySet<string>> = {
  images: IMAGE_EXTENSIONS,
  labels: LABEL_EXTENSIONS,
  originals: LABEL_EXTENSIONS,
};

/** Each folder owns one item field; the images folder holds a single image. */
const ITEM_KEYS: Record<DatasetFolder, "image" | "labels" | "originals"> = {
  images: "image",
  labels: "labels",
  originals: "originals",
};

/** Stems mapped to the stored file names of one dataset folder. */
function filesByStem(
  datasetDir: string,
  folder: DatasetFolder,
): Map<string, string> {
  const byStem = new Map<string, string>();
  try {
    for (const name of fs.readdirSync(path.join(datasetDir, folder))) {
      if (!FOLDER_EXTENSIONS[folder].has(path.extname(name).toLowerCase())) {
        continue;
      }
      const stem = stemOf(name);
      if (!byStem.has(stem)) byStem.set(stem, name);
    }
  } catch {
    // Missing folder: nothing is stored under it yet.
  }
  return byStem;
}

/**
 * Re-pairs every item with the files that are actually on disk. A manifest can
 * name a file that has since been replaced by the same-stem file in another
 * extension (say a `.txt` export swapped for the `.jsonl` one); keeping that
 * stale name makes the item 404 on open and rejects its saves. Resolved
 * changes are written back so the dataset heals on the next request.
 */
export function reconcileManifest(
  datasetDir: string,
  manifest: Manifest,
): Manifest {
  const listings: Record<DatasetFolder, Map<string, string>> = {
    images: filesByStem(datasetDir, "images"),
    labels: filesByStem(datasetDir, "labels"),
    originals: filesByStem(datasetDir, "originals"),
  };

  let changed = false;
  const items = manifest.items.map((item) => {
    const next: ManifestItem = { ...item };
    for (const folder of DATASET_FOLDERS) {
      const key = ITEM_KEYS[folder];
      const recorded = next[key] ?? null;
      const recordedPath =
        recorded === null ? null : resolveWithin(datasetDir, folder, recorded);
      const stored =
        recordedPath !== null && fs.existsSync(recordedPath)
          ? recorded
          : (listings[folder].get(item.stem) ?? null);
      // Older manifests lack a field entirely; writing the canonical shape back
      // keeps the stored file and the served one in sync.
      if (stored !== recorded || !(key in next)) changed = true;
      next[key] = stored;
    }
    return next;
  });

  const reconciled: Manifest = { ...manifest, items };
  if (changed) writeManifest(datasetDir, reconciled);
  return reconciled;
}

/** Reads the manifest and hands back the version that matches the disk. */
function loadManifest(datasetDir: string, name: string): Manifest {
  return reconcileManifest(datasetDir, readManifest(datasetDir, name));
}

export function createDatasetMiddleware(rootDir: string) {
  fs.mkdirSync(rootDir, { recursive: true });

  return function datasetMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void {
    const rawUrl = (req.url ?? "").split("?")[0] ?? "";
    let url: string;
    try {
      url = decodeURIComponent(rawUrl);
    } catch {
      sendError(res, 400, "invalid URL encoding");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();

    // Serve stored dataset assets.
    if (method === "GET" && url.startsWith("/datasets/")) {
      const segments = url.slice("/datasets/".length).split("/").filter(Boolean);
      if (segments.length !== 3) {
        next();
        return;
      }
      const [name, folder, fileName] = segments;
      if (name === undefined || folder === undefined || fileName === undefined) {
        next();
        return;
      }
      if (!DATASET_FOLDERS.some((allowed) => allowed === folder)) {
        next();
        return;
      }
      const filePath = resolveWithin(rootDir, name, folder, fileName);
      if (filePath === null || !fs.existsSync(filePath)) {
        sendError(res, 404, "not found");
        return;
      }
      sendFile(res, filePath);
      return;
    }

    if (!url.startsWith("/api/datasets")) {
      next();
      return;
    }

    const handle = async () => {
      if (url === "/api/datasets" && method === "GET") {
        const entries = fs
          .readdirSync(rootDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .filter((entry) =>
            fs.existsSync(path.join(rootDir, entry.name, "dataset.json")),
          )
          .map((entry) => {
            const datasetDir = path.join(rootDir, entry.name);
            return loadManifest(datasetDir, entry.name);
          });
        sendJson(res, 200, entries);
        return;
      }

      if (url === "/api/datasets" && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          name?: string;
        };
        const name = body.name ?? "";
        if (!isValidSegment(name)) {
          sendError(res, 400, "invalid dataset name");
          return;
        }
        const datasetDir = resolveWithin(rootDir, name);
        if (datasetDir === null || fs.existsSync(datasetDir)) {
          sendError(res, 409, "dataset name is taken");
          return;
        }
        fs.mkdirSync(path.join(datasetDir, "images"), { recursive: true });
        fs.mkdirSync(path.join(datasetDir, "labels"), { recursive: true });
        fs.mkdirSync(path.join(datasetDir, "originals"), { recursive: true });
        const manifest: Manifest = { name, items: [] };
        writeManifest(datasetDir, manifest);
        sendJson(res, 201, manifest);
        return;
      }

      const match = url.match(
        /^\/api\/datasets\/([^/]+)(?:\/(items|labels)(?:\/([^/]+))?)?$/,
      );
      if (!match) {
        next();
        return;
      }
      const [, name, resource, resourceKey] = match;
      if (!name) {
        next();
        return;
      }
      const datasetDir = resolveWithin(rootDir, name);
      if (datasetDir === null || !fs.existsSync(datasetDir)) {
        sendError(res, 404, "dataset not found");
        return;
      }

      if (method === "DELETE" && !resource) {
        removeDirectoryRecursive(datasetDir);
        res.writeHead(204);
        res.end();
        return;
      }

      const manifest = loadManifest(datasetDir, name);

      if (resource === "items" && !resourceKey && method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          items?: {
            image?: { name?: string; data?: string };
            labels?: { name?: string; text?: string };
          }[];
        };
        for (const item of body.items ?? []) {
          const image = item.image;
          const labels = item.labels;
          if (
            (!image || !image.name || !image.data) &&
            (!labels || !labels.name || typeof labels.text !== "string")
          ) {
            sendError(
              res,
              400,
              "each item needs an image, a label file, or both",
            );
            return;
          }
          if (image?.name) {
            if (!IMAGE_EXTENSIONS.has(path.extname(image.name).toLowerCase())) {
              sendError(res, 400, `unsupported image type: ${image.name}`);
              return;
            }
            const imagePath = resolveWithin(datasetDir, "images", image.name);
            if (imagePath === null) {
              sendError(res, 400, "invalid image file name");
              return;
            }
            fs.writeFileSync(
              imagePath,
              Buffer.from(image.data ?? "", "base64"),
            );
          }
          if (labels?.name) {
            if (!LABEL_EXTENSIONS.has(path.extname(labels.name).toLowerCase())) {
              sendError(res, 400, `unsupported label type: ${labels.name}`);
              return;
            }
            const labelsPath = resolveWithin(datasetDir, "labels", labels.name);
            if (labelsPath === null) {
              sendError(res, 400, "invalid label file name");
              return;
            }
            fs.writeFileSync(labelsPath, labels.text ?? "", "utf8");
          }

          const stem = stemOf(image?.name ?? labels?.name ?? "");
          let existing = manifest.items.find((entry) => entry.stem === stem);
          if (!existing) {
            existing = { stem, image: null, labels: null, originals: null };
            manifest.items.push(existing);
          }
          if (image?.name) existing.image = image.name;
          if (labels?.name) existing.labels = labels.name;
        }
        writeManifest(datasetDir, manifest);
        sendJson(res, 200, manifest);
        return;
      }

      if (resource === "items" && resourceKey && method === "DELETE") {
        const item = manifest.items.find((entry) => entry.stem === resourceKey);
        if (!item) {
          sendError(res, 404, "item not found");
          return;
        }
        const files: readonly [string | null | undefined, string][] = [
          [item.image, "images"],
          [item.labels, "labels"],
          [item.originals, "originals"],
        ];
        for (const [fileName, folder] of files) {
          if (!fileName) continue;
          const filePath = resolveWithin(datasetDir, folder, fileName);
          if (filePath !== null && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        manifest.items = manifest.items.filter(
          (entry) => entry.stem !== resourceKey,
        );
        writeManifest(datasetDir, manifest);
        res.writeHead(204);
        res.end();
        return;
      }

      if (resource === "labels" && resourceKey && method === "PUT") {
        const ext = path.extname(resourceKey).toLowerCase();
        if (!LABEL_EXTENSIONS.has(ext)) {
          sendError(res, 400, "unsupported label type");
          return;
        }
        // An item that only has an image gets its label file on first save, so
        // freshly imported images can be annotated right away.
        const existingForFile = manifest.items.find(
          (entry) => entry.labels === resourceKey,
        );
        const waitingForLabels =
          existingForFile ??
          manifest.items.find(
            (entry) => entry.stem === stemOf(resourceKey) && !entry.labels,
          );
        if (!waitingForLabels) {
          sendError(res, 404, "label file not found in dataset");
          return;
        }
        const filePath = resolveWithin(datasetDir, "labels", resourceKey);
        if (filePath === null) {
          sendError(res, 400, "invalid label file name");
          return;
        }
        fs.writeFileSync(filePath, await readBody(req), "utf8");
        if (waitingForLabels.labels !== resourceKey) {
          waitingForLabels.labels = resourceKey;
          writeManifest(datasetDir, manifest);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      next();
    };

    handle().catch((error: unknown) => {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "dataset server error",
      );
    });
  };
}

export function datasetServerPlugin(): Plugin {
  return {
    name: "rec-dataset-server",
    configureServer(server) {
      const rootDir = path.resolve(process.cwd(), "datasets");
      fs.mkdirSync(rootDir, { recursive: true });
      server.middlewares.use(createDatasetMiddleware(rootDir));
    },
    configurePreviewServer(server) {
      const rootDir = path.resolve(process.cwd(), "datasets");
      fs.mkdirSync(rootDir, { recursive: true });
      server.middlewares.use(createDatasetMiddleware(rootDir));
    },
  };
}
