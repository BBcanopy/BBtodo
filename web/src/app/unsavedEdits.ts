import { useEffect, useSyncExternalStore } from "react";

const unsavedEditListeners = new Set<() => void>();
const lostEditListeners = new Set<(ticketId: string) => void>();
let editorsWithUnsavedEdits = 0;

function changeEditorsWithUnsavedEdits(change: number) {
  editorsWithUnsavedEdits += change;
  unsavedEditListeners.forEach((listener) => listener());
}

function subscribeToUnsavedEdits(listener: () => void) {
  unsavedEditListeners.add(listener);

  return () => {
    unsavedEditListeners.delete(listener);
  };
}

export function useHasUnsavedEdits() {
  return useSyncExternalStore(subscribeToUnsavedEdits, () => editorsWithUnsavedEdits > 0);
}

/** Reports unsaved edits to the rest of the app and has the browser warn before the tab closes. */
export function useUnsavedEditsGuard(hasUnsavedEdits: boolean) {
  useEffect(() => {
    if (!hasUnsavedEdits) {
      return;
    }

    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warnBeforeUnload);
    changeEditorsWithUnsavedEdits(1);

    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      changeEditorsWithUnsavedEdits(-1);
    };
  }, [hasUnsavedEdits]);
}

/** Tells the app shell that edits could not be saved after their editor had already closed. */
export function reportLostEdits(ticketId: string) {
  lostEditListeners.forEach((listener) => listener(ticketId));
}

export function subscribeToLostEdits(listener: (ticketId: string) => void) {
  lostEditListeners.add(listener);

  return () => {
    lostEditListeners.delete(listener);
  };
}
