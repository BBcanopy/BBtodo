import {
  type CSSProperties,
  type RefObject,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { api, type Project } from "../api";
import { itemStyle, parseExactTicketId } from "../app/utils";
import {
  EmptyState,
  ErrorBanner,
  ProjectGridSkeleton,
  ToastNotice,
  TrashIcon
} from "../components/ui";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useCreateProjectMutation } from "../hooks/useCreateProjectMutation";

type PageToast = {
  message: string;
  title: string;
  tone: "danger" | "success";
};
type DeleteProjectMutationContext = {
  deletedProject: Project | null;
  previousProjects: [QueryKey, Project[] | undefined][];
};

const projectCardBaseRowSpan = 12;

function getProjectCardRowSpan(element: HTMLElement) {
  const gridElement = element.closest(".project-grid");

  if (!(gridElement instanceof HTMLElement)) {
    return projectCardBaseRowSpan;
  }

  const styles = getComputedStyle(gridElement);
  const rowHeight = Number.parseFloat(styles.gridAutoRows);
  const rowGap = Number.parseFloat(styles.rowGap);

  if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
    return projectCardBaseRowSpan;
  }

  const normalizedRowGap = Number.isFinite(rowGap) ? rowGap : 0;

  return Math.max(
    Math.ceil((element.getBoundingClientRect().height + normalizedRowGap) / (rowHeight + normalizedRowGap)),
    projectCardBaseRowSpan
  );
}

function useProjectCardRowSpan(elementRef: RefObject<HTMLElement | null>, contentKey: string) {
  const [rowSpan, setRowSpan] = useState(projectCardBaseRowSpan);

  useLayoutEffect(() => {
    const element = elementRef.current;

    if (!element) {
      return;
    }

    let frameId = 0;

    const updateRowSpan = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const nextRowSpan = getProjectCardRowSpan(element);
        setRowSpan((currentRowSpan) => (currentRowSpan === nextRowSpan ? currentRowSpan : nextRowSpan));
      });
    };

    updateRowSpan();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateRowSpan();
    });

    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [contentKey, elementRef]);

  return rowSpan;
}

