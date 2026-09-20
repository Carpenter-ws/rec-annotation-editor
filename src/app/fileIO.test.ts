import {
  downloadText,
  loadImageFile,
  partitionDroppedFiles,
  pickTextFile,
  readTextFile,
  saveTextAs,
  writeTextToHandle,
} from "./fileIO";

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("downloadText", () => {
  const OriginalURL = globalThis.URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads the requested contents, name, and MIME through a temporary object URL", async () => {
    let downloadedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return "blob:download";
    });
    const revokeObjectURL = vi.fn();
    class MockURL extends OriginalURL {}
    Object.defineProperties(MockURL, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal("URL", MockURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadText("annotation text", "scene-edited.txt", "text/plain");

    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("scene-edited.txt");
    expect(anchor.href).toBe("blob:download");
    expect(document.body).not.toContainElement(anchor);
    expect(downloadedBlob).not.toBeNull();
    expect(downloadedBlob!.type).toBe("text/plain");
    expect(await readBlob(downloadedBlob!)).toBe("annotation text");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("removes the temporary anchor and revokes its URL when clicking fails", () => {
    const createObjectURL = vi.fn(() => "blob:failed-download");
    const revokeObjectURL = vi.fn();
    class MockURL extends OriginalURL {}
    Object.defineProperties(MockURL, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal("URL", MockURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {
        throw new Error("click failed");
      });

    expect(() => downloadText("x", "x.txt", "text/plain")).toThrow(
      "click failed",
    );

    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(document.body).not.toContainElement(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-download");
  });
});

describe("writeTextToHandle", () => {
  it("writes the complete contents and closes the writable stream", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = {
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    };

    await writeTextToHandle(
      handle as unknown as FileSystemFileHandle,
      "annotation text",
    );

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("annotation text");
    expect(close).toHaveBeenCalledOnce();
  });

  it("commits the newest requested snapshot last for one retained handle", async () => {
    const firstClose = deferred<void>();
    const secondClose = deferred<void>();
    let diskContents = "";
    const writable = (closeGate: Promise<void>) => {
      let stagedContents = "";
      return {
        write: vi.fn(async (contents: FileSystemWriteChunkType) => {
          stagedContents = String(contents);
        }),
        close: vi.fn(async () => {
          await closeGate;
          diskContents = stagedContents;
        }),
      };
    };
    const handle = {
      createWritable: vi
        .fn()
        .mockResolvedValueOnce(writable(firstClose.promise))
        .mockResolvedValueOnce(writable(secondClose.promise)),
    };

    const saveA = writeTextToHandle(
      handle as unknown as FileSystemFileHandle,
      "snapshot A",
    );
    const saveB = writeTextToHandle(
      handle as unknown as FileSystemFileHandle,
      "snapshot B",
    );

    secondClose.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    firstClose.resolve();
    await Promise.all([saveA, saveB]);

    expect(diskContents).toBe("snapshot B");
  });

  it.each(["write", "close"] as const)(
    "continues the retained-handle queue after a %s rejection",
    async (failureStage) => {
      const failure = new Error(`${failureStage} failed`);
      let diskContents = "";
      const handle = {
        createWritable: vi
          .fn()
          .mockResolvedValueOnce({
            write:
              failureStage === "write"
                ? vi.fn().mockRejectedValue(failure)
                : vi.fn().mockResolvedValue(undefined),
            close:
              failureStage === "close"
                ? vi.fn().mockRejectedValue(failure)
                : vi.fn().mockResolvedValue(undefined),
          })
          .mockResolvedValueOnce({
            write: vi.fn(async (contents: FileSystemWriteChunkType) => {
              diskContents = String(contents);
            }),
            close: vi.fn().mockResolvedValue(undefined),
          }),
      };

      const failedSave = writeTextToHandle(
        handle as unknown as FileSystemFileHandle,
        "snapshot A",
      );
      const recoveredSave = writeTextToHandle(
        handle as unknown as FileSystemFileHandle,
        "snapshot B",
      );

      await expect(failedSave).rejects.toBe(failure);
      await expect(recoveredSave).resolves.toBeUndefined();
      expect(diskContents).toBe("snapshot B");
    },
  );
});

describe("saveTextAs", () => {
  const OriginalURL = globalThis.URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads through a temporary object URL when the save picker is unavailable", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const createObjectURL = vi.fn(() => "blob:fallback");
    const revokeObjectURL = vi.fn();
    class MockURL extends OriginalURL {}
    Object.defineProperties(MockURL, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal("URL", MockURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    await expect(
      saveTextAs("content", "scene-edited.txt", "text/plain"),
    ).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fallback");
  });

  it("uses a writable file handle when the save picker is available", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    });
    vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);

    await expect(
      saveTextAs("content", "scene-edited.txt", "text/plain"),
    ).resolves.toBe("saved");

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "scene-edited.txt",
    });
    expect(write).toHaveBeenCalledWith("content");
    expect(close).toHaveBeenCalledOnce();
  });

  it("treats AbortError as cancellation instead of an application error", async () => {
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn().mockRejectedValue(new DOMException("", "AbortError")),
    );

    await expect(
      saveTextAs("x", "x.txt", "text/plain"),
    ).resolves.toBe("cancelled");
  });

  it("propagates non-abort save failures", async () => {
    const failure = new Error("permission denied");
    vi.stubGlobal(
      "showSaveFilePicker",
      vi.fn().mockRejectedValue(failure),
    );

    await expect(saveTextAs("x", "x.txt", "text/plain")).rejects.toBe(
      failure,
    );
  });
});

