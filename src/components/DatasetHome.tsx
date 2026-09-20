import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  createDataset,
  datasetThumbnailUrl,
  deleteDataset,
  listDatasets,
  type DatasetItem,
  type DatasetSummary,
} from "../app/datasetApi";
import { ConfirmDialog } from "./ConfirmDialog";
import { firstPendingItem, reviewCounts } from "../domain/review";

const PREVIEW_LIMIT = 3;

export interface DatasetHomeProps {
  /** Re-fetch the list whenever this changes (after an import, for example). */
  refreshToken: number;
  /** Leave the dataset browser and use local files instead. */
  onOpenEditor: () => void;
  onOpenItem: (
    datasetName: string,
    item: DatasetItem,
    items: readonly DatasetItem[],
  ) => void;
  /** Open the file manager for one dataset. */
  onManage: (datasetName: string) => void;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Landing page: everything that has been imported into the project, with a
 * preview per dataset and a direct way back into the canvas.
 */
export function DatasetHome({
  refreshToken,
  onOpenEditor,
  onOpenItem,
  onManage,
}: DatasetHomeProps): JSX.Element {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await listDatasets();
      setDatasets(Array.isArray(loaded) ? loaded : []);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load datasets.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createDataset(name);
      setNewName("");
      setCreateOpen(false);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create dataset.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    setPendingDelete(null);
    setBusy(true);
    try {
      await deleteDataset(name);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete dataset.",
      );
    } finally {
      setBusy(false);
    }
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleDatasets = useMemo(
    () =>
      normalizedQuery === ""
        ? datasets
        : datasets.filter((dataset) =>
            dataset.name.toLocaleLowerCase().includes(normalizedQuery),
          ),
    [datasets, normalizedQuery],
  );

  const totals = useMemo(() => {
    let items = 0;
    let images = 0;
    let labels = 0;
    for (const dataset of datasets) {
      for (const item of dataset.items) {
        items += 1;
        if (item.image) images += 1;
        if (item.labels) labels += 1;
      }
    }
    return { items, images, labels };
  }, [datasets]);

