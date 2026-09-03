import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

afterEach(() => {
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

it("shows and clears drag-active guidance", () => {
  render(<App />);
  const workspace = screen.getByRole("region", { name: "Image workspace" });

  fireEvent.dragEnter(workspace, { dataTransfer: { files: [] } });
  expect(workspace).toHaveTextContent("Drop files to import");

  fireEvent.dragLeave(workspace, { dataTransfer: { files: [] } });
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
      expect.objectContaining({ type: "LOAD_ANNOTATIONS" }),
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
