import { renderHook } from "@testing-library/react";
import type { Annotation } from "../domain/types";
import {
  EditorProvider,
  useEditorDispatch,
  useEditorState,
} from "./EditorContext";
import { editorReducer, initialEditorState } from "./editorReducer";

const person: Annotation = {
  id: "ann_001",
  bbox: { x1: 0, y1: 0, x2: 10, y2: 10 },
  label: "person",
  reservedField: "0",
};

const previewPerson: Annotation = { ...person, label: "preview" };
const secondPerson: Annotation = {
  ...person,
  id: "ann_002",
  bbox: { x1: 20, y1: 20, x2: 30, y2: 30 },
};

const loadedState = (annotations: Annotation[]) =>
  editorReducer(initialEditorState, {
    type: "LOAD_ANNOTATIONS",
    annotations,
    fileName: "scene.txt",
  });

function activeBranchedTransaction() {
  const committed = editorReducer(loadedState([person]), {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "committed" },
  });
  const undone = editorReducer(committed, { type: "UNDO" });
  const begun = editorReducer(undone, { type: "BEGIN_TRANSACTION" });
  return editorReducer(begun, {
    type: "PREVIEW_PATCH",
    id: "ann_001",
    patch: { label: "preview" },
  });
}

function stateWithRedoBranch() {
  const changed = editorReducer(loadedState([person]), {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "changed" },
  });
  return editorReducer(changed, { type: "UNDO" });
}

it("keeps duplicate labels as separate annotations", () => {
  const duplicatePeople = [
    person,
    {
      ...person,
      id: "ann_002",
      bbox: { x1: 20, y1: 20, x2: 30, y2: 30 },
    },
  ];

  const loaded = loadedState(duplicatePeople);

  expect(loaded.annotations).toHaveLength(2);
  expect(new Set(loaded.annotations.map((annotation) => annotation.id)).size).toBe(2);
});

it("groups many preview updates into one undo step", () => {
  const start = loadedState([person]);
  const begun = editorReducer(start, { type: "BEGIN_TRANSACTION" });
  const first = editorReducer(begun, {
    type: "PREVIEW_PATCH",
    id: "ann_001",
    patch: { label: "the person" },
  });
  const second = editorReducer(first, {
    type: "PREVIEW_PATCH",
    id: "ann_001",
    patch: { label: "the person left" },
  });
  const committed = editorReducer(second, { type: "COMMIT_TRANSACTION" });

  expect(committed.past).toHaveLength(1);
  expect(editorReducer(committed, { type: "UNDO" }).annotations[0]?.label).toBe(
    "person",
  );
});

it("does not create history for an unchanged transaction", () => {
  const start = loadedState([person]);
  const begun = editorReducer(start, { type: "BEGIN_TRANSACTION" });

  const committed = editorReducer(begun, { type: "COMMIT_TRANSACTION" });

  expect(committed.past).toEqual([]);
  expect(committed.transactionBase).toBeNull();
});

it("cancels a preview transaction without changing history or dirty state", () => {
  const start = loadedState([person]);
  const begun = editorReducer(start, { type: "BEGIN_TRANSACTION" });
  const previewed = editorReducer(begun, {
    type: "PREVIEW_PATCH",
    id: "ann_001",
    patch: { label: "temporary" },
  });

  expect(previewed.dirty).toBe(true);

  const cancelled = editorReducer(previewed, { type: "CANCEL_TRANSACTION" });

  expect(cancelled.annotations[0]?.label).toBe("person");
  expect(cancelled.past).toEqual([]);
  expect(cancelled.future).toEqual([]);
  expect(cancelled.transactionBase).toBeNull();
  expect(cancelled.dirty).toBe(false);
});

it("restores an undone edit with redo", () => {
  const changed = editorReducer(loadedState([person]), {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "changed" },
  });
  const undone = editorReducer(changed, { type: "UNDO" });

  const redone = editorReducer(undone, { type: "REDO" });

  expect(redone.annotations[0]?.label).toBe("changed");
  expect(redone.past).toHaveLength(1);
  expect(redone.future).toEqual([]);
});

it("clears redo after a new committed edit", () => {
  const start = loadedState([person]);
  const changedState = editorReducer(start, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "changed" },
  });
  const undone = editorReducer(changedState, { type: "UNDO" });
  const edited = editorReducer(undone, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "new branch" },
  });

  expect(edited.future).toEqual([]);
});

it("becomes clean again when undo reaches the saved fingerprint", () => {
  const changedState = editorReducer(loadedState([person]), {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "saved label" },
  });
  const saved = editorReducer(changedState, { type: "MARK_SAVED" });
  const deleted = editorReducer(saved, {
    type: "DELETE_ANNOTATION",
    id: "ann_001",
  });

  expect(deleted.dirty).toBe(true);
  expect(editorReducer(deleted, { type: "UNDO" }).dirty).toBe(false);
});

