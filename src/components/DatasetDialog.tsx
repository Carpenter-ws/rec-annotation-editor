import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createDataset,
  deleteDataset,
  deleteDatasetItem,
  listDatasets,
  uploadDatasetItems,
  type DatasetItem,
  type DatasetSummary,
} from "../app/datasetApi";
import {
  createStagedFile,
  markDuplicateStems,
  readStagedDatasetFile,
  revokeStagedFiles,
  stagedFilesSummary,
  stagedFilesToUploadItems,
  type StagedDatasetFile,
} from "../app/datasetStaging";

export interface DatasetDialogProps {
  open: boolean;
  onClose: () => void;
  /** `items` carries the whole dataset so the editor can navigate siblings. */
  onOpenItem: (
    datasetName: string,
    item: DatasetItem,
    items: readonly DatasetItem[],
  ) => void;
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
  const [summary, setSummary] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedDatasetFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Staged files hold object URLs, so every drop path must be observable from
  // callbacks without waiting for a render.
  const stagedRef = useRef<StagedDatasetFile[]>([]);
  stagedRef.current = staged;
  const stageGenerationRef = useRef(0);
  const stagedIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stageGenerationRef.current += 1;
      revokeStagedFiles(stagedRef.current);
    };
  }, []);

  const replaceStaged = useCallback((next: StagedDatasetFile[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const clearStaged = useCallback(() => {
    stageGenerationRef.current += 1;
    revokeStagedFiles(stagedRef.current);
    replaceStaged([]);
  }, [replaceStaged]);

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
    setSummary(null);
    setNewName("");
    clearStaged();
    void refresh();
  }, [open, refresh, clearStaged]);

  if (!open) return null;

  const toggleDataset = (name: string) => {
    if (expandedName !== name) clearStaged();
    setExpandedName(expandedName === name ? null : name);
  };

  /** Files are read and validated locally the moment they are chosen. */
  const stageFiles = (files: readonly File[]) => {
    if (files.length === 0 || busy) return;
    setSummary(null);
    setError(null);

    const generation = ++stageGenerationRef.current;
    const skeletons = files.map((file) =>
      createStagedFile(file, `staged-${++stagedIdRef.current}`),
    );
    replaceStaged(
      markDuplicateStems([...stagedRef.current, ...skeletons]),
    );

    for (const skeleton of skeletons) {
      void readStagedDatasetFile(skeleton).then((stagedFile) => {
        if (!mountedRef.current || stageGenerationRef.current !== generation) {
          revokeStagedFiles([stagedFile]);
          return;
        }
        replaceStaged(
          markDuplicateStems(
            stagedRef.current.map((entry) =>
              entry.id === stagedFile.id ? stagedFile : entry,
            ),
          ),
        );
      });
    }
  };

  const removeStaged = (id: string) => {
    const target = stagedRef.current.find((file) => file.id === id);
    if (target) revokeStagedFiles([target]);
    replaceStaged(
      markDuplicateStems(stagedRef.current.filter((file) => file.id !== id)),
    );
  };

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
      if (expandedName === name) {
        clearStaged();
        setExpandedName(null);
      }
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

  /** Confirm import is the single point where the batch reaches the backend. */
  const handleConfirmImport = async () => {
    const items = stagedFilesToUploadItems(stagedRef.current);
    if (!expandedName || busy || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await uploadDatasetItems(expandedName, items);
      const ready = updated.items.filter(
        (item) => item.image && item.labels,
      ).length;
      setSummary(
        `Imported ${items.length} item(s) — ${ready} of ${updated.items.length} complete. Upload the matching files (same name) to finish the rest.`,
      );
      clearStaged();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import files.");
    } finally {
      setBusy(false);
    }
  };

  const stagedSummary = stagedFilesSummary(staged);
  const canConfirm =
    staged.length > 0 &&
    !busy &&
    staged.every((file) => file.status === "ready");

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
            No datasets yet. Create one, then add image and label pairs.
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
                    onClick={() => toggleDataset(dataset.name)}
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
                    <div
                      className="dataset-dropzone"
                      data-testid={`dataset-dropzone-${dataset.name}`}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        stageFiles([...event.dataTransfer.files]);
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,.txt,.jsonl"
                        aria-label={`Choose dataset files for ${dataset.name}`}
                        hidden
                        onChange={(event) => {
                          const input = event.currentTarget;
                          const files = [...(input.files ?? [])];
                          input.value = "";
                          stageFiles(files);
                        }}
                      />
                      <p>
                        Drop images and <code>.txt</code>/<code>.jsonl</code>{" "}
                        labels here — they load right away and are only sent to
                        the server when you confirm.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Choose files
                      </button>
                    </div>
                    {staged.length > 0 ? (
                      <ul className="dataset-staged" aria-label="Staged files">
                        {staged.map((file) => (
                          <li
                            key={file.id}
                            data-staged-name={file.name}
                            data-staged-status={file.status}
                          >
                            {file.previewUrl ? (
                              <img
                                className="staged-thumb"
                                src={file.previewUrl}
                                alt=""
                              />
                            ) : (
                              <span className="staged-kind" aria-hidden="true">
                                {file.kind === "image"
                                  ? "IMG"
                                  : file.kind === "labels"
                                    ? "LBL"
                                    : "?"}
                              </span>
                            )}
                            <span className="staged-name">{file.name}</span>
                            {file.status === "reading" ? (
                              <span
                                className="staged-spinner"
                                role="progressbar"
                                aria-label={`Loading ${file.name}`}
                              />
                            ) : file.status === "error" ? (
                              <span className="staged-detail is-error">
                                {file.error}
                              </span>
                            ) : (
                              <span className="staged-detail">
                                {file.detail}
                              </span>
                            )}
                            <button
                              type="button"
                              aria-label={`Remove ${file.name}`}
                              onClick={() => removeStaged(file.id)}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {stagedSummary ? (
                      <p className="dataset-summary" data-testid="staged-summary">
                        {stagedSummary}
                      </p>
                    ) : null}
                    {summary ? <p className="dataset-summary">{summary}</p> : null}
                    {dataset.items.length === 0 ? (
                      <p className="dataset-empty">
                        No items yet. Add images, labels, or both — images and
                        labels can arrive in separate batches as long as they
                        share the same name.
                      </p>
                    ) : (
                      <>
                        <p
                          className="dataset-summary"
                          data-testid={`dataset-ready-${dataset.name}`}
                        >
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
                                      : "Add both the image and its label file first"
                                  }
                                  onClick={() => {
                                    onOpenItem(dataset.name, item, dataset.items);
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
          <button
            type="button"
            onClick={() => {
              clearStaged();
              onClose();
            }}
          >
            {staged.length > 0 ? "Cancel" : "Close"}
          </button>
          <button
            type="button"
            aria-busy={busy}
            disabled={!canConfirm}
            onClick={() => void handleConfirmImport()}
          >
            Confirm import
          </button>
        </div>
      </div>
    </div>
  );
}
