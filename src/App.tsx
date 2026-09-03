import type { JSX } from "react";

export default function App(): JSX.Element {
  return (
    <main>
      <h1>REC Annotation Editor</h1>
      <button type="button">Open image</button>
      <button type="button">Open labels</button>
    </main>
  );
}
