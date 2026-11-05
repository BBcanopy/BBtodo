import { useEffect, useSyncExternalStore } from "react";

import type { TaskTag } from "../api";

export interface TaskDraft {
  body: string;
  tags: TaskTag[];
  title: string;
}

interface TaskSaveQueue {
  latestDraft: TaskDraft;
  latestSave: Promise<unknown>;
  tail: Promise<void>;
}

const lostEditListeners = new Set<(ticketId: string) => void>();
const taskSaveQueues = new Map<string, TaskSaveQueue>();
const unsavedWorkListeners = new Set<() => void>();
let unsavedWorkCount = 0;

function changeUnsavedWorkCount(change: number) {
  unsavedWorkCount += change;
  unsavedWorkListeners.forEach((listener) => listener());
}

function subscribeToUnsavedWork(listener: () => void) {
  unsavedWorkListeners.add(listener);

  return () => {
    unsavedWorkListeners.delete(listener);
  };
}

/** True while an open editor holds unsaved edits or any card save has yet to finish. */
export function useHasUnsavedEdits() {
  return useSyncExternalStore(subscribeToUnsavedWork, () => unsavedWorkCount > 0);
}

export function useWarnBeforeUnload(shouldWarn: boolean) {
  useEffect(() => {
    if (!shouldWarn) {
      return;
    }

    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warnBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [shouldWarn]);
}

export function useReportUnsavedEdits(hasUnsavedEdits: boolean) {
  useEffect(() => {
    if (!hasUnsavedEdits) {
      return;
    }

    changeUnsavedWorkCount(1);

    return () => {
      changeUnsavedWorkCount(-1);
    };
  }, [hasUnsavedEdits]);
}

/**
 * Runs saves for one card strictly in the order they were requested, across editor instances. A
 * closed editor's last save can still be in flight when the card is reopened, and without this an
 * older draft could reach the server after a newer one. Each save runs even if the previous failed.
 */
export function runTaskSaveInOrder<T>(taskId: string, draft: TaskDraft, save: () => Promise<T>) {
  const result = (taskSaveQueues.get(taskId)?.tail ?? Promise.resolve()).then(save);
  const settle = () => undefined;
  const tail: Promise<void> = result.then(settle, settle).then(() => {
    changeUnsavedWorkCount(-1);

    if (taskSaveQueues.get(taskId)?.tail === tail) {
      taskSaveQueues.delete(taskId);
    }
  });

  taskSaveQueues.set(taskId, { latestDraft: draft, latestSave: result, tail });
  changeUnsavedWorkCount(1);

  return result;
}

/** The newest save still pending for a card. Its draft is more recent than any cached copy. */
export function getLatestQueuedTaskSave(taskId: string) {
  const queue = taskSaveQueues.get(taskId);

  return queue ? { draft: queue.latestDraft, save: queue.latestSave } : null;
}

/** Announces that edits could not be saved after their editor had already closed. */
export function reportLostEdits(ticketId: string) {
  lostEditListeners.forEach((listener) => listener(ticketId));
}

export function subscribeToLostEdits(listener: (ticketId: string) => void) {
  lostEditListeners.add(listener);

  return () => {
    lostEditListeners.delete(listener);
  };
}
