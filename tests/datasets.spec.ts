import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const example = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

test("switches between images of one dataset", async ({ page }) => {
  test.setTimeout(90000);
  await page.request.delete("/api/datasets/e2e-nav");
  await page.goto("/");
  await page.getByRole("button", { name: "Datasets" }).click();
  const dialog = page.getByRole("dialog", { name: "Datasets" });
  await dialog.getByLabel("Dataset name").fill("e2e-nav");
  await dialog.getByRole("button", { name: "Create dataset" }).click();

  const row = dialog.locator('[data-dataset-name="e2e-nav"]');
  const fileInput = row.getByLabel("Choose dataset files for e2e-nav");
  const image = await readFile(example("rec-aerial-scene.svg"));
  const labels = await readFile(example("rec-aerial-scene.txt"), "utf8");
  const secondLabels = labels.replaceAll("person", "vehicle");

  await fileInput.setInputFiles([
    { name: "nav-one.svg", mimeType: "image/svg+xml", buffer: image },
    { name: "nav-one.txt", mimeType: "text/plain", buffer: Buffer.from(labels) },
    { name: "nav-two.svg", mimeType: "image/svg+xml", buffer: image },
    {
      name: "nav-two.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(secondLabels),
    },
  ]);
  await expect(row.getByTestId("staged-summary")).toContainText(
    "4 files ready to import",
  );
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(row.getByText("2 of 2 item(s) ready to open.")).toBeVisible();

  // Open the second item and step back with the toolbar buttons.
  await row
    .locator('[data-item-stem="nav-two"]')
    .getByRole("button", { name: "Open" })
    .click();
  const position = page.getByTestId("dataset-position");
  const firstCard = page.locator('[data-annotation-id="ann_001"]');
  await expect(position).toHaveText("2 / 2");
  await expect(page.getByRole("button", { name: "Next image" })).toBeDisabled();
  await expect(firstCard.getByLabel("Expression")).toHaveValue("vehicle");

  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(position).toHaveText("1 / 2");
  await expect(page.getByRole("button", { name: "Previous image" })).toBeDisabled();
  await expect(firstCard.getByLabel("Expression")).toHaveValue("person");

  // Unsaved edits are protected before switching.
  await firstCard.getByLabel("Expression").fill("draft change");
  await firstCard.getByLabel("Expression").blur();
  await page.getByRole("button", { name: "Next image" }).click();
  const confirm = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(confirm).toBeVisible();
  await expect(position).toHaveText("1 / 2");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirm).not.toBeVisible();
  await expect(firstCard.getByLabel("Expression")).toHaveValue("draft change");

  // Discarding really switches, and saving targets the open item's labels.
  await page.getByRole("button", { name: "Next image" }).click();
  await page.getByRole("button", { name: "Discard and switch" }).click();
  await expect(position).toHaveText("2 / 2");
  await firstCard.getByLabel("Expression").fill("vehicle edited for e2e");
  await firstCard.getByLabel("Expression").blur();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByTestId("editor-notice")).toContainText(
    '"nav-two.txt"',
  );

  await page.request.delete("/api/datasets/e2e-nav");
});

test("persists a dataset across page reloads", async ({ page }) => {
  test.setTimeout(90000);
  // Remove leftovers from earlier runs so the dataset can be created again.
  await page.request.delete("/api/datasets/e2e-dataset");
  await page.goto("/");
  await page.getByRole("button", { name: "Datasets" }).click();
  const dialog = page.getByRole("dialog", { name: "Datasets" });
  await dialog.getByLabel("Dataset name").fill("e2e-dataset");
  await dialog.getByRole("button", { name: "Create dataset" }).click();

  const row = dialog.locator('[data-dataset-name="e2e-dataset"]');
  await expect(row).toBeVisible();
  const fileInput = row.getByLabel("Choose dataset files for e2e-dataset");

  // First pass: add the image alone; it is staged locally, then imported.
  await fileInput.setInputFiles([example("rec-aerial-scene.svg")]);
  await expect(row.getByTestId("staged-summary")).toContainText(
    "1 file ready to import",
  );
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(row.getByText("labels pending")).toBeVisible();
  await expect(row.getByRole("button", { name: "Open" })).toBeDisabled();
  await expect(row.getByText("0 of 1 item(s) ready to open.")).toBeVisible();

  // Second pass: add the matching labels; the item becomes openable.
  await fileInput.setInputFiles([example("rec-aerial-scene.txt")]);
  await expect(row.getByTestId("staged-summary")).toContainText(
    "1 file ready to import",
  );
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(row.getByText("image + labels")).toBeVisible();
  await expect(row.getByText("1 of 1 item(s) ready to open.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Open" })).toBeEnabled();

  await row.getByRole("button", { name: "Open" }).click();
  await expect(dialog).not.toBeVisible();
  const cards = page.locator("[data-annotation-id]");
  await expect(cards).toHaveCount(24);
  await expect(page.getByText("1920 × 1080", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Save status")).toContainText("Saved");

  // Edits persist back into the stored dataset.
  const firstCard = page.locator('[data-annotation-id="ann_001"]');
  const expression = firstCard.getByLabel("Expression");
  await expression.fill("person edited for e2e");
  await expression.blur();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByTestId("editor-notice")).toContainText(
    'dataset "e2e-dataset"',
  );

  await page.reload();

  await page.getByRole("button", { name: "Datasets" }).click();
  const dialogAgain = page.getByRole("dialog", { name: "Datasets" });
  const rowAgain = dialogAgain.locator('[data-dataset-name="e2e-dataset"]');
  await rowAgain
    .getByRole("button", { name: "Toggle e2e-dataset items" })
    .click();
  await rowAgain.getByRole("button", { name: "Open" }).click();
  await expect(cards).toHaveCount(24);
  await expect(
    page.locator('[data-annotation-id="ann_001"]').getByLabel("Expression"),
  ).toHaveValue("person edited for e2e");
  await expect(page.getByLabel("Save status")).toContainText("Saved");

  // Clean up the test dataset.
  await page.getByRole("button", { name: "Datasets" }).click();
  await expect(dialogAgain).toBeVisible();
  await dialogAgain
    .getByRole("button", { name: "Delete dataset e2e-dataset" })
    .click();
  await expect(
    dialogAgain.locator('[data-dataset-name="e2e-dataset"]'),
  ).toHaveCount(0);
});
