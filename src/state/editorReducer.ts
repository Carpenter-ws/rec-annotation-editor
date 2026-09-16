import type { Annotation, ImageInfo } from "../domain/types";

export interface EditorState {
  image: ImageInfo | null;
  labelFileName: string | null;
  annotations: Annotation[];
  nextAnnotationNumber: number;
  selectedId: string | null;
  mode: "select" | "add";
  past: Annotation[][];
  future: Annotation[][];
  transactionBase: Annotation[] | null;
  savedFingerprint: string;
  dirty: boolean;
}

export type EditorAction =
  | { type: "SET_IMAGE"; image: ImageInfo | null }
  | {
      type: "LOAD_ANNOTATIONS";
      annotations: Annotation[];
      fileName: string | null;
    }
  | {
      type: "COMMIT_IMPORT";
      image?: ImageInfo;
      annotationBaseline?: {
        annotations: Annotation[];
        fileName: string | null;
      };
    }
  | { type: "SELECT"; id: string | null }
  | { type: "SET_MODE"; mode: "select" | "add" }
  | { type: "BEGIN_TRANSACTION" }
  | {
      type: "PREVIEW_PATCH";
      id: string;
      patch: Partial<Pick<Annotation, "bbox" | "label">>;
    }
  | { type: "COMMIT_TRANSACTION" }
  | { type: "CANCEL_TRANSACTION" }
  | {
      type: "UPDATE_ANNOTATION";
      id: string;
      patch: Partial<Pick<Annotation, "bbox" | "label">>;
    }
  | { type: "ADD_ANNOTATION"; annotation: Annotation }
  | { type: "DELETE_ANNOTATION"; id: string }
  | { type: "DELETE_LABEL"; label: string }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "MARK_SAVED" };

function fingerprint(annotations: Annotation[]): string {
  return JSON.stringify(annotations);
}

function isDirty(annotations: Annotation[], savedFingerprint: string): boolean {
  return fingerprint(annotations) !== savedFingerprint;
}

function nextAnnotationNumber(annotations: Annotation[]): number {
  const largestSuffix = annotations.reduce((largest, annotation) => {
    const match = /^ann_(\d+)$/.exec(annotation.id);
    if (!match) return largest;

    const suffix = Number(match[1]);
    return Number.isSafeInteger(suffix) ? Math.max(largest, suffix) : largest;
  }, 0);

  return largestSuffix + 1;
}

function patchAnnotation(
  annotations: Annotation[],
  id: string,
  patch: Partial<Pick<Annotation, "bbox" | "label">>,
): Annotation[] {
  return annotations.map((annotation) =>
    annotation.id === id ? { ...annotation, ...patch } : annotation,
  );
}

function pushPast(past: Annotation[][], snapshot: Annotation[]): Annotation[][] {
  return [...past.slice(-99), snapshot];
}

function commitAtomicEdit(
  state: EditorState,
  annotations: Annotation[],
  nextNumber = state.nextAnnotationNumber,
): EditorState {
  if (fingerprint(annotations) === fingerprint(state.annotations)) return state;

  return {
    ...state,
    annotations,
    nextAnnotationNumber: nextNumber,
    past: pushPast(state.past, state.annotations),
    future: [],
    transactionBase: null,
    dirty: isDirty(annotations, state.savedFingerprint),
  };
}

function resolveTransaction(state: EditorState): EditorState {
  if (state.transactionBase === null) return state;

  const changed = fingerprint(state.annotations) !== fingerprint(state.transactionBase);
  return {
    ...state,
    past: changed ? pushPast(state.past, state.transactionBase) : state.past,
    future: changed ? [] : state.future,
    transactionBase: null,
    dirty: isDirty(state.annotations, state.savedFingerprint),
  };
}

function validSelection(
  selectedId: string | null,
  annotations: Annotation[],
): string | null {
  return selectedId !== null && annotations.some(({ id }) => id === selectedId)
    ? selectedId
    : null;
}

