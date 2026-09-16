import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import type { Annotation } from "../domain/types";
import { editorReducer, initialEditorState } from "../state/editorReducer";
import { AnnotationCard } from "./AnnotationCard";
import { AnnotationPanel } from "./AnnotationPanel";

const annotation: Annotation = {
  id: "ann_001",
  bbox: { x1: 10, y1: 20, x2: 70, y2: 90 },
  label: "person",
  reservedField: "0",
};

function ReducerPanelHarness() {
  const [state, dispatch] = useReducer(
    editorReducer,
    initialEditorState,
    (initialState) =>
      editorReducer(initialState, {
        type: "LOAD_ANNOTATIONS",
        annotations: [annotation],
        fileName: "scene.txt",
      }),
  );

  return (
    <>
      <AnnotationPanel
        annotations={state.annotations}
        selectedId={state.selectedId}
        bounds={null}
        dispatch={dispatch}
        onLocate={vi.fn()}
      />
      <output data-testid="transaction-state">
        {state.transactionBase === null ? "closed" : "open"}
      </output>
      <output data-testid="past-count">{state.past.length}</output>
      <output data-testid="current-label">
        {state.annotations[0]?.label ?? "missing"}
      </output>
    </>
  );
}

/** Categories start collapsed, so panel tests reveal the cards they drive. */
async function showAllCards(): Promise<void> {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Expand all" }));
}

function renderCard(dispatch = vi.fn()) {
  render(
    <AnnotationCard
      annotation={annotation}
      index={1}
      bounds={{ width: 1920, height: 1080 }}
      selected
      dispatch={dispatch}
      onSelect={vi.fn()}
      onLocate={vi.fn()}
      onExpressionEditingChange={vi.fn()}
    />,
  );
  return dispatch;
}

it("previews every visible expression value and commits one transaction on blur", async () => {
  const user = userEvent.setup();
  const dispatch = renderCard();
  const input = screen.getByRole("textbox", { name: "Expression" });

  await user.click(input);
  await user.clear(input);
  await user.type(input, "new label");
  fireEvent.blur(input);

  expect(dispatch.mock.calls).toEqual([
    [{ type: "BEGIN_TRANSACTION" }],
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { label: "" },
      },
    ],
    ...[..."new label"].map((_, index) => [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { label: "new label".slice(0, index + 1) },
      },
    ]),
    [{ type: "COMMIT_TRANSACTION" }],
  ]);
});

it("trims an expression on Enter before committing exactly once", async () => {
  const user = userEvent.setup();
  const dispatch = renderCard();
  const input = screen.getByRole("textbox", { name: "Expression" });

  await user.click(input);
  await user.clear(input);
  await user.type(input, "  updated person  ");
  dispatch.mockClear();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);

  expect(input).toHaveValue("updated person");
  expect(dispatch.mock.calls).toEqual([
    [
      {
        type: "PREVIEW_PATCH",
        id: "ann_001",
        patch: { label: "updated person" },
      },
    ],
    [{ type: "COMMIT_TRANSACTION" }],
  ]);
});

it("cancels an empty expression and restores the focus-start label", async () => {
  const user = userEvent.setup();
  const dispatch = renderCard();
  const input = screen.getByRole("textbox", { name: "Expression" });

  await user.click(input);
  await user.clear(input);
  fireEvent.blur(input);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Expression cannot be empty.",
  );
  expect(input).toHaveValue("person");
  expect(dispatch).toHaveBeenLastCalledWith({ type: "CANCEL_TRANSACTION" });
  expect(
    dispatch.mock.calls.filter(([action]) => action.type === "CANCEL_TRANSACTION"),
  ).toHaveLength(1);
  expect(
    dispatch.mock.calls.filter(([action]) => action.type === "COMMIT_TRANSACTION"),
  ).toHaveLength(0);
});

