import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatasetHome } from "./DatasetHome";
import * as datasetApi from "../app/datasetApi";

vi.mock("../app/datasetApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/datasetApi")>();
  return {
    ...actual,
    listDatasets: vi.fn(),
    createDataset: vi.fn(),
    deleteDataset: vi.fn(),
  };
});

const datasets: datasetApi.DatasetSummary[] = [
  {
    name: "dji",
    items: [
      { stem: "a", image: "a.jpg", labels: "a.jsonl" },
      { stem: "b", image: "b.jpg", labels: null },
      { stem: "c", image: null, labels: "c.txt" },
    ],
  },
  {
    name: "empty",
    items: [{ stem: "d", image: null, labels: null }],
  },
];

function renderHome(overrides: Partial<Parameters<typeof DatasetHome>[0]> = {}) {
  const props = {
    refreshToken: 0,
    onOpenEditor: vi.fn(),
    onOpenItem: vi.fn(),
    onManage: vi.fn(),
    ...overrides,
  };
  render(<DatasetHome {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(datasetApi.listDatasets).mockResolvedValue(datasets);
});

it("lists every stored dataset with its counts and previews", async () => {
  renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  expect(within(card).getByRole("heading", { name: "dji" })).toBeVisible();
  expect(card).toHaveTextContent("3 items");
  expect(card).toHaveTextContent("2 with images");
  // `c` has labels but no image, so the two counts are independent.
  expect(card).toHaveTextContent("2 with labels");

  const previews = [...card.querySelectorAll<HTMLImageElement>("img")];
  expect(previews.map((image) => image.getAttribute("src"))).toEqual([
    "/datasets/dji/images/a.jpg",
    "/datasets/dji/images/b.jpg",
  ]);
  expect(previews[0]).toHaveAttribute("loading", "lazy");

  // Labels-only datasets are still listed, just without a preview and with
  // nothing to open.
  const emptyCard = screen.getByTestId("dataset-card-empty");
  expect(emptyCard).toHaveTextContent("No images yet");
  expect(
    within(emptyCard).getByRole("button", { name: "Open dataset empty" }),
  ).toBeDisabled();
});

it("opens the first item that has an image from the card itself", async () => {
  const user = userEvent.setup();
  const props = renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  // The stretched hit area covers the whole card, so there is no Open button.
  expect(
    within(card).queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  await user.click(
    within(card).getByRole("button", { name: "Open dataset dji" }),
  );

  expect(props.onOpenItem).toHaveBeenCalledWith(
    "dji",
    { stem: "a", image: "a.jpg", labels: "a.jsonl" },
    datasets[0]!.items,
  );
});

it("keeps the secondary actions from opening the dataset", async () => {
  const user = userEvent.setup();
  const props = renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  await user.click(within(card).getByRole("button", { name: "Manage files" }));

  expect(props.onManage).toHaveBeenCalledWith("dji");
  expect(props.onOpenItem).not.toHaveBeenCalled();
});

it("filters datasets by name and sums up the import", async () => {
  const user = userEvent.setup();
  renderHome();
  await screen.findByTestId("dataset-card-dji");

  expect(screen.getByText(/2 datasets · 4 items/)).toBeVisible();

  await user.type(screen.getByLabelText("Search datasets"), "emp");

  expect(screen.queryByTestId("dataset-card-dji")).not.toBeInTheDocument();
  expect(screen.getByTestId("dataset-card-empty")).toBeVisible();
  expect(screen.getByText("1 of 2")).toBeVisible();
});

it("calls out the halves a dataset is still missing", async () => {
  renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  // `b` has no labels, `c` has no image.
  expect(within(card).getByText("1 without images")).toBeVisible();
  expect(within(card).getByText("1 without labels")).toBeVisible();

  const emptyCard = screen.getByTestId("dataset-card-empty");
  expect(within(emptyCard).getByText("1 without images")).toBeVisible();
  expect(within(emptyCard).getByText("1 without labels")).toBeVisible();
});

it("hands the dataset over for file management", async () => {
  const user = userEvent.setup();
  const props = renderHome();

  const card = await screen.findByTestId("dataset-card-empty");
  await user.click(
    within(card).getByRole("button", { name: "Manage files" }),
  );

  expect(props.onManage).toHaveBeenCalledWith("empty");
});

it("asks for the name only after Create dataset is clicked", async () => {
  const user = userEvent.setup();
  vi.mocked(datasetApi.createDataset).mockResolvedValue(undefined);
  renderHome();
  await screen.findByTestId("dataset-card-dji");

  // Nothing to fill in upfront.
  expect(screen.queryByLabelText("New dataset name")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Create dataset" }));

  const dialog = await screen.findByRole("dialog", { name: "New dataset" });
  const name = within(dialog).getByLabelText("New dataset name");
  const confirm = within(dialog).getByRole("button", { name: "Create" });
  expect(confirm).toBeDisabled();

  await user.type(name, "night-flights");
  await user.click(confirm);

  await waitFor(() =>
    expect(datasetApi.createDataset).toHaveBeenCalledWith("night-flights"),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "New dataset" }),
    ).not.toBeInTheDocument(),
  );
  expect(vi.mocked(datasetApi.listDatasets).mock.calls.length).toBeGreaterThan(1);
});