it("sets the next number from the largest imported numeric ann_ suffix", () => {
  const loaded = loadedState([
    person,
    { ...person, id: "ann_019" },
    { ...person, id: "ann_not-a-number" },
    { ...person, id: "other_400" },
  ]);

  expect(loaded.nextAnnotationNumber).toBe(20);
});

it("never reuses an annotation id after deletion", () => {
  const loaded = loadedState([person]);
  const deleted = editorReducer(loaded, {
    type: "DELETE_ANNOTATION",
    id: "ann_001",
  });

  expect(deleted.nextAnnotationNumber).toBe(2);

  const added = editorReducer(deleted, {
    type: "ADD_ANNOTATION",
    annotation: {
      ...person,
      id: `ann_${String(deleted.nextAnnotationNumber).padStart(3, "0")}`,
    },
  });

  expect(added.annotations[0]?.id).toBe("ann_002");
  expect(added.nextAnnotationNumber).toBe(3);
});

it("does not roll the next annotation number back through undo or redo", () => {
  const loaded = loadedState([{ ...person, id: "ann_007" }]);
  const added = editorReducer(loaded, {
    type: "ADD_ANNOTATION",
    annotation: { ...person, id: "ann_008" },
  });
  const undone = editorReducer(added, { type: "UNDO" });
  const redone = editorReducer(undone, { type: "REDO" });
  const deleted = editorReducer(redone, {
    type: "DELETE_ANNOTATION",
    id: "ann_008",
  });

  expect(loaded.nextAnnotationNumber).toBe(8);
  expect(added.nextAnnotationNumber).toBe(9);
  expect(undone.nextAnnotationNumber).toBe(9);
  expect(redone.nextAnnotationNumber).toBe(9);
  expect(deleted.nextAnnotationNumber).toBe(9);
});

it("bounds annotation history to the newest 100 transactions", () => {
  let state = loadedState([person]);

  for (let index = 1; index <= 101; index += 1) {
    state = editorReducer(state, {
      type: "UPDATE_ANNOTATION",
      id: "ann_001",
      patch: { label: `person ${index}` },
    });
  }

  expect(state.past).toHaveLength(100);

  for (let index = 0; index < 100; index += 1) {
    state = editorReducer(state, { type: "UNDO" });
  }

  expect(state.annotations[0]?.label).toBe("person 1");
});

it("keeps selection and mode changes out of annotation history", () => {
  const changed = editorReducer(loadedState([person]), {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "changed" },
  });
  const selected = editorReducer(changed, { type: "SELECT", id: "ann_001" });
  const addMode = editorReducer(selected, { type: "SET_MODE", mode: "add" });
  const undone = editorReducer(addMode, { type: "UNDO" });

  expect(addMode.past).toHaveLength(1);
  expect(undone.annotations[0]?.label).toBe("person");
  expect(undone.selectedId).toBe("ann_001");
  expect(undone.mode).toBe("add");
});

it("undo resolves a changed preview transaction without consuming older history", () => {
  const active = activeBranchedTransaction();

  const undone = editorReducer(active, { type: "UNDO" });

  expect(undone.annotations).toEqual([person]);
  expect(undone.past).toEqual([]);
  expect(undone.future).toEqual([[previewPerson]]);
  expect(undone.transactionBase).toBeNull();
  expect(undone.dirty).toBe(false);
});

it("redo resolves a changed preview transaction before discarding the old redo branch", () => {
  const active = activeBranchedTransaction();

  const redone = editorReducer(active, { type: "REDO" });

  expect(redone.annotations).toEqual([previewPerson]);
  expect(redone.past).toEqual([[person]]);
  expect(redone.future).toEqual([]);
  expect(redone.transactionBase).toBeNull();
  expect(redone.dirty).toBe(true);
});

it("updates atomically after committing an active preview transaction", () => {
  const active = activeBranchedTransaction();

  const updated = editorReducer(active, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "atomic" },
  });

  expect(updated.annotations).toEqual([{ ...person, label: "atomic" }]);
  expect(updated.past).toEqual([[person], [previewPerson]]);
  expect(updated.future).toEqual([]);
  expect(updated.transactionBase).toBeNull();
  expect(updated.dirty).toBe(true);
});

it("keeps the resolved transaction when an interleaved update is a no-op", () => {
  const active = activeBranchedTransaction();

  const resolved = editorReducer(active, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "preview" },
  });

  expect(resolved).not.toBe(active);
  expect(resolved.annotations).toEqual([previewPerson]);
  expect(resolved.past).toEqual([[person]]);
  expect(resolved.future).toEqual([]);
  expect(resolved.transactionBase).toBeNull();
  expect(resolved.dirty).toBe(true);
});

