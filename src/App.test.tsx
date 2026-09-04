import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { EditorErrorBoundary } from "./components/EditorErrorBoundary";
import { parseAnnotationText } from "./domain/parser";
import * as editorReducerModule from "./state/editorReducer";
import { makeStressAnnotations } from "../tests/fixtures/makeStressAnnotations";

const exampleFixture = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

function mockNarrowLayout(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

interface DecodedImage {
  width: number;
  height: number;
}

function textFile(contents: string, name = "scene.txt"): File {
  const file = new File([contents], name, { type: "text/plain" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn().mockResolvedValue(contents),
  });
  return file;
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

function deferredTextFile(name: string) {
  const contents = deferred<string>();
  const file = new File(["pending"], name, { type: "text/plain" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn(() => contents.promise),
  });
  return { file, ...contents };
}

function mockImageEnvironment(outcomes: readonly (DecodedImage | "error")[]) {
  const OriginalURL = globalThis.URL;
  let urlNumber = 0;
  let outcomeNumber = 0;
  const createObjectURL = vi.fn((_blob: Blob) => `blob:image-${++urlNumber}`);
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

function mockViewportEnvironment(width = 1000, height = 700) {
  const rect: DOMRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  };
  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element) {
        this.callback(
          [{ target, contentRect: rect } as ResizeObserverEntry],
          this,
        );
      }

      unobserve() {}
      disconnect() {}
    },
  );
}

function mockPointerEnvironment() {
  vi.stubGlobal(
    "PointerEvent",
    class PointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    },
  );
}

interface DeferredImageController {
  succeed: (width: number, height: number) => void;
  fail: () => void;
}

