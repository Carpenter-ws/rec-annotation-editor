import { Component, type PropsWithChildren } from "react";

interface EditorErrorBoundaryState {
  failed: boolean;
}

export class EditorErrorBoundary extends Component<
  PropsWithChildren,
  EditorErrorBoundaryState
> {
  state: EditorErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): EditorErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error">
          <h1>The editor hit an unexpected error</h1>
          <p>
            Your files stay on this machine. Reload the editor to continue from
            your last import or save.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload editor
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
