import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject } from "react";
import type { Annotation, BBox, ImageInfo } from "../domain/types";
import type { ViewTransform } from "../domain/coordinates";
import { Viewport, type ViewportHandle } from "./Viewport";

const image: ImageInfo = {
  name: "scene.jpg",
  width: 1920,
  height: 1080,
  url: "blob:scene",
};

const annotations: Annotation[] = [
  {
    id: "ann_001",
    bbox: { x1: 855.04, y1: 544.45, x2: 1040.5, y2: 702.25 },
    label: "person",
    reservedField: "0",
  },
];

const duplicateLabels: Annotation[] = [
  annotations[0]!,
  {
    id: "ann_002",
    bbox: { x1: 120, y1: 90, x2: 260, y2: 310 },
    label: "person",
    reservedField: "0",
  },
];

const dispatch = vi.fn();
let viewportWidth = 1000;
let viewportHeight = 700;
let resizeCallback: ResizeObserverCallback | null = null;
let resizeTarget: Element | null = null;
let resizeObserver: ResizeObserver | null = null;

function workspaceRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: viewportWidth,
    bottom: viewportHeight,
    width: viewportWidth,
    height: viewportHeight,
    toJSON: () => ({}),
  };
}

function resizeViewport(width: number, height: number): void {
  viewportWidth = width;
  viewportHeight = height;
  if (!resizeCallback || !resizeTarget || !resizeObserver) {
    throw new Error("Viewport is not being observed");
  }

  act(() => {
    resizeCallback!(
      [
        {
          target: resizeTarget!,
          contentRect: workspaceRect(),
        } as ResizeObserverEntry,
      ],
      resizeObserver!,
    );
  });
}

interface RenderOptions {
  image?: ImageInfo;
  annotations?: Annotation[];
  initialTransform?: ViewTransform;
  selectedId?: string | null;
  viewportRef?: RefObject<ViewportHandle>;
  mode?: "select" | "add";
  onDraftBox?: (bbox: BBox) => void;
}

function renderViewport(options: RenderOptions = {}) {
  return render(
    <Viewport
      ref={options.viewportRef}
      image={options.image ?? image}
      annotations={options.annotations ?? annotations}
      selectedId={options.selectedId ?? null}
      dispatch={dispatch}
      initialTransform={options.initialTransform}
      onZoomChange={vi.fn()}
      mode={options.mode ?? "select"}
      onDraftBox={options.onDraftBox ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  dispatch.mockReset();
  viewportWidth = 1000;
  viewportHeight = 700;
  resizeCallback = null;
  resizeTarget = null;
  resizeObserver = null;

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

  vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(
    workspaceRect,
  );

  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }

      observe(target: Element) {
        resizeTarget = target;
        resizeCallback!(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
            } as ResizeObserverEntry,
          ],
          this,
        );
      }

      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders image and boxes in one transformed SVG group", () => {
  renderViewport();

  const scene = screen.getByTestId("image-space");
  expect(scene).toHaveAttribute(
    "transform",
    "translate(0 68.75) scale(0.5208333333333334)",
  );
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("x", "855.04");
  expect(screen.getByTestId("bbox-ann_001")).toHaveAttribute("y", "544.45");
});

it("selects by annotation id rather than label", async () => {
  const user = userEvent.setup();
  renderViewport({ annotations: duplicateLabels });

  await user.click(screen.getByTestId("bbox-ann_002"));

  expect(dispatch).toHaveBeenCalledWith({ type: "SELECT", id: "ann_002" });
});

it("commits one original-coordinate move transaction after pointer up", () => {
  const annotation: Annotation = {
    id: "ann_001",
    bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
    label: "person",
    reservedField: "0",
  };
  renderViewport({
    annotations: [annotation],
    selectedId: annotation.id,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 1,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 1,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 1,
    clientX: 120,
    clientY: 105,
  });

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { bbox: { x1: 200, y1: 150, x2: 300, y2: 250 } },
      },
    ],
    [{ type: "COMMIT_TRANSACTION" }],
  ]);
  expect(setPointerCapture).toHaveBeenCalledOnce();
  expect(setPointerCapture).toHaveBeenCalledWith(1);
  expect(releasePointerCapture).toHaveBeenCalledOnce();
  expect(releasePointerCapture).toHaveBeenCalledWith(1);
});

