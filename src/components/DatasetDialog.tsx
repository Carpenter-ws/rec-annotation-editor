import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createDataset,
  deleteDataset,
  deleteDatasetItem,
  listDatasets,
  planDatasetUpload,
  uploadDatasetItems,
  type DatasetItem,
  type DatasetSummary,
} from "../app/datasetApi";

export interface DatasetDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenItem: (datasetName: string, item: DatasetItem) => void;
}

export function DatasetDialog({
  open,
  onClose,
  onOpenItem,
}: DatasetDialogProps): JSX.Element | null {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      setDatasets(await listDatasets());
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load datasets.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setExpandedName(null);
    setError(null);
    setWarning(null);
    setSummary(null);
    setNewName("");
    void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createDataset(name);
      setNewName("");
      setExpandedName(name);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create dataset.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDataset = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteDataset(name);
      if (expandedName === name) setExpandedName(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete dataset.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (name: string, stem: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteDatasetItem(name, stem);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete item.");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (name: string) => {
    const input = fileInputRef.current;
    const files = [...(input?.files ?? [])];
    if (files.length === 0 || busy) return;
    const plan = planDatasetUpload(files);
    setBusy(true);
    try {
      if (plan.items.length > 0) {
        const updated = await uploadDatasetItems(name, plan.items);
        const ready = updated.items.filter(
          (item) => item.image && item.labels,
        ).length;
        setSummary(
          `Uploaded ${plan.items.length} item(s) — ${ready} of ${updated.items.length} complete. Upload the matching files (same name) to finish the rest.`,
        );
      }
      setWarning(
        plan.unsupported.length > 0
          ? `${plan.unsupported.length} file(s) skipped — only images and .txt/.jsonl labels are supported, one file per stem.`
          : null,
      );
      if (input) input.value = "";
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload files.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dataset-dialog-backdrop">
      <div
        className="dataset-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dataset-dialog-title"
      >
        <h2 id="dataset-dialog-title">Datasets</h2>
        <p className="dataset-hint">
          Datasets live in the project's <code>datasets/</code> folder, so they
          are still here next time you open the editor.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="dataset-create">
          <label>
            New dataset
            <input
              value={newName}
              placeholder="Dataset name"
              aria-label="Dataset name"
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
        </div>
        {loading ? <p>Loading datasets…</p> : null}
        {!loading && datasets.length === 0 ? (
          <p className="dataset-empty">
            No datasets yet. Create one, then batch-upload image and label
            pairs.
          </p>
        ) : null}
        <ul className="dataset-list">
          {datasets.map((dataset) => {
            const expanded = expandedName === dataset.name;
            return (
              <li key={dataset.name} data-dataset-name={dataset.name}>
                <div className="dataset-row">
                  <button
                    type="button"
                    className="dataset-expand"
                    aria-expanded={expanded}
                    aria-label={`Toggle ${dataset.name} items`}
                    onClick={() => setExpandedName(expanded ? null : dataset.name)}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                  <span className="dataset-name">{dataset.name}</span>
                  <span className="dataset-count">{dataset.items.length}</span>
                  <button
                    type="button"
                    aria-label={`Delete dataset ${dataset.name}`}
                    disabled={busy}
                    onClick={() => void handleDeleteDataset(dataset.name)}
                  >
                    Delete
                  </button>
                </div>
                {expanded ? (
                  <div className="dataset-items">
                    <div className="dataset-actions">
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,.txt,.jsonl"
                        aria-label={`Choose dataset files for ${dataset.name}`}
                        hidden
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Choose files
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUpload(dataset.name)}
                      >
                        Upload
                      </button>
                    </div>
                    {summary ? <p className="dataset-summary">{summary}</p> : null}
                    {warning ? <p className="dataset-warning">{warning}</p> : null}
                    {dataset.items.length === 0 ? (
                      <p className="dataset-empty">
                        No items yet. Select images, labels, or both, then
                        Upload — images and labels can be uploaded in separate
                        passes as long as they share the same name.
                      </p>
                    ) : (
                      <>
                        <p className="dataset-summary" data-testid={`dataset-ready-${dataset.name}`}>
                          {
                            dataset.items.filter(
                              (item) => item.image && item.labels,
                            ).length
                          }{" "}
                          of {dataset.items.length} item(s) ready to open.
                        </p>
                        <ul className="dataset-item-list">
                          {dataset.items.map((item: DatasetItem) => {
                            const ready = Boolean(item.image && item.labels);
                            return (
                              <li key={item.stem} data-item-stem={item.stem}>
                                <span className="dataset-item-stem">
                                  {item.stem}
                                </span>
                                <span
                                  className={
                                    ready
                                      ? "dataset-item-state is-ready"
                                      : "dataset-item-state"
                                  }
                                >
                                  {ready
                                    ? "image + labels"
                                    : item.image
                                      ? "labels pending"
                                      : "image pending"}
                                </span>
                                <button
                                  type="button"
                                  disabled={!ready}
                                  title={
                                    ready
                                      ? undefined
                                      : "Upload both the image and its label file first"
                                  }
                                  onClick={() => {
                                    onOpenItem(dataset.name, item);
                                  }}
                                >
                                  Open
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Delete item ${item.stem}`}
                                  disabled={busy}
                                  onClick={() =>
                                    void handleDeleteItem(dataset.name, item.stem)
                                  }
                                >
                                  Delete
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="dataset-dialog-footer">
          <button type="button" onClick={onClose}>
            Confirm import
          </button>
        </div>
      </div>
    </div>
  );
}