it("adds atomically after committing an active preview transaction", () => {
  const active = activeBranchedTransaction();

  const added = editorReducer(active, {
    type: "ADD_ANNOTATION",
    annotation: secondPerson,
  });

  expect(added.annotations).toEqual([previewPerson, secondPerson]);
  expect(added.past).toEqual([[person], [previewPerson]]);
  expect(added.future).toEqual([]);
  expect(added.transactionBase).toBeNull();
  expect(added.dirty).toBe(true);
  expect(added.nextAnnotationNumber).toBe(3);
});

it("deletes atomically after committing an active preview transaction", () => {
  const active = activeBranchedTransaction();

  const deleted = editorReducer(active, {
    type: "DELETE_ANNOTATION",
    id: "ann_001",
  });

  expect(deleted.annotations).toEqual([]);
  expect(deleted.past).toEqual([[person], [previewPerson]]);
  expect(deleted.future).toEqual([]);
  expect(deleted.transactionBase).toBeNull();
  expect(deleted.dirty).toBe(true);
});

it("clears a selection removed by undoing an add", () => {
  const added = editorReducer(loadedState([person]), {
    type: "ADD_ANNOTATION",
    annotation: secondPerson,
  });
  const selected = editorReducer(added, { type: "SELECT", id: "ann_002" });

  const undone = editorReducer(selected, { type: "UNDO" });

  expect(undone.annotations).toEqual([person]);
  expect(undone.selectedId).toBeNull();
});

it("clears a selection removed by redoing a delete", () => {
  const selected = editorReducer(loadedState([person, secondPerson]), {
    type: "SELECT",
    id: "ann_002",
  });
  const deleted = editorReducer(selected, {
    type: "DELETE_ANNOTATION",
    id: "ann_002",
  });
  const restored = editorReducer(deleted, { type: "UNDO" });
  const selectedAgain = editorReducer(restored, { type: "SELECT", id: "ann_002" });

  const redone = editorReducer(selectedAgain, { type: "REDO" });

  expect(redone.annotations).toEqual([person]);
  expect(redone.selectedId).toBeNull();
});

it("preserves history and redo for a same-value update", () => {
  const branched = stateWithRedoBranch();

  const unchanged = editorReducer(branched, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "person" },
  });

  expect(unchanged).toBe(branched);
  expect(unchanged.past).toEqual([]);
  expect(unchanged.future).toEqual([[{ ...person, label: "changed" }]]);
});

it("preserves history and redo for an update with a missing id", () => {
  const branched = stateWithRedoBranch();

  const unchanged = editorReducer(branched, {
    type: "UPDATE_ANNOTATION",
    id: "ann_missing",
    patch: { label: "missing" },
  });

  expect(unchanged).toBe(branched);
  expect(unchanged.past).toEqual([]);
  expect(unchanged.future).toEqual([[{ ...person, label: "changed" }]]);
});

it("preserves history and redo for a delete with a missing id", () => {
  const branched = stateWithRedoBranch();

  const unchanged = editorReducer(branched, {
    type: "DELETE_ANNOTATION",
    id: "ann_missing",
  });

  expect(unchanged).toBe(branched);
  expect(unchanged.past).toEqual([]);
  expect(unchanged.future).toEqual([[{ ...person, label: "changed" }]]);
});

it("does not evict real bounded history with a same-value update", () => {
  let state = loadedState([person]);

  for (let index = 1; index <= 100; index += 1) {
    state = editorReducer(state, {
      type: "UPDATE_ANNOTATION",
      id: "ann_001",
      patch: { label: `person ${index}` },
    });
  }

  const unchanged = editorReducer(state, {
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { label: "person 100" },
  });

  expect(unchanged).toBe(state);
  expect(unchanged.past).toHaveLength(100);
  expect(unchanged.past[0]?.[0]?.label).toBe("person");
});

it("provides typed editor state and dispatch", () => {
  const { result } = renderHook(
    () => ({ state: useEditorState(), dispatch: useEditorDispatch() }),
    { wrapper: EditorProvider },
  );

  expect(result.current.state).toEqual(initialEditorState);
  expect(result.current.dispatch).toEqual(expect.any(Function));
});

it("throws a descriptive error when state is read outside EditorProvider", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  expect(() => renderHook(() => useEditorState())).toThrow(
    "useEditorState must be used inside EditorProvider",
  );
});

it("throws a descriptive error when dispatch is read outside EditorProvider", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  expect(() => renderHook(() => useEditorDispatch())).toThrow(
    "useEditorDispatch must be used inside EditorProvider",
  );
});
