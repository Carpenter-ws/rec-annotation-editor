import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_TIMEOUT_MS,
  createDataset,
  datasetImageUrl,
  datasetLabelsUrl,
  deleteDataset,
  deleteDatasetItem,
  listDatasets,
  planDatasetUpload,
  saveDatasetLabels,
  uploadDatasetItems,
  type DatasetSummary,
} from "./datasetApi";

function textFile(contents: string, name: string): File {
  return new File([contents], name, { type: "text/plain" });
}

function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    handler(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planDatasetUpload", () => {
  it("pairs images and labels by file stem within one batch", () => {
    const result = planDatasetUpload([
      textFile("a", "DJI_0001_W.jsonl"),
      textFile("b", "DJI_0002_W.txt"),
      textFile("c", "DJI_0001_W.jpg"),
      textFile("d", "DJI_0002_W.PNG"),
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      stem: "DJI_0001_W",
      image: expect.objectContaining({ name: "DJI_0001_W.jpg" }),
      labels: expect.objectContaining({ name: "DJI_0001_W.jsonl" }),
    });
    expect(result.items[1]?.stem).toBe("DJI_0002_W");
    expect(result.unsupported).toEqual([]);
  });

  it("accepts an images-only batch", () => {
    const result = planDatasetUpload([
      textFile("a", "scene.jpg"),
      textFile("b", "scene-2.png"),
    ]);

    expect(result.items.map((item) => item.stem)).toEqual(["scene", "scene-2"]);
    expect(result.items[0]?.image).toBeDefined();
    expect(result.items[0]?.labels).toBeUndefined();
    expect(result.unsupported).toEqual([]);
  });

  it("accepts a labels-only batch", () => {
    const result = planDatasetUpload([
      textFile("a", "scene.jsonl"),
      textFile("b", "another.txt"),
    ]);

    expect(result.items.map((item) => item.stem)).toEqual([
      "scene",
      "another",
    ]);
    expect(result.items[0]?.image).toBeUndefined();
    expect(result.items[0]?.labels).toBeDefined();
    expect(result.unsupported).toEqual([]);
  });

  it("reports unsupported files and duplicate stems in one batch", () => {
    const result = planDatasetUpload([
      textFile("a", "scene.jpg"),
      textFile("b", "scene.jpg"),
      textFile("c", "notes.pdf"),
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.unsupported.map((file) => file.name)).toEqual([
      "scene.jpg",
      "notes.pdf",
    ]);
  });
});

describe("dataset API calls", () => {
  it("lists datasets from the server", async () => {
    const datasets: DatasetSummary[] = [
      { name: "dji", items: [{ stem: "a", image: "a.jpg", labels: "a.jsonl" }] },
    ];
    const fetchMock = mockFetch((url) => {
      expect(url).toBe("/api/datasets");
      return Response.json(datasets);
    });

    await expect(listDatasets()).resolves.toEqual(datasets);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("creates and deletes datasets with encoded names", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (init?.method === "POST") {
        expect(url).toBe("/api/datasets");
        expect(init.body).toBe(JSON.stringify({ name: "my set" }));
        return new Response(null, { status: 201 });
      }
      expect(url).toBe("/api/datasets/my%20set");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    await createDataset("my set");
    await deleteDataset("my set");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uploads paired items with image bytes and label text", async () => {
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe("/api/datasets/dji/items");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.items).toHaveLength(1);
      expect(body.items[0].image.name).toBe("a.jpg");
      expect(atob(body.items[0].image.data)).toBe("image-bytes");
      expect(body.items[0].labels.name).toBe("a.jsonl");
      expect(body.items[0].labels.text).toBe("labels");
      return Response.json({ name: "dji", items: [] });
    });

    const imageFile = new File(["image-bytes"], "a.jpg", { type: "image/jpeg" });
    const labelsFile = textFile("labels", "a.jsonl");
    await uploadDatasetItems("dji", [
      { stem: "a", image: imageFile, labels: labelsFile },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uploads image-only and label-only batches without the other half", async () => {
    const payloads: { image?: unknown; labels?: unknown }[] = [];
    const fetchMock = mockFetch(async (url, init) => {
      expect(url).toBe("/api/datasets/dji/items");
      const body = JSON.parse(String(init?.body));
      payloads.push(body.items[0]);
      return Response.json({ name: "dji", items: [] });
    });

    await uploadDatasetItems("dji", [
      {
        stem: "a",
        image: new File(["image-bytes"], "a.jpg", { type: "image/jpeg" }),
      },
    ]);
    await uploadDatasetItems("dji", [
      { stem: "a", labels: textFile("labels", "a.jsonl") },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloads[0]?.image).toBeDefined();
    expect(payloads[0]?.labels).toBeUndefined();
    expect(payloads[1]?.image).toBeUndefined();
    expect(payloads[1]?.labels).toBeDefined();
  });

  it("saves label text back to the dataset", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe("/api/datasets/dji/labels/a.jsonl");
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe("edited labels");
      return new Response(null, { status: 204 });
    });

    await saveDatasetLabels("dji", "a.jsonl", "edited labels");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deletes a dataset item", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe("/api/datasets/dji/items/a");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    await deleteDatasetItem("dji", "a");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces server error messages", async () => {
    mockFetch(() => Response.json({ error: "dataset name is taken" }, { status: 409 }));

    await expect(createDataset("dji")).rejects.toThrow("dataset name is taken");
  });

  it("gives up on a server that accepts the call but never answers", async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const call = listDatasets();
    const assertion = expect(call).rejects.toThrow(/did not answer within/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await assertion;
    vi.useRealTimers();
  });

  it("builds static asset URLs", () => {
    expect(datasetImageUrl("dji", "a.jpg")).toBe("/datasets/dji/images/a.jpg");
    expect(datasetLabelsUrl("dji", "a.jsonl")).toBe(
      "/datasets/dji/labels/a.jsonl",
    );
  });
});
