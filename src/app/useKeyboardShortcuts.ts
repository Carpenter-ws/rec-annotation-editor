import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  enabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onDelete: () => void;
  onEscape: () => void;
  /** Alt+ArrowLeft / Alt+ArrowRight dataset navigation. */
  onPreviousItem?: () => void;
  onNextItem?: () => void;
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
      if (handlersRef.current.enabled === false) return;
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
        return;
      }
      if (event.altKey && !commandKey) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          handlersRef.current.onPreviousItem?.();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          handlersRef.current.onNextItem?.();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