it("does not select again when a completed box drag produces a click", () => {
  const annotation: Annotation = {
    id: "ann_001",
    bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
    label: "person",
    reservedField: "0",
  };
  renderViewport({
    annotations: [annotation],
    selectedId: annotation.id,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const box = screen.getByTestId("bbox-ann_001");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(box, {
    pointerId: 13,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 13,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.pointerUp(canvas, { pointerId: 13, clientX: 120, clientY: 105 });
  fireEvent.click(box);

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { bbox: { x1: 200, y1: 150, x2: 300, y2: 250 } },
      },
    ],
    [{ type: "COMMIT_TRANSACTION" }],
  ]);
});

it("renders eight constant-screen-size handles at corners and edge midpoints", () => {
  renderViewport({
    annotations: [
      {
        id: "ann_001",
        bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
        label: "person",
        reservedField: "0",
      },
    ],
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });

  const expectedHandles = [
    ["nw", 90, 90],
    ["n", 140, 90],
    ["ne", 190, 90],
    ["e", 190, 140],
    ["se", 190, 190],
    ["s", 140, 190],
    ["sw", 90, 190],
    ["w", 90, 140],
  ] as const;

  for (const [name, x, y] of expectedHandles) {
    expect(screen.getByTestId(`handle-${name}`)).toHaveAttribute(
      "x",
      String(x),
    );
    expect(screen.getByTestId(`handle-${name}`)).toHaveAttribute(
      "y",
      String(y),
    );
    expect(screen.getByTestId(`handle-${name}`)).toHaveAttribute("width", "20");
    expect(screen.getByTestId(`handle-${name}`)).toHaveAttribute("height", "20");
  }
});

it.each([
  {
    handle: "nw",
    start: { x: 70, y: 80 },
    end: { x: 60, y: 65 },
    bbox: { x1: 80, y1: 70, x2: 200, y2: 200 },
  },
  {
    handle: "n",
    start: { x: 95, y: 80 },
    end: { x: 95, y: 65 },
    bbox: { x1: 100, y1: 70, x2: 200, y2: 200 },
  },
  {
    handle: "ne",
    start: { x: 120, y: 80 },
    end: { x: 130, y: 65 },
    bbox: { x1: 100, y1: 70, x2: 220, y2: 200 },
  },
  {
    handle: "e",
    start: { x: 120, y: 105 },
    end: { x: 130, y: 105 },
    bbox: { x1: 100, y1: 100, x2: 220, y2: 200 },
  },
  {
    handle: "se",
    start: { x: 120, y: 130 },
    end: { x: 130, y: 145 },
    bbox: { x1: 100, y1: 100, x2: 220, y2: 230 },
  },
  {
    handle: "s",
    start: { x: 95, y: 130 },
    end: { x: 95, y: 145 },
    bbox: { x1: 100, y1: 100, x2: 200, y2: 230 },
  },
  {
    handle: "sw",
    start: { x: 70, y: 130 },
    end: { x: 60, y: 145 },
    bbox: { x1: 80, y1: 100, x2: 200, y2: 230 },
  },
  {
    handle: "w",
    start: { x: 70, y: 105 },
    end: { x: 60, y: 105 },
    bbox: { x1: 80, y1: 100, x2: 200, y2: 200 },
  },
] as const)(
  "activates the $handle handle as one original-coordinate resize transaction",
  ({ handle, start, end, bbox }) => {
    renderViewport({
      annotations: [
        {
          id: "ann_001",
          bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
          label: "person",
          reservedField: "0",
        },
      ],
      selectedId: "ann_001",
      initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
    });
    const canvas = screen.getByLabelText("Annotation canvas");
    Object.assign(canvas, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    });

    fireEvent.pointerDown(screen.getByTestId(`handle-${handle}`), {
      pointerId: 2,
      clientX: start.x,
      clientY: start.y,
      button: 0,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 2,
      clientX: end.x,
      clientY: end.y,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 2,
      clientX: end.x,
      clientY: end.y,
    });

    expect(dispatch.mock.calls).toEqual([
      [{ type: "BEGIN_TRANSACTION" }],
      [
        {
          type: "PREVIEW_PATCH",
          id: "ann_001",
          patch: { bbox },
        },
      ],
      [{ type: "COMMIT_TRANSACTION" }],
    ]);
  },
);

