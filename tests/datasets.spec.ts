import { expect, test } from "@playwright/test";
import path from "node:path";

const example = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

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

  // First pass: upload the image alone.
  await fileInput.setInputFiles([example("rec-aerial-scene.svg")]);
  await row.getByRole("button", { name: "Upload" }).click();
  await expect(row.getByText("labels pending")).toBeVisible();
  await expect(row.getByRole("button", { name: "Open" })).toBeDisabled();
  await expect(row.getByText("0 of 1 item(s) ready to open.")).toBeVisible();

  // Second pass: upload the matching labels; the item becomes openable.
  await fileInput.setInputFiles([example("rec-aerial-scene.txt")]);
  await row.getByRole("button", { name: "Upload" }).click();
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
