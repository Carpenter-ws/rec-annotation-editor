import { render, screen } from "@testing-library/react";
import App from "./App";

it("renders the REC editor workspace", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "REC Annotation Editor" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open image" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Open labels" })).toBeEnabled();
});