it("keeps resize click suppression after dragging away and back", () => {
  renderViewport({
    annotations: [
      {
        id: "ann_001",
        bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
        label: "person",
        reservedField: "0",
      },
    ],
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const handle = screen.getByTestId("handle-e");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(handle, {
    pointerId: 18,
    clientX: 120,
    clientY: 105,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 18,
    clientX: 130,
    clientY: 105,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 18,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 18,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.click(handle);

  expect(dispatch).toHaveBeenCalledWith({ type: "COMMIT_TRANSACTION" });
  expect(
    dispatch.mock.calls.some(([action]) => action.type === "SELECT"),
  ).toBe(false);
});

it("cancels a moved preview on pointer cancel without committing", () => {
  const annotation: Annotation = {
    id: "ann_001",
    bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
    label: "person",
    reservedField: "0",
  };
  renderViewport({
    annotations: [annotation],
    selectedId: annotation.id,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 4,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 4,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.pointerCancel(canvas, { pointerId: 4 });

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { bbox: { x1: 200, y1: 150, x2: 300, y2: 250 } },
      },
    ],
    [{ type: "CANCEL_TRANSACTION" }],
  ]);
  expect(releasePointerCapture).toHaveBeenCalledOnce();
  expect(releasePointerCapture).toHaveBeenCalledWith(4);
});

it("cancels a moved preview when pointer capture is unexpectedly lost", () => {
  const annotation: Annotation = {
    id: "ann_001",
    bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
    label: "person",
    reservedField: "0",
  };
  renderViewport({
    annotations: [annotation],
    selectedId: annotation.id,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => false),
  });

  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 16,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 16,
    clientX: 120,
    clientY: 105,
  });
  fireEvent.lostPointerCapture(canvas, { pointerId: 16 });

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { bbox: { x1: 200, y1: 150, x2: 300, y2: 250 } },
      },
    ],
    [{ type: "CANCEL_TRANSACTION" }],
  ]);
  expect(releasePointerCapture).not.toHaveBeenCalled();
});

it("cancels a resized preview on Escape and releases pointer capture", () => {
  renderViewport({
    annotations: [
      {
        id: "ann_001",
        bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
        label: "person",
        reservedField: "0",
      },
    ],
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(screen.getByTestId("handle-se"), {
    pointerId: 5,
    clientX: 120,
    clientY: 130,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 5,
    clientX: 130,
    clientY: 145,
  });
  fireEvent.keyDown(window, { key: "Escape" });

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { bbox: { x1: 100, y1: 100, x2: 220, y2: 230 } },
      },
    ],
    [{ type: "CANCEL_TRANSACTION" }],
  ]);
  expect(releasePointerCapture).toHaveBeenCalledOnce();
  expect(releasePointerCapture).toHaveBeenCalledWith(5);
});

it("converts an add-mode drag into an image-space draft", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 6,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 6,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 6,
    clientX: 170,
    clientY: 180,
  });

  expect(onDraftBox).toHaveBeenCalledOnce();
  expect(onDraftBox).toHaveBeenCalledWith({
    x1: 100,
    y1: 100,
    x2: 300,
    y2: 300,
  });
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not clear selection when a completed draw produces a click", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 14,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 14,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 14,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.click(canvas);

  expect(onDraftBox).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});

it("suppresses a draw click when the final coordinates arrive on pointer up", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 16,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 16,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.click(canvas);

  expect(onDraftBox).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});

it("keeps draw click suppression after dragging away and back", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    selectedId: "ann_001",
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 19,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 19,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 19,
    clientX: 70,
    clientY: 80,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 19,
    clientX: 70,
    clientY: 80,
  });
  fireEvent.click(canvas);

  expect(onDraftBox).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

it("draws instead of moving when an add-mode drag starts over a box", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    annotations: [
      {
        id: "ann_001",
        bbox: { x1: 100, y1: 100, x2: 200, y2: 200 },
        label: "person",
        reservedField: "0",
      },
    ],
    selectedId: "ann_001",
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(screen.getByTestId("bbox-ann_001"), {
    pointerId: 15,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 15,
    clientX: 170,
    clientY: 180,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 15,
    clientX: 170,
    clientY: 180,
  });

  expect(onDraftBox).toHaveBeenCalledWith({
    x1: 100,
    y1: 100,
    x2: 300,
    y2: 300,
  });
  expect(dispatch).not.toHaveBeenCalled();
});