it("cancels expression editing once on Escape and restores the focus-start label", async () => {
  const user = userEvent.setup();
  const dispatch = renderCard();
  const input = screen.getByRole("textbox", { name: "Expression" });

  await user.click(input);
  await user.clear(input);
  await user.type(input, "temporary");
  dispatch.mockClear();
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);

  expect(input).toHaveValue("person");
  expect(dispatch.mock.calls).toEqual([[{ type: "CANCEL_TRANSACTION" }]]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  ["blur", "updated"],
  ["Enter", "updated"],
  ["empty blur", ""],
  ["Escape", "updated"],
] as const)(
  "reports expression editing active then inactive exactly once on %s",
  (finish, value) => {
    const onExpressionEditingChange = vi.fn();
    render(
      <AnnotationCard
        annotation={annotation}
        index={1}
        bounds={{ width: 1920, height: 1080 }}
        selected
        dispatch={vi.fn()}
        onSelect={vi.fn()}
        onLocate={vi.fn()}
        onExpressionEditingChange={onExpressionEditingChange}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Expression" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });

    if (finish === "blur" || finish === "empty blur") {
      fireEvent.blur(input);
    } else {
      fireEvent.keyDown(input, { key: finish });
      fireEvent.blur(input);
    }

    expect(onExpressionEditingChange.mock.calls).toEqual([
      ["ann_001"],
      [null],
    ]);
  },
);

it("synchronizes an unfocused expression from annotation prop changes", () => {
  const dispatch = vi.fn();
  const props = {
    annotation,
    index: 1,
    bounds: { width: 1920, height: 1080 },
    selected: true,
    dispatch,
    onSelect: vi.fn(),
    onLocate: vi.fn(),
    onExpressionEditingChange: vi.fn(),
  };
  const { rerender } = render(<AnnotationCard {...props} />);

  rerender(
    <AnnotationCard
      {...props}
      annotation={{ ...annotation, label: "externally updated" }}
    />,
  );

  expect(screen.getByRole("textbox", { name: "Expression" })).toHaveValue(
    "externally updated",
  );
});

it("commits all four valid coordinate drafts in one atomic bbox update", () => {
  const dispatch = renderCard();
  const x1 = screen.getByRole("textbox", { name: "X1" });

  fireEvent.focus(x1);
  fireEvent.change(x1, { target: { value: "12.25" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Y1" }), {
    target: { value: "21" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "X2" }), {
    target: { value: "80" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Y2" }), {
    target: { value: "95" },
  });
  dispatch.mockClear();
  fireEvent.keyDown(x1, { key: "Enter" });
  fireEvent.blur(x1);

  expect(dispatch.mock.calls).toEqual([
    [
      {
        type: "UPDATE_ANNOTATION",
        id: "ann_001",
        patch: { bbox: { x1: 12.25, y1: 21, x2: 80, y2: 95 } },
      },
    ],
  ]);
});

it("allows temporary coordinate strings then rejects nonfinite input and restores legal values", () => {
  const dispatch = renderCard();
  const x1 = screen.getByRole("textbox", { name: "X1" });

  fireEvent.focus(x1);
  fireEvent.change(x1, { target: { value: "-" } });
  expect(x1).toHaveValue("-");
  expect(dispatch).not.toHaveBeenCalled();
  fireEvent.change(x1, { target: { value: "Infinity" } });
  fireEvent.blur(x1);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "All coordinates must be finite numbers.",
  );
  expect(dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "UPDATE_ANNOTATION" }),
  );
  expect(x1).toHaveValue("10");
  expect(screen.getByRole("textbox", { name: "Y1" })).toHaveValue("20");
  expect(screen.getByRole("textbox", { name: "X2" })).toHaveValue("70");
  expect(screen.getByRole("textbox", { name: "Y2" })).toHaveValue("90");
});

it("rejects X2 at or before X1 and restores the last legal coordinates", () => {
  const dispatch = renderCard();
  const x2 = screen.getByRole("textbox", { name: "X2" });

  fireEvent.focus(x2);
  fireEvent.change(x2, { target: { value: "10" } });
  fireEvent.blur(x2);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "X2 must be greater than X1.",
  );
  expect(dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "UPDATE_ANNOTATION" }),
  );
  expect(x2).toHaveValue("70");
});

