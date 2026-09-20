import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type PropsWithChildren,
} from "react";
import {
  editorReducer,
  initialEditorState,
  type EditorAction,
  type EditorState,
} from "./editorReducer";

const StateContext = createContext<EditorState | null>(null);
const DispatchContext = createContext<Dispatch<EditorAction> | null>(null);

export function EditorProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useEditorState(): EditorState {
  const value = useContext(StateContext);
  if (!value) throw new Error("useEditorState must be used inside EditorProvider");
  return value;
}

export function useEditorDispatch(): Dispatch<EditorAction> {
  const value = useContext(DispatchContext);
  if (!value) throw new Error("useEditorDispatch must be used inside EditorProvider");
  return value;
}
