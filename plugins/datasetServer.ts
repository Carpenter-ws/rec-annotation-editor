import fs from "node:fs";
import { serveThumbnail } from "./thumbnails";
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
    // 255 is the longest a single file system component can be. Imported data
    // often carries long generated names, and those still have to be served.
    segment.length <= 255 &&
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

/**
 * Review states of one image. `pending` is the default, so it is never stored:
 * `review.json` only holds the images that were actually moved on.
 *
 * It lives next to `dataset.json` as its own file: the manifest describes which
 * files pair up, the review file records what humans decided about them, and
 * keeping them apart means a review pass can be diffed, backed up, or produced
 * by another tool without touching the annotation data.
 */
export const REVIEW_STATUSES = ["approved", "pending", "rejected"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ReviewEntry {
  status: ReviewStatus;
  /** ISO timestamp of the last change, for auditing an iteration. */
  updatedAt: string;
}

export interface ReviewFile {
  /** Bumped when the shape below changes, so older files stay readable. */
  version: number;
  items: Record<string, ReviewEntry>;
}

const REVIEW_FILE = "review.json";

export function readReview(datasetDir: string): ReviewFile {
  try {
    const raw = fs
      .readFileSync(path.join(datasetDir, REVIEW_FILE), "utf8")
      .replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as ReviewFile;
    if (parsed && typeof parsed === "object" && parsed.items) {
      return { version: parsed.version ?? 1, items: parsed.items };
    }
  } catch {
    // Missing or corrupt: every image simply counts as pending.
  }
  return { version: 1, items: {} };
}

export function writeReview(datasetDir: string, review: ReviewFile): void {
  fs.writeFileSync(
    path.join(datasetDir, REVIEW_FILE),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8",
  );
}

/** Status of one image; anything never reviewed is still pending. */
export function reviewStatusOf(review: ReviewFile, stem: string): ReviewStatus {
  const entry = review.items[stem];
  if (!entry) return "pending";
  return REVIEW_STATUSES.some((status) => status === entry.status)
    ? entry.status
    : "pending";
}

/** Tags every item with its review status, for the editor to show. */
export function withReview(datasetDir: string, manifest: Manifest): Manifest {
  const review = readReview(datasetDir);
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      review: reviewStatusOf(review, item.stem),
    })),
  };
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
      // Stems are compared case-insensitively so a file that differs only in
      // case still pairs with the item that owns it.
      const stem = stemOf(name).toLocaleLowerCase();
      if (!byStem.has(stem)) byStem.set(stem, name);
    }
  } catch {
    // Missing folder: nothing is stored under it yet.
  }
  return byStem;
}

/** The files one item owns, gathered by the stem they share. */
interface StemFiles {
  stem: string;
  image: string | null;
  labels: string | null;
  originals: string | null;
}

/** Groups every stored file of a dataset by the stem it belongs to. */
function filesByItemStem(
  listings: Record<DatasetFolder, Map<string, string>>,
): Map<string, StemFiles> {
  const byStem = new Map<string, StemFiles>();
  for (const folder of DATASET_FOLDERS) {
    const key = ITEM_KEYS[folder];
    for (const [stemKey, fileName] of listings[folder]) {
      const entry: StemFiles = byStem.get(stemKey) ?? {
        stem: stemOf(fileName),
        image: null,
        labels: null,
        originals: null,
      };
      entry[key] = fileName;
      // An image names the item; without one its labels do.
      if (folder === "images") entry.stem = stemOf(fileName);
      byStem.set(stemKey, entry);
    }
  }
  return byStem;
}

