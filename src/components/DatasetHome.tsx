import { useCallback, useEffect, useState, type JSX } from "react";
import {
  createDataset,
  datasetImageUrl,
  deleteDataset,
  listDatasets,
  type DatasetItem,
  type DatasetSummary,
} from "../app/datasetApi";
import { ConfirmDialog } from "./ConfirmDialog";

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

  return (
    <div className="home-shell">
      <header className="home-header">
        <div>
          <h1>REC Annotation Editor</h1>
          <p className="home-hint">
            Datasets live in the project's <code>datasets/</code> folder, so
            everything you imported is still here next time you open the editor.
          </p>
        </div>
        <div className="home-create">
          <label>
            New dataset
            <input
              value={newName}
              placeholder="Dataset name"
              aria-label="New dataset name"
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || newName.trim().length === 0}
            onClick={() => void handleCreate()}
          >
            Create dataset
          </button>
          <button type="button" onClick={onOpenEditor}>
            Open files without a dataset
          </button>
        </div>
      </header>

      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p className="home-status">Loading datasets…</p> : null}
      {!loading && datasets.length === 0 ? (
        <p className="home-status">
          No datasets yet. Create one above, then add images together with their
          <code> .txt</code>/<code>.jsonl</code> label files.
        </p>
      ) : null}

      {datasets.length > 0 ? (
        <section aria-label="Datasets">
          <h2 className="home-section-title">
            {countLabel(datasets.length, "dataset")}
          </h2>
          <ul className="dataset-card-list">
            {datasets.map((dataset) => {
              const total = dataset.items.length;
              const withImages = dataset.items.filter(
                (item) => item.image !== null,
              );
              // Counted independently: a dataset can hold labels whose image is
              // still missing, and only items with an image can be opened.
              const withLabels = dataset.items.filter(
                (item) => item.labels !== null,
              ).length;
              const first = withImages[0] ?? null;
              const previews = withImages.slice(0, PREVIEW_LIMIT);

              return (
                <li
                  key={dataset.name}
                  className="dataset-card"
                  data-dataset-card={dataset.name}
                  data-testid={`dataset-card-${dataset.name}`}
                >
                  <div className="dataset-card-previews">
                    {previews.length > 0 ? (
                      previews.map((item) => (
                        <img
                          key={item.stem}
                          src={datasetImageUrl(dataset.name, item.image!)}
                          alt=""
                          loading="lazy"
                        />
                      ))
                    ) : (
                      <span className="dataset-card-placeholder">
                        No images yet
                      </span>
                    )}
                  </div>
                  <div className="dataset-card-body">
                    <h3>{dataset.name}</h3>
                    <p
                      className="dataset-card-meta"
                      data-testid={`dataset-card-meta-${dataset.name}`}
                    >
                      {countLabel(total, "item")} · {withLabels} with labels ·{" "}
                      {withImages.length} with images
                    </p>
                    <div className="dataset-card-actions">
                      <button
                        type="button"
                        disabled={first === null}
                        title={
                          first === null
                            ? "Add an image to this dataset first"
                            : undefined
                        }
                        onClick={() => {
                          if (first) {
                            onOpenItem(dataset.name, first, dataset.items);
                          }
                        }}
                      >
                        Open
                      </button>
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
