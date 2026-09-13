import {
  createStagedFile,
  markDuplicateStems,
  readStagedDatasetFile,
  revokeStagedFiles,
  stagedFilesToUploadItems,
  stagedFilesSummary,
  type StagedDatasetFile,
} from "./datasetStaging";

function mockImageEnvironment(
  outcomes: readonly ({ width: number; height: number } | "error")[],
) {
  const OriginalURL = globalThis.URL;
  let urlNumber = 0;
  let outcomeNumber = 0;
  const createObjectURL = vi.fn((_blob: Blob) => `blob:staged-${++urlNumber}`);
  const revokeObjectURL = vi.fn();
  class MockURL extends OriginalURL {}
  Object.defineProperties(MockURL, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal("URL", MockURL);

  class MockImage {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;

    set src(_value: string) {
      const outcome = outcomes[outcomeNumber++];
      queueMicrotask(() => {
        if (!outcome || outcome === "error") {
          this.onerror?.();
          return;
        }
        this.naturalWidth = outcome.width;
        this.naturalHeight = outcome.height;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", MockImage);

  return { createObjectURL, revokeObjectURL };
}

function textFile(contents: string, name: string): File {
  return new File([contents], name, { type: "text/plain" });
}

describe("createStagedFile", () => {
  it("recognizes images, labels and unsupported files", () => {
    expect(createStagedFile(new File(["x"], "a.jpg"), "one").kind).toBe("image");
    expect(createStagedFile(new File(["x"], "a.jsonl"), "two").kind).toBe(
      "labels",
    );
    expect(createStagedFile(new File(["x"], "a.txt"), "three").kind).toBe(
      "labels",
    );
    expect(createStagedFile(new File(["x"], "a.pdf"), "four")).toMatchObject({
      kind: null,
      status: "error",
      error: "Unsupported file type — use an image or a .txt/.jsonl label file.",
    });
  });

  it("keeps the stem so image and labels pair up", () => {
    expect(createStagedFile(new File(["x"], "DJI_0001.JPG"), "one").stem).toBe(
      "DJI_0001",
    );
    expect(
      createStagedFile(new File(["x"], "DJI_0001.jsonl"), "two").stem,
    ).toBe("DJI_0001");
  });
});

describe("readStagedDatasetFile", () => {
  it("decodes an image and reports its size with a preview URL", async () => {
    const { createObjectURL } = mockImageEnvironment([
      { width: 3840, height: 2160 },
    ]);
    const staged = await readStagedDatasetFile(
      createStagedFile(new File(["bytes"], "a.jpg"), "one"),
    );

    expect(staged).toMatchObject({
      status: "ready",
      detail: "3840 × 2160",
      previewUrl: "blob:staged-1",
      error: null,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("fails an image that cannot be decoded and releases its preview", async () => {
    const { revokeObjectURL } = mockImageEnvironment(["error"]);
    const staged = await readStagedDatasetFile(
      createStagedFile(new File(["bytes"], "broken.png"), "one"),
    );

    expect(staged.status).toBe("error");
    expect(staged.error).toBe("Could not decode this image.");
    expect(staged.previewUrl).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:staged-1");
  });

  it("counts the boxes of a TXT label file", async () => {
    const staged = await readStagedDatasetFile(
      createStagedFile(
        textFile("10 20 70 90 person 0\n0 0 10 10 bicycle 0", "a.txt"),
        "one",
      ),
    );

    expect(staged).toMatchObject({ status: "ready", detail: "2 boxes" });
  });

  it("counts the targets of a JSONL label file", async () => {
    const staged = await readStagedDatasetFile(
      createStagedFile(
        textFile(
          '{"expression": "boats", "targets": [[1, 2, 3, 4], [5, 6, 7, 8]]}',
          "a.jsonl",
        ),
        "one",
      ),
    );

    expect(staged).toMatchObject({ status: "ready", detail: "2 boxes" });
  });

  it("reports the failing line of a broken label file", async () => {
    const staged = await readStagedDatasetFile(
      createStagedFile(textFile("10 10 5 5 broken 0", "a.txt"), "one"),
    );

    expect(staged.status).toBe("error");
    expect(staged.error).toBe("Line 1: invalid bounding box");
    expect(staged.detail).toBeNull();
  });

  it("mentions a single box in the singular", async () => {
    const staged = await readStagedDatasetFile(
      createStagedFile(textFile("10 20 70 90 person 0", "a.txt"), "one"),
    );
    expect(staged.detail).toBe("1 box");
  });
});

describe("markDuplicateStems", () => {
  const staged = (id: string, name: string, kind: "image" | "labels"): StagedDatasetFile => ({
    ...createStagedFile(new File(["x"], name), id),
    kind,
    status: "ready",
    detail: "1 box",
  });

  it("flags a second file with the same stem and kind", () => {
    const marked = markDuplicateStems([
      staged("one", "a.jpg", "image"),
      staged("two", "a.png", "image"),
      staged("three", "a.jsonl", "labels"),
    ]);

    expect(marked.map((file) => file.status)).toEqual([
      "ready",
      "error",
      "ready",
    ]);
    expect(marked[1]?.error).toBe(
      "Another image of this item is already in the list.",
    );
  });
});

describe("stagedFilesToUploadItems", () => {
  it("pairs ready images and labels by stem and skips failures", () => {
    const files: StagedDatasetFile[] = [
      { ...createStagedFile(new File(["x"], "a.jpg"), "one"), status: "ready" },
      {
        ...createStagedFile(new File(["x"], "a.txt"), "two"),
        status: "ready",
      },
      {
        ...createStagedFile(new File(["x"], "b.jpg"), "three"),
        status: "error",
        error: "boom",
      },
      {
        ...createStagedFile(new File(["x"], "c.jsonl"), "four"),
        status: "reading",
      },
    ];

    const items = stagedFilesToUploadItems(files);

    expect(items).toEqual([
      {
        stem: "a",
        image: expect.objectContaining({ name: "a.jpg" }),
        labels: expect.objectContaining({ name: "a.txt" }),
      },
    ]);
  });
});

describe("stagedFilesSummary", () => {
  it("describes loading, ready, and failed files", () => {
    const reading: StagedDatasetFile = {
      ...createStagedFile(new File(["x"], "a.jpg"), "one"),
      status: "reading",
    };
    const ready: StagedDatasetFile = { ...reading, status: "ready" };
    const failed: StagedDatasetFile = {
      ...reading,
      status: "error",
      error: "boom",
    };

    expect(stagedFilesSummary([reading, ready])).toBe(
      "Reading files… · 1 ready",
    );
    expect(stagedFilesSummary([ready, ready])).toBe("2 files ready to import");
    expect(stagedFilesSummary([ready, failed])).toBe(
      "1 ready · 1 needs attention",
    );
    expect(stagedFilesSummary([])).toBeNull();
  });
});

describe("revokeStagedFiles", () => {
  it("releases every preview URL", () => {
    const { revokeObjectURL } = mockImageEnvironment([]);
    revokeStagedFiles([
      {
        ...createStagedFile(new File(["x"], "a.jpg"), "one"),
        previewUrl: "blob:staged-1",
      },
      {
        ...createStagedFile(new File(["x"], "b.jpg"), "two"),
        previewUrl: null,
      },
    ]);

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:staged-1");
  });
});
