import { loadImageFile, partitionDroppedFiles, readTextFile } from "./fileIO";

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

  it("rejects extra image and label files instead of replacing the first match", () => {
    const firstImage = new File(["image"], "first.png", { type: "image/png" });
    const firstLabels = new File(["labels"], "first.txt");
    const extraImage = new File(["image"], "extra.webp", { type: "image/webp" });
    const extraLabels = new File(["labels"], "extra.TXT", {
      type: "text/plain",
    });

    expect(
      partitionDroppedFiles([
        firstImage,
        firstLabels,
        extraImage,
        extraLabels,
      ]),
    ).toEqual({
      image: firstImage,
      labels: firstLabels,
      rejected: [extraImage, extraLabels],
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