describe("pickTextFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when the open picker is unavailable", async () => {
    vi.stubGlobal("showOpenFilePicker", undefined);

    await expect(pickTextFile()).resolves.toBeNull();
  });

  it("returns null when the open picker is cancelled", async () => {
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn().mockRejectedValue(new DOMException("", "AbortError")),
    );

    await expect(pickTextFile()).resolves.toBeNull();
  });

  it("returns null when the open picker returns no handle", async () => {
    vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([]));

    await expect(pickTextFile()).resolves.toBeNull();
  });

  it("returns the selected text file together with its writable handle", async () => {
    const file = new File(["0 0 10 10 person 0"], "picked.txt", {
      type: "text/plain",
    });
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal("showOpenFilePicker", showOpenFilePicker);

    await expect(pickTextFile()).resolves.toEqual({ file, handle });
    expect(showOpenFilePicker).toHaveBeenCalledWith({
      multiple: false,
      types: [
        {
          description: "Text files",
          accept: { "text/plain": [".txt"] },
        },
      ],
    });
    expect(handle.getFile).toHaveBeenCalledOnce();
  });

  it("propagates non-abort open-picker failures", async () => {
    const failure = new Error("picker failed");
    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn().mockRejectedValue(failure),
    );

    await expect(pickTextFile()).rejects.toBe(failure);
  });
});