it("normalizes a reversed add-mode drag", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 7,
    clientX: 170,
    clientY: 180,
    button: 0,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 7,
    clientX: 70,
    clientY: 80,
  });

  expect(onDraftBox).toHaveBeenCalledOnce();
  expect(onDraftBox).toHaveBeenCalledWith({
    x1: 100,
    y1: 100,
    x2: 300,
    y2: 300,
  });
});

it("clamps an add-mode drag to the image bounds", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    image: {
      name: "small.png",
      width: 400,
      height: 300,
      url: "blob:small",
    },
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 8,
    clientX: 0,
    clientY: 20,
    button: 0,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 8,
    clientX: 270,
    clientY: 230,
  });

  expect(onDraftBox).toHaveBeenCalledOnce();
  expect(onDraftBox).toHaveBeenCalledWith({
    x1: 0,
    y1: 0,
    x2: 400,
    y2: 300,
  });
});

it("keeps a clamped draw preview local until pointer up", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    image: {
      name: "small.png",
      width: 400,
      height: 300,
      url: "blob:small",
    },
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 10,
    clientX: 0,
    clientY: 20,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 10,
    clientX: 270,
    clientY: 230,
  });

  expect(screen.getByTestId("draft-box")).toHaveAttribute("x", "0");
  expect(screen.getByTestId("draft-box")).toHaveAttribute("y", "0");
  expect(screen.getByTestId("draft-box")).toHaveAttribute("width", "400");
  expect(screen.getByTestId("draft-box")).toHaveAttribute("height", "300");
  expect(onDraftBox).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

it("discards a local draw preview on pointer cancel", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 11,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 11,
    clientX: 170,
    clientY: 180,
  });
  expect(screen.getByTestId("draft-box")).toBeVisible();

  fireEvent.pointerCancel(canvas, { pointerId: 11 });

  expect(screen.queryByTestId("draft-box")).not.toBeInTheDocument();
  expect(onDraftBox).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(releasePointerCapture).toHaveBeenCalledOnce();
  expect(releasePointerCapture).toHaveBeenCalledWith(11);
});

it("discards a local draw preview on Escape", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 12,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 12,
    clientX: 170,
    clientY: 180,
  });
  expect(screen.getByTestId("draft-box")).toBeVisible();

  fireEvent.keyDown(window, { key: "Escape" });

  expect(screen.queryByTestId("draft-box")).not.toBeInTheDocument();
  expect(onDraftBox).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(releasePointerCapture).toHaveBeenCalledOnce();
  expect(releasePointerCapture).toHaveBeenCalledWith(12);
});