it("rejects Y2 at or before Y1 with the Y2 order error", () => {
  const dispatch = renderCard();
  const y2 = screen.getByRole("textbox", { name: "Y2" });

  fireEvent.focus(y2);
  fireEvent.change(y2, { target: { value: "20" } });
  fireEvent.blur(y2);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Y2 must be greater than Y1.",
  );
  expect(dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "UPDATE_ANNOTATION" }),
  );
  expect(y2).toHaveValue("90");
});

it("clamps a valid coordinate commit to the current image bounds", () => {
  const dispatch = vi.fn();
  render(
    <AnnotationCard
      annotation={annotation}
      index={1}
      bounds={{ width: 100, height: 100 }}
      selected
      dispatch={dispatch}
      onSelect={vi.fn()}
      onLocate={vi.fn()}
      onExpressionEditingChange={vi.fn()}
    />,
  );
  const x1 = screen.getByRole("textbox", { name: "X1" });
  fireEvent.focus(x1);
  fireEvent.change(x1, { target: { value: "-5" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Y1" }), {
    target: { value: "-10" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "X2" }), {
    target: { value: "120" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Y2" }), {
    target: { value: "110" },
  });
  fireEvent.keyDown(x1, { key: "Enter" });

  expect(dispatch).toHaveBeenCalledWith({
    type: "UPDATE_ANNOTATION",
    id: "ann_001",
    patch: { bbox: { x1: 0, y1: 0, x2: 100, y2: 100 } },
  });
  expect(x1).toHaveValue("0");
  expect(screen.getByRole("textbox", { name: "Y2" })).toHaveValue("100");
});

it("syncs canvas-driven coordinate props except for the actively edited field", () => {
  const props = {
    annotation,
    index: 1,
    bounds: { width: 1920, height: 1080 },
    selected: true,
    dispatch: vi.fn(),
    onSelect: vi.fn(),
    onLocate: vi.fn(),
    onExpressionEditingChange: vi.fn(),
  };
  const { rerender } = render(<AnnotationCard {...props} />);
  const x1 = screen.getByRole("textbox", { name: "X1" });
  fireEvent.focus(x1);
  fireEvent.change(x1, { target: { value: "1." } });

  rerender(
    <AnnotationCard
      {...props}
      annotation={{
        ...annotation,
        bbox: { x1: 12, y1: 30, x2: 80, y2: 95 },
      }}
    />,
  );

  expect(x1).toHaveValue("1.");
  expect(screen.getByRole("textbox", { name: "Y1" })).toHaveValue("30");
  expect(screen.getByRole("textbox", { name: "X2" })).toHaveValue("80");
  expect(screen.getByRole("textbox", { name: "Y2" })).toHaveValue("95");
});

it("disables bbox editing when image bounds are unavailable", () => {
  const dispatch = vi.fn();
  render(
    <AnnotationCard
      annotation={annotation}
      index={1}
      bounds={null}
      selected
      dispatch={dispatch}
      onSelect={vi.fn()}
      onLocate={vi.fn()}
      onExpressionEditingChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("textbox", { name: "Expression" })).toBeEnabled();
  for (const name of ["X1", "Y1", "X2", "Y2"]) {
    expect(screen.getByRole("textbox", { name })).toBeDisabled();
  }
  fireEvent.change(screen.getByRole("textbox", { name: "X1" }), {
    target: { value: "12" },
  });
  fireEvent.blur(screen.getByRole("textbox", { name: "X1" }));
  expect(dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "UPDATE_ANNOTATION" }),
  );
});

it("filters duplicate labels case-insensitively without changing ID order", async () => {
  const user = userEvent.setup();
  const annotations: Annotation[] = [
    annotation,
    { ...annotation, id: "duplicate/id", label: "PERSON" },
    { ...annotation, id: "ann_003", label: "bicycle" },
  ];
  const { container } = render(
    <AnnotationPanel
      annotations={annotations}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={vi.fn()}
      onLocate={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Total annotations")).toHaveTextContent(
    "3 annotations",
  );
  expect(
    screen.queryByLabelText("Matching annotations"),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByRole("searchbox", { name: "Search annotations" }),
    "  PeRsOn  ",
  );

  expect(screen.getByLabelText("Matching annotations")).toHaveTextContent(
    "2 matches",
  );
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-annotation-id]")].map(
      (element) => element.dataset.annotationId,
    ),
  ).toEqual(["ann_001", "duplicate/id"]);
});