function mockDeferredImageEnvironment() {
  const OriginalURL = globalThis.URL;
  let urlNumber = 0;
  const createObjectURL = vi.fn(() => `blob:image-${++urlNumber}`);
  const revokeObjectURL = vi.fn();
  class MockURL extends OriginalURL {}
  Object.defineProperties(MockURL, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal("URL", MockURL);

  const images: DeferredImageController[] = [];
  class DeferredImage implements DeferredImageController {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;

    constructor() {
      images.push(this);
    }

    set src(_value: string) {}

    succeed(width: number, height: number) {
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.onload?.();
    }

    fail() {
      this.onerror?.();
    }
  }
  vi.stubGlobal("Image", DeferredImage);

  return { createObjectURL, revokeObjectURL, images };
}

async function settleDeferred(callback: () => void): Promise<void> {
  await act(async () => {
    callback();
    await Promise.resolve();
  });
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function mockDownloadEnvironment() {
  const OriginalURL = globalThis.URL;
  const blobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:download-${blobs.length}`;
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

  return { blobs, click, createObjectURL, revokeObjectURL };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders the provider-backed REC editor shell and semantic regions", () => {
  render(<App />);

  expect(
    screen.getByRole("heading", { name: "REC Annotation Editor" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Open image" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Open labels" })).toBeEnabled();
  expect(
    screen.getByRole("region", { name: "Image workspace" }),
  ).toHaveTextContent("Drop an image and label file here");
  expect(
    screen.getByRole("complementary", { name: "Annotations" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("0 annotations");
});

it("enters Add Box mode from the toolbar after an image loads", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("400 × 300")).toBeVisible();

  const addBox = screen.getByRole("button", { name: "Add box" });
  expect(addBox).toBeEnabled();
  expect(addBox).toHaveAttribute("aria-pressed", "false");

  await user.click(addBox);

  expect(addBox).toHaveAttribute("aria-pressed", "true");
});

it("opens a focused new-annotation dialog after drawing a box", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("400 × 300")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add box" }));

  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 1,
    clientX: 300,
    clientY: 300,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 1,
    clientX: 300,
    clientY: 300,
  });

  const dialog = await screen.findByRole("dialog", { name: "New annotation" });
  expect(dialog).toBeVisible();
  const expression = screen.getByRole("textbox", { name: "Expression" });
  expect(expression).toHaveAttribute("type", "text");
  expect(expression).toHaveFocus();
});

it("rejects an empty trimmed expression in the new-annotation dialog", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("400 × 300")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add box" }));
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 2,
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 2,
    clientX: 300,
    clientY: 300,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 2,
    clientX: 300,
    clientY: 300,
  });
  const expression = await screen.findByRole("textbox", { name: "Expression" });

  await user.type(expression, "   ");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(screen.getByRole("dialog", { name: "New annotation" })).toHaveTextContent(
    "Expression cannot be empty.",
  );
  expect(screen.getByRole("status")).toHaveTextContent("0 annotations");
});

it("adds, selects, and centers a trimmed original-coordinate annotation", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 1000, height: 1000 }]);
  mockViewportEnvironment();
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "square.png", { type: "image/png" }),
  );
  expect(await screen.findByText("1000 × 1000")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add box" }));
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 3,
    clientX: 220,
    clientY: 70,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 3,
    clientX: 290,
    clientY: 140,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 3,
    clientX: 290,
    clientY: 140,
  });
  const expression = await screen.findByRole("textbox", { name: "Expression" });
  reducer.mockClear();

  await user.type(expression, "  vehicle  ");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(screen.queryByRole("dialog", { name: "New annotation" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 annotation");
  expect(screen.getByRole("complementary", { name: "Annotations" })).toHaveTextContent(
    "vehicle",
  );
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("x", "100");
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("y", "100");
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("width", "100");
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("height", "100");
  expect(screen.getByTestId("handle-nw")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add box" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const editActions = reducer.mock.calls
    .map(([, action]) => action)
    .filter(({ type }) =>
      ["ADD_ANNOTATION", "SELECT", "SET_MODE"].includes(type),
    );
  expect(editActions).toEqual([
    {
      type: "ADD_ANNOTATION",
      annotation: {
        id: "ann_001",
        bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
        label: "vehicle",
        reservedField: "0",
      },
    },
    { type: "SELECT", id: "ann_001" },
    { type: "SET_MODE", mode: "select" },
  ]);

  await waitFor(() => {
    expect(
      Number(screen.getByTestId("image-space").getAttribute("data-scale")),
    ).toBeCloseTo(2.45, 10);
  });
  expect(
    Number(screen.getByTestId("image-space").getAttribute("data-offset-x")),
  ).toBeCloseTo(132.5, 10);
  expect(
    Number(screen.getByTestId("image-space").getAttribute("data-offset-y")),
  ).toBeCloseTo(-17.5, 10);
});

it("uses the reducer next annotation number after importing annotations", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 1000, height: 1000 }]);
  mockViewportEnvironment();
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "square.png", { type: "image/png" }),
  );
  expect(await screen.findByText("1000 × 1000")).toBeVisible();
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 10 20 20 first 0\n30 30 40 40 second 0"),
  );
  expect(await screen.findByText("2 annotations")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add box" }));
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 6,
    clientX: 220,
    clientY: 70,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 6,
    clientX: 290,
    clientY: 140,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 6,
    clientX: 290,
    clientY: 140,
  });
  const expression = await screen.findByRole("textbox", { name: "Expression" });
  await user.type(expression, "third");
  reducer.mockClear();

  await user.click(screen.getByRole("button", { name: "Add" }));

  const addActions = reducer.mock.calls
    .map(([, action]) => action)
    .filter(({ type }) => type === "ADD_ANNOTATION");
  expect(addActions).toEqual([
    expect.objectContaining({
      type: "ADD_ANNOTATION",
      annotation: expect.objectContaining({ id: "ann_003", label: "third" }),
    }),
  ]);
  expect(screen.getByTestId("bbox-ann_003")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("3 annotations");
});

it("discards a new annotation draft with Cancel", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("400 × 300")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add box" }));
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 4,
    clientX: 100,
    clientY: 100,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 4,
    clientX: 300,
    clientY: 300,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 4,
    clientX: 300,
    clientY: 300,
  });
  expect(
    await screen.findByRole("dialog", { name: "New annotation" }),
  ).toBeVisible();
  reducer.mockClear();

  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog", { name: "New annotation" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("0 annotations");
  expect(screen.getByRole("button", { name: "Add box" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    reducer.mock.calls.some(([, action]) => action.type === "ADD_ANNOTATION"),
  ).toBe(false);
});

it.each(["dialog", "background"] as const)(
  "discards a new annotation draft once with Escape from %s focus",
  async (focusLocation) => {
    const reducer = vi.spyOn(editorReducerModule, "editorReducer");
    const user = userEvent.setup();
    mockImageEnvironment([{ width: 400, height: 300 }]);
    mockViewportEnvironment();
    mockPointerEnvironment();
    render(<App />);

    await user.upload(
      screen.getByLabelText("Open image"),
      new File(["pixels"], "scene.png", { type: "image/png" }),
    );
    expect(await screen.findByText("400 × 300")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add box" }));
    const canvas = screen.getByLabelText("Annotation canvas");
    Object.assign(canvas, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
    fireEvent.pointerDown(canvas, {
      pointerId: 5,
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 5,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 5,
      clientX: 300,
      clientY: 300,
    });
    const expression = await screen.findByRole("textbox", {
      name: "Expression",
    });
    await user.type(expression, "temporary label");
    if (focusLocation === "background") {
      screen.getByRole("button", { name: "Zoom in" }).focus();
      expect(screen.getByRole("button", { name: "Zoom in" })).toHaveFocus();
    } else {
      expect(expression).toHaveFocus();
    }
    reducer.mockClear();

    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "New annotation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 annotations");
    expect(
      reducer.mock.calls.some(([, action]) => action.type === "ADD_ANNOTATION"),
    ).toBe(false);
    expect(
      reducer.mock.calls.filter(([, action]) => action.type === "SET_MODE"),
    ).toEqual([[expect.anything(), { type: "SET_MODE", mode: "select" }]]);
  },
);

it.each(["image", "labels"] as const)(
  "cancels a pending annotation draft immediately when an import begins for %s",
  async (kind) => {
    const reducer = vi.spyOn(editorReducerModule, "editorReducer");
    const user = userEvent.setup();
    const { images, revokeObjectURL } = mockDeferredImageEnvironment();
    const pendingLabels = deferredTextFile("replacement.txt");
    mockViewportEnvironment();
    mockPointerEnvironment();
    render(<App />);

    const imageInput = screen.getByLabelText("Open image");
    await user.upload(
      imageInput,
      new File(["first"], "first.png", { type: "image/png" }),
    );
    await settleDeferred(() => images[0]!.succeed(400, 300));
    expect(await screen.findByText("400 × 300")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add box" }));
    const canvas = screen.getByLabelText("Annotation canvas");
    Object.assign(canvas, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });
    fireEvent.pointerDown(canvas, {
      pointerId: 17,
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 17,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 17,
      clientX: 300,
      clientY: 300,
    });
    const expression = await screen.findByRole("textbox", {
      name: "Expression",
    });
    await user.type(expression, "stale draft");
    reducer.mockClear();

    if (kind === "image") {
      await user.upload(
        imageInput,
        new File(["second"], "second.png", { type: "image/png" }),
      );
      expect(images).toHaveLength(2);
    } else {
      await user.upload(screen.getByLabelText("Open labels"), pendingLabels.file);
    }

    expect(
      screen.queryByRole("dialog", { name: "New annotation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add box" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      reducer.mock.calls.filter(([, action]) => action.type === "SET_MODE"),
    ).toEqual([[expect.anything(), { type: "SET_MODE", mode: "select" }]]);
    expect(
      reducer.mock.calls.some(([, action]) => action.type === "ADD_ANNOTATION"),
    ).toBe(false);

    if (kind === "image") {
      await settleDeferred(() => images[1]!.succeed(500, 350));
      expect(await screen.findByText("500 × 350")).toBeVisible();
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
    } else {
      await settleDeferred(() =>
        pendingLabels.resolve("10 10 20 20 imported label 0"),
      );
      expect(await screen.findByText("imported label")).toBeVisible();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    }

    expect(
      reducer.mock.calls.some(([, action]) => action.type === "ADD_ANNOTATION"),
    ).toBe(false);
  },
);

it("wires centered zoom controls to the viewport and status bar", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 1920, height: 1080 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );

  expect(await screen.findByText("1920 × 1080")).toBeVisible();
  const zoomPercent = screen.getByTestId("zoom-percent");
  expect(zoomPercent).toHaveTextContent("52%");
  expect(screen.getByRole("status")).toHaveTextContent("Zoom 52%");

  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(zoomPercent).toHaveTextContent("63%");
  const imageSpace = screen.getByTestId("image-space");
  expect(Number(imageSpace.getAttribute("data-scale"))).toBeCloseTo(0.625, 10);
  expect(Number(imageSpace.getAttribute("data-offset-x"))).toBeCloseTo(
    -100,
    10,
  );
  expect(Number(imageSpace.getAttribute("data-offset-y"))).toBeCloseTo(12.5, 10);

  await user.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(zoomPercent).toHaveTextContent("52%");

  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  await user.click(screen.getByRole("button", { name: "Fit" }));
  expect(zoomPercent).toHaveTextContent("52%");
  expect(imageSpace).toHaveAttribute(
    "transform",
    "translate(0 68.75) scale(0.5208333333333334)",
  );
});

it("fits a replacement image even after manual zoom", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([
    { width: 1920, height: 1080 },
    { width: 400, height: 400 },
  ]);
  mockViewportEnvironment();
  render(<App />);
  const imageInput = screen.getByLabelText("Open image");

  await user.upload(
    imageInput,
    new File(["first"], "first.png", { type: "image/png" }),
  );
  expect(await screen.findByText("1920 × 1080")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByTestId("zoom-percent")).toHaveTextContent("63%");

  await user.upload(
    imageInput,
    new File(["second"], "second.png", { type: "image/png" }),
  );
  expect(await screen.findByText("400 × 400")).toBeVisible();
  await waitFor(() => {
    expect(screen.getByTestId("zoom-percent")).toHaveTextContent("175%");
  });
  expect(screen.getByTestId("image-space")).toHaveAttribute(
    "transform",
    "translate(150 0) scale(1.75)",
  );
});

it("keeps drag guidance across descendants and clears it on exit or drop", () => {
  render(<App />);
  const workspace = screen.getByRole("region", { name: "Image workspace" });
  const child = workspace.querySelector("p");
  expect(child).not.toBeNull();

  fireEvent.dragEnter(workspace, { dataTransfer: { files: [] } });
  fireEvent.dragEnter(child!, { dataTransfer: { files: [] } });
  expect(workspace).toHaveTextContent("Drop files to import");

  fireEvent.dragLeave(child!, { dataTransfer: { files: [] } });
  expect(workspace).toHaveTextContent("Drop files to import");

  fireEvent.dragLeave(workspace, { dataTransfer: { files: [] } });
  expect(workspace).toHaveTextContent("Drop an image and label file here");

  fireEvent.dragEnter(child!, { dataTransfer: { files: [] } });
  fireEvent.drop(child!, { dataTransfer: { files: [] } });
  expect(workspace).toHaveTextContent("Drop an image and label file here");
});

it("loads duplicate free-text annotations and shows their count", async () => {
  const user = userEvent.setup();
  render(<App />);
  const labels = textFile(
    "0 0 10 10 person 0\n20 20 50 60 the person beside the car 0",
  );

  await user.upload(screen.getByLabelText("Open labels"), labels);

  expect(await screen.findByText("2 annotations")).toBeVisible();
  expect(screen.getByText("person", { exact: true })).toBeVisible();
  expect(screen.getByText("the person beside the car")).toBeVisible();
});

it("lists label-only imports but disables bbox editing without image bounds", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 70 90 person 0"),
  );

  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  expect(expression).toHaveValue("person");
  expect(expression).toBeEnabled();
  for (const name of ["X1", "Y1", "X2", "Y2"]) {
    expect(screen.getByRole("textbox", { name })).toBeDisabled();
  }
  expect(screen.queryByLabelText("Annotation canvas")).not.toBeInTheDocument();
});

it("centers the viewport on the exact annotation clicked in the panel", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 70 90 person 0"),
  );
  expect(await screen.findByDisplayValue("person")).toBeVisible();
  const imageSpace = screen.getByTestId("image-space");
  const startingOffsetX = Number(imageSpace.getAttribute("data-offset-x"));

  await user.click(screen.getByText("Annotation 1"));

  await waitFor(() => {
    expect(Number(imageSpace.getAttribute("data-offset-x"))).not.toBe(
      startingOffsetX,
    );
    expect(Number(imageSpace.getAttribute("data-offset-x"))).toBeCloseTo(
      406.6666666667,
      8,
    );
    expect(Number(imageSpace.getAttribute("data-offset-y"))).toBeCloseTo(
      221.6666666667,
      8,
    );
  });
});

it("highlights and scrolls the exact card selected from a duplicate-label bbox", async () => {
  const user = userEvent.setup();
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment();

  try {
    render(<App />);
    await user.upload(
      screen.getByLabelText("Open image"),
      new File(["pixels"], "scene.png", { type: "image/png" }),
    );
    await user.upload(
      screen.getByLabelText("Open labels"),
      textFile("10 20 70 90 person 0\n100 110 180 200 person 0"),
    );
    expect(await screen.findAllByDisplayValue("person")).toHaveLength(2);
    const cards = [
      ...screen
        .getByRole("complementary", { name: "Annotations" })
        .querySelectorAll<HTMLElement>("[data-annotation-id]"),
    ];

    fireEvent.click(screen.getByTestId("bbox-ann_002"));

    expect(cards[0]).not.toHaveAttribute("aria-current");
    expect(cards[1]).toHaveAttribute("aria-current", "true");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(cards[1]);
  } finally {
    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  }
});

it("separates a focused expression edit, canvas move, and later expression edit into undo units", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment(400, 300);
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 70 90 person 0"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  reducer.mockClear();

  await user.click(expression);
  await user.clear(expression);
  await user.type(expression, "car");
  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 31,
    clientX: 20,
    clientY: 30,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 31,
    clientX: 30,
    clientY: 40,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 31,
    clientX: 30,
    clientY: 40,
  });
  await user.click(expression);
  await user.type(expression, "t");
  fireEvent.blur(expression);

  const transactionActions = reducer.mock.calls
    .map(([, action]) => action)
    .filter(({ type }) =>
      [
        "BEGIN_TRANSACTION",
        "PREVIEW_PATCH",
        "COMMIT_TRANSACTION",
        "CANCEL_TRANSACTION",
      ].includes(type),
    )
    .map((action) =>
      action.type === "PREVIEW_PATCH"
        ? `PREVIEW_${action.patch.label === undefined ? "BBOX" : "LABEL"}`
        : action.type,
    );
  expect(transactionActions).toEqual([
    "BEGIN_TRANSACTION",
    "PREVIEW_LABEL",
    "PREVIEW_LABEL",
    "PREVIEW_LABEL",
    "PREVIEW_LABEL",
    "COMMIT_TRANSACTION",
    "BEGIN_TRANSACTION",
    "PREVIEW_BBOX",
    "COMMIT_TRANSACTION",
    "BEGIN_TRANSACTION",
    "PREVIEW_LABEL",
    "COMMIT_TRANSACTION",
  ]);

  const finalState = reducer.mock.results.at(-1)?.value;
  expect(finalState?.transactionBase).toBeNull();
  expect(finalState?.annotations).toEqual([
    {
      id: "ann_001",
      bbox: { x1: 20, y1: 30, x2: 80, y2: 100 },
      label: "cart",
      reservedField: "0",
    },
  ]);
  expect(finalState?.past).toEqual([
    [
      {
        id: "ann_001",
        bbox: { x1: 10, y1: 20, x2: 70, y2: 90 },
        label: "person",
        reservedField: "0",
      },
    ],
    [
      {
        id: "ann_001",
        bbox: { x1: 10, y1: 20, x2: 70, y2: 90 },
        label: "car",
        reservedField: "0",
      },
    ],
    [
      {
        id: "ann_001",
        bbox: { x1: 20, y1: 30, x2: 80, y2: 100 },
        label: "car",
        reservedField: "0",
      },
    ],
  ]);
});

it("preserves a focused numeric draft through a canvas move and commits it afterward", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 400, height: 300 }]);
  mockViewportEnvironment(400, 300);
  mockPointerEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 70 90 person 0"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "15." } });
  reducer.mockClear();

  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 32,
    clientX: 20,
    clientY: 30,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 32,
    clientX: 30,
    clientY: 40,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 32,
    clientX: 30,
    clientY: 40,
  });

  expect(x1).toHaveFocus();
  expect(x1).toHaveValue("15.");
  expect(screen.getByRole("textbox", { name: "Y1" })).toHaveValue("30");
  expect(screen.getByRole("textbox", { name: "X2" })).toHaveValue("80");
  expect(screen.getByRole("textbox", { name: "Y2" })).toHaveValue("100");

  fireEvent.blur(x1);

  const editActions = reducer.mock.calls
    .map(([, action]) => action)
    .filter(({ type }) =>
      [
        "BEGIN_TRANSACTION",
        "PREVIEW_PATCH",
        "COMMIT_TRANSACTION",
        "UPDATE_ANNOTATION",
      ].includes(type),
    )
    .map((action) => action.type);
  expect(editActions).toEqual([
    "BEGIN_TRANSACTION",
    "PREVIEW_PATCH",
    "COMMIT_TRANSACTION",
    "UPDATE_ANNOTATION",
  ]);

  const finalState = reducer.mock.results.at(-1)?.value;
  expect(finalState?.transactionBase).toBeNull();
  expect(finalState?.annotations).toEqual([
    {
      id: "ann_001",
      bbox: { x1: 15, y1: 30, x2: 80, y2: 100 },
      label: "person",
      reservedField: "0",
    },
  ]);
  expect(finalState?.past).toEqual([
    [
      {
        id: "ann_001",
        bbox: { x1: 10, y1: 20, x2: 70, y2: 90 },
        label: "person",
        reservedField: "0",
      },
    ],
    [
      {
        id: "ann_001",
        bbox: { x1: 20, y1: 30, x2: 80, y2: 100 },
        label: "person",
        reservedField: "0",
      },
    ],
  ]);
  expect(x1).toHaveValue("15");
});

it("reloads identical labels to establish a fresh document baseline", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  render(<App />);
  const labels = textFile("0 0 10 10 person 0", "same.txt");
  const labelInput = screen.getByLabelText("Open labels");

  await user.upload(labelInput, labels);
  expect(await screen.findByText("1 annotation")).toBeVisible();
  reducer.mockClear();

  await user.upload(
    labelInput,
    textFile("0 0 10 10 person 0", "same.txt"),
  );

  await waitFor(() => {
    expect(reducer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "COMMIT_IMPORT" }),
    );
  });
});

it("keeps the current document when a new file contains invalid lines", async () => {
  const user = userEvent.setup();
  render(<App />);
  const labelInput = screen.getByLabelText("Open labels");

  await user.upload(labelInput, textFile("0 0 10 10 person 0", "valid.txt"));
  expect(await screen.findByText("1 annotation")).toBeVisible();

  await user.upload(
    labelInput,
    textFile(
      "0 0 10 10 replacement 0\n0 0 0 9 broken width 0\nx 1 4 5 broken number 0",
      "bad.txt",
    ),
  );

  const dialog = await screen.findByRole("dialog", {
    name: "Could not import labels",
  });
  expect(dialog).toHaveTextContent("Line 2: invalid bounding box");
  expect(dialog).toHaveTextContent(
    "Line 3: expected four coordinates and a label",
  );
  expect(screen.getByText("person", { exact: true })).toBeVisible();
  expect(screen.queryByText("replacement", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText("1 annotation")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Close error" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("loads the first recognized dropped file and reports extras explicitly", async () => {
  render(<App />);
  const labels = textFile("0 0 10 10 first label 0", "first.txt");
  const extraLabels = textFile("0 0 10 10 ignored 0", "extra.TXT");
  const archive = new File(["zip"], "scene.zip", {
    type: "application/zip",
  });

  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: { files: [labels, extraLabels, archive] },
  });

  expect(await screen.findByText("first label")).toBeVisible();
  const dialog = await screen.findByRole("dialog", {
    name: "Some dropped files were rejected",
  });
  expect(dialog).toHaveTextContent("extra.TXT");
  expect(dialog).toHaveTextContent("scene.zip");
  expect(screen.queryByText("ignored", { exact: true })).not.toBeInTheDocument();
});

it("clamps labels against an existing image and announces the count", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("90 10 120 40 edge car 0"),
  );

  expect(
    await screen.findByText("Clamped 1 bounding box to the image bounds."),
  ).toBeVisible();
  expect(screen.getByText("edge car")).toBeVisible();
});

it("rejects every new label when one box is wholly outside the current image", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 current label 0", "current.txt"),
  );
  expect(await screen.findByText("current label")).toBeVisible();
  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile(
      "10 10 20 20 replacement 0\n120 10 130 20 outside image 0",
      "outside.txt",
    ),
  );

  expect(
    await screen.findByRole("dialog", { name: "Could not import labels" }),
  ).toHaveTextContent("outside the image bounds");
  expect(screen.getByText("current label")).toBeVisible();
  expect(screen.queryByText("replacement", { exact: true })).not.toBeInTheDocument();
});

it("clamps labels loaded before an image as one successful UI operation", async () => {
  const user = userEvent.setup();
  const { revokeObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
  ]);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("-10 10 120 40 wide vehicle 0"),
  );
  expect(await screen.findByText("wide vehicle")).toBeVisible();

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );

  expect(await screen.findByText("100 × 80")).toBeVisible();
  expect(
    screen.getByText("Clamped 1 bounding box to the image bounds."),
  ).toBeVisible();
  expect(screen.getByText("wide vehicle")).toBeVisible();
  expect(revokeObjectURL).not.toHaveBeenCalled();
});

it("rejects an image that would collapse a pending box and revokes only its URL", async () => {
  const user = userEvent.setup();
  const { revokeObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
  ]);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("120 10 140 30 pending outside box 0"),
  );
  expect(await screen.findByText("pending outside box")).toBeVisible();

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "too-small.png", { type: "image/png" }),
  );

  expect(
    await screen.findByRole("dialog", { name: "Could not import image" }),
  ).toHaveTextContent("outside the image bounds");
  expect(screen.getByText("No image loaded")).toBeVisible();
  expect(screen.getByText("pending outside box")).toBeVisible();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("keeps the old image when a replacement cannot decode", async () => {
  const user = userEvent.setup();
  const { revokeObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
    "error",
  ]);
  render(<App />);
  const imageInput = screen.getByLabelText("Open image");

  await user.upload(
    imageInput,
    new File(["first"], "first.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await user.upload(
    imageInput,
    new File(["broken"], "broken.png", { type: "image/png" }),
  );

  expect(
    await screen.findByRole("dialog", { name: "Could not import image" }),
  ).toHaveTextContent('Could not decode image "broken.png".');
  expect(screen.getByText("100 × 80")).toBeVisible();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-2");
});

it("revokes the previous image URL only after a replacement succeeds", async () => {
  const user = userEvent.setup();
  const { revokeObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
    { width: 200, height: 160 },
  ]);
  render(<App />);
  const imageInput = screen.getByLabelText("Open image");

  await user.upload(
    imageInput,
    new File(["first"], "first.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();
  expect(revokeObjectURL).not.toHaveBeenCalled();

  await user.upload(
    imageInput,
    new File(["second"], "second.png", { type: "image/png" }),
  );

  expect(await screen.findByText("200 × 160")).toBeVisible();
  await waitFor(() => {
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("lets a newer image request supersede delayed outside labels", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  const delayedLabels = deferredTextFile("outside.txt");
  render(<App />);

  await user.upload(screen.getByLabelText("Open labels"), delayedLabels.file);
  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "latest.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await settleDeferred(() => {
    delayedLabels.resolve("120 10 140 30 outside label 0");
  });

  expect(screen.getByText("0 annotations")).toBeVisible();
  expect(screen.queryByText("outside label")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(/Clamped \d+ bounding/)).not.toBeInTheDocument();
});

it("does not show an error from a stale label request", async () => {
  const user = userEvent.setup();
  const staleLabels = deferredTextFile("stale-invalid.txt");
  render(<App />);
  const labelInput = screen.getByLabelText("Open labels");

  await user.upload(labelInput, staleLabels.file);
  await user.upload(
    labelInput,
    textFile("0 0 10 10 latest label 0", "latest.txt"),
  );
  expect(await screen.findByText("latest label")).toBeVisible();

  await settleDeferred(() => {
    staleLabels.resolve("0 0 0 10 invalid stale label 0");
  });

  expect(screen.getByText("latest label")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not replace the latest labels or notice from a stale clamped request", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  const staleLabels = deferredTextFile("stale-clamped.txt");
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  const labelInput = screen.getByLabelText("Open labels");
  await user.upload(labelInput, staleLabels.file);
  await user.upload(
    labelInput,
    textFile("10 10 20 20 latest label 0", "latest.txt"),
  );
  expect(await screen.findByText("latest label")).toBeVisible();

  await settleDeferred(() => {
    staleLabels.resolve("90 10 120 30 stale edge label 0");
  });

  expect(screen.getByText("latest label")).toBeVisible();
  expect(screen.queryByText("stale edge label")).not.toBeInTheDocument();
  expect(screen.queryByText(/Clamped \d+ bounding/)).not.toBeInTheDocument();
});

it("keeps the latest image when two decodes finish in reverse order", async () => {
  const user = userEvent.setup();
  const { images, revokeObjectURL } = mockDeferredImageEnvironment();
  render(<App />);
  const imageInput = screen.getByLabelText("Open image");

  await user.upload(
    imageInput,
    new File(["first"], "first.png", { type: "image/png" }),
  );
  await user.upload(
    imageInput,
    new File(["second"], "second.png", { type: "image/png" }),
  );
  expect(images).toHaveLength(2);

  await settleDeferred(() => images[1]!.succeed(200, 160));
  expect(await screen.findByText("200 × 160")).toBeVisible();
  expect(revokeObjectURL).not.toHaveBeenCalled();

  await settleDeferred(() => images[0]!.succeed(100, 80));

  expect(screen.getByText("200 × 160")).toBeVisible();
  expect(screen.queryByText("100 × 80")).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "second.png" })).toBeVisible();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("does not show an error from a stale failed image request", async () => {
  const user = userEvent.setup();
  const { images, revokeObjectURL } = mockDeferredImageEnvironment();
  render(<App />);
  const imageInput = screen.getByLabelText("Open image");

  await user.upload(
    imageInput,
    new File(["first"], "stale.png", { type: "image/png" }),
  );
  await user.upload(
    imageInput,
    new File(["second"], "latest.png", { type: "image/png" }),
  );

  await settleDeferred(() => images[1]!.succeed(200, 160));
  expect(await screen.findByText("200 × 160")).toBeVisible();

  await settleDeferred(() => images[0]!.fail());

  expect(screen.getByText("200 × 160")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("reclaims the accepted image URL when the editor unmounts", async () => {
  const user = userEvent.setup();
  const { revokeObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
  ]);
  const { unmount } = render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();
  expect(revokeObjectURL).not.toHaveBeenCalled();

  unmount();

  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("reclaims a pending image that finishes after unmount without dispatching", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  const { images, revokeObjectURL } = mockDeferredImageEnvironment();
  const { unmount } = render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "pending.png", { type: "image/png" }),
  );
  expect(images).toHaveLength(1);
  reducer.mockClear();
  unmount();

  await settleDeferred(() => images[0]!.succeed(100, 80));

  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
  expect(reducer).not.toHaveBeenCalled();
});

it("commits a same-drop image and labels through one reducer action", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  mockImageEnvironment([{ width: 100, height: 80 }]);
  render(<App />);
  const image = new File(["pixels"], "scene.png", { type: "image/png" });
  const labels = textFile("10 10 20 20 paired label 0", "scene.txt");

  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: { files: [image, labels] },
  });

  expect(await screen.findByText("paired label")).toBeVisible();
  expect(screen.getByText("100 × 80")).toBeVisible();
  const importActions = reducer.mock.calls
    .map(([, action]) => action)
    .filter(({ type }) =>
      ["SET_IMAGE", "LOAD_ANNOTATIONS", "COMMIT_IMPORT"].includes(type),
    );
  expect(importActions).toEqual([
    expect.objectContaining({
      type: "COMMIT_IMPORT",
      image: expect.objectContaining({ name: "scene.png" }),
      annotationBaseline: expect.objectContaining({ fileName: "scene.txt" }),
    }),
  ]);
});

it("saves edited TXT with a deterministic label stem and marks that snapshot clean", async () => {
  const user = userEvent.setup();
  const { blobs, click } = mockDownloadEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "aerial.scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.clear(expression);
  await user.type(expression, "edited person");
  fireEvent.blur(expression);

  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "aerial.scene-edited.txt",
  );
  expect(await readBlob(blobs[0]!)).toBe(
    "0.00 0.00 10.00 10.00 edited person 0\n",
  );
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("saves an empty document with the deterministic annotations stem", async () => {
  const user = userEvent.setup();
  const { blobs, click } = mockDownloadEnvironment();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "annotations-edited.txt",
  );
  expect(await readBlob(blobs[0]!)).toBe("");
});

it("uses the image stem when saving without an imported label file", async () => {
  const user = userEvent.setup();
  const { createObjectURL } = mockImageEnvironment([
    { width: 100, height: 80 },
  ]);
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "aerial.scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "aerial.scene-edited.txt",
  );
  expect(await readBlob(createObjectURL.mock.calls[1]![0] as Blob)).toBe("");
});

it("retains a valid picker label handle and uses it for Save", async () => {
  const user = userEvent.setup();
  const write = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({ write, close }),
  };
  const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
  vi.stubGlobal("showOpenFilePicker", showOpenFilePicker);
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.clear(expression);
  await user.type(expression, "saved through handle");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(showOpenFilePicker).toHaveBeenCalledOnce();
  expect(handle.createWritable).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith(
    "0.00 0.00 10.00 10.00 saved through handle 0\n",
  );
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("clears the retained handle after a valid hidden-input label import", async () => {
  const user = userEvent.setup();
  const { click } = mockDownloadEnvironment();
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  expect(await screen.findByText("picked label")).toBeVisible();
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 replacement label 0", "replacement.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(handle.createWritable).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "replacement-edited.txt",
  );
});

it("clears the retained handle after a valid dropped label import", async () => {
  const user = userEvent.setup();
  const { click } = mockDownloadEnvironment();
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  expect(await screen.findByText("picked label")).toBeVisible();
  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: {
      files: [textFile("0 0 10 10 dropped label 0", "dropped.txt")],
    },
  });
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(handle.createWritable).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "dropped-edited.txt",
  );
});

it("preserves the retained handle when a hidden-input label import is invalid", async () => {
  const user = userEvent.setup();
  const { click } = mockDownloadEnvironment();
  const write = vi.fn().mockResolvedValue(undefined);
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  expect(await screen.findByText("picked label")).toBeVisible();
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 0 10 invalid replacement 0", "invalid.txt"),
  );
  expect(
    await screen.findByRole("dialog", { name: "Could not import labels" }),
  ).toBeVisible();
  expect(screen.getByText("picked label")).toBeVisible();

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(handle.createWritable).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("0.00 0.00 10.00 10.00 picked label 0\n");
  expect(click).not.toHaveBeenCalled();
});

it("preserves the retained handle when a later open picker is cancelled", async () => {
  const user = userEvent.setup();
  const write = vi.fn().mockResolvedValue(undefined);
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const showOpenFilePicker = vi
    .fn()
    .mockResolvedValueOnce([handle])
    .mockRejectedValueOnce(new DOMException("", "AbortError"));
  vi.stubGlobal("showOpenFilePicker", showOpenFilePicker);
  render(<App />);
  const openLabels = screen.getByRole("button", { name: "Open labels" });

  await user.click(openLabels);
  expect(await screen.findByText("picked label")).toBeVisible();
  await user.click(openLabels);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(showOpenFilePicker).toHaveBeenCalledTimes(2);
  expect(handle.createWritable).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("0.00 0.00 10.00 10.00 picked label 0\n");
});

it.each(["hidden input", "drop"] as const)(
  "does not restore a stale picker handle after a newer valid %s import",
  async (newerSource) => {
    const user = userEvent.setup();
    const { click } = mockDownloadEnvironment();
    const firstHandle = {
      getFile: vi
        .fn()
        .mockResolvedValue(textFile("0 0 10 10 first picker 0", "first.txt")),
      createWritable: vi.fn(),
    };
    const staleFile = deferredTextFile("stale.txt");
    const staleHandle = {
      getFile: vi.fn().mockResolvedValue(staleFile.file),
      createWritable: vi.fn(),
    };
    const showOpenFilePicker = vi
      .fn()
      .mockResolvedValueOnce([firstHandle])
      .mockResolvedValueOnce([staleHandle]);
    vi.stubGlobal("showOpenFilePicker", showOpenFilePicker);
    render(<App />);
    const openLabels = screen.getByRole("button", { name: "Open labels" });

    await user.click(openLabels);
    expect(await screen.findByText("first picker")).toBeVisible();
    await user.click(openLabels);
    await waitFor(() => expect(staleFile.file.text).toHaveBeenCalledOnce());

    const newer = textFile("0 0 10 10 newer labels 0", "newer.txt");
    if (newerSource === "hidden input") {
      await user.upload(screen.getByLabelText("Open labels"), newer);
    } else {
      fireEvent.drop(
        screen.getByRole("region", { name: "Image workspace" }),
        { dataTransfer: { files: [newer] } },
      );
    }
    expect(await screen.findByText("newer labels")).toBeVisible();

    await settleDeferred(() =>
      staleFile.resolve("0 0 10 10 stale picker labels 0"),
    );
    expect(screen.getByText("newer labels")).toBeVisible();
    expect(screen.queryByText("stale picker labels")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(firstHandle.createWritable).not.toHaveBeenCalled();
    expect(staleHandle.createWritable).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      "newer-edited.txt",
    );
  },
);

it("retains the label handle across an image-only import", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  const write = vi.fn().mockResolvedValue(undefined);
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  expect(await screen.findByText("picked label")).toBeVisible();
  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  expect(await screen.findByText("100 × 80")).toBeVisible();

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(handle.createWritable).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("0.00 0.00 10.00 10.00 picked label 0\n");
});

it("preserves the previous handle when a newer picker label is invalid", async () => {
  const user = userEvent.setup();
  const firstWrite = vi.fn().mockResolvedValue(undefined);
  const firstHandle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 first picker 0", "first.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write: firstWrite,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const invalidHandle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 0 10 invalid picker 0", "invalid.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal(
    "showOpenFilePicker",
    vi
      .fn()
      .mockResolvedValueOnce([firstHandle])
      .mockResolvedValueOnce([invalidHandle]),
  );
  render(<App />);
  const openLabels = screen.getByRole("button", { name: "Open labels" });

  await user.click(openLabels);
  expect(await screen.findByText("first picker")).toBeVisible();
  await user.click(openLabels);
  expect(
    await screen.findByRole("dialog", { name: "Could not import labels" }),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(firstHandle.createWritable).toHaveBeenCalledOnce();
  expect(invalidHandle.createWritable).not.toHaveBeenCalled();
  expect(firstWrite).toHaveBeenCalledWith(
    "0.00 0.00 10.00 10.00 first picker 0\n",
  );
});

it("surfaces non-cancellation open-picker failures in the existing error UI", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "showOpenFilePicker",
    vi.fn().mockRejectedValue(new Error("open picker failed")),
  );
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));

  expect(
    await screen.findByRole("dialog", { name: "Could not open labels" }),
  ).toHaveTextContent("open picker failed");
});

it("surfaces save failures without marking edited annotations clean", async () => {
  const user = userEvent.setup();
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi.fn().mockRejectedValue(new Error("disk full")),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(
    await screen.findByRole("dialog", { name: "Could not save annotations" }),
  ).toHaveTextContent("disk full");
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("keeps retained-handle AbortError cancellation silent and dirty", async () => {
  const user = userEvent.setup();
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 picked label 0", "picked.txt")),
    createWritable: vi
      .fn()
      .mockRejectedValue(new DOMException("", "AbortError")),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("saves through Save As and marks the written annotation snapshot clean", async () => {
  const user = userEvent.setup();
  const write = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const showSaveFilePicker = vi.fn().mockResolvedValue({
    createWritable: vi.fn().mockResolvedValue({ write, close }),
  });
  vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: "Save As" }));

  expect(showSaveFilePicker).toHaveBeenCalledWith({
    suggestedName: "scene-edited.txt",
  });
  expect(write).toHaveBeenCalledWith(
    "0.00 0.00 10.00 10.00 person edited 0\n",
  );
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("falls back to a Save As download and marks the downloaded snapshot clean", async () => {
  const user = userEvent.setup();
  const { click } = mockDownloadEnvironment();
  vi.stubGlobal("showSaveFilePicker", undefined);
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: "Save As" }));

  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "scene-edited.txt",
  );
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("keeps Save As cancellation silent without marking edits clean", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "showSaveFilePicker",
    vi.fn().mockRejectedValue(new DOMException("", "AbortError")),
  );
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: "Save As" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("surfaces Save As failures without marking edited annotations clean", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "showSaveFilePicker",
    vi.fn().mockRejectedValue(new Error("Save As failed")),
  );
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  await user.click(screen.getByRole("button", { name: "Save As" }));

  expect(
    await screen.findByRole("dialog", { name: "Could not save annotations" }),
  ).toHaveTextContent("Save As failed");
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("does not mark newer edits clean when an older Save finishes", async () => {
  const user = userEvent.setup();
  const pendingWrite = deferred<void>();
  const write = vi.fn(() => pendingWrite.promise);
  const handle = {
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 person 0", "scene.txt")),
    createWritable: vi.fn().mockResolvedValue({
      write,
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " first");
  fireEvent.blur(expression);
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());

  await user.click(expression);
  await user.type(expression, " newer");
  fireEvent.blur(expression);
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
  await settleDeferred(() => pendingWrite.resolve());

  expect(write).toHaveBeenCalledWith(
    "0.00 0.00 10.00 10.00 person first 0\n",
  );
  expect(screen.getByDisplayValue("person first newer")).toBeVisible();
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("does not mark newer edits clean when an older Save As finishes", async () => {
  const user = userEvent.setup();
  const pendingWrite = deferred<void>();
  const write = vi.fn(() => pendingWrite.promise);
  vi.stubGlobal(
    "showSaveFilePicker",
    vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  );
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " first");
  fireEvent.blur(expression);
  await user.click(screen.getByRole("button", { name: "Save As" }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());

  await user.click(expression);
  await user.type(expression, " newer");
  fireEvent.blur(expression);
  await settleDeferred(() => pendingWrite.resolve());

  expect(write).toHaveBeenCalledWith(
    "0.00 0.00 10.00 10.00 person first 0\n",
  );
  expect(screen.getByDisplayValue("person first newer")).toBeVisible();
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("maps editor history and delete shortcuts while protecting editable fields", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  await user.click(await screen.findByText("person", { exact: true }));

  fireEvent.keyDown(window, { key: "Delete" });
  expect(screen.getByText("0 annotations")).toBeVisible();

  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(screen.getByText("1 annotation")).toBeVisible();

  fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(screen.getByText("0 annotations")).toBeVisible();

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(screen.getByText("1 annotation")).toBeVisible();

  fireEvent.keyDown(window, { key: "y", ctrlKey: true });
  expect(screen.getByText("0 annotations")).toBeVisible();

  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  const expression = screen.getByRole("textbox", { name: "Expression" });
  act(() => expression.focus());
  expect(expression).toHaveFocus();
  fireEvent.keyDown(window, { key: "Delete" });
  fireEvent.keyDown(window, { key: "Backspace" });
  expect(screen.getByText("1 annotation")).toBeVisible();
});

it("commits a focused expression transaction before shortcut Undo", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.click(expression);
  await user.clear(expression);
  await user.type(expression, "vehicle");
  reducer.mockClear();

  fireEvent.keyDown(expression, { key: "z", ctrlKey: true });

  await waitFor(() => expect(expression).toHaveValue("person"));
  expect(expression).not.toHaveFocus();
  expect(
    reducer.mock.calls
      .map(([, action]) => action.type)
      .filter((type) => ["COMMIT_TRANSACTION", "UNDO"].includes(type)),
  ).toEqual(["COMMIT_TRANSACTION", "UNDO"]);
});

it("commits a focused numeric draft before shortcut Undo", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 10 30 30 person 0", "scene.txt"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  await user.clear(x1);
  await user.type(x1, "15");
  reducer.mockClear();

  fireEvent.keyDown(x1, { key: "z", metaKey: true });

  await waitFor(() => expect(x1).toHaveValue("10"));
  expect(x1).not.toHaveFocus();
  expect(
    reducer.mock.calls
      .map(([, action]) => action.type)
      .filter((type) => ["UPDATE_ANNOTATION", "UNDO"].includes(type)),
  ).toEqual(["UPDATE_ANNOTATION", "UNDO"]);
});

it("commits a focused expression transaction before shortcut Save", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  const { blobs, click } = mockDownloadEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.click(expression);
  await user.clear(expression);
  await user.type(expression, "delivery vehicle");
  reducer.mockClear();

  fireEvent.keyDown(expression, { key: "s", ctrlKey: true });

  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(await readBlob(blobs[0]!)).toBe(
    "0.00 0.00 10.00 10.00 delivery vehicle 0\n",
  );
  expect(expression).not.toHaveFocus();
  expect(
    reducer.mock.calls
      .map(([, action]) => action.type)
      .filter((type) => ["COMMIT_TRANSACTION", "MARK_SAVED"].includes(type)),
  ).toEqual(["COMMIT_TRANSACTION", "MARK_SAVED"]);
});

it("commits a focused numeric draft before shortcut Save", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 10 30 30 person 0", "scene.txt"),
  );
  const { blobs, click } = mockDownloadEnvironment();
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  await user.clear(x1);
  await user.type(x1, "15");
  reducer.mockClear();

  fireEvent.keyDown(x1, { key: "s", metaKey: true });

  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(await readBlob(blobs[0]!)).toBe(
    "15.00 10.00 30.00 30.00 person 0\n",
  );
  expect(x1).not.toHaveFocus();
  expect(
    reducer.mock.calls
      .map(([, action]) => action.type)
      .filter((type) => ["UPDATE_ANNOTATION", "MARK_SAVED"].includes(type)),
  ).toEqual(["UPDATE_ANNOTATION", "MARK_SAVED"]);
});

it("exposes disabled-aware Undo and Redo toolbar controls", async () => {
  const user = userEvent.setup();
  render(<App />);
  const undo = screen.getByRole("button", { name: "Undo" });
  const redo = screen.getByRole("button", { name: "Redo" });

  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();

  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.click(expression);
  expect(undo).toBeDisabled();
  await user.type(expression, " edited");
  fireEvent.blur(expression);
  expect(undo).toBeEnabled();
  expect(redo).toBeDisabled();

  await user.click(undo);
  expect(screen.getByRole("textbox", { name: "Expression" })).toHaveValue(
    "person",
  );
  expect(undo).toBeDisabled();
  expect(redo).toBeEnabled();

  await user.click(redo);
  expect(screen.getByRole("textbox", { name: "Expression" })).toHaveValue(
    "person edited",
  );
  expect(undo).toBeEnabled();
  expect(redo).toBeDisabled();
});

it("exports exact TXT and JSON snapshots without marking edits clean", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "aerial.scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 delivery truck 0", "aerial.labels.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
  const { blobs, click } = mockDownloadEnvironment();

  await user.click(screen.getByRole("button", { name: "Export" }));
  const exportMenu = screen.getByRole("menu", { name: "Export annotations" });
  expect(exportMenu).toBeVisible();
  await user.click(
    screen.getByRole("menuitem", { name: "Export TXT" }),
  );

  expect(exportMenu).not.toBeInTheDocument();
  expect(click).toHaveBeenCalledTimes(1);
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
    "aerial.labels.txt",
  );
  expect(blobs[0]?.type).toBe("text/plain");
  expect(await readBlob(blobs[0]!)).toBe(
    "10.00 20.00 30.00 40.00 delivery truck edited 0\n",
  );
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  await user.click(screen.getByRole("button", { name: "Export" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Export JSON" }),
  );

  expect(click).toHaveBeenCalledTimes(2);
  expect((click.mock.contexts[1] as HTMLAnchorElement).download).toBe(
    "aerial.labels.json",
  );
  expect(blobs[1]?.type).toBe("application/json");
  expect(JSON.parse(await readBlob(blobs[1]!))).toEqual({
    image: "aerial.scene.png",
    width: 100,
    height: 80,
    annotations: [
      {
        id: "ann_001",
        bbox: [10, 20, 30, 40],
        label: "delivery truck edited",
        reservedField: "0",
      },
    ],
  });
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
});

it("installs the beforeunload warning only while annotations are dirty", async () => {
  const user = userEvent.setup();
  mockDownloadEnvironment();
  const addEventListener = vi.spyOn(window, "addEventListener");
  const removeEventListener = vi.spyOn(window, "removeEventListener");
  render(<App />);

  expect(
    addEventListener.mock.calls.some(([type]) => type === "beforeunload"),
  ).toBe(false);
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 person 0", "scene.txt"),
  );
  expect(
    addEventListener.mock.calls.some(([type]) => type === "beforeunload"),
  ).toBe(false);

  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  let warningListener!: EventListener;
  await waitFor(() => {
    const call = addEventListener.mock.calls.find(
      ([type]) => type === "beforeunload",
    );
    expect(call).toBeDefined();
    warningListener = call![1] as EventListener;
  });
  const event = {
    preventDefault: vi.fn(),
    returnValue: "unchanged",
  } as unknown as BeforeUnloadEvent;
  warningListener(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.returnValue).toBe("");

  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => {
    expect(removeEventListener).toHaveBeenCalledWith(
      "beforeunload",
      warningListener,
    );
  });
});

it("protects an uncommitted coordinate draft as an unsaved change", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  const addEventListener = vi.spyOn(window, "addEventListener");
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 person 0", "scene.txt"),
  );
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");

  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "12." } });

  expect(x1).toHaveFocus();
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );
  let warningListener!: EventListener;
  await waitFor(() => {
    const call = addEventListener.mock.calls.find(
      ([type]) => type === "beforeunload",
    );
    expect(call).toBeDefined();
    warningListener = call![1] as EventListener;
  });
  const event = {
    preventDefault: vi.fn(),
    returnValue: "unchanged",
  } as unknown as BeforeUnloadEvent;
  warningListener(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.returnValue).toBe("");
});

it("clears effective dirty when an invalid coordinate draft resets on blur", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 person 0", "scene.txt"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "-" } });
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  fireEvent.blur(x1);

  expect(x1).toHaveValue("10");
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("clears the coordinate draft marker when a valid commit is saved", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 person 0", "scene.txt"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "12" } });
  fireEvent.blur(x1);
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("clears effective dirty when a focused coordinate draft is reverted", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 person 0", "scene.txt"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "12" } });
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  fireEvent.change(x1, { target: { value: "10" } });

  expect(x1).toHaveFocus();
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("removes a stale coordinate draft when an import unmounts its card", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile(
      "10 20 30 40 person 0\n40 20 60 40 bicycle 0",
      "scene.txt",
    ),
  );
  const secondX1 = (await screen.findAllByRole("textbox", { name: "X1" }))[1]!;
  await user.click(secondX1);
  fireEvent.change(secondX1, { target: { value: "-" } });
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: {
      files: [textFile("12 22 32 42 car 0", "replacement.txt")],
    },
  });

  await waitFor(() => {
    expect(screen.getByLabelText("Total annotations")).toHaveTextContent(
      "1 annotation",
    );
  });
  expect(secondX1).not.toBeInTheDocument();
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("resets a focused coordinate draft before a same-ID label import", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 20 30 40 person 0", "scene.txt"),
  );
  const x1 = await screen.findByRole("textbox", { name: "X1" });
  await user.click(x1);
  fireEvent.change(x1, { target: { value: "-" } });
  expect(screen.getByLabelText("Save status")).toHaveTextContent(
    "Unsaved changes",
  );

  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: {
      files: [textFile("12 22 32 42 car 0", "replacement.txt")],
    },
  });

  await waitFor(() => expect(x1).toHaveValue("12"));
  expect(screen.getByRole("textbox", { name: "Expression" })).toHaveValue(
    "car",
  );
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});

it("keeps the search field focused while its global Save shortcut runs", async () => {
  const user = userEvent.setup();
  const { blobs, click } = mockDownloadEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 10 10 delivery person 0", "scene.txt"),
  );
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " edited");
  fireEvent.blur(expression);

  const search = screen.getByRole("searchbox", {
    name: "Search annotations",
  });
  await user.click(search);
  await user.type(search, "delivery");
  fireEvent.keyDown(search, { key: "s", ctrlKey: true });

  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(search).toHaveFocus();
  expect(search).toHaveValue("delivery");
  expect(await readBlob(blobs[0]!)).toBe(
    "0.00 0.00 10.00 10.00 delivery person edited 0\n",
  );
});

it("commits the newest concurrent Save snapshot last and reports it saved", async () => {
  const user = userEvent.setup();
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
    getFile: vi
      .fn()
      .mockResolvedValue(textFile("0 0 10 10 person 0", "scene.txt")),
    createWritable: vi
      .fn()
      .mockResolvedValueOnce(writable(firstClose.promise))
      .mockResolvedValueOnce(writable(secondClose.promise)),
  };
  vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValue([handle]));
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Open labels" }));
  const expression = await screen.findByRole("textbox", {
    name: "Expression",
  });
  await user.type(expression, " first");
  fireEvent.blur(expression);
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(handle.createWritable).toHaveBeenCalledTimes(1));

  await user.click(expression);
  await user.type(expression, " second");
  fireEvent.blur(expression);
  await user.click(screen.getByRole("button", { name: /^Save$/ }));

  await settleDeferred(() => secondClose.resolve());
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await settleDeferred(() => firstClose.resolve());

  await waitFor(() => {
    expect(diskContents).toBe(
      "0.00 0.00 10.00 10.00 person first second 0\n",
    );
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
  });
  expect(expression).toHaveValue("person first second");
});

it("exposes named workspace, annotation panel, status and mode controls", () => {
  render(<App />);

  expect(screen.getByRole("region", { name: "Image workspace" })).toBeVisible();
  expect(
    screen.getByRole("complementary", { name: "Annotations" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add box" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("reports clamped imported boxes without losing valid annotations", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 1920, height: 1080 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("1900 100 2000 200 edge car 0"),
  );

  expect(
    await screen.findByText("Clamped 1 bounding box to the image bounds."),
  ).toBeVisible();
  expect(screen.getByLabelText("X2")).toHaveValue("1920");
  expect(screen.getByLabelText("X1")).toHaveValue("1900");
});

it("announces notices through a polite live region", async () => {
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 1920, height: 1080 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("0 0 2000 200 edge box 0"),
  );

  const notice = await screen.findByText(
    "Clamped 1 bounding box to the image bounds.",
  );
  expect(notice).toHaveAttribute("aria-live", "polite");
});

it("offers deterministic example image and label downloads from the empty state", () => {
  render(<App />);

  expect(screen.getByRole("link", { name: "Example image" })).toHaveAttribute(
    "href",
    "/examples/rec-aerial-scene.svg",
  );
  expect(screen.getByRole("link", { name: "Example labels" })).toHaveAttribute(
    "href",
    "/examples/rec-aerial-scene.txt",
  );
});

it("ships 24-line example fixtures that parse inside a 1920x1080 image", async () => {
  const [labels, image] = await Promise.all([
    readFile(exampleFixture("rec-aerial-scene.txt"), "utf8"),
    readFile(exampleFixture("rec-aerial-scene.svg"), "utf8"),
  ]);
  const lines = labels.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(24);

  const parsed = parseAnnotationText(labels);
  expect(parsed.issues).toEqual([]);
  expect(parsed.annotations).toHaveLength(24);
  expect(
    parsed.annotations.filter((annotation) => annotation.label === "person"),
  ).toHaveLength(2);
  expect(parsed.annotations[0]?.id).toBe("ann_001");
  expect(parsed.annotations[1]?.id).toBe("ann_002");
  expect(
    parsed.annotations.every(
      (annotation) =>
        annotation.bbox.x1 >= 0 &&
        annotation.bbox.y1 >= 0 &&
        annotation.bbox.x2 <= 1920 &&
        annotation.bbox.y2 <= 1080,
    ),
  ).toBe(true);
  expect(image).toContain('width="1920"');
  expect(image).toContain('height="1080"');
});

it("focuses the error dialog and restores focus to the triggering control", async () => {
  const user = userEvent.setup();
  render(<App />);

  const trigger = screen.getByRole("button", { name: /^Save$/ });
  trigger.focus();
  fireEvent.drop(screen.getByRole("region", { name: "Image workspace" }), {
    dataTransfer: { files: [textFile("not a bounding box\n")] },
  });

  const close = await screen.findByRole("button", { name: "Close error" });
  expect(close).toHaveFocus();

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
});

it("keeps keyboard focus inside the error dialog while it is open", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile("10 10 5 5 broken 0\n"),
  );
  const close = await screen.findByRole("button", { name: "Close error" });
  expect(close).toHaveFocus();

  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(close).toHaveFocus();
});

it("shows a recoverable fatal error screen when the editor throws", () => {
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  function ExplodingChild(): JSX.Element {
    throw new Error("editor crashed");
  }

  render(
    <EditorErrorBoundary>
      <ExplodingChild />
    </EditorErrorBoundary>,
  );

  expect(
    screen.getByRole("heading", { name: "The editor hit an unexpected error" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Reload editor" }),
  ).toBeVisible();
  expect(consoleError).toHaveBeenCalled();
  consoleError.mockRestore();
});

it("collapses the annotation panel into an explicit drawer on narrow screens", async () => {
  const user = userEvent.setup();
  mockNarrowLayout(true);
  render(<App />);

  const toggle = screen.getByRole("button", { name: "Annotations" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Annotations")).not.toBeVisible();

  await user.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("complementary", { name: "Annotations" }),
  ).toBeVisible();
});

it("keeps the annotation panel open without a drawer toggle on wide screens", () => {
  mockNarrowLayout(false);
  render(<App />);

  expect(
    screen.getByRole("complementary", { name: "Annotations" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Annotations" }),
  ).not.toBeInTheDocument();
});

it("searches and selects one annotation in a 500-box document", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open labels"),
    textFile(makeStressAnnotations(500), "stress.txt"),
  );

  const panel = screen.getByRole("complementary", { name: "Annotations" });
  expect(screen.getByLabelText("Total annotations")).toHaveTextContent(
    "500 annotations",
  );

  await user.type(
    screen.getByPlaceholderText("Search expressions..."),
    "target 417",
  );
  await user.click(within(panel).getByText("target 417", { exact: true }));

  expect(within(panel).getByText("ann_417", { exact: true })).toBeVisible();
}, 60000);

it("leaves Add Box mode once when Escape is pressed before a draft exists", async () => {
  const reducer = vi.spyOn(editorReducerModule, "editorReducer");
  const user = userEvent.setup();
  mockImageEnvironment([{ width: 100, height: 80 }]);
  mockViewportEnvironment();
  render(<App />);

  await user.upload(
    screen.getByLabelText("Open image"),
    new File(["pixels"], "scene.png", { type: "image/png" }),
  );
  const addBox = screen.getByRole("button", { name: "Add box" });
  await user.click(addBox);
  expect(addBox).toHaveAttribute("aria-pressed", "true");
  reducer.mockClear();

  fireEvent.keyDown(window, { key: "Escape" });

  expect(addBox).toHaveAttribute("aria-pressed", "false");
  expect(
    reducer.mock.calls.filter(([, action]) => action.type === "SET_MODE"),
  ).toEqual([[expect.anything(), { type: "SET_MODE", mode: "select" }]]);
});
