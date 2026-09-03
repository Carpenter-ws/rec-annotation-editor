import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as editorReducerModule from "./state/editorReducer";

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
  const createObjectURL = vi.fn(() => `blob:image-${++urlNumber}`);
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

  const addBox = screen.getByRole("button", { name: "Add Box" });
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
  await user.click(screen.getByRole("button", { name: "Add Box" }));

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
  await user.click(screen.getByRole("button", { name: "Add Box" }));
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
  await user.click(screen.getByRole("button", { name: "Add Box" }));
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
  expect(screen.getByRole("button", { name: "Add Box" })).toHaveAttribute(
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
  await user.click(screen.getByRole("button", { name: "Add Box" }));
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
  await user.click(screen.getByRole("button", { name: "Add Box" }));
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
  expect(screen.getByRole("button", { name: "Add Box" })).toHaveAttribute(
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
    await user.click(screen.getByRole("button", { name: "Add Box" }));
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

    await user.click(screen.getByRole("button", { name: "Add Box" }));
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
    expect(screen.getByRole("button", { name: "Add Box" })).toHaveAttribute(
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