export const initialEditorState: EditorState = {
  image: null,
  labelFileName: null,
  annotations: [],
  nextAnnotationNumber: 1,
  selectedId: null,
  mode: "select",
  past: [],
  future: [],
  transactionBase: null,
  savedFingerprint: fingerprint([]),
  dirty: false,
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SET_IMAGE":
      return {
        ...state,
        image: action.image,
        dirty: isDirty(state.annotations, state.savedFingerprint),
      };

    case "LOAD_ANNOTATIONS": {
      const savedFingerprint = fingerprint(action.annotations);
      return {
        ...state,
        labelFileName: action.fileName,
        annotations: action.annotations,
        nextAnnotationNumber: nextAnnotationNumber(action.annotations),
        selectedId: null,
        past: [],
        future: [],
        transactionBase: null,
        savedFingerprint,
        dirty: false,
      };
    }

    case "COMMIT_IMPORT": {
      if (!action.annotationBaseline) {
        if (!action.image || action.image === state.image) return state;
        return {
          ...state,
          image: action.image,
          dirty: isDirty(state.annotations, state.savedFingerprint),
        };
      }

      const { annotations, fileName } = action.annotationBaseline;
      const savedFingerprint = fingerprint(annotations);
      return {
        ...state,
        image: action.image ?? state.image,
        labelFileName: fileName,
        annotations,
        nextAnnotationNumber: nextAnnotationNumber(annotations),
        selectedId: null,
        past: [],
        future: [],
        transactionBase: null,
        savedFingerprint,
        dirty: false,
      };
    }

    case "SELECT":
      return {
        ...state,
        selectedId: action.id,
        dirty: isDirty(state.annotations, state.savedFingerprint),
      };

    case "SET_MODE":
      return {
        ...state,
        mode: action.mode,
        dirty: isDirty(state.annotations, state.savedFingerprint),
      };

    case "BEGIN_TRANSACTION":
      if (state.transactionBase !== null) return state;
      return {
        ...state,
        transactionBase: [...state.annotations],
        dirty: isDirty(state.annotations, state.savedFingerprint),
      };

    case "PREVIEW_PATCH": {
      if (state.transactionBase === null) return state;
      const annotations = patchAnnotation(state.annotations, action.id, action.patch);
      return {
        ...state,
        annotations,
        dirty: isDirty(annotations, state.savedFingerprint),
      };
    }

    case "COMMIT_TRANSACTION":
      return resolveTransaction(state);

    case "CANCEL_TRANSACTION": {
      if (state.transactionBase === null) return state;
      const annotations = state.transactionBase;
      return {
        ...state,
        annotations,
        transactionBase: null,
        dirty: isDirty(annotations, state.savedFingerprint),
      };
    }

    case "UPDATE_ANNOTATION": {
      const resolved = resolveTransaction(state);
      return commitAtomicEdit(
        resolved,
        patchAnnotation(resolved.annotations, action.id, action.patch),
      );
    }

    case "ADD_ANNOTATION": {
      const resolved = resolveTransaction(state);
      return commitAtomicEdit(
        resolved,
        [...resolved.annotations, action.annotation],
        resolved.nextAnnotationNumber + 1,
      );
    }

    case "DELETE_ANNOTATION": {
      const resolved = resolveTransaction(state);
      const committed = commitAtomicEdit(
        resolved,
        resolved.annotations.filter((annotation) => annotation.id !== action.id),
      );
      if (committed === resolved) return resolved;
      return resolved.selectedId === action.id
        ? { ...committed, selectedId: null }
        : committed;
    }

    case "DELETE_LABEL": {
      const resolved = resolveTransaction(state);
      const remaining = resolved.annotations.filter(
        (annotation) => annotation.label !== action.label,
      );
      if (remaining.length === resolved.annotations.length) return resolved;
      const committed = commitAtomicEdit(resolved, remaining);
      if (committed === resolved) return resolved;
      const selected = resolved.annotations.find(
        (annotation) => annotation.id === resolved.selectedId,
      );
      return selected && selected.label === action.label
        ? { ...committed, selectedId: null }
        : committed;
    }

    case "UNDO": {
      const resolved = resolveTransaction(state);
      const annotations = resolved.past.at(-1);
      if (!annotations) return resolved;

      return {
        ...resolved,
        annotations,
        selectedId: validSelection(resolved.selectedId, annotations),
        past: resolved.past.slice(0, -1),
        future: [resolved.annotations, ...resolved.future],
        transactionBase: null,
        dirty: isDirty(annotations, resolved.savedFingerprint),
      };
    }

    case "REDO": {
      const resolved = resolveTransaction(state);
      const [annotations, ...future] = resolved.future;
      if (!annotations) return resolved;

      return {
        ...resolved,
        annotations,
        selectedId: validSelection(resolved.selectedId, annotations),
        past: pushPast(resolved.past, resolved.annotations),
        future,
        transactionBase: null,
        dirty: isDirty(annotations, resolved.savedFingerprint),
      };
    }

    case "MARK_SAVED": {
      const savedFingerprint = fingerprint(state.annotations);
      return {
        ...state,
        savedFingerprint,
        dirty: false,
      };
    }
  }
}
