import { useRef, useState, type KeyboardEvent } from "react";

import type { Project } from "../api";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { ArchiveIcon, ErrorBanner, PencilIcon, SettingsIcon, TrashIcon } from "./ui";

type SettingsView = "menu" | "archive" | "delete" | "rename" | null;

export function ProjectSettings({
  disabled,
  onArchive,
  onDelete,
  onRename,
  project
}: {
  disabled: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onRename: (name: string) => Promise<unknown>;
  project: Project;
}) {
  const [view, setView] = useState<SettingsView>(null);
  const [name, setName] = useState(project.name);
  const [renameError, setRenameError] = useState<unknown>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  function close() {
    setView(null);
    buttonRef.current?.focus();
  }

  useDismissableLayer(view !== null, controlRef, close);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div className="subnav__settings-control" ref={controlRef}>
      <button
        aria-controls={view ? "project-settings-popover" : undefined}
        aria-expanded={view !== null}
        aria-haspopup={view === null || view === "menu" ? "menu" : "dialog"}
        aria-label="Project settings"
        className="subnav__settings-action"
        disabled={disabled}
        onClick={() => setView((current) => current === null ? "menu" : null)}
        ref={buttonRef}
        title="Project settings"
        type="button"
      >
        <SettingsIcon />
      </button>
      {view === "menu" ? (
        <div
          aria-label="Project settings"
          className="avatar-dropdown subnav__settings-menu"
          id="project-settings-popover"
          onKeyDown={handleMenuKeyDown}
          role="menu"
        >
          <button
            autoFocus
            className="menu-item"
            onClick={() => {
              if (project.archived) {
                close();
                onArchive();
              } else {
                setView("archive");
              }
            }}
            role="menuitem"
            type="button"
          >
            <ArchiveIcon restore={project.archived} />
            {project.archived ? "Unarchive" : "Archive"}
          </button>
          <button
            className="menu-item danger-button"
            onClick={() => setView("delete")}
            role="menuitem"
            type="button"
          >
            <TrashIcon />
            Delete
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setName(project.name);
              setRenameError(null);
              setView("rename");
            }}
            role="menuitem"
            type="button"
          >
            <PencilIcon />
            Rename
          </button>
        </div>
      ) : null}
      {view === "archive" || view === "delete" ? (
        <div
          aria-label={`${view === "archive" ? "Archive" : "Delete"} project ${project.name}`}
          className="task-delete-popover subnav__settings-panel"
          id="project-settings-popover"
          role="alertdialog"
        >
          <p>{view === "archive" ? "Archive" : "Delete"} {project.name}?</p>
          <p>
            {view === "archive"
              ? "It will be hidden. This action can be reverted"
              : "The project and all its tasks will be permanently deleted."}
          </p>
          <div className="task-delete-popover__actions">
            <button autoFocus className="text-button" onClick={close} type="button">
              Cancel
            </button>
            <button
              className="ghost-button danger-button"
              disabled={disabled}
              onClick={() => {
                close();
                if (view === "archive") {
                  onArchive();
                } else {
                  onDelete();
                }
              }}
              type="button"
            >
              {view === "archive" ? "Archive" : "Delete"}
            </button>
          </div>
        </div>
      ) : null}
      {view === "rename" ? (
        <div
          aria-label={`Rename project ${project.name}`}
          className="task-delete-popover subnav__settings-panel"
          id="project-settings-popover"
          role="dialog"
        >
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (disabled || !name.trim()) {
                return;
              }
              setRenameError(null);
              try {
                await onRename(name.trim());
                close();
              } catch (error) {
                setRenameError(error);
              }
            }}
          >
            <label className="field">
              <span className="field__label">Project name</span>
              <input
                autoFocus
                disabled={disabled}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            {renameError ? <ErrorBanner error={renameError} /> : null}
            <div className="task-delete-popover__actions">
              <button className="text-button" disabled={disabled} onClick={close} type="button">
                Cancel
              </button>
              <button className="ghost-button" disabled={disabled || !name.trim()} type="submit">
                {disabled ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
