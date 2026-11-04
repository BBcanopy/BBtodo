import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../api";
import { getStatusOptions, getTodoStatus, normalizeStatus } from "../app/todo-status";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { ChevronDownIcon, ErrorBanner } from "./ui";

export function TodoStatusSwitcher({ active }: { active: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    enabled: open || active
  });
  const status = getTodoStatus(active ? params.get("status") : null);
  const options = useMemo(() => getStatusOptions(projectsQuery.data ?? []), [projectsQuery.data]);
  const visibleOptions = options.filter((option) => option.key.includes(normalizeStatus(search)));
  const highlighted = visibleOptions[highlightedIndex];
  const label = options.find((option) => option.key === status.key)?.label ?? status.label;

  useDismissableLayer(open, containerRef, () => setOpen(false));

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightedIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlighted?.key]);

  function selectStatus(nextStatus: { key: string; label: string }) {
    const nextParams = active ? new URLSearchParams(params) : new URLSearchParams();
    if (nextStatus.key === "todo") {
      nextParams.delete("status");
    } else {
      nextParams.set("status", nextStatus.label);
    }
    setOpen(false);
    triggerRef.current?.focus();
    const searchString = nextParams.toString();
    navigate({ pathname: "/todos", search: searchString ? `?${searchString}` : "" });
  }

  return (
    <div className="todo-status-switcher" ref={containerRef}>
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`subnav__link todo-status-switcher__trigger${active ? " is-active" : ""}`}
        data-testid="todo-status-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={`Filter tasks by status: ${label}`}
        type="button"
      >
        <span className="todo-status-switcher__label">{label}</span>
        <ChevronDownIcon className={`project-switcher__chevron${open ? " is-open" : ""}`} />
      </button>
      {open ? (
        <div className="todo-status-switcher__dropdown">
          <input
            aria-activedescendant={highlighted && !projectsQuery.isPending && !projectsQuery.error ? `${listId}-${highlightedIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-label="Search statuses"
            autoComplete="off"
            onChange={(event) => {
              setSearch(event.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightedIndex((current) => visibleOptions.length === 0 ? 0 :
                  (current + (event.key === "ArrowDown" ? 1 : -1) + visibleOptions.length) % visibleOptions.length);
              } else if (event.key === "Enter" && highlighted && !projectsQuery.isPending && !projectsQuery.error) {
                event.preventDefault();
                selectStatus(highlighted);
              } else if (event.key === "Tab") {
                setOpen(false);
              }
            }}
            placeholder="Search statuses..."
            ref={inputRef}
            role="combobox"
            value={search}
          />
          {projectsQuery.error ? <ErrorBanner error={projectsQuery.error} /> : null}
          <div aria-label="Board statuses" className="todo-status-switcher__options" id={listId} ref={listRef} role="listbox">
            {projectsQuery.isPending ? <p className="subnav__search-empty" role="status">Loading statuses...</p> : null}
            {!projectsQuery.isPending && !projectsQuery.error ? visibleOptions.map((option, index) => (
              <button
                aria-selected={option.key === status.key}
                className="todo-status-switcher__option"
                data-highlighted={index === highlightedIndex}
                id={`${listId}-${index}`}
                key={option.key}
                onClick={() => selectStatus(option)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span>{option.label}</span>
                {option.key === status.key ? <span aria-hidden="true">✓</span> : null}
              </button>
            )) : null}
            {!projectsQuery.isPending && !projectsQuery.error && visibleOptions.length === 0 ? (
              <p className="subnav__search-empty" role="status">No matching statuses.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