/** A folder is a dataset when it holds a manifest or any of its roles. */
export function isDatasetDir(datasetDir: string): boolean {
  if (fs.existsSync(path.join(datasetDir, "dataset.json"))) return true;
  return DATASET_FOLDERS.some((folder) =>
    fs.existsSync(path.join(datasetDir, folder)),
  );
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

  const known = new Set(
    manifest.items.map((item) => item.stem.toLocaleLowerCase()),
  );
  let changed = false;
  const items = manifest.items.map((item) => {
    const stemKey = item.stem.toLocaleLowerCase();
    const next: ManifestItem = { ...item };
    for (const folder of DATASET_FOLDERS) {
      const key = ITEM_KEYS[folder];
      const recorded = next[key] ?? null;
      const recordedPath =
        recorded === null ? null : resolveWithin(datasetDir, folder, recorded);
      const stored =
        recordedPath !== null && fs.existsSync(recordedPath)
          ? recorded
          : (listings[folder].get(stemKey) ?? null);
      // Older manifests lack a field entirely; writing the canonical shape back
      // keeps the stored file and the served one in sync.
      if (stored !== recorded || !(key in next)) changed = true;
      next[key] = stored;
    }
    return next;
  });

  // Files that no item owns yet — dropped into the folders by an import script
  // or by hand — become items of their own, so the dataset shows everything it
  // actually holds.
  for (const [stemKey, entry] of filesByItemStem(listings)) {
    if (known.has(stemKey)) continue;
    known.add(stemKey);
    changed = true;
    items.push({
      stem: entry.stem,
      image: entry.image,
      labels: entry.labels,
      originals: entry.originals,
    });
  }

  // An item whose files are all gone is a leftover of a re-import or a cleanup:
  // the manifest lets it go, so the dataset only shows what it can serve. The
  // files are the source of truth here, nothing but bookkeeping is dropped.
  const kept = items.filter(
    (item) =>
      item.image !== null || item.labels !== null || item.originals !== null,
  );
  if (kept.length !== items.length) changed = true;

  const reconciled: Manifest = { ...manifest, items: kept };
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

    if (method === "GET" && url.startsWith("/thumbnails/")) {
      const segments = url.slice("/thumbnails/".length).split("/");
      const [name, fileName] = segments;
      if (segments.length !== 2 || !name || !fileName ||
          !isValidSegment(name) || !isValidSegment(fileName)) {
        sendError(res, 400, "invalid thumbnail path");
        return;
      }
      const source = resolveWithin(rootDir, name, "images", fileName);
      if (!source || !IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
        sendError(res, 404, "image not found");
        return;
      }
      void serveThumbnail(req, res, source).catch(() => {
        if (!res.headersSent) sendError(res, 500, "thumbnail server error");
        else res.destroy();
      });
      return;
    }

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
          // A folder that was imported on the server side has no manifest yet;
          // it still counts as a dataset so the editor can show it.
          .filter((entry) => isDatasetDir(path.join(rootDir, entry.name)))
          .map((entry) => {
            const datasetDir = path.join(rootDir, entry.name);
            return withReview(
              datasetDir,
              loadManifest(datasetDir, entry.name),
            );
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
        /^\/api\/datasets\/([^/]+)(?:\/(items|labels|review)(?:\/([^/]+))?)?$/,
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
        // The review decision goes with the image it belongs to.
        const review = readReview(datasetDir);
        if (review.items[resourceKey] !== undefined) {
          delete review.items[resourceKey];
          writeReview(datasetDir, review);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (resource === "review" && resourceKey && method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          status?: string;
        };
        const status = body.status;
        if (!REVIEW_STATUSES.some((known) => known === status)) {
          sendError(res, 400, "invalid review status");
          return;
        }
        if (!manifest.items.some((entry) => entry.stem === resourceKey)) {
          sendError(res, 404, "item not found in dataset");
          return;
        }
        const review = readReview(datasetDir);
        if (status === "pending") {
          // The default is not stored, so the file only lists real decisions.
          delete review.items[resourceKey];
        } else {
          review.items[resourceKey] = {
            status: status as ReviewStatus,
            updatedAt: new Date().toISOString(),
          };
        }
        writeReview(datasetDir, review);
        sendJson(res, 200, { stem: resourceKey, status });
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