  return (
    <div className="home-shell">
      <header className="home-topbar">
        <div className="home-brand">
          <span className="home-mark" aria-hidden="true">
            REC
          </span>
          <div>
            <h1>REC Annotation Editor</h1>
            <p className="home-tagline">
              Referring-expression boxes, kept in the project's{" "}
              <code>datasets/</code> folder.
            </p>
          </div>
        </div>
        <button type="button" className="home-ghost" onClick={onOpenEditor}>
          Open files without a dataset
        </button>
      </header>

      <main className="home-main">
        <div className="home-intro">
          <div>
            <h2 className="home-title">Datasets</h2>
            <p className="home-stats">
              {countLabel(datasets.length, "dataset")} ·{" "}
              {countLabel(totals.items, "item")} ·{" "}
              {countLabel(totals.images, "image")} ·{" "}
              {countLabel(totals.labels, "label file")}
            </p>
          </div>
          <div className="home-create">
            <button
              type="button"
              className="home-primary"
              onClick={() => {
                setError(null);
                setNewName("");
                setCreateOpen(true);
              }}
            >
              Create dataset
            </button>
          </div>
        </div>

        {error && !createOpen ? <p role="alert">{error}</p> : null}

        {datasets.length > 0 ? (
          <div className="home-filter">
            <input
              type="search"
              value={query}
              placeholder="Search datasets..."
              aria-label="Search datasets"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            {normalizedQuery !== "" ? (
              <span className="home-filter-count">
                {visibleDatasets.length} of {datasets.length}
              </span>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <ul className="dataset-card-list" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <li key={index} className="dataset-card is-skeleton">
                <div className="dataset-card-previews" />
                <div className="dataset-card-body">
                  <span className="skeleton-line" />
                  <span className="skeleton-line is-short" />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {!loading && datasets.length === 0 ? (
          <div className="home-empty">
            <h3>No datasets yet</h3>
            <p>
              Create one above, then add images together with their{" "}
              <code>.txt</code>/<code>.jsonl</code> label files. Images and
              labels can arrive in separate batches as long as they share the
              same name.
            </p>
            <button type="button" className="home-ghost" onClick={onOpenEditor}>
              Annotate a single image instead
            </button>
          </div>
        ) : null}

        {!loading && datasets.length > 0 ? (
          <section aria-label="Datasets">
            <ul className="dataset-card-list">
              {visibleDatasets.map((dataset) => {
                const total = dataset.items.length;
                const withImages = dataset.items.filter(
                  (item) => item.image !== null,
                );
                const withLabels = dataset.items.filter(
                  (item) => item.labels !== null,
                ).length;
                // Opening a dataset picks up the review pass where it stopped:
                // the first image still waiting for a decision.
                const first =
                  withImages.length > 0 ? firstPendingItem(withImages) : null;
                const previews = withImages.slice(0, PREVIEW_LIMIT);
                const missingImages = total - withImages.length;
                const missingLabels = total - withLabels;
                const statuses = reviewCounts(dataset.items);

                return (
                  <li
                    key={dataset.name}
                    className={first ? "dataset-card" : "dataset-card is-empty"}
                    data-dataset-card={dataset.name}
                    data-testid={`dataset-card-${dataset.name}`}
                  >
                    {/* The whole card opens the dataset; secondary actions sit
                        above this overlay. */}
                    <button
                      type="button"
                      className="dataset-card-open"
                      aria-label={`Open dataset ${dataset.name}`}
                      disabled={first === null}
                      title={
                        first === null
                          ? "Add an image to this dataset first"
                          : `Open ${first.stem}`
                      }
                      onClick={() => {
                        if (first) {
                          onOpenItem(dataset.name, first, dataset.items);
                        }
                      }}
                    />
                    <div className="dataset-card-previews">
                      {previews.length > 0 ? (
                        previews.map((item) => (
                          <img
                            key={item.stem}
                            src={datasetThumbnailUrl(dataset.name, item.image!)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                        ))
                      ) : (
                        <span className="dataset-card-placeholder">
                          No images yet
                        </span>
                      )}
                      <h3 className="dataset-card-name">{dataset.name}</h3>
                      {first ? (
                        <span className="dataset-card-cta" aria-hidden="true">
                          Open →
                        </span>
                      ) : null}
                    </div>
                    <div className="dataset-card-body">
                      <p
                        className="dataset-card-meta"
                        data-testid={`dataset-card-meta-${dataset.name}`}
                      >
                        {countLabel(total, "item")} · {withImages.length} with
                        images · {withLabels} with labels
                      </p>
                      {total > 0 ? (
                        <p
                          className="dataset-card-review"
                          data-testid={`dataset-review-${dataset.name}`}
                        >
                          审核：待审核 {statuses.pending} · 通过{" "}
                          {statuses.approved} · 打回 {statuses.rejected}
                        </p>
                      ) : null}
                      {missingImages > 0 || missingLabels > 0 ? (
                        <p className="dataset-card-gaps">
                          {missingImages > 0 ? (
                            <span className="dataset-gap is-error">
                              {missingImages} without images
                            </span>
                          ) : null}
                          {missingLabels > 0 ? (
                            <span className="dataset-gap">
                              {missingLabels} without labels
                            </span>
                          ) : null}
                        </p>
                      ) : null}
                      <div className="dataset-card-actions">
                        <button
                          type="button"
                          onClick={() => onManage(dataset.name)}
                        >
                          Manage files
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete dataset ${dataset.name}`}
                          disabled={busy}
                          onClick={() => setPendingDelete(dataset.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </main>

      {createOpen ? (
        <div className="confirm-backdrop">
          <form
            className="confirm-dialog home-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <h2 id="home-create-title">New dataset</h2>
            <p>
              It is stored in the project's <code>datasets/</code> folder. Add
              images and their <code>.txt</code>/<code>.jsonl</code> label files
              right after creating it.
            </p>
            <label>
              Dataset name
              <input
                autoFocus
                value={newName}
                placeholder="Dataset name"
                aria-label="New dataset name"
                onChange={(event) => setNewName(event.currentTarget.value)}
              />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <div className="confirm-actions">
              <button type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || newName.trim().length === 0}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={`Delete dataset ${pendingDelete}?`}
          message={`${
            datasets.find((dataset) => dataset.name === pendingDelete)?.items
              .length ?? 0
          } item(s) and their files are removed from disk. This cannot be undone.`}
          confirmLabel="Delete dataset"
          cancelLabel="Keep dataset"
          onConfirm={() => void handleDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
