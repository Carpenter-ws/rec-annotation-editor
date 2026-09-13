import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatasetMiddleware,
  isValidSegment,
  resolveWithin,
} from "./datasetServer";

const imageBase64 = Buffer.from("fake-jpeg-bytes").toString("base64");

describe("isValidSegment", () => {
  it("accepts ordinary file and dataset names", () => {
    expect(isValidSegment("DJI_0001_W")).toBe(true);
    expect(isValidSegment("a.jsonl")).toBe(true);
    expect(isValidSegment("数据集 1")).toBe(true);
  });

  it("rejects traversal and unsafe names", () => {
    expect(isValidSegment("..")).toBe(false);
    expect(isValidSegment("a/b")).toBe(false);
    expect(isValidSegment("a\\b")).toBe(false);
    expect(isValidSegment("a..b/../c")).toBe(false);
    expect(isValidSegment("")).toBe(false);
  });
});

describe("resolveWithin", () => {
  it("keeps resolved paths inside the root", () => {
    const root = path.resolve(os.tmpdir(), "rec-root");
    expect(resolveWithin(root, "d1", "images", "a.jpg")).toBe(
      path.join(root, "d1", "images", "a.jpg"),
    );
    expect(resolveWithin(root, "..", "escape.txt")).toBeNull();
    expect(resolveWithin(root, "d1", "..", "..", "escape.txt")).toBeNull();
  });
});

describe("dataset middleware", () => {
  let rootDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-datasets-"));
    server = http.createServer((req, res) => {
      createDatasetMiddleware(rootDir)(req, res, () => {
        res.writeHead(404);
        res.end("fallthrough");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const createDataset = async (name: string) =>
    fetch(`${baseUrl}/api/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

  const uploadItem = async (name: string) =>
    fetch(`${baseUrl}/api/datasets/${name}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            image: { name: "a.jpg", data: imageBase64 },
            labels: {
              name: "a.jsonl",
              text: '{"expression": "x", "targets": [[0, 0, 5, 5]]}',
            },
          },
        ],
      }),
    });

  it("creates a dataset once and rejects duplicate names", async () => {
    const created = await createDataset("dji");
    expect(created.status).toBe(201);
    const duplicate = await createDataset("dji");
    expect(duplicate.status).toBe(409);
    const invalid = await createDataset("../escape");
    expect(invalid.status).toBe(400);
  });

  it("stores uploaded pairs and serves them statically", async () => {
    await createDataset("dji");
    const uploaded = await uploadItem("dji");
    expect(uploaded.status).toBe(200);
    const manifest = (await uploaded.json()) as {
      items: { stem: string; image: string; labels: string }[];
    };
    expect(manifest.items).toEqual([
      { stem: "a", image: "a.jpg", labels: "a.jsonl" },
    ]);

    expect(
      fs.readFileSync(path.join(rootDir, "dji", "images", "a.jpg"), "utf8"),
    ).toBe("fake-jpeg-bytes");
    expect(
      fs.readFileSync(path.join(rootDir, "dji", "labels", "a.jsonl"), "utf8"),
    ).toContain('"expression": "x"');

    const imageResponse = await fetch(`${baseUrl}/datasets/dji/images/a.jpg`);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/jpeg");
    expect(await imageResponse.text()).toBe("fake-jpeg-bytes");

    const labelsResponse = await fetch(
      `${baseUrl}/datasets/dji/labels/a.jsonl`,
    );
    expect(await labelsResponse.text()).toContain('"expression": "x"');
  });

  it("merges separately uploaded images and labels into one item", async () => {
    await createDataset("dji");

    const imagesOnly = await fetch(`${baseUrl}/api/datasets/dji/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ image: { name: "a.jpg", data: imageBase64 } }],
      }),
    });
    expect(imagesOnly.status).toBe(200);
    expect(((await imagesOnly.json()) as { items: unknown[] }).items).toEqual([
      { stem: "a", image: "a.jpg", labels: null },
    ]);

    const labelsOnly = await fetch(`${baseUrl}/api/datasets/dji/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            labels: {
              name: "a.jsonl",
              text: '{"expression": "later", "targets": [[1, 2, 3, 4]]}',
            },
          },
        ],
      }),
    });
    expect(labelsOnly.status).toBe(200);
    expect(((await labelsOnly.json()) as { items: unknown[] }).items).toEqual([
      { stem: "a", image: "a.jpg", labels: "a.jsonl" },
    ]);
    expect(
      fs.readFileSync(path.join(rootDir, "dji", "labels", "a.jsonl"), "utf8"),
    ).toContain('"later"');
    expect(
      fs.readFileSync(path.join(rootDir, "dji", "images", "a.jpg"), "utf8"),
    ).toBe("fake-jpeg-bytes");

    const served = await fetch(`${baseUrl}/datasets/dji/images/a.jpg`);
    expect(served.status).toBe(200);
  });

  it("rejects an item that carries neither half", async () => {
    await createDataset("dji");
    const response = await fetch(`${baseUrl}/api/datasets/dji/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ stem: "a" }] }),
    });
    expect(response.status).toBe(400);
  });

  it("lists datasets with their manifests", async () => {
    await createDataset("dji");
    await uploadItem("dji");

    const response = await fetch(`${baseUrl}/api/datasets`);
    const datasets = (await response.json()) as {
      name: string;
      items: unknown[];
    }[];
    expect(datasets).toEqual([
      { name: "dji", items: [{ stem: "a", image: "a.jpg", labels: "a.jsonl" }] },
    ]);
  });

  it("writes label edits back to the dataset file", async () => {
    await createDataset("dji");
    await uploadItem("dji");

    const response = await fetch(`${baseUrl}/api/datasets/dji/labels/a.jsonl`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: '{"expression": "edited", "targets": [[1, 2, 3, 4]]}',
    });
    expect(response.status).toBe(204);
    expect(
      fs.readFileSync(path.join(rootDir, "dji", "labels", "a.jsonl"), "utf8"),
    ).toContain('"edited"');
  });

  it("deletes items and whole datasets", async () => {
    await createDataset("dji");
    await uploadItem("dji");

    const deleteItem = await fetch(`${baseUrl}/api/datasets/dji/items/a`, {
      method: "DELETE",
    });
    expect(deleteItem.status).toBe(204);
    expect(
      fs.existsSync(path.join(rootDir, "dji", "images", "a.jpg")),
    ).toBe(false);

    const deleteDataset = await fetch(`${baseUrl}/api/datasets/dji`, {
      method: "DELETE",
    });
    expect(deleteDataset.status).toBe(204);
    expect(fs.existsSync(path.join(rootDir, "dji"))).toBe(false);
  });

  it("blocks traversal outside the datasets root", async () => {
    fs.writeFileSync(path.join(rootDir, "secret.txt"), "top secret");
    const escaped = await fetch(
      `${baseUrl}/datasets/dji/images/..%2F..%2Fsecret.txt`,
    );
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("top secret");

    const inner = await fetch(
      `${baseUrl}/datasets/dji/..%2Fsecret.txt`,
    );
    expect(inner.status).toBe(404);
    expect(await inner.text()).not.toContain("top secret");
  });
});
