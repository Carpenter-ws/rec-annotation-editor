# REC Annotation Editor

A fully local web editor for REC (Referring Expression Comprehension) bounding-box
annotations: load an image and its TXT label file, review every referring
expression, fix boxes by dragging or by typing exact pixel coordinates, and save
or export the result. All processing happens in your browser — there is no
backend, and neither images nor annotations ever leave your machine.

## Quick start

```bash
./start.sh
```

Then open **http://localhost:5173**. The first run installs the pinned npm
dependencies into this project's own `node_modules` (cache in `.npm-cache`);
later runs start instantly. Nothing is installed globally, and no Conda or base
environment is touched.

Override the bind address or port with project-specific variables:

```bash
REC_EDITOR_HOST=127.0.0.1 REC_EDITOR_PORT=8080 ./start.sh
```

On Windows, run the script from Git Bash/WSL, or start the dev server directly:
`npm ci --cache .npm-cache && npm run dev`.

## Home page (imported datasets)

The editor opens on the dataset home, which is where everything you imported
lives:

- one card per dataset in the project's `datasets/` folder, with up to three
  image previews and a summary (`76 items · 68 with images · 62 with labels`);
- a header row totals the whole import (`2 datasets · 183 items · 175 images ·
  169 label files`), a search box filters the cards by name, and each card
  badges the halves it is missing (`8 without images`, `14 without labels`);
- **clicking anywhere on a card** opens the dataset: the first item with an
  image lands on the canvas, labels or not (an image-only item opens as an
  empty document). A card whose dataset holds no image at all is not clickable
  and says so; the hover badge shows `Open →`;
- **Manage files** opens the file manager already expanded on that dataset, for
  adding or replacing images and label files;
- **Delete** removes the dataset and its files from disk after a confirmation;
- **Create dataset** opens a small card that asks for the name (the button is
  disabled until something is typed); **Cancel** throws the half-typed name
  away, so the page never shows an empty form next to the datasets;
- **Open files without a dataset** goes straight to the editor for a one-off
  image + label pair; **Home** in the toolbar brings you back at any time.

## Workflow

1. **Open image** — pick a local image (PNG/JPEG/WebP/SVG/…).
2. **Open labels** — pick the matching TXT. You can also drag both files onto
   the workspace at once, in either order.
3. Edit on the canvas or in the right-hand panel:
   - the panel groups cards by their text label: each category header shows the
     **full expression** — long ones wrap over as many lines as they need
     instead of being cut off — plus how many boxes share it. The cards below
     carry only coordinates: an expression belongs to the category, never to a
     single box;
   - **Edit** next to a category header retypes its expression in place: every
     box of that category is renamed at once, as one undo step. `Enter` or a
     click elsewhere commits, `Esc` drops the draft, and the field grows with
     the wrapped text;
   - **categories start collapsed**, so a document opens as a readable list of
     expressions. Reveal one with the small arrow left of its text, or with
     **Expand all** / **Collapse all**; searching shows the matching cards right
     away, and the category of a selected box always opens itself. Clicking the
     expression text itself only selects it on the canvas — it never unfolds the
     panel and never opens an editor, and the blank space right of the text does
     nothing;
   - **the canvas starts clean**: no boxes are drawn until an expression is
     picked, so a crowded image is readable from the first second;
   - hover a category to **preview** all of its boxes; click a category to
     **isolate** it — only its boxes stay on the canvas and the header is
     highlighted; click it again to go back to a clean canvas. The box selected
     in the panel (or on the canvas) always stays visible, which is what makes
     “locate” and resizing work;
   - **Reset** (next to Collapse all) clears the selected category and the
     selection, hides every box, and re-fits the image;
   - the arrow is the only expand/collapse target (it sits left of the text, so
     the hit area never grows past the expression); **Collapse all / Expand
     all** cover the whole panel, and the category of a selected box always
     reopens;
   - **Add** on a category header draws a new box of that category: drag a
     rectangle on the image and it joins the category immediately (no dialog);
     keep drawing to add more, press `Esc` to stop;
   - the `×` next to a category header deletes **the whole expression**: a
     confirmation reports how many boxes it removes, and the deletion is one
     undo step (isolation and hover of that category are cleared with it);
   - click a box (or a card) to select it; the panel locates the matching card
     and vice versa;
   - drag a box to move it; drag a **corner** handle to resize it (both axes at
     once, i.e. enlarge/shrink) or an **edge** handle to stretch one axis;
   - **Add box** enters draw mode: drag a rectangle, then type a free-text
     expression in the dialog;
   - the panel search filters by expression or box ID and reveals matching
     categories; each card exposes X1/Y1/X2/Y2 for exact original-pixel edits;
   - **Delete** removes the selected annotation and stays undoable.