it("discards a half-typed name when the new-dataset dialog is cancelled", async () => {
  const user = userEvent.setup();
  renderHome();
  await screen.findByTestId("dataset-card-dji");

  await user.click(screen.getByRole("button", { name: "Create dataset" }));
  const dialog = await screen.findByRole("dialog", { name: "New dataset" });
  await user.type(within(dialog).getByLabelText("New dataset name"), "typo");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  expect(
    screen.queryByRole("dialog", { name: "New dataset" }),
  ).not.toBeInTheDocument();
  expect(datasetApi.createDataset).not.toHaveBeenCalled();

  // Reopening starts from an empty field.
  await user.click(screen.getByRole("button", { name: "Create dataset" }));
  const reopened = await screen.findByRole("dialog", { name: "New dataset" });
  expect(within(reopened).getByLabelText("New dataset name")).toHaveValue("");
});

it("deletes a dataset after confirming", async () => {
  const user = userEvent.setup();
  vi.mocked(datasetApi.deleteDataset).mockResolvedValue(undefined);
  vi.mocked(datasetApi.listDatasets)
    .mockResolvedValueOnce(datasets)
    .mockResolvedValue([datasets[1]!]);
  renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  await user.click(
    within(card).getByRole("button", { name: "Delete dataset dji" }),
  );

  const confirm = await screen.findByRole("dialog", {
    name: "Delete dataset dji?",
  });
  expect(confirm).toHaveTextContent("3 item(s)");
  await user.click(
    within(confirm).getByRole("button", { name: "Delete dataset" }),
  );

  await waitFor(() =>
    expect(datasetApi.deleteDataset).toHaveBeenCalledWith("dji"),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("dataset-card-dji")).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId("dataset-card-empty")).toBeVisible();
});

it("keeps the dataset when the delete is cancelled", async () => {
  const user = userEvent.setup();
  renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  await user.click(
    within(card).getByRole("button", { name: "Delete dataset dji" }),
  );
  await user.click(screen.getByRole("button", { name: "Keep dataset" }));

  expect(
    screen.queryByRole("dialog", { name: "Delete dataset dji?" }),
  ).not.toBeInTheDocument();
  expect(datasetApi.deleteDataset).not.toHaveBeenCalled();
  expect(screen.getByTestId("dataset-card-dji")).toBeVisible();
});

it("offers the plain editor for files that are not in a dataset", async () => {
  const user = userEvent.setup();
  const props = renderHome();

  await user.click(
    await screen.findByRole("button", { name: "Open files without a dataset" }),
  );

  expect(props.onOpenEditor).toHaveBeenCalledTimes(1);
});

it("reloads when the refresh token changes", async () => {
  const { rerender } = render(
    <DatasetHome
      refreshToken={0}
      onOpenEditor={vi.fn()}
      onOpenItem={vi.fn()}
      onManage={vi.fn()}
    />,
  );
  await screen.findByTestId("dataset-card-dji");
  expect(datasetApi.listDatasets).toHaveBeenCalledTimes(1);

  rerender(
    <DatasetHome
      refreshToken={1}
      onOpenEditor={vi.fn()}
      onOpenItem={vi.fn()}
      onManage={vi.fn()}
    />,
  );

  await waitFor(() => expect(datasetApi.listDatasets).toHaveBeenCalledTimes(2));
});

it("shows an empty state before any dataset exists", async () => {
  vi.mocked(datasetApi.listDatasets).mockResolvedValue([]);
  renderHome();

  expect(
    await screen.findByText(/No datasets yet/),
  ).toBeVisible();
});

it("surfaces a load failure", async () => {
  vi.mocked(datasetApi.listDatasets).mockRejectedValue(
    new Error("server is down"),
  );
  renderHome();

  expect(await screen.findByRole("alert")).toHaveTextContent("server is down");
});