it("keeps each card's source ordinal while filtering", async () => {
  const user = userEvent.setup();
  render(
    <AnnotationPanel
      annotations={[
        annotation,
        { ...annotation, id: "ann_002", label: "car" },
        { ...annotation, id: "ann_003", label: "bicycle" },
      ]}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={vi.fn()}
      onLocate={vi.fn()}
    />,
  );

  await user.type(
    screen.getByRole("searchbox", { name: "Search annotations" }),
    "bicycle",
  );

  expect(screen.getByText("Annotation 3")).toBeVisible();
  expect(screen.queryByText("Annotation 1")).not.toBeInTheDocument();
});

it("offers deleting a whole expression from its header", async () => {
  const user = userEvent.setup();
  const onDeleteCategory = vi.fn();
  render(
    <AnnotationPanel
      annotations={[annotation, { ...annotation, id: "ann_002" }]}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={vi.fn()}
      onLocate={vi.fn()}
      onDeleteCategory={onDeleteCategory}
    />,
  );

  await user.click(
    screen.getByRole("button", { name: 'Delete "person" boxes' }),
  );

  expect(onDeleteCategory).toHaveBeenCalledWith("person");
});

it("hides the expression delete control when the panel cannot delete", () => {
  render(
    <AnnotationPanel
      annotations={[annotation]}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={vi.fn()}
      onLocate={vi.fn()}
    />,
  );

  expect(
    screen.queryByRole("button", { name: 'Delete "person" boxes' }),
  ).not.toBeInTheDocument();
});

it("selects and locates the exact clicked annotation ID", async () => {
  const user = userEvent.setup();
  const dispatch = vi.fn();
  const onLocate = vi.fn();
  const annotations: Annotation[] = [
    annotation,
    { ...annotation, id: "duplicate/id", label: annotation.label },
  ];
  const { container } = render(
    <AnnotationPanel
      annotations={annotations}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={dispatch}
      onLocate={onLocate}
    />,
  );
  await showAllCards();

  await user.click(
    container.querySelector<HTMLElement>('[data-annotation-id="duplicate/id"]')!,
  );

  expect(dispatch.mock.calls).toEqual([
    [{ type: "SELECT", id: "duplicate/id" }],
  ]);
  expect(onLocate).toHaveBeenCalledTimes(1);
  expect(onLocate).toHaveBeenCalledWith("duplicate/id");
});

it("marks only the card matching the selected annotation ID", () => {
  const annotations: Annotation[] = [
    annotation,
    { ...annotation, id: "duplicate/id", label: annotation.label },
  ];
  const { container } = render(
    <AnnotationPanel
      annotations={annotations}
      selectedId="duplicate/id"
      bounds={{ width: 1920, height: 1080 }}
      dispatch={vi.fn()}
      onLocate={vi.fn()}
    />,
  );

  expect(
    container.querySelector('[data-annotation-id="duplicate/id"]'),
  ).toHaveAttribute("aria-current", "true");
  expect(container.querySelector('[data-annotation-id="ann_001"]')).not.toHaveAttribute(
    "aria-current",
  );
});

it("deletes the exact card without bubbling into selection or locate", async () => {
  const user = userEvent.setup();
  const dispatch = vi.fn();
  const onLocate = vi.fn();
  const annotations: Annotation[] = [
    annotation,
    { ...annotation, id: "duplicate/id", label: annotation.label },
  ];
  render(
    <AnnotationPanel
      annotations={annotations}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={dispatch}
      onLocate={onLocate}
    />,
  );
  await showAllCards();

  await user.click(
    screen.getAllByRole("button", { name: "Delete annotation" })[1]!,
  );

  expect(dispatch.mock.calls).toEqual([
    [{ type: "DELETE_ANNOTATION", id: "duplicate/id" }],
  ]);
  expect(onLocate).not.toHaveBeenCalled();
});

