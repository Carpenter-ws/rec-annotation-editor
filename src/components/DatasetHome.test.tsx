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

  // Labels-only datasets are still listed, just without a preview.
  const emptyCard = screen.getByTestId("dataset-card-empty");
  expect(emptyCard).toHaveTextContent("No images yet");
  expect(
    within(emptyCard).getByRole("button", { name: "Open" }),
  ).toBeDisabled();
});

it("opens the first item that has an image", async () => {
  const user = userEvent.setup();
  const props = renderHome();

  const card = await screen.findByTestId("dataset-card-dji");
  await user.click(within(card).getByRole("button", { name: "Open" }));

  expect(props.onOpenItem).toHaveBeenCalledWith(
    "dji",
    { stem: "a", image: "a.jpg", labels: "a.jsonl" },
    datasets[0]!.items,
  );
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

it("creates a dataset and reloads the list", async () => {
  const user = userEvent.setup();
  vi.mocked(datasetApi.createDataset).mockResolvedValue(undefined);
  renderHome();
  await screen.findByTestId("dataset-card-dji");

  await user.type(screen.getByLabelText("New dataset name"), "night-flights");
  await user.click(screen.getByRole("button", { name: "Create dataset" }));

  await waitFor(() =>
    expect(datasetApi.createDataset).toHaveBeenCalledWith("night-flights"),
  );
  expect(vi.mocked(datasetApi.listDatasets).mock.calls.length).toBeGreaterThan(1);
  expect(screen.getByLabelText("New dataset name")).toHaveValue("");
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
