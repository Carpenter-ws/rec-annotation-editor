import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
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
  groupStagedItems,
  markDuplicateStems,
  readStagedDatasetFile,
  revokeStagedFiles,
  stagedFilesToUploadItems,
  stagedItemsSummary,
  type StagedDatasetFile,
  type StagedItem,
} from "../app/datasetStaging";

/** Wording for the pairing state of one staged item. */
const ITEM_STATE_LABEL: Record<StagedItem["state"], string> = {
  complete: "image + labels",
  "missing-labels": "missing labels",
  "missing-image": "missing image",
};

export interface DatasetDialogProps {
  open: boolean;
  /** Dataset to expand as soon as the dialog opens. */
  initialExpandedName?: string | null;
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
  initialExpandedName = null,
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

  const refresh = useCallback(async (): Promise<DatasetSummary[] | null> => {
    setLoading(true);
    try {
      const loaded = await listDatasets();
      setDatasets(loaded);
      setError(null);
      return loaded;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load datasets.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setExpandedName(initialExpandedName);
    setError(null);
    setSummary(null);
    setNewName("");
    clearStaged();
    void refresh();
  }, [open, initialExpandedName, refresh, clearStaged]);

  // One row per item: staged halves are paired with what the dataset already
  // stores, so a lone image only reads as "missing labels" when nothing is
  // stored for it yet.
  const expandedItems =
    datasets.find((dataset) => dataset.name === expandedName)?.items ?? [];
  const stagedItems = useMemo(
    () => groupStagedItems(staged, expandedItems),
    [staged, expandedItems],
  );

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

  /** Drops every staged half of one item. */
  const removeStagedItem = (stem: string) => {
    const key = stem.toLocaleLowerCase();
    const removed = stagedRef.current.filter(
      (file) => file.stem.toLocaleLowerCase() === key,
    );
    revokeStagedFiles(removed);
    replaceStaged(
      markDuplicateStems(
        stagedRef.current.filter(
          (file) => file.stem.toLocaleLowerCase() !== key,
        ),
      ),
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
    const datasetName = expandedName;
    const items = stagedFilesToUploadItems(stagedRef.current);
    if (!datasetName || busy || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await uploadDatasetItems(datasetName, items);
      clearStaged();
      const loaded = await refresh();

      // The canvas re-enters the dataset as soon as an image is available.
      const updated = loaded?.find((entry) => entry.name === datasetName);
      const importedStems = items.map((entry) => entry.stem.toLocaleLowerCase());
      const next = updated?.items.find(
        (entry) =>
          entry.image !== null &&
          importedStems.includes(entry.stem.toLocaleLowerCase()),
      );
      if (updated && next) {
        onOpenItem(datasetName, next, updated.items);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import files.");
    } finally {
      setBusy(false);
    }
  };

  const stagedSummary = stagedItemsSummary(stagedItems);
  const canConfirm =
    stagedItems.length > 0 &&
    !busy &&
    stagedItems.every((item) => item.status === "ready");

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
                    {stagedItems.length > 0 ? (
                      <ul className="dataset-staged" aria-label="Staged files">
                        {stagedItems.map((item) => {
                          const details: string[] = [];
                          if (item.image) {
                            if (item.image.detail)
                              details.push(item.image.detail);
                          } else if (item.imageOnServer) {
                            details.push("image already stored");
                          }
                          if (item.labels) {
                            if (item.labels.detail)
                              details.push(item.labels.detail);
                          } else if (item.labelsOnServer) {
                            details.push("labels already stored");
                          }

                          return (
                            <li
                              key={item.stem}
                              data-staged-stem={item.stem}
                              data-staged-status={item.status}
                              data-staged-state={item.state}
                            >
                              {item.image?.previewUrl ? (
                                <img
                                  className="staged-thumb"
                                  src={item.image.previewUrl}
                                  alt=""
                                />
                              ) : (
                                <span
                                  className="staged-kind"
                                  aria-hidden="true"
                                >
                                  {item.hasImage ? "IMG" : "LBL"}
                                </span>
                              )}
                              <span className="staged-name">{item.stem}</span>
                              {item.status === "reading" ? (
                                <span
                                  className="staged-spinner"
                                  role="progressbar"
                                  aria-label={`Loading ${item.stem}`}
                                />
                              ) : item.status === "error" ? (
                                <span className="staged-detail is-error">
                                  {item.issues.join(" · ")}
                                </span>
                              ) : (
                                <span className="staged-detail">
                                  {details.join(" · ")}
                                </span>
                              )}
                              <span
                                className={`staged-state is-${item.state}`}
                                data-testid={`staged-state-${item.stem}`}
                              >
                                {ITEM_STATE_LABEL[item.state]}
                              </span>
                              <button
                                type="button"
                                aria-label={`Remove ${item.stem}`}
                                onClick={() => removeStagedItem(item.stem)}
                              >
                                ×
                              </button>
                            </li>
                          );
                        })}
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
                            dataset.items.filter((item) => item.image).length
                          }{" "}
                          of {dataset.items.length} item(s) ready to open (an
                          image is enough; labels are created on save).
                        </p>
                        <ul className="dataset-item-list">
                          {dataset.items.map((item: DatasetItem) => {
                            // An image alone can be opened and annotated; the
                            // labels file is created on the first save.
                            const ready = Boolean(item.image);
                            const hasLabels = Boolean(item.labels);
                            return (
                              <li key={item.stem} data-item-stem={item.stem}>
                                <span className="dataset-item-stem">
                                  {item.stem}
                                </span>
                                <span
                                  className={
                                    hasLabels
                                      ? "dataset-item-state is-ready"
                                      : "dataset-item-state"
                                  }
                                >
                                  {hasLabels
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
                                      : "Add the image first — labels are optional"
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