4. **Save** writes back to the opened TXT (in Chromium, via the File System
   Access API). In browsers without write access — Firefox and Safari — the
   same action downloads `<name>-edited.txt` instead; the status bar explains
   which path was used. **Save As** always asks for a destination where the
   browser supports it.
5. **Export → TXT / JSON** produce a copy and never mark the working document
   as saved.

All coordinates are original image pixels. Zooming, panning, and window
resizing only change the view; they never rewrite box data.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + S` | Save (commits any in-progress field edit first) |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y` | Redo |
| `Delete` / `Backspace` | Delete the selected annotation |
| `Alt + ←` / `Alt + →` | Previous / next image of the open dataset |
| `Escape` | Leave Add box mode / cancel a dialog or drag |
| `Ctrl/Cmd` + mouse wheel | Zoom around the cursor |
| Mouse wheel | Pan the image up/down |
| `Shift` + mouse wheel | Pan the image left/right |
| `Shift` + left-drag, or middle-drag | Pan the canvas |

## Datasets (batch upload and persistent groups)

Click **Datasets** in the toolbar to manage reusable annotation groups that
live in the project's `datasets/` folder (served by the dev server, no external
backend):

- **Create dataset** — a group is a folder with `images/`, `labels/`, and a
  `dataset.json` manifest.
- **Drop or choose files — one row per item, read immediately** — files are
  read in the browser as soon as they are picked (file dialog or drag and
  drop): a spinner while loading, then the image thumbnail plus its size and
  the label file's box count, or an explicit error. Images and their labels
  collapse into a **single row per item** (`DJI_0001`), never one row per file.
- **The stored halves are searched first** — if the dataset already holds the
  label file for a chosen image (or the image for a chosen label file), the row
  pairs them up and reads `image + labels`. Only a genuinely missing half shows
  `missing labels` or `missing image`; a missing half does not block the import,
  it just means that item arrives incomplete.
- **Confirm import** is the only step that reaches the backend: the staged
  batch is uploaded in one request and merged by basename
  (`DJI_0001.jpg` + `DJI_0001.jsonl`). **Cancel** (or `Close` when nothing is
  staged) throws the staged files away without touching the server.
- Unsupported extensions, duplicate stems, unreadable images, and label files
  with parse errors are flagged in the item's row — **Confirm import** stays
  disabled until the offending row is removed with its `×`.
- **After importing, the canvas re-enters the dataset**: the dialog closes and
  the first imported item that has an image is loaded, labels or not. An item
  whose labels are missing opens as an empty document — the image is shown with
  no boxes and **Save** creates `<stem>.txt` (or `.jsonl` when the dataset uses
  that) next to the image.
- Each item shows its state — `image + labels`, `labels pending`, or
  `image pending` — and **Open** is enabled as soon as an image exists; the
  header reports how many items are ready to open.
- **Open** — loads the image and its labels straight from disk, so nothing has
  to be re-uploaded next session. Edits are stored back into the dataset with
  **Save**.
