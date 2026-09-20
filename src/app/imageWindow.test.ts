import { afterEach, expect, it, vi } from "vitest";
import { ImageWindow } from "./imageWindow";

afterEach(() => vi.unstubAllGlobals());

it("loads the current image first, then only its neighbors, and releases outside the window", async () => {
  const images: { src: string; onload: (() => void) | null; onerror: (() => void) | null; naturalWidth: number; naturalHeight: number }[] = [];
  vi.stubGlobal("Image", class {
    src = ""; onload = null; onerror = null; naturalWidth = 100; naturalHeight = 80;
    constructor() { images.push(this); }
  });
  const cache = new ImageWindow(1);
  const resources = ["a", "b", "c", "d", "e"].map(name => ({ url: `/${name}.jpg`, name }));
  const current = cache.focus(resources, 2);
  expect(images.map(i => i.src)).toEqual(["/c.jpg"]);
  images[0]!.onload!();
  expect(await current).toMatchObject({ name: "c", width: 100 });
  cache.prefetch();
  expect(images.map(i => i.src)).toEqual(["/c.jpg", "/d.jpg", "/b.jpg"]);
  images[1]!.onload!(); images[2]!.onload!();
  await cache.focus(resources, 3);
  cache.prefetch();
  expect(images[2]!.src).toBe("");
  expect(images.map(i => i.src).filter(Boolean)).toEqual(["/c.jpg", "/d.jpg", "/e.jpg"]);
  cache.clear();
  expect(images.every(i => i.src === "")).toBe(true);
});

it("cancels stale requests and allows failed images to be retried", async () => {
  const images: any[] = [];
  vi.stubGlobal("Image", class {
    src = ""; onload = null; onerror = null; naturalWidth = 100; naturalHeight = 80;
    constructor() { images.push(this); }
  });
  const cache = new ImageWindow();
  const pending = cache.focus([{ url: "/a", name: "a" }], 0);
  const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  cache.clear(); await aborted;
  const failed = cache.focus([{ url: "/b", name: "b" }], 0);
  const failure = expect(failed).rejects.toThrow("Could not decode");
  images[1].onerror(); await failure;
  const retry = cache.focus([{ url: "/b", name: "b" }], 0);
  images[2].onload();
  await expect(retry).resolves.toMatchObject({ name: "b" });
  cache.clear();
});

it("waits for decode and prefetches a fifteen-image window with at most two background loads", async () => {
  const images: any[] = [];
  let finishDecode!: () => void;
  vi.stubGlobal("Image", class {
    src = ""; onload = null; onerror = null; naturalWidth = 100; naturalHeight = 80;
    decode = vi.fn(() => new Promise<void>(resolve => { finishDecode = resolve; }));
    constructor() { images.push(this); }
  });
  const cache = new ImageWindow();
  const resources = Array.from({length: 19}, (_, i) => ({url: `/${i}`, name: String(i)}));
  let ready = false;
  const current = cache.focus(resources, 9).then(() => { ready = true; });
  images[0].onload();
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(images[0].decode).toHaveBeenCalledOnce();
  finishDecode(); await current;
  cache.prefetch();
  expect(images.map(i => i.src)).toEqual(["/9", "/10", "/8"]);
  for (let i = 1; i < 15; i++) {
    images[i].onload(); await Promise.resolve(); finishDecode();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(images.map(i => i.src)).toEqual(["/9", "/10", "/8", "/11", "/7", "/12", "/6", "/13", "/5", "/14", "/4", "/15", "/3", "/16", "/2"]);
  cache.clear();
});
