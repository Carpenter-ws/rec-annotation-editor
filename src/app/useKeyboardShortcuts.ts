import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onDelete: () => void;
  onEscape: () => void;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function useKeyboardShortcuts(
  handlers: KeyboardShortcutHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;

      if (commandKey && !event.altKey) {
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) handlersRef.current.onRedo();
          else handlersRef.current.onUndo();
          return;
        }
        if (key === "y") {
          event.preventDefault();
          handlersRef.current.onRedo();
          return;
        }
        if (key === "s") {
          event.preventDefault();
          handlersRef.current.onSave();
          return;
        }
      }

      if (
        isEditableTarget(event.target) ||
        isEditableTarget(document.activeElement)
      ) {
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        handlersRef.current.onDelete();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        handlersRef.current.onEscape();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
