import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const example = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

/** The dataset home is the landing page; the editor is one click away. */
async function openEditor(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open files without a dataset" })
    .click();
}

test("switches between images of one dataset", async ({ page }) => {
  test.setTimeout(90000);
  await page.request.delete("/api/datasets/e2e-nav");
  await openEditor(page);
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
    // An image without any label file: it must still be reachable by paging.
    { name: "nav-three.svg", mimeType: "image/svg+xml", buffer: image },
  ]);
  // One row per item, each pairing its image with its label file.
  const stagedRows = row.locator(".dataset-staged li");
  await expect(stagedRows).toHaveCount(3);
  await expect(
    row.locator('[data-staged-stem="nav-one"]'),
  ).toHaveAttribute("data-staged-state", "complete");
  await expect(
    row.locator('[data-staged-stem="nav-three"]'),
  ).toHaveAttribute("data-staged-state", "missing-labels");
  await expect(row.getByTestId("staged-summary")).toContainText(
    "3 items to import",
  );
  await dialog.getByRole("button", { name: "Confirm import" }).click();

  // The canvas re-enters the dataset on the first imported image.
  const position = page.getByTestId("dataset-position");
  const firstCard = page.locator('[data-annotation-id="ann_001"]');
  await expect(position).toHaveText("1 / 3");
  await expect(firstCard.getByLabel("Expression")).toHaveValue("person");

  // Step to the second item, then back with the toolbar buttons.
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(position).toHaveText("2 / 3");
  await expect(firstCard.getByLabel("Expression")).toHaveValue("vehicle");

  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(position).toHaveText("1 / 3");
  await expect(page.getByRole("button", { name: "Previous image" })).toBeDisabled();
  await expect(firstCard.getByLabel("Expression")).toHaveValue("person");

  // Unsaved edits are protected before switching.
  await firstCard.getByLabel("Expression").fill("draft change");
  await firstCard.getByLabel("Expression").blur();
  await page.getByRole("button", { name: "Next image" }).click();
  const confirm = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(confirm).toBeVisible();
  await expect(position).toHaveText("1 / 3");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(confirm).not.toBeVisible();
  await expect(firstCard.getByLabel("Expression")).toHaveValue("draft change");

  // Discarding really switches, and saving targets the open item's labels.
  await page.getByRole("button", { name: "Next image" }).click();
  await page.getByRole("button", { name: "Discard and switch" }).click();
  await expect(position).toHaveText("2 / 3");
  await firstCard.getByLabel("Expression").fill("vehicle edited for e2e");
  await firstCard.getByLabel("Expression").blur();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.getByTestId("editor-notice")).toContainText(
    '"nav-two.txt"',
  );

  // The image without labels is part of the sequence and opens empty.
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(position).toHaveText("3 / 3");
  await expect(page.getByRole("button", { name: "Next image" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("0 annotations");
  await expect(page.getByTestId("editor-notice")).toContainText(
    'No label file yet for "nav-three"',
  );

  await page.request.delete("/api/datasets/e2e-nav");
});

test("persists a dataset across page reloads", async ({ page }) => {
  test.setTimeout(90000);
  // Remove leftovers from earlier runs so the dataset can be created again.
  await page.request.delete("/api/datasets/e2e-dataset");
  await openEditor(page);
  await page.getByRole("button", { name: "Datasets" }).click();
  const dialog = page.getByRole("dialog", { name: "Datasets" });
  await dialog.getByLabel("Dataset name").fill("e2e-dataset");
  await dialog.getByRole("button", { name: "Create dataset" }).click();

  const row = dialog.locator('[data-dataset-name="e2e-dataset"]');
  await expect(row).toBeVisible();
  const fileInput = row.getByLabel("Choose dataset files for e2e-dataset");

  // First pass: the image alone. It is staged, then shown on the canvas even
  // without a label file.
  await fileInput.setInputFiles([example("rec-aerial-scene.svg")]);
  await expect(row.getByTestId("staged-state-rec-aerial-scene")).toHaveText(
    "missing labels",
  );
  await expect(row.getByTestId("staged-summary")).toContainText(
    "1 item to import",
  );
  await dialog.getByRole("button", { name: "Confirm import" }).click();
  await expect(dialog).not.toBeVisible();
  const cards = page.locator("[data-annotation-id]");
  await expect(page.getByText("1920 × 1080", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("0 annotations");

  // Second pass: add the matching labels to the same item.
  await page.getByRole("button", { name: "Datasets" }).click();
  const reopened = page.getByRole("dialog", { name: "Datasets" });
  const reopenedRow = reopened.locator('[data-dataset-name="e2e-dataset"]');
  await reopenedRow
    .getByRole("button", { name: "Toggle e2e-dataset items" })
    .click();
  await expect(reopenedRow.getByText("labels pending")).toBeVisible();
  await expect(reopenedRow.getByText(/1 of 1 item\(s\) ready to open/)).toBeVisible();
  await reopenedRow
    .getByLabel("Choose dataset files for e2e-dataset")
    .setInputFiles([example("rec-aerial-scene.txt")]);
  await expect(
    reopenedRow.getByTestId("staged-state-rec-aerial-scene"),
  ).toHaveText("image + labels");
  await reopened.getByRole("button", { name: "Confirm import" }).click();
  await expect(reopened).not.toBeVisible();
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

  // The landing page lists what was imported and reopens it in one click.
  const card = page.getByTestId("dataset-card-e2e-dataset");
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 item");
  await expect(card).toContainText("1 with labels");
  // Clicking the card itself (not a dedicated button) opens the dataset.
  await card.click();
  await expect(cards).toHaveCount(24);
  await expect(
    page.locator('[data-annotation-id="ann_001"]').getByLabel("Expression"),
  ).toHaveValue("person edited for e2e");
  await expect(page.getByLabel("Save status")).toContainText("Saved");

  // Back home, delete the dataset from its card.
  await page.getByRole("button", { name: "Home" }).click();
  await expect(card).toBeVisible();
  await card
    .getByRole("button", { name: "Delete dataset e2e-dataset" })
    .click();
  await page.getByRole("button", { name: "Delete dataset", exact: true }).click();
  await expect(card).toHaveCount(0);
});