- **‹ Previous / Next ›** — once an item is open, the toolbar switches to the
  neighbouring image of the same dataset and shows the position (`48 / 68`).
  Any item **with an image** is part of that sequence, including images whose
  label file has not been imported yet — they open as an empty document and
  **Save** creates their label file. Only items without an image are skipped.
  Keyboard equivalents are `Alt + ←` / `Alt + →`. **Save** always writes back
  to the labels file of the item shown in the toolbar. Switching with unsaved
  edits asks first (**Keep editing** / **Discard and switch**) — edits are never
  dropped silently.
- Once imported, items, files, and edits stay on disk.
- Delete items or whole datasets from the same dialog.

## REC JSONL format

The JSONL format (one REC document per line) is fully supported for import,
editing, save, and export:

```jsonl
{"expression": "the red-and-white boats", "level": "L1", "targets": [[3, 46, 117, 62], [317, 482, 368, 550]]}
{"expression": "the white boats", "level": "L2", "targets": [[636, 790, 665, 837]]}
```

Targets are **normalized integers on a [0, 1000] grid**, not pixels:

- pixel = target / 1000 × image width (or height)
- importing scales them to pixels, so boxes land in the right place on the
  image; the panel and the canvas always work in image pixels
- saving and *Export JSONL* convert them back with
  `round(pixel / size × 1000)`, clamped to `[0, 1000]` and kept non-degenerate
  so the file stays valid

Every target becomes one box sharing the expression; boxes that share a label
are regrouped into one `targets` line on export. The auxiliary `level` field is
not preserved by the editor (per-box metadata is out of scope) — keep a backup
of the original file if `level` matters.

## Label formats

TXT lines contain four coordinates, the referring expression, and a trailing
reserved field:

```text
840.00 505.00 972.00 573.00 car 0
405.00 130.00 470.00 205.00 the person wearing a white shirt standing beside the car 0
```

The parser treats the **last standalone `0`** as the reserved field and
everything between the fourth number and that field as the expression, so
multi-word expressions and expressions that contain digits work. One inherent
ambiguity remains: a line like `0 0 10 10 0` is a box labelled `0`, while
`0 0 10 10 0 0` is a box labelled `0` with the reserved field. When an
expression itself ends in a standalone `0`, prefer **JSONL** or **JSON** to
avoid losing information:

```json
{
  "image": "rec-aerial-scene.svg",
  "width": 1920,
  "height": 1080,
  "annotations": [
    { "id": "ann_001", "bbox": [840, 505, 972, 573], "label": "car", "reservedField": "0" }
  ]
}
```

Imports are atomic: if any line is invalid, the current document is kept and
the dialog lists every problem with its line number. Boxes that fall partly
outside the image are clamped and the count is announced; a box entirely
outside rejects the whole import.

## Fixtures and tests

- `public/examples/rec-aerial-scene.svg` — a synthetic 1920×1080 aerial scene.
- `public/examples/rec-aerial-scene.txt` — 24 sample annotations, including
  duplicate `person` labels, long referring expressions, edge-touching boxes,
  and decimal coordinates. Both are linked from the empty workspace.
- `tests/fixtures/makeStressAnnotations.ts` — deterministic 500-box generator.

```bash
npm run test:run     # unit + component tests (Vitest)
npm run typecheck    # strict TypeScript
npm run build        # production build
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npm run test:e2e
```

The E2E suite drives a full editing session (import → select → zoom/resize →
edit → draw → undo/redo → export) in Chromium against the bundled fixtures.

## Troubleshooting

- **Port already in use** — start on another port:
  `REC_EDITOR_PORT=5174 ./start.sh`.
- **Node missing or too old** — the editor needs Node 20+. Check `node -v`;
  the startup script uses only the Node runtime and never installs one.
- **Browser blocked the download** — saving through downloads needs the
  browser's "allow multiple downloads" permission for the site; alternatively
  use Save As (Chromium) or the Export menu.
- **Saved file did not change** — Firefox/Safari cannot write back to the
  original file; the status bar will say `Downloaded …`, and the original file
  must be replaced manually.