describe("partitionDroppedFiles", () => {
  it("recognizes one image and one txt file regardless of drop order", () => {
    const files = [
      new File(["0 0 1 1 person 0"], "scene.txt", { type: "text/plain" }),
      new File(["image"], "scene.png", { type: "image/png" }),
    ];

    expect(partitionDroppedFiles(files)).toMatchObject({
      image: { name: "scene.png" },
      labels: { name: "scene.txt" },
      rejected: [],
    });
  });

  it("recognizes common image extensions and txt without case sensitivity", () => {
    const image = new File(["image"], "SCENE.JPEG");
    const labels = new File(["labels"], "SCENE.TXT");

    expect(partitionDroppedFiles([image, labels])).toEqual({
      image,
      labels,
      rejected: [],
    });
  });

  it("accepts an image MIME type when the extension is unknown", () => {
    const image = new File(["image"], "scene.data", { type: "image/png" });

    expect(partitionDroppedFiles([image])).toEqual({
      image,
      labels: undefined,
      rejected: [],
    });
  });

  it("rejects unsupported dropped files explicitly", () => {
    const archive = new File(["zip"], "scene.zip", {
      type: "application/zip",
    });

    expect(partitionDroppedFiles([archive]).rejected).toEqual([archive]);
  });

  it("treats a second label file as the original annotations", () => {
    const image = new File(["image"], "scene.png", { type: "image/png" });
    const labels = new File(["labels"], "scene.txt");
    const originals = new File(["222 462 321 575 boat"], "DJI_0133.txt", {
      type: "text/plain",
    });

    expect(partitionDroppedFiles([image, labels, originals])).toEqual({
      image,
      labels,
      reference: originals,
      rejected: [],
    });
  });

  it("rejects extra images and a third label file", () => {
    const firstImage = new File(["image"], "first.png", { type: "image/png" });
    const firstLabels = new File(["labels"], "first.txt");
    const extraImage = new File(["image"], "extra.webp", { type: "image/webp" });
    const originals = new File(["labels"], "originals.TXT", {
      type: "text/plain",
    });
    const thirdLabels = new File(["labels"], "third.TXT", {
      type: "text/plain",
    });

    expect(
      partitionDroppedFiles([
        firstImage,
        firstLabels,
        extraImage,
        originals,
        thirdLabels,
      ]),
    ).toEqual({
      image: firstImage,
      labels: firstLabels,
      reference: originals,
      rejected: [extraImage, thirdLabels],
    });
  });
});

describe("readTextFile", () => {
  it("reads text through the File API", async () => {
    const file = new File(["unused"], "scene.txt");
    const text = vi.fn().mockResolvedValue("0 0 10 10 person 0");
    Object.defineProperty(file, "text", { value: text });

    await expect(readTextFile(file)).resolves.toBe("0 0 10 10 person 0");
    expect(text).toHaveBeenCalledOnce();
  });
});

describe("loadImageFile", () => {
  const OriginalURL = globalThis.URL;

  function stubObjectURL(url: string) {
    const createObjectURL = vi.fn(() => url);
    const revokeObjectURL = vi.fn();
    class MockURL extends OriginalURL {}
    Object.defineProperties(MockURL, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal("URL", MockURL);
    return { createObjectURL, revokeObjectURL };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads decoded original image dimensions", async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectURL("blob:scene");
    class MockImage {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);

    const info = await loadImageFile(
      new File(["pixels"], "scene.png", { type: "image/png" }),
    );

    expect(info).toEqual({
      name: "scene.png",
      width: 1920,
      height: 1080,
      url: "blob:scene",
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes its new object URL when image decoding fails", async () => {
    const { revokeObjectURL } = stubObjectURL("blob:broken");
    class BrokenImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);

    const file = new File(["broken"], "broken.png", { type: "image/png" });

    await expect(loadImageFile(file)).rejects.toThrow(
      'Could not decode image "broken.png".',
    );
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:broken");
  });

  it.each([
    [0, 1080],
    [1920, 0],
    [Number.POSITIVE_INFINITY, 1080],
    [1920, Number.NaN],
  ])(
    "rejects invalid decoded dimensions %s × %s and revokes once",
    async (width, height) => {
      const { revokeObjectURL } = stubObjectURL("blob:invalid-dimensions");
      class InvalidDimensionsImage {
        naturalWidth = width;
        naturalHeight = height;
        onload: null | (() => void) = null;
        onerror: null | (() => void) = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
      vi.stubGlobal("Image", InvalidDimensionsImage);
      const file = new File(["pixels"], "invalid.png", {
        type: "image/png",
      });

      await expect(loadImageFile(file)).rejects.toThrow(
        'Could not decode image "invalid.png".',
      );
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:invalid-dimensions");
    },
  );
});
