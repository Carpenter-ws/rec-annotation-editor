import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createDataset,
  deleteDataset,
  deleteDatasetItem,
  listDatasets,
  pairDatasetFiles,
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
    const plan = pairDatasetFiles(files);
    setBusy(true);
    try {
      if (plan.pairs.length > 0) {
        await uploadDatasetItems(name, plan.pairs);
      }
      setWarning(
        plan.unpaired.length > 0
          ? `${plan.unpaired.length} file(s) skipped — an image and its label file must share the same name (e.g. DJI_0001.jpg + DJI_0001.jsonl).`
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
                    {warning ? <p className="dataset-warning">{warning}</p> : null}
                    {dataset.items.length === 0 ? (
                      <p className="dataset-empty">
                        No items yet. Select an image plus its .txt/.jsonl
                        labels, then Upload.
                      </p>
                    ) : (
                      <ul className="dataset-item-list">
                        {dataset.items.map((item: DatasetItem) => (
                          <li key={item.stem} data-item-stem={item.stem}>
                            <span className="dataset-item-stem">{item.stem}</span>
                            <button
                              type="button"
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
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="dataset-dialog-footer">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
