import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";

// Share concurrent requests (including React development remounts).
const pending = new Map<string, Promise<Buffer>>();

export async function serveThumbnail(
  req: IncomingMessage,
  res: ServerResponse,
  source: string,
): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const version = createHash("sha256")
    .update(`webp-480-v1:${source}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    .digest("hex");
  const etag = `"${version}"`;
  // Cache the bytes, but revalidate so replacing an image is visible immediately.
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"]?.split(",").some((tag) =>
    tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*")) {
    res.writeHead(304).end();
    return;
  }
  const cacheDir = path.join(path.dirname(source), "..", ".thumbnails");
  const cacheFile = path.join(cacheDir, `${version}.webp`);
  let job = pending.get(cacheFile);
  if (!job) {
    job = (async () => {
      try {
        return await fs.readFile(cacheFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = await sharp(await fs.readFile(source))
        .rotate()
        .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      await fs.mkdir(cacheDir, { recursive: true });
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, cacheFile);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return bytes;
    })();
    pending.set(cacheFile, job);
  }
  try {
    const bytes = await job;
    res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": bytes.length });
    res.end(bytes);
  } catch {
    // Never fall back to downloading a potentially huge original on the home page.
    res.removeHeader("ETag");
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(422).end("Could not generate thumbnail");
  } finally {
    if (pending.get(cacheFile) === job) pending.delete(cacheFile);
  }
}