it("selects card fields without locating them through click bubbling", async () => {
  const user = userEvent.setup();
  const dispatch = vi.fn();
  const onLocate = vi.fn();
  render(
    <AnnotationPanel
      annotations={[annotation]}
      selectedId={null}
      bounds={{ width: 1920, height: 1080 }}
      dispatch={dispatch}
      onLocate={onLocate}
    />,
  );
  await showAllCards();

  await user.click(
    screen.getByRole("searchbox", { name: "Search annotations" }),
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(onLocate).not.toHaveBeenCalled();

  await user.click(screen.getByRole("textbox", { name: "Expression" }));
  expect(dispatch).toHaveBeenCalledWith({ type: "SELECT", id: "ann_001" });
  expect(
    dispatch.mock.calls.filter(([action]) => action.type === "SELECT"),
  ).toHaveLength(1);
  expect(onLocate).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByRole("textbox", { name: "Expression" }), {
    key: "Escape",
  });
  dispatch.mockClear();
  await user.click(screen.getByRole("textbox", { name: "X1" }));
  expect(dispatch.mock.calls).toEqual(
    [[{ type: "SELECT", id: "ann_001" }]],
  );
  expect(onLocate).not.toHaveBeenCalled();
});

it("scrolls the exact selected special-character ID without CSS.escape", async () => {
  const specialId = 'ann_\"]#special\\id';
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal("CSS", undefined);

  try {
    const props = {
      annotations: [
        annotation,
        { ...annotation, id: specialId, label: "special" },
      ],
      selectedId: null,
      bounds: { width: 1920, height: 1080 },
      dispatch: vi.fn(),
      onLocate: vi.fn(),
    };
    const { container, rerender } = render(<AnnotationPanel {...props} />);
    await showAllCards();
    const selectedCard = [
      ...container.querySelectorAll<HTMLElement>("[data-annotation-id]"),
    ].find((element) => element.dataset.annotationId === specialId);

    rerender(<AnnotationPanel {...props} selectedId={specialId} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(selectedCard);
  } finally {
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  }
});

it("retains an empty focused search match until blur cancels and restores it", async () => {
  const user = userEvent.setup();
  render(<ReducerPanelHarness />);
  const search = screen.getByRole("searchbox", {
    name: "Search annotations",
  });
  await user.type(search, "per");
  const expression = screen.getByRole("textbox", { name: "Expression" });

  fireEvent.focus(expression);
  fireEvent.change(expression, { target: { value: "" } });

  expect(screen.getByLabelText("Matching annotations")).toHaveTextContent(
    "0 matches",
  );
  expect(expression).toBeInTheDocument();
  expect(expression).toHaveValue("");
  expect(screen.getByTestId("transaction-state")).toHaveTextContent("open");

  fireEvent.blur(expression);

  expect(screen.getByTestId("transaction-state")).toHaveTextContent("closed");
  expect(screen.getByTestId("past-count")).toHaveTextContent("0");
  expect(screen.getByTestId("current-label")).toHaveTextContent("person");
  expect(expression).toHaveValue("person");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Expression cannot be empty.",
  );

  await user.clear(search);
  await user.type(search, "zzz");
  expect(
    screen.queryByRole("textbox", { name: "Expression" }),
  ).not.toBeInTheDocument();
});

it("removes a retained search mismatch only after its valid edit commits", async () => {
  const user = userEvent.setup();
  render(<ReducerPanelHarness />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search annotations" }),
    "per",
  );
  const expression = screen.getByRole("textbox", { name: "Expression" });

  fireEvent.focus(expression);
  fireEvent.change(expression, { target: { value: "vehicle" } });

  expect(screen.getByLabelText("Matching annotations")).toHaveTextContent(
    "0 matches",
  );
  expect(expression).toBeInTheDocument();
  expect(screen.getByTestId("transaction-state")).toHaveTextContent("open");

  fireEvent.blur(expression);

  expect(screen.getByTestId("transaction-state")).toHaveTextContent("closed");
  expect(screen.getByTestId("past-count")).toHaveTextContent("1");
  expect(screen.getByTestId("current-label")).toHaveTextContent("vehicle");
  expect(
    screen.queryByRole("textbox", { name: "Expression" }),
  ).not.toBeInTheDocument();
});
