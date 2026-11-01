import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useSearchParams
} from "react-router-dom";

import { api, type Project, type TaskTag, type User } from "../api";
import { getTaskTagStyle } from "../app/tag-colors";
import { themeOptions } from "../app/constants";
import { useCreateProjectMutation } from "../hooks/useCreateProjectMutation";
import {
  formatSingleTagInput,
  getAvatarLetter,
  getGravatarUrl,
  normalizeTagKey,
  parseExactTicketId,
  parseSingleTagInput
} from "../app/utils";
import { ArchiveIcon, ChevronDownIcon, CloseIcon, ErrorBanner, PencilIcon, ToastNotice } from "../components/ui";
import { useDismissableLayer } from "../hooks/useDismissableLayer";

interface AppToast {
  message: string;
  title: string;
  tone: "danger" | "success" | "warning";
}

export function AppShell({ user }: { user: User }) {
  const location = useLocation();
  const navigate = useNavigate();
  const boardMatch = useMatch("/projects/:projectTicketPrefix/:ticketId?");
  const todosMatch = useMatch("/todos");
  const isProjectsRoute = location.pathname === "/";
  const [searchParams, setSearchParams] = useSearchParams();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isProjectSwitcherOpen, setIsProjectSwitcherOpen] = useState(false);
  const [isTagFilterOpen, setIsTagFilterOpen] = useState(false);
  const [projectSwitcherInput, setProjectSwitcherInput] = useState("");
  const [toast, setToast] = useState<AppToast | null>(null);
  const [gravatarUrl, setGravatarUrl] = useState<string | null>(null);
  const [isGravatarLoaded, setIsGravatarLoaded] = useState(false);
  const queryClient = useQueryClient();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const tagFilterRef = useRef<HTMLDivElement | null>(null);
  const tagFilterInputRef = useRef<HTMLInputElement | null>(null);
  const navSearchLookupRequestRef = useRef(0);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    enabled: Boolean(boardMatch || isProjectsRoute)
  });
  const currentProjectQuery = useQuery({
    queryKey: ["project", boardMatch?.params.projectTicketPrefix],
    queryFn: () => api.getProjectByTicketPrefix(boardMatch?.params.projectTicketPrefix ?? ""),
    enabled: Boolean(boardMatch)
  });
  const taskTagsQuery = useQuery({
    queryKey: ["task-tags"],
    queryFn: () => api.listTaskTags(),
    enabled: Boolean(boardMatch || todosMatch)
  });
  const todosQuery = useQuery({
    queryKey: ["todos"],
    queryFn: () => api.listTodoGroups(),
    enabled: Boolean(todosMatch)
  });
  const createProjectMutation = useCreateProjectMutation({
    onSuccess: async (project) => {
      setIsProjectSwitcherOpen(false);
      setProjectSwitcherInput("");
      startTransition(() => {
        navigate(`/projects/${project.ticketPrefix}`, {
          state: {
            toast: {
              message: `Created board ${project.name}.`,
              title: "Board created",
              tone: "success"
            }
          }
        });
      });
    }
  });
  const renameProjectMutation = useMutation({
    mutationFn: ({ name, projectId }: { name: string; projectId: string }) =>
      api.updateProject(projectId, { name }),
    onSuccess: async (project) => {
      setIsProjectSwitcherOpen(false);
      setProjectSwitcherInput("");
      queryClient.setQueryData(["project", project.ticketPrefix], project);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["todos"] })
      ]);
    }
  });
  const archiveProjectMutation = useMutation({
    mutationFn: (project: Project) => api.updateProject(project.id, { archived: !project.archived }),
    onSuccess: async (project) => {
      queryClient.setQueryData(["project", project.ticketPrefix], project);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["todos"] })
      ]);
      setIsProjectSwitcherOpen(false);
      setToast({
        message: `${project.archived ? "Archived" : "Unarchived"} board ${project.name}.`,
        title: project.archived ? "Board archived" : "Board unarchived",
        tone: "success"
      });
    }
  });
  const themeMutation = useMutation({
    mutationFn: api.updateTheme,
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(["me"], updatedUser);
    }
  });
  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      window.location.replace("/");
    }
  });
  const avatarLetter = getAvatarLetter(user);
  const showGravatarImage = gravatarUrl !== null && isGravatarLoaded;
  const isTaskSearchRoute = Boolean(boardMatch || todosMatch);
  const showNavSearch = Boolean(isTaskSearchRoute || isProjectsRoute);
  const authNotice = searchParams.get("authNotice");
  const navSearch = showNavSearch ? searchParams.get("q") ?? "" : "";
  const navSearchLabel = boardMatch ? "Search cards" : todosMatch ? "Search todos" : "Search boards";
  const navTagSearch = isTaskSearchRoute ? searchParams.get("tags") ?? "" : "";
  const availableTagFilters = taskTagsQuery.data ?? [];
  const availableTagFilterMap = useMemo(
    () => new Map(availableTagFilters.map((tag) => [normalizeTagKey(tag.label), tag])),
    [availableTagFilters]
  );
  const activeTagFilter = useMemo(() => parseSingleTagInput(navTagSearch), [navTagSearch]);
  const activeTagFilterKey = normalizeTagKey(activeTagFilter);
  const selectedTagFilterChip =
    activeTagFilterKey.length > 0 ? availableTagFilterMap.get(activeTagFilterKey) ?? null : null;
  const tagFilterInputValue = selectedTagFilterChip ? "" : activeTagFilter;
  const tagFilterQuery = normalizeTagKey(tagFilterInputValue);
  const visibleTagFilterOptions = useMemo(
    () =>
      availableTagFilters.filter((tag) => {
        const key = normalizeTagKey(tag.label);
        if (selectedTagFilterChip && key === activeTagFilterKey) {
          return false;
        }

        return tagFilterQuery.length === 0 || key.includes(tagFilterQuery);
      }),
    [activeTagFilterKey, availableTagFilters, selectedTagFilterChip, tagFilterQuery]
  );
  const activeProject = currentProjectQuery.data ??
    (boardMatch && projectsQuery.data
      ? projectsQuery.data.find(
          (project) => project.ticketPrefix === boardMatch.params.projectTicketPrefix
        ) ?? null
      : null);
  const projectSwitcherLabel = activeProject?.name ?? "All projects";
  const totalTodoCount = useMemo(
    () => (todosQuery.data ?? []).reduce((count, group) => count + group.tasks.length, 0),
    [todosQuery.data]
  );
  const deferredProjectSwitcherInput = useDeferredValue(projectSwitcherInput.trim().toLowerCase());
  const visibleProjects = useMemo(() => {
    const projects = projectsQuery.data ?? [];
    if (!deferredProjectSwitcherInput) {
      return projects;
    }

    return projects.filter((project) =>
      project.name.toLowerCase().includes(deferredProjectSwitcherInput)
    );
  }, [deferredProjectSwitcherInput, projectsQuery.data]);
  const hasProjectInput = projectSwitcherInput.trim().length > 0;
  const isProjectMutationPending =
    createProjectMutation.isPending || renameProjectMutation.isPending || archiveProjectMutation.isPending;

  useDismissableLayer(isMenuOpen, menuRef, () => setIsMenuOpen(false));
  useDismissableLayer(isProjectSwitcherOpen, projectSwitcherRef, () => setIsProjectSwitcherOpen(false));
  useDismissableLayer(isTagFilterOpen, tagFilterRef, () => setIsTagFilterOpen(false));

  useEffect(() => {
    if (isProjectSwitcherOpen) {
      return;
    }

    setProjectSwitcherInput("");
    createProjectMutation.reset();
    renameProjectMutation.reset();
    archiveProjectMutation.reset();
  }, [isProjectSwitcherOpen]);

  useEffect(() => {
    if (isTaskSearchRoute) {
      return;
    }

    setIsTagFilterOpen(false);
  }, [isTaskSearchRoute]);

  useEffect(() => {
    if (authNotice !== "missing-refresh-token") {
      return;
    }

    setToast({
      message:
        "Signed in successfully, but your OIDC provider did not return a refresh token. You'll need to sign in again after this session expires.",
      title: "Session auto-extension unavailable",
      tone: "warning"
    });

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("authNotice");
    setSearchParams(nextParams, { replace: true });
  }, [authNotice, searchParams, setSearchParams]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, toast.tone === "warning" ? 9000 : 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  useEffect(() => {
    let isCancelled = false;

    setGravatarUrl(null);
    setIsGravatarLoaded(false);

    void getGravatarUrl(user.email)
      .then((nextGravatarUrl) => {
        if (isCancelled) {
          return;
        }

        setGravatarUrl(nextGravatarUrl);
      })
      .catch(() => {
        if (isCancelled) {
          return;
        }

        setGravatarUrl(null);
      });

    return () => {
      isCancelled = true;
    };
  }, [user.email]);

  function updateRouteParams(updater: (params: URLSearchParams) => void) {
    const nextParams = new URLSearchParams(searchParams);
    updater(nextParams);
    setSearchParams(nextParams, { replace: true });
  }

  async function lookupTicketAndNavigate(ticketId: string) {
    const requestId = ++navSearchLookupRequestRef.current;

    try {
      const task = await api.getTaskByTicketId(ticketId);
      if (navSearchLookupRequestRef.current !== requestId) {
        return;
      }

      const nextParams = new URLSearchParams();
      nextParams.set("q", task.ticketId);

      startTransition(() => {
        navigate({
          pathname: `/projects/${task.ticketId.split("-")[0]}/${encodeURIComponent(task.ticketId)}`,
          search: `?${nextParams.toString()}`
        });
      });
    } catch {
      if (navSearchLookupRequestRef.current !== requestId) {
        return;
      }
    }
  }

  function updateNavSearch(value: string) {
    const trimmedValue = value.trim();
    updateRouteParams((params) => {
      if (trimmedValue) {
        params.set("q", trimmedValue);
      } else {
        params.delete("q");
      }
    });

    navSearchLookupRequestRef.current += 1;
  }

  function handleNavSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }

    const exactTicketId = parseExactTicketId(event.currentTarget.value);
    if (!exactTicketId) {
      return;
    }

    event.preventDefault();
    void lookupTicketAndNavigate(exactTicketId);
  }

  function openProject(projectTicketPrefix: string) {
    setIsProjectSwitcherOpen(false);
    setProjectSwitcherInput("");
    startTransition(() => {
      navigate(`/projects/${projectTicketPrefix}`);
    });
  }

  function updateTagFilterSearch(draftValue: string) {
    updateRouteParams((params) => {
      const nextValue = formatSingleTagInput(draftValue);
      if (nextValue) {
        params.set("tags", nextValue);
      } else {
        params.delete("tags");
      }
    });
  }

  function removeTagFilter() {
    updateRouteParams((params) => {
      params.delete("tags");
    });

    setIsTagFilterOpen(true);
    window.requestAnimationFrame(() => {
      tagFilterInputRef.current?.focus();
    });
  }

  function selectTagFilter(tag: TaskTag) {
    updateRouteParams((params) => {
      params.set("tags", formatSingleTagInput(tag.label));
    });

    setIsTagFilterOpen(true);
    window.requestAnimationFrame(() => {
      tagFilterInputRef.current?.focus();
    });
  }

  return (
    <div className="app-frame">
      {toast ? (
        <ToastNotice
          message={toast.message}
          onDismiss={() => setToast(null)}
          title={toast.title}
          tone={toast.tone}
        />
      ) : null}
      <div className="app-shell">
        <div className="topbar-shell" data-testid="app-topbar-shell">
          <header className="topbar">
          <div className="topbar__nav">
            <Link className="brand-mark" to="/">
              <span className="brand-mark__pill">BB</span>
              <span className="brand-mark__text">bbtodo</span>
            </Link>
            <nav className="subnav">
              <div className="subnav__cluster subnav__cluster--primary">
                <NavLink className={({ isActive }) => `subnav__link${isActive ? " is-active" : ""}`} to="/todos">
                  TODOs
                </NavLink>
                {todosMatch && !todosQuery.isPending && !todosQuery.error ? (
                  <span className="label-chip label-chip--soft subnav__meta-chip" data-testid="todos-nav-count">
                    {totalTodoCount} todos
                  </span>
                ) : null}
                <NavLink className={({ isActive }) => `subnav__link${isActive ? " is-active" : ""}`} end to="/">
                  Projects
                </NavLink>
                {activeProject || isProjectsRoute ? (
                  <div className="project-switcher" ref={projectSwitcherRef}>
                    <button
                      aria-expanded={isProjectSwitcherOpen}
                      aria-haspopup="dialog"
                      aria-label="Open project switcher"
                      className="subnav__current subnav__current--button"
                      onClick={() => setIsProjectSwitcherOpen((current) => !current)}
                      title={projectSwitcherLabel}
                      type="button"
                    >
                      <span className="subnav__current-copy">
                        <span className="subnav__current-value">{projectSwitcherLabel}</span>
                      </span>
                      <ChevronDownIcon
                        className={`project-switcher__chevron${isProjectSwitcherOpen ? " is-open" : ""}`}
                      />
                    </button>
                    {isProjectSwitcherOpen ? (
                      <div
                        aria-label="Project switcher"
                        className="project-switcher__dropdown"
                        role="dialog"
                      >
                        <label className="project-switcher__field">
                          <input
                            aria-label="Project switcher input"
                            onChange={(event) => setProjectSwitcherInput(event.target.value)}
                            placeholder="Search or enter a project name"
                            value={projectSwitcherInput}
                          />
                        </label>
                        <div className="project-switcher__actions">
                          <button
                            className="project-switcher__quick-action"
                            disabled={!hasProjectInput || isProjectMutationPending}
                            onClick={() => createProjectMutation.mutate(projectSwitcherInput.trim())}
                            type="button"
                          >
                            <span aria-hidden="true" className="project-switcher__quick-mark">
                              +
                            </span>
                            <span>Create Project</span>
                          </button>
                          {activeProject ? (
                            <>
                              <button
                                className="project-switcher__quick-action project-switcher__quick-action--secondary"
                                disabled={!hasProjectInput || isProjectMutationPending}
                                onClick={() => {
                                  renameProjectMutation.mutate({
                                    name: projectSwitcherInput.trim(),
                                    projectId: activeProject.id
                                  });
                                }}
                                type="button"
                              >
                                <PencilIcon />
                                <span>Rename Project</span>
                              </button>
                              <button
                                aria-label={`${activeProject.archived ? "Unarchive" : "Archive"} board ${activeProject.name}`}
                                className="project-switcher__quick-action project-switcher__quick-action--secondary project-switcher__archive-action"
                                disabled={isProjectMutationPending}
                                onClick={() => archiveProjectMutation.mutate(activeProject)}
                                type="button"
                              >
                                <ArchiveIcon restore={activeProject.archived} />
                                <span>{activeProject.archived ? "Unarchive Project" : "Archive Project"}</span>
                              </button>
                            </>
                          ) : null}
                        </div>
                        {projectsQuery.error ? <ErrorBanner error={projectsQuery.error} /> : null}
                        {createProjectMutation.error ? <ErrorBanner error={createProjectMutation.error} /> : null}
                        {renameProjectMutation.error ? <ErrorBanner error={renameProjectMutation.error} /> : null}
                        {archiveProjectMutation.error ? <ErrorBanner error={archiveProjectMutation.error} /> : null}
                        <div className="project-switcher__list">
                          {projectsQuery.isPending ? (
                            <p className="project-switcher__empty">Loading projects...</p>
                          ) : visibleProjects.length > 0 ? (
                            visibleProjects.map((project) => (
                              <button
                                aria-current={project.id === activeProject?.id ? "page" : undefined}
                                aria-label={`Open project ${project.name}`}
                                className={`project-switcher__item${project.id === activeProject?.id ? " is-active" : ""}`}
                                key={project.id}
                                onClick={() => openProject(project.ticketPrefix)}
                                type="button"
                              >
                                <span className="project-switcher__item-name">{project.name}</span>
                                {project.id === activeProject?.id ? (
                                  <span className="project-switcher__item-meta">Current</span>
                                ) : null}
                              </button>
                            ))
                          ) : (
                            <p className="project-switcher__empty">No projects match that input yet.</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {showNavSearch ? (
                <div className="subnav__cluster subnav__cluster--tools">
                  <label className="subnav__search">
                    <input
                      aria-label={navSearchLabel}
                      onChange={(event) => updateNavSearch(event.target.value)}
                      onKeyDown={handleNavSearchKeyDown}
                      placeholder={navSearchLabel}
                      type="search"
                      value={navSearch}
                    />
                  </label>
                  {isTaskSearchRoute ? (
                    <div className="subnav__search subnav__search--tag-filter" ref={tagFilterRef}>
                      <div
                        className={`subnav__search-combo${isTagFilterOpen ? " is-open" : ""}`}
                        onClick={() => {
                          setIsTagFilterOpen(true);
                          tagFilterInputRef.current?.focus();
                        }}
                        role="presentation"
                      >
                        <div className="subnav__tag-filter-field">
                          {selectedTagFilterChip ? (
                            <span
                              className="subnav__tag-filter-chip"
                              key={selectedTagFilterChip.label}
                              style={getTaskTagStyle(selectedTagFilterChip.color)}
                            >
                              <span aria-hidden="true" className="subnav__tag-filter-chip-swatch" />
                              <span className="subnav__tag-filter-chip-label">{selectedTagFilterChip.label}</span>
                              <button
                                aria-label={`Remove tag filter ${selectedTagFilterChip.label}`}
                                className="subnav__tag-filter-chip-remove"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeTagFilter();
                                }}
                                type="button"
                              >
                                <CloseIcon />
                              </button>
                            </span>
                          ) : null}
                        <input
                          aria-controls="tag-filter-dropdown"
                          aria-expanded={isTagFilterOpen}
                          aria-label="Filter by tags"
                          className={`subnav__tag-filter-input${selectedTagFilterChip && tagFilterInputValue.length === 0 ? " is-collapsed" : ""}`}
                          onChange={(event) => {
                            setIsTagFilterOpen(true);
                            updateTagFilterSearch(event.target.value);
                          }}
                          onFocus={() => setIsTagFilterOpen(true)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                              event.preventDefault();
                              setIsTagFilterOpen(true);
                            }

                            if (event.key === "Escape") {
                              setIsTagFilterOpen(false);
                            }

                            if (
                              (event.key === "Backspace" || event.key === "Delete") &&
                              tagFilterInputValue.length === 0 &&
                              selectedTagFilterChip
                            ) {
                              event.preventDefault();
                              removeTagFilter();
                            }
                          }}
                          placeholder={selectedTagFilterChip ? "" : "tag"}
                          ref={tagFilterInputRef}
                          type="search"
                          value={tagFilterInputValue}
                        />
                        </div>
                        <button
                          aria-expanded={isTagFilterOpen}
                          aria-label="Show tag filter suggestions"
                          className="subnav__search-toggle"
                          onClick={(event) => {
                            event.stopPropagation();
                            setIsTagFilterOpen((current) => !current);
                            tagFilterInputRef.current?.focus();
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          type="button"
                        >
                          <ChevronDownIcon className={`project-switcher__chevron${isTagFilterOpen ? " is-open" : ""}`} />
                        </button>
                      </div>
                      {isTagFilterOpen ? (
                        <div
                          aria-label="Available tag filters"
                          className="subnav__search-dropdown"
                          id="tag-filter-dropdown"
                          role="list"
                        >
                          {taskTagsQuery.error ? <ErrorBanner error={taskTagsQuery.error} /> : null}
                          {!taskTagsQuery.error ? (
                            taskTagsQuery.isPending ? (
                              <p className="subnav__search-empty">Loading tags...</p>
                            ) : visibleTagFilterOptions.length > 0 ? (
                              <div className="subnav__tag-option-list">
                                {visibleTagFilterOptions.map((tag) => (
                                  <button
                                    aria-label={`Add tag filter ${tag.label}`}
                                    className="subnav__tag-option"
                                    key={tag.label}
                                    onClick={() => selectTagFilter(tag)}
                                    style={getTaskTagStyle(tag.color)}
                                    type="button"
                                  >
                                    <span aria-hidden="true" className="subnav__tag-option-swatch" />
                                    <span>{tag.label}</span>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="subnav__search-empty">
                                {availableTagFilters.length === 0
                                  ? "No reusable tags yet."
                                  : "No tags match that input."}
                              </p>
                            )
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </nav>
          </div>

          <div className="topbar__meta">
            <div className="avatar-menu" ref={menuRef}>
              <button
                aria-expanded={isMenuOpen}
                aria-haspopup="menu"
                aria-label="Open account menu"
                className="avatar-button"
                onClick={() => setIsMenuOpen((current) => !current)}
                type="button"
              >
                {gravatarUrl ? (
                  <img
                    alt=""
                    aria-hidden="true"
                    className={`avatar-button__image${showGravatarImage ? " is-visible" : ""}`}
                    decoding="async"
                    onError={() => {
                      setGravatarUrl(null);
                      setIsGravatarLoaded(false);
                    }}
                    onLoad={() => setIsGravatarLoaded(true)}
                    referrerPolicy="no-referrer"
                    src={gravatarUrl}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={`avatar-button__letter${showGravatarImage ? " is-hidden" : ""}`}
                >
                  {avatarLetter}
                </span>
              </button>
              {isMenuOpen ? (
                <div className="avatar-dropdown" role="menu">
                  <div className="menu-section">
                    <p className="menu-section__label">Theme</p>
                    <div className="theme-picker" role="group" aria-label="Theme switcher">
                      {themeOptions.map((themeOption) => (
                        <button
                          aria-pressed={user.theme === themeOption.id}
                          className={`theme-option${user.theme === themeOption.id ? " is-active" : ""}`}
                          disabled={themeMutation.isPending}
                          key={themeOption.id}
                          onClick={() => themeMutation.mutate(themeOption.id)}
                          type="button"
                        >
                          <span className={`theme-option__swatch theme-option__swatch--${themeOption.id}`} />
                          <span className="theme-option__copy">
                            <strong>{themeOption.label}</strong>
                          </span>
                        </button>
                      ))}
                    </div>
                    {themeMutation.error ? <ErrorBanner error={themeMutation.error} /> : null}
                  </div>
                  <Link
                    className="menu-item"
                    onClick={() => setIsMenuOpen(false)}
                    role="menuitem"
                    to="/settings/api-tokens"
                  >
                    API tokens
                  </Link>
                  <button
                    className="menu-item danger-button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      logoutMutation.mutate();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {logoutMutation.isPending ? "Signing out..." : "Sign out"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          </header>
        </div>

        <div className="shell-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