function ProjectCard({
  index,
  isPending,
  onDelete,
  onOpen,
  project
}: {
  index: number;
  isPending: boolean;
  onDelete: (projectId: string) => void;
  onOpen: (projectTicketPrefix: string) => void;
  project: Project;
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const laneSummaryKey = project.laneSummaries.map((lane) => `${lane.id}:${lane.taskCount}`).join("|");
  const rowSpan = useProjectCardRowSpan(cardRef, `${project.name}|${project.archived}|${laneSummaryKey}`);

  useDismissableLayer(isConfirmOpen, confirmRef, () => setIsConfirmOpen(false));

  const cardStyle = {
    ...itemStyle(index),
    "--project-card-row-span": rowSpan
  } as CSSProperties;

  return (
    <article
      className={`project-card${isConfirmOpen ? " is-confirm-open" : ""}`}
      data-testid={`project-card-${project.id}`}
      onClick={() => onOpen(project.ticketPrefix)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(project.ticketPrefix);
        }
      }}
      role="link"
      ref={cardRef}
      style={cardStyle}
      tabIndex={0}
    >
      <div className="project-card__surface">
        <div className="project-card__meta">
          <div className="project-card__delete-menu" ref={confirmRef}>
            <button
              aria-expanded={isConfirmOpen}
              aria-label={`Delete board ${project.name}`}
              className="icon-button danger-button"
              disabled={isPending}
              onClick={(event) => {
                event.stopPropagation();
                setIsConfirmOpen((current) => !current);
              }}
              type="button"
            >
              <TrashIcon />
            </button>
            {isConfirmOpen ? (
              <div className="task-delete-popover" onClick={(event) => event.stopPropagation()} role="alertdialog">
                <p>Delete this board?</p>
                <div className="task-delete-popover__actions">
                  <button
                    className="text-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setIsConfirmOpen(false);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="ghost-button danger-button"
                    disabled={isPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      setIsConfirmOpen(false);
                      onDelete(project.id);
                    }}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="project-card__body">
          <div className="project-card__headline">
            <h2>{project.name}</h2>
            {project.archived ? <span className="label-chip">Archived</span> : null}
          </div>
          <div aria-label={`Lane counts for ${project.name}`} className="project-card__lane-counts">
            {project.laneSummaries.map((lane) => (
              <div
                aria-label={`${lane.name} ${lane.taskCount}`}
                className="project-card__lane-pill"
                key={lane.id}
              >
                <span>{lane.name}</span>
                <strong>{lane.taskCount}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function ProjectComposerCard({
  draftName,
  error,
  index,
  inputRef,
  isPending,
  onCancel,
  onChange,
  onSubmit
}: {
  draftName: string;
  error: unknown;
  index: number;
  inputRef: RefObject<HTMLInputElement | null>;
  isPending: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const errorKey =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : error
        ? String(error)
        : "ok";
  const rowSpan = useProjectCardRowSpan(cardRef, `${draftName}|${isPending ? "pending" : "idle"}|${errorKey}`);
  const cardStyle = {
    ...itemStyle(index),
    "--project-card-row-span": rowSpan
  } as CSSProperties;

  function stopCardPropagation(event: {
    stopPropagation: () => void;
  }) {
    event.stopPropagation();
  }

  return (
    <article
      className="project-card project-card--composer"
      data-testid="project-card-composer"
      onClick={stopCardPropagation}
      onDoubleClick={stopCardPropagation}
      onPointerDown={stopCardPropagation}
      ref={cardRef}
      style={cardStyle}
    >
      <div className="project-card__surface">
        <form
          className="project-card-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="project-card-composer__copy">
            <p className="project-card-composer__eyebrow">New board</p>
          </div>
          <label className="field">
            <span className="field__label">Board name</span>
            <input
              aria-label="New board name"
              autoFocus
              disabled={isPending}
              maxLength={120}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                }
              }}
              placeholder="Incident response"
              ref={inputRef}
              required
              value={draftName}
            />
          </label>
          {error ? <ErrorBanner error={error} /> : null}
          <div className="project-card-composer__actions">
            <button className="primary-button" disabled={isPending || draftName.trim().length === 0} type="submit">
              {isPending ? "Creating board..." : "Create board"}
            </button>
            <button className="text-button" disabled={isPending} onClick={onCancel} type="button">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}

export function ProjectsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const locationToast = ((location.state as { toast?: PageToast } | null) ?? null)?.toast ?? null;
  const [toast, setToast] = useState<PageToast | null>(locationToast);
  const [composerDraftName, setComposerDraftName] = useState("");
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const showArchived = searchParams.get("showArchived") === "true";
  // Keep the checkbox responsive while React Router commits the URL change.
  const [isArchiveToggleChecked, setIsArchiveToggleChecked] = useState(showArchived);

  useEffect(() => {
    setIsArchiveToggleChecked(showArchived);
  }, [showArchived]);
  const projectsQuery = useQuery({
    queryKey: showArchived ? ["projects", { includeArchived: true }] : ["projects"],
    queryFn: () => api.listProjects(showArchived)
  });
  const projects = projectsQuery.data ?? [];
  const projectSearch = searchParams.get("q")?.trim() ?? "";
  const exactTicketIdSearch = parseExactTicketId(projectSearch);
  const exactTicketPrefixSearch = exactTicketIdSearch?.split("-")[0] ?? null;
  const deferredProjectSearch = useDeferredValue(projectSearch.toLowerCase());
  const visibleProjects = useMemo(() => {
    if (exactTicketPrefixSearch) {
      return projects.filter((project) => project.ticketPrefix === exactTicketPrefixSearch);
    }

    if (!deferredProjectSearch) {
      return projects;
    }

    return projects.filter((project) => {
      const normalizedSearchTarget = `${project.name} ${project.ticketPrefix}`.toLowerCase();
      return normalizedSearchTarget.includes(deferredProjectSearch);
    });
  }, [deferredProjectSearch, exactTicketPrefixSearch, projects]);

  const deleteProjectMutation = useMutation<null, Error, string, DeleteProjectMutationContext>({
    mutationFn: (projectId: string) => api.deleteProject(projectId),
    onMutate: async (projectId) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previousProjects = queryClient.getQueriesData<Project[]>({ queryKey: ["projects"] });
      const deletedProject = previousProjects
        .flatMap(([, projects]) => projects ?? [])
        .find((project) => project.id === projectId) ?? null;

      queryClient.setQueriesData<Project[]>({ queryKey: ["projects"] }, (currentProjects) =>
        currentProjects?.filter((project) => project.id !== projectId)
      );

      return {
        deletedProject,
        previousProjects
      };
    },
    onError: (_error, _projectId, context) => {
      context?.previousProjects.forEach(([key, projects]) => queryClient.setQueryData(key, projects));
    },
    onSuccess: async (_result, _projectId, context) => {
      setToast({
        message: context?.deletedProject ? `Deleted board ${context.deletedProject.name}.` : "Deleted board.",
        title: "Board deleted",
        tone: "success"
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["todos"] })
      ]);
    }
  });
  const createProjectMutation = useCreateProjectMutation({
    onSuccess: async (project) => {
      setComposerDraftName("");
      setIsComposerOpen(false);
      setToast({
        message: `Created board ${project.name}.`,
        title: "Board created",
        tone: "success"
      });
      updateRouteParams((params) => {
        params.delete("q");
      });
    }
  });

  function updateRouteParams(updater: (params: URLSearchParams) => void) {
    const nextParams = new URLSearchParams(searchParams);
    updater(nextParams);
    setSearchParams(nextParams, { replace: true });
  }

  function openComposer() {
    setComposerDraftName("");
    setIsComposerOpen(true);
    createProjectMutation.reset();
  }

  function closeComposer() {
    setComposerDraftName("");
    setIsComposerOpen(false);
    createProjectMutation.reset();
  }

  useEffect(() => {
    if (!locationToast) {
      return;
    }

    setToast(locationToast);
    navigate(
      {
        pathname: location.pathname,
        search: location.search
      },
      { replace: true, state: null }
    );
  }, [location.pathname, location.search, locationToast, navigate]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  useEffect(() => {
    if (!isComposerOpen) {
      return;
    }

    composerInputRef.current?.focus();
  }, [isComposerOpen]);

  return (
    <main className="page-shell page-shell--projects">
      <title>Projects | BBTodo</title>
      {toast ? (
        <ToastNotice
          message={toast.message}
          onDismiss={() => setToast(null)}
          title={toast.title}
          tone={toast.tone}
        />
      ) : null}
      {projectsQuery.error ? <ErrorBanner error={projectsQuery.error} /> : null}
      {deleteProjectMutation.error ? <ErrorBanner error={deleteProjectMutation.error} /> : null}

      <div className="projects-toolbar">
        <label className="projects-archive-toggle">
          <input
            checked={isArchiveToggleChecked}
            onChange={(event) => {
              const checked = event.target.checked;
              setIsArchiveToggleChecked(checked);
              updateRouteParams((params) => {
                if (checked) {
                  params.set("showArchived", "true");
                } else {
                  params.delete("showArchived");
                }
              });
            }}
            type="checkbox"
          />
          Show archived
        </label>
      </div>

      {projectsQuery.isPending ? <ProjectGridSkeleton /> : null}

      {!projectsQuery.isPending && projects.length === 0 ? (
        <EmptyState
          copy={
            showArchived
              ? "Create the first project to open a board with Todo, In Progress, In review, and Done ready to go."
              : "Create a project or enable Show archived to find an archived board."
          }
          eyebrow="Empty workspace"
          title={showArchived ? "No boards yet." : "No active boards."}
        />
      ) : null}

      {!projectsQuery.isPending && projects.length > 0 && visibleProjects.length === 0 ? (
        <EmptyState
          copy="Try a different board name or ticket prefix."
          eyebrow="No matches"
          title={`No boards match "${projectSearch}".`}
        />
      ) : null}

      {!projectsQuery.isPending && visibleProjects.length > 0 ? (
        <section
          className="project-grid"
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }

            openComposer();
          }}
        >
          {visibleProjects.map((project, index) => (
            <ProjectCard
              key={project.id}
              index={index}
              isPending={deleteProjectMutation.isPending}
              onDelete={(projectId) => deleteProjectMutation.mutate(projectId)}
              onOpen={(projectTicketPrefix) => navigate(`/projects/${projectTicketPrefix}`)}
              project={project}
            />
          ))}
          {isComposerOpen ? (
            <ProjectComposerCard
              draftName={composerDraftName}
              error={createProjectMutation.error}
              index={visibleProjects.length}
              inputRef={composerInputRef}
              isPending={createProjectMutation.isPending}
              onCancel={closeComposer}
              onChange={setComposerDraftName}
              onSubmit={() => createProjectMutation.mutate(composerDraftName.trim())}
            />
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
