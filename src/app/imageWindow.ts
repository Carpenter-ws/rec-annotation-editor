import type { ImageInfo } from "../domain/types";

interface Resource { url: string; name: string }
interface Entry {
  image: HTMLImageElement;
  promise: Promise<ImageInfo>;
  pending: boolean;
  cancel: () => void;
}

/** Retains decoded originals around the canvas; two background requests at most. */
export class ImageWindow {
  private entries = new Map<string, Entry>();
  private neighbors: Resource[] = [];
  private queue: Resource[] = [];
  constructor(private readonly radius = 7) {}

  focus(resources: readonly Resource[], index: number): Promise<ImageInfo> {
    const current = resources[index];
    if (!current) return Promise.reject(new Error("Image not found"));
    this.queue = [];
    const window = resources.slice(Math.max(0, index - this.radius), index + this.radius + 1);
    const allowed = new Set(window.map(item => item.url));
    for (const [url, entry] of this.entries) {
      if (!allowed.has(url)) { entry.cancel(); this.entries.delete(url); }
      else entry.image.fetchPriority = "low";
    }
    this.neighbors = [];
    for (let offset = 1; offset <= this.radius; offset++) {
      for (const at of [index + offset, index - offset]) {
        if (resources[at]) this.neighbors.push(resources[at]!);
      }
    }
    return this.load(current, "high");
  }

  prefetch(): void {
    this.queue = this.neighbors.filter(item => !this.entries.has(item.url));
    this.pump();
  }

  private pump(): void {
    while (this.queue.length && [...this.entries.values()].filter(entry =>
      entry.pending && entry.image.fetchPriority !== "high").length < 2) {
      void this.load(this.queue.shift()!, "low").catch(() => {});
    }
  }

  clear(): void {
    this.queue = [];
    this.neighbors = [];
    for (const entry of this.entries.values()) entry.cancel();
    this.entries.clear();
  }

  private load(resource: Resource, priority: "high" | "low"): Promise<ImageInfo> {
    const existing = this.entries.get(resource.url);
    if (existing) { existing.image.fetchPriority = priority; return existing.promise; }
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = priority;
    let active = true;
    let rejectLoad: (error: Error) => void = () => {};
    const promise = new Promise<ImageInfo>((resolve, reject) => {
      rejectLoad = reject;
      image.onload = () => {
        void (async () => {
          // Download completion alone does not make a large image ready to draw.
          if (typeof image.decode === "function") await image.decode();
          if (!active) return;
          if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("Invalid dimensions");
          resolve({ ...resource, width: image.naturalWidth, height: image.naturalHeight });
        })().catch(() => { if (active) image.onerror?.(new Event("error")); });
      };
      image.onerror = () => {
        this.entries.delete(resource.url);
        reject(new Error(`Could not decode image "${resource.name}".`));
      };
    });
    const entry: Entry = {
      image, promise, pending: true,
      cancel: () => {
        active = false;
        image.onload = null; image.onerror = null;
        image.src = "";
        rejectLoad(new DOMException("Image request cancelled", "AbortError"));
      },
    };
    this.entries.set(resource.url, entry);
    const settled = () => { entry.pending = false; this.pump(); };
    void promise.then(settled, settled);
    image.src = resource.url;
    return promise;
  }
}
