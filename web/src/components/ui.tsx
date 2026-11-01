import type { ReactNode } from "react";

import { defaultLaneLabels } from "../app/constants";
import { getErrorMessage, itemStyle } from "../app/utils";

function SvgIcon({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className ?? "ui-icon"}
      fill="none"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="m6.75 9.75 5.25 5.25 5.25-5.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </SvgIcon>
  );
}

export function CloseIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </SvgIcon>
  );
}

export function ArchiveIcon({ restore = false }: { restore?: boolean }) {
  return (
    <SvgIcon>
      <path
        d="M4 8h16V4H4v4Zm1 0v12h14V8M9 12h6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      {restore ? (
        <path
          d="m10 17 2-2 2 2m-2-2v4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      ) : null}
    </SvgIcon>
  );
}

export function ExpandIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="M8.25 4.75h-3.5v3.5M15.75 4.75h3.5v3.5M8.25 19.25h-3.5v-3.5M15.75 19.25h3.5v-3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m9 9-4.25-4.25M15 9l4.25-4.25M9 15l-4.25 4.25M15 15l4.25 4.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </SvgIcon>
  );
}

export function ContractIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="M7.75 7.75h8.5v8.5h-8.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M9.25 4.75h-1.5A3 3 0 0 0 4.75 7.75v1.5M14.75 4.75h1.5a3 3 0 0 1 3 3v1.5M9.25 19.25h-1.5a3 3 0 0 1-3-3v-1.5M14.75 19.25h1.5a3 3 0 0 0 3-3v-1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </SvgIcon>
  );
}

export function PencilIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="m15.5 5.5 3 3M6 18l2.5-.5L18 8l-3-3-9.5 9.5ZM6 18h12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </SvgIcon>
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="M12 5.25v13.5M5.25 12h13.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </SvgIcon>
  );
}

export function TrashIcon({ className }: { className?: string }) {
  return (
    <SvgIcon className={className}>
      <path
        d="M9.25 5.25V4.5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M5.75 7h12.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="m7.75 7 .55 9.7A1.5 1.5 0 0 0 9.8 18.1h4.4a1.5 1.5 0 0 0 1.5-1.4l.55-9.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M10 10.25v4.5M14 10.25v4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </SvgIcon>
  );
}

export function MetricRibbon({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="metric-ribbon">
      {items.map((item, index) => (
        <div className="metric-pill" key={item.label} style={itemStyle(index)}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  return <p className="error-banner">{getErrorMessage(error)}</p>;
}

export function ToastNotice({
  message,
  onDismiss,
  title,
  tone
}: {
  message: string;
  onDismiss: () => void;
  title: string;
  tone: "danger" | "success" | "warning";
}) {
  return (
    <div aria-live="polite" className="toast-stack">
      <div
        className={`toast-notice toast-notice--${tone}`}
        data-tone={tone}
        data-testid="toast-notice"
        role="status"
      >
        <div className="toast-notice__copy">
          <strong>{title}</strong>
          <p>{message}</p>
        </div>
        <button
          aria-label="Dismiss notification"
          className="icon-button toast-notice__dismiss"
          onClick={onDismiss}
          type="button"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

export function EmptyState({
  eyebrow,
  title,
  copy
}: {
  eyebrow: string;
  title: string;
  copy?: string;
}) {
  return (
    <section className="empty-state">
      <div className="empty-state__copy">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {copy ? <p className="lead-copy">{copy}</p> : null}
      </div>
      <div aria-hidden="true" className="empty-state__art">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

export function ProjectGridSkeleton() {
  return (
    <section aria-hidden="true" className="project-grid">
      {Array.from({ length: 4 }).map((_, index) => (
        <article className="project-card skeleton-card" key={index} style={itemStyle(index)}>
          <div className="skeleton-line skeleton-line--small" />
          <div className="skeleton-line skeleton-line--title" />
          <div className="skeleton-line skeleton-line--body" />
          <div className="skeleton-line skeleton-line--body short" />
          <div className="skeleton-row">
            <div className="skeleton-pill" />
            <div className="skeleton-pill" />
          </div>
        </article>
      ))}
    </section>
  );
}

export function BoardSkeleton() {
  return (
      <section aria-hidden="true" className="board-grid" data-testid="board-grid">
      {defaultLaneLabels.map((laneLabel, index) => (
        <article className="board-column skeleton-column" key={laneLabel} style={itemStyle(index)}>
          <div className="board-column__header">
            <div>
              <div className="skeleton-line skeleton-line--small" />
              <div className="skeleton-line skeleton-line--medium" />
            </div>
            <div className="skeleton-pill" />
          </div>
          <div className="board-column__content">
            {Array.from({ length: 3 }).map((_, cardIndex) => (
              <div className="task-card skeleton-card skeleton-card--compact" key={cardIndex}>
                <div className="skeleton-line skeleton-line--small" />
                <div className="skeleton-line skeleton-line--body" />
                <div className="skeleton-line skeleton-line--body short" />
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

export function TokenListSkeleton() {
  return (
    <section aria-hidden="true" className="token-list">
      {Array.from({ length: 3 }).map((_, index) => (
        <div className="token-row token-row--skeleton" key={index}>
          <div className="token-row__copy">
            <div className="skeleton-line skeleton-line--medium" />
            <div className="skeleton-line skeleton-line--body short" />
          </div>
          <div className="skeleton-pill" />
        </div>
      ))}
    </section>
  );
}

export function LoadingState() {
  return (
    <main className="loading-shell">
      <div className="loading-shell__inner">
        <section className="surface-strip loading-strip">
          <div className="loading-strip__copy">
            <div className="skeleton-line skeleton-line--small" />
            <div className="skeleton-line skeleton-line--medium" />
            <div className="skeleton-line skeleton-line--body short" />
          </div>
          <div className="loading-strip__meta">
            <div className="skeleton-pill" />
            <div className="skeleton-pill" />
            <div className="skeleton-pill" />
          </div>
        </section>
        <BoardSkeleton />
      </div>
    </main>
  );
}