it("ignores an add-mode draft narrower than three screen pixels", () => {
  const onDraftBox = vi.fn();
  renderViewport({
    mode: "add",
    onDraftBox,
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.pointerDown(canvas, {
    pointerId: 9,
    clientX: 70,
    clientY: 80,
    button: 0,
  });
  fireEvent.pointerUp(canvas, {
    pointerId: 9,
    clientX: 72,
    clientY: 90,
  });

  expect(onDraftBox).not.toHaveBeenCalled();
});

it("keeps the same image point beneath the wheel cursor", () => {
  renderViewport({
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");

  fireEvent.wheel(canvas, {
    clientX: 420,
    clientY: 300,
    deltaY: -Math.log(2) / 0.0015,
  });

  const imageSpace = screen.getByTestId("image-space");
  expect(Number(imageSpace.getAttribute("data-scale"))).toBeCloseTo(1, 10);
  expect(Number(imageSpace.getAttribute("data-offset-x"))).toBeCloseTo(-380, 10);
  expect(Number(imageSpace.getAttribute("data-offset-y"))).toBeCloseTo(-240, 10);
});

it("clamps wheel zoom to the supported scale range", () => {
  renderViewport({
    initialTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const imageSpace = screen.getByTestId("image-space");

  fireEvent.wheel(canvas, { clientX: 500, clientY: 350, deltaY: 10_000 });
  expect(Number(imageSpace.getAttribute("data-scale"))).toBe(0.05);

  fireEvent.wheel(canvas, { clientX: 500, clientY: 350, deltaY: -10_000 });
  expect(Number(imageSpace.getAttribute("data-scale"))).toBe(32);
});

it("pans with the middle button while holding pointer capture", () => {
  renderViewport({
    initialTransform: { scale: 0.5, offsetX: 20, offsetY: 30 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  const hasPointerCapture = vi.fn(() => true);
  Object.assign(canvas, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture,
  });

  fireEvent.pointerDown(canvas, {
    button: 1,
    pointerId: 7,
    clientX: 100,
    clientY: 120,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 7,
    clientX: 130,
    clientY: 160,
  });

  const imageSpace = screen.getByTestId("image-space");
  expect(imageSpace).toHaveAttribute("data-scale", "0.5");
  expect(imageSpace).toHaveAttribute("data-offset-x", "50");
  expect(imageSpace).toHaveAttribute("data-offset-y", "70");
  expect(setPointerCapture).toHaveBeenCalledWith(7);

  fireEvent.pointerUp(canvas, { pointerId: 7 });
  expect(releasePointerCapture).toHaveBeenCalledWith(7);

  hasPointerCapture.mockReturnValue(false);
  fireEvent.pointerDown(canvas, {
    button: 1,
    pointerId: 10,
    clientX: 130,
    clientY: 160,
  });
  fireEvent.pointerCancel(canvas, { pointerId: 10 });
  expect(releasePointerCapture).toHaveBeenCalledTimes(1);
});

it("pans with the left button only while Space is held", () => {
  renderViewport({
    initialTransform: { scale: 0.75, offsetX: 10, offsetY: 15 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const setPointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture,
    releasePointerCapture: vi.fn(),
  });

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 8,
    clientX: 50,
    clientY: 60,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 8,
    clientX: 80,
    clientY: 90,
  });
  expect(screen.getByTestId("image-space")).toHaveAttribute(
    "data-offset-x",
    "10",
  );

  fireEvent.keyDown(window, { code: "Space" });
  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 9,
    clientX: 50,
    clientY: 60,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 9,
    clientX: 80,
    clientY: 100,
  });

  const imageSpace = screen.getByTestId("image-space");
  expect(imageSpace).toHaveAttribute("data-scale", "0.75");
  expect(imageSpace).toHaveAttribute("data-offset-x", "40");
  expect(imageSpace).toHaveAttribute("data-offset-y", "55");
  expect(setPointerCapture).toHaveBeenCalledWith(9);

  fireEvent.keyUp(window, { code: "Space" });
});

it("prevents canvas Space scrolling, preserves interactive keys, and resets on blur", () => {
  renderViewport({
    initialTransform: { scale: 1, offsetX: 10, offsetY: 15 },
  });
  const canvas = screen.getByLabelText("Annotation canvas");
  const setPointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture,
    releasePointerCapture: vi.fn(),
  });

  expect(fireEvent.keyDown(window, { code: "Space" })).toBe(false);
  fireEvent.blur(window);
  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 12,
    clientX: 50,
    clientY: 60,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 12,
    clientX: 90,
    clientY: 100,
  });

  expect(setPointerCapture).not.toHaveBeenCalled();
  expect(screen.getByTestId("image-space")).toHaveAttribute(
    "transform",
    "translate(10 15) scale(1)",
  );

  const input = document.createElement("input");
  document.body.append(input);
  expect(fireEvent.keyDown(input, { code: "Space" })).toBe(true);
  input.remove();

  const button = document.createElement("button");
  document.body.append(button);
  expect(fireEvent.keyDown(button, { code: "Space" })).toBe(true);
  button.remove();
});

it("does not change selection when a completed pan produces a click", () => {
  renderViewport({ selectedId: "ann_001" });
  const canvas = screen.getByLabelText("Annotation canvas");
  const box = screen.getByTestId("bbox-ann_001");
  Object.assign(canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });

  fireEvent.keyDown(window, { code: "Space" });
  fireEvent.pointerDown(box, {
    button: 0,
    pointerId: 11,
    clientX: 100,
    clientY: 120,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 11,
    clientX: 140,
    clientY: 160,
  });
  fireEvent.pointerUp(canvas, { pointerId: 11 });
  fireEvent.click(box);
  fireEvent.keyUp(window, { code: "Space" });

  expect(dispatch).not.toHaveBeenCalled();
});

it("clears selection when the blank canvas is left-clicked", async () => {
  const user = userEvent.setup();
  renderViewport({ selectedId: "ann_001" });

  await user.click(screen.getByLabelText("Annotation canvas"));

  expect(dispatch).toHaveBeenCalledWith({ type: "SELECT", id: null });
});

it("refits on resize only until the user zooms manually", () => {
  renderViewport();
  const canvas = screen.getByLabelText("Annotation canvas");
  const imageSpace = screen.getByTestId("image-space");

  resizeViewport(800, 600);
  expect(imageSpace).toHaveAttribute("data-scale", "0.4166666666666667");
  expect(imageSpace).toHaveAttribute("data-offset-x", "0");
  expect(imageSpace).toHaveAttribute("data-offset-y", "75");

  fireEvent.wheel(canvas, {
    clientX: 400,
    clientY: 300,
    deltaY: -Math.log(2) / 0.0015,
  });
  const manualTransform = imageSpace.getAttribute("transform");

  resizeViewport(1200, 900);
  expect(imageSpace).toHaveAttribute("transform", manualTransform);
});

it.each([
  {
    description: "tiny",
    image: { name: "tiny.png", width: 1, height: 1, url: "blob:tiny" },
    scale: 32,
    offsetX: 484,
    offsetY: 334,
  },
  {
    description: "huge",
    image: {
      name: "huge.png",
      width: 100_000,
      height: 100_000,
      url: "blob:huge",
    },
    scale: 0.05,
    offsetX: -2000,
    offsetY: -2150,
  },
])(
  "clamps and centers fit scale for $description images",
  ({ image: fittedImage, scale, offsetX, offsetY }) => {
    renderViewport({ image: fittedImage });

    const imageSpace = screen.getByTestId("image-space");
    expect(Number(imageSpace.getAttribute("data-scale"))).toBe(scale);
    expect(Number(imageSpace.getAttribute("data-offset-x"))).toBe(offsetX);
    expect(Number(imageSpace.getAttribute("data-offset-y"))).toBe(offsetY);
  },
);

it("exposes fit and resumes fitting subsequent resizes", () => {
  const viewportRef = createRef<ViewportHandle>();
  renderViewport({
    viewportRef,
    initialTransform: { scale: 2, offsetX: -300, offsetY: -200 },
  });

  act(() => viewportRef.current!.fit());

  const imageSpace = screen.getByTestId("image-space");
  expect(imageSpace).toHaveAttribute(
    "transform",
    "translate(0 68.75) scale(0.5208333333333334)",
  );

  resizeViewport(500, 500);
  expect(imageSpace).toHaveAttribute(
    "transform",
    "translate(0 109.375) scale(0.2604166666666667)",
  );
});

it("centers annotations, enlarging small boxes to roughly 35% with an 8x cap", () => {
  const viewportRef = createRef<ViewportHandle>();
  const medium: Annotation = {
    id: "ann_002",
    bbox: { x1: 200, y1: 200, x2: 270, y2: 250 },
    label: "person",
    reservedField: "0",
  };
  const tiny: Annotation = {
    id: "ann_003",
    bbox: { x1: 100, y1: 100, x2: 110, y2: 110 },
    label: "person",
    reservedField: "0",
  };
  renderViewport({
    viewportRef,
    annotations: [annotations[0]!, medium, tiny],
    initialTransform: { scale: 1, offsetX: 12, offsetY: 18 },
  });
  const imageSpace = screen.getByTestId("image-space");

  act(() => viewportRef.current!.centerAnnotation("ann_001"));
  expect(Number(imageSpace.getAttribute("data-scale"))).toBe(1);
  expect(Number(imageSpace.getAttribute("data-offset-x"))).toBeCloseTo(
    -447.77,
    10,
  );
  expect(Number(imageSpace.getAttribute("data-offset-y"))).toBeCloseTo(
    -273.35,
    10,
  );

  act(() => viewportRef.current!.centerAnnotation("ann_002"));
  expect(Number(imageSpace.getAttribute("data-scale"))).toBeCloseTo(4.9, 10);
  expect(Number(imageSpace.getAttribute("data-offset-x"))).toBeCloseTo(
    -651.5,
    10,
  );
  expect(Number(imageSpace.getAttribute("data-offset-y"))).toBeCloseTo(
    -752.5,
    10,
  );

  act(() => viewportRef.current!.centerAnnotation("ann_003"));
  expect(Number(imageSpace.getAttribute("data-scale"))).toBe(8);
  expect(Number(imageSpace.getAttribute("data-offset-x"))).toBe(-340);
  expect(Number(imageSpace.getAttribute("data-offset-y"))).toBe(-490);
});
