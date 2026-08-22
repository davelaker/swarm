/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useCallback, useId, useRef } from 'react';
import type { SwarmBranch, BranchCommit } from '../../types';
import { IconTrash } from '../common/icons';
import { useProjectClient } from '../../project/ProjectClientContext';
import type { ProjectClient } from '../../project/projectClient';

const DEFAULT_VISIBLE_MERGED_BRANCHES = 25;
type BranchStatusFilter = 'all' | 'open' | 'merged' | 'current';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso) {
    return '';
  }
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) {
    return 'just now';
  }
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  if (d < 30) {
    return `${d}d ago`;
  }
  return new Date(iso).toLocaleDateString();
}

function branchActivityTimestamp(branch: SwarmBranch): number {
  const stamp = Date.parse(branch.lastCommit.date);
  if (Number.isNaN(stamp)) {
    return 0;
  }
  return stamp;
}

export function sortBranchesByActivity(branches: SwarmBranch[]): SwarmBranch[] {
  return [...branches].sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }
    const byActivity = branchActivityTimestamp(right) - branchActivityTimestamp(left);
    if (byActivity !== 0) {
      return byActivity;
    }
    return left.shortName.localeCompare(right.shortName);
  });
}

function matchesBranchStatus(branch: SwarmBranch, status: BranchStatusFilter): boolean {
  if (status === 'current') {
    return branch.isCurrent;
  }
  if (status === 'open') {
    return !branch.merged;
  }
  if (status === 'merged') {
    return branch.merged;
  }
  return true;
}

function matchesBranchSearch(branch: SwarmBranch, search: string): boolean {
  if (!search) {
    return true;
  }
  const needle = search.toLowerCase();
  const prTitle = branch.pr?.title?.toLowerCase() ?? '';
  const prNumber = branch.pr ? String(branch.pr.number) : '';
  return [
    branch.name.toLowerCase(),
    branch.shortName.toLowerCase(),
    branch.lastCommit.message.toLowerCase(),
    branch.lastCommit.hash.toLowerCase(),
    prTitle,
    prNumber,
  ].some(field => field.includes(needle));
}

export function filterBranches(
  branches: SwarmBranch[],
  search: string,
  status: BranchStatusFilter,
): SwarmBranch[] {
  const normalizedSearch = search.trim().toLowerCase();
  return sortBranchesByActivity(branches).filter(branch => {
    return matchesBranchStatus(branch, status) && matchesBranchSearch(branch, normalizedSearch);
  });
}

export function projectBranchSections(
  branches: SwarmBranch[],
  search: string,
  status: BranchStatusFilter,
  mergedExpanded: boolean,
  mergedVisibleCount = DEFAULT_VISIBLE_MERGED_BRANCHES,
) {
  const filtered = filterBranches(branches, search, status);
  const openBranches = filtered.filter(branch => !branch.merged);
  const mergedBranches = filtered.filter(branch => branch.merged);
  const hasActiveFilters = search.trim().length > 0 || status !== 'all';
  const showMergedBranches = hasActiveFilters || mergedExpanded;
  const visibleMergedBranches = showMergedBranches
    ? mergedBranches.slice(0, mergedVisibleCount)
    : [];
  const hiddenMergedCount = showMergedBranches
    ? Math.max(mergedBranches.length - visibleMergedBranches.length, 0)
    : mergedBranches.length;

  return {
    openBranches,
    mergedBranches,
    visibleMergedBranches,
    hiddenMergedCount,
    hasActiveFilters,
    showMergedBranches,
  };
}

export function collectMergedDeletableBranches(branches: SwarmBranch[]): SwarmBranch[] {
  return sortBranchesByActivity(branches).filter(branch => {
    return branch.merged && !branch.isCurrent;
  });
}

// ─── Delete confirmation ───────────────────────────────────────────────────────
// The consequences of deleting a swarm branch depend entirely on where its commits
// live, so spell that out per scenario before the destructive action.

const TONE = {
  safe: {
    color: 'var(--green)',
    bg: 'var(--green-d)',
    border: 'rgba(52,207,138,0.25)',
    label: 'Safe to delete',
  },
  recoverable: {
    color: 'var(--amber)',
    bg: 'var(--amber-d)',
    border: 'rgba(245,160,55,0.3)',
    label: 'Recoverable from GitHub',
  },
  danger: {
    color: 'var(--red)',
    bg: 'var(--red-d)',
    border: 'rgba(240,90,82,0.3)',
    label: 'Permanent — lost forever',
  },
} as const;

function deleteScenario(
  branch: SwarmBranch,
  defaultBranch: string,
): { tone: keyof typeof TONE; lines: string[] } {
  if (branch.merged) {
    return {
      tone: 'safe',
      lines: [
        `Merged into ${defaultBranch} — its commits already live there. Deleting only removes the local branch.`,
      ],
    };
  }
  if (branch.pushed) {
    return {
      tone: 'recoverable',
      lines: [
        `Not merged into ${defaultBranch}, but pushed to origin/${branch.shortName}.`,
        `Its commits remain on GitHub and can be restored — only the local branch goes away.`,
      ],
    };
  }
  const n = branch.ahead;
  return {
    tone: 'danger',
    lines: [
      `Never pushed to GitHub and not merged into ${defaultBranch}.`,
      `Its ${n} commit${n === 1 ? '' : 's'} exist${n === 1 ? 's' : ''} only here and will be lost forever. This cannot be undone.`,
    ],
  };
}

function DeleteBranchDialog({
  branch,
  defaultBranch,
  projectClient,
  onClose,
  onDeleted,
}: {
  branch: SwarmBranch;
  defaultBranch: string;
  projectClient: ProjectClient;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scn = deleteScenario(branch, defaultBranch);
  const tone = TONE[scn.tone];

  const confirm = () => {
    setBusy(true);
    setError(null);
    projectClient
      .fetchResponse('/branches/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch: branch.name }),
      })
      .then(async r => {
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || `${r.status}`);
        }
      })
      .then(() => {
        onDeleted();
        onClose();
      })
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };

  const btnBase = {
    fontSize: 12,
    fontFamily: 'var(--mono)',
    padding: '7px 14px',
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'transparent',
    cursor: busy ? 'default' : 'pointer',
  } as const;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '90vw',
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--tx-1)' }}>
          Delete <span style={{ fontFamily: 'var(--mono)' }}>⎇ {branch.shortName}</span>?
        </div>
        <div
          style={{
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            borderRadius: 8,
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: tone.color,
            }}
          >
            {tone.label}
          </div>
          {scn.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--tx-2)' }}>
              {l}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--tx-3)' }}>
          Runs <code style={{ fontFamily: 'var(--mono)' }}>git branch -D {branch.name}</code>{' '}
          locally — the remote is not touched.
        </div>
        {error && (
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--red)' }}>
            ⚠ {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={{ ...btnBase, color: 'var(--tx-2)' }}>
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{
              ...btnBase,
              color: '#fff',
              background: 'var(--red)',
              borderColor: 'var(--red)',
            }}
          >
            {busy ? 'Deleting…' : 'Delete branch'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Bulk delete (all merged) ─────────────────────────────────────────────────

function DeleteMergedDialog({
  branches,
  projectClient,
  onClose,
  onDone,
}: {
  branches: SwarmBranch[]; // merged, already excluding the current branch
  projectClient: ProjectClient;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const confirm = async () => {
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    // Sequential — keeps the load light and any error message attributable.
    for (const b of branches) {
      try {
        const r = await projectClient.fetchResponse('/branches/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ branch: b.name }),
        });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          failed.push(`${b.shortName}: ${d.error || r.status}`);
        }
      } catch (e) {
        failed.push(`${b.shortName}: ${(e as Error).message}`);
      }
    }
    onDone();
    if (failed.length) {
      setErrors(failed);
      setBusy(false);
    } else {
      onClose();
    }
  };

  const btnBase = {
    fontSize: 12,
    fontFamily: 'var(--mono)',
    padding: '7px 14px',
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'transparent',
    cursor: busy ? 'default' : 'pointer',
  } as const;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: '90vw',
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--tx-1)' }}>
          Delete all {branches.length} merged branch{branches.length !== 1 ? 'es' : ''}?
        </div>
        <div
          style={{
            background: TONE.safe.bg,
            border: `1px solid ${TONE.safe.border}`,
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--tx-2)',
          }}
        >
          These are all merged across this project. Their commits already live in the default
          branch, so deleting only removes the local branches. Nothing is lost.
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            maxHeight: 160,
            overflowY: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--tx-2)',
          }}
        >
          {branches.map(b => (
            <div key={b.name}>⎇ {b.shortName}</div>
          ))}
        </div>
        {errors.length > 0 && (
          <div style={{ fontSize: 11.5, fontFamily: 'var(--mono)', color: 'var(--red)' }}>
            {errors.map((e, i) => (
              <div key={i}>⚠ {e}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={{ ...btnBase, color: 'var(--tx-2)' }}>
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{
              ...btnBase,
              color: '#fff',
              background: 'var(--red)',
              borderColor: 'var(--red)',
            }}
          >
            {busy ? 'Deleting…' : `Delete ${branches.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function BranchStatus({ branch }: { branch: SwarmBranch }) {
  if (branch.isCurrent) {
    return <span className="vchip complete">CURRENT</span>;
  }
  if (branch.merged) {
    return <span className="vchip pass">MERGED</span>;
  }
  return <span className="vchip changes">OPEN</span>;
}

// ─── PR chip ─────────────────────────────────────────────────────────────────

function PrChip({ pr }: { pr: SwarmBranch['pr'] }) {
  if (!pr) {
    return null;
  }
  const cls = pr.state === 'merged' ? 'pass' : pr.state === 'open' ? 'changes' : 'fail';
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`vchip ${cls}`}
      style={{ textDecoration: 'none', cursor: 'pointer' }}
      title={pr.title}
    >
      PR #{pr.number} {pr.state.toUpperCase()} ↗
    </a>
  );
}

// ─── Commit row ───────────────────────────────────────────────────────────────

function CommitRow({
  commit,
  repoUrl,
  pushed,
}: {
  commit: BranchCommit;
  repoUrl: string | null;
  pushed: boolean;
}) {
  const msg = commit.message.length > 80 ? commit.message.slice(0, 77) + '…' : commit.message;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        padding: '5px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {repoUrl && pushed ? (
        <a
          href={`${repoUrl}/commit/${commit.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            flexShrink: 0,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--blue)',
            textDecoration: 'none',
          }}
          title={commit.hash}
          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
        >
          {commit.shortHash}
        </a>
      ) : (
        <span
          style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--tx-3)' }}
        >
          {commit.shortHash}
        </span>
      )}
      <span style={{ flex: 1, fontSize: 12, color: 'var(--tx-2)', fontFamily: 'var(--mono)' }}>
        {msg}
      </span>
      <span
        style={{ flexShrink: 0, fontSize: 11, color: 'var(--tx-3)', fontFamily: 'var(--mono)' }}
      >
        {timeAgo(commit.date)}
      </span>
    </div>
  );
}

function BranchOverflowMenu({ branch, onDelete }: { branch: SwarmBranch; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="branch-row-menu" onClick={event => event.stopPropagation()}>
      <button
        type="button"
        className="branch-row-menu-trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Actions for branch ${branch.shortName}`}
        onClick={() => setOpen(current => !current)}
      >
        Actions ▾
      </button>
      {open && (
        <div
          id={panelId}
          className="branch-row-menu-popover"
          aria-label={`Actions for ${branch.shortName}`}
        >
          <button
            type="button"
            className="branch-row-menu-item danger"
            aria-label={`Delete branch ${branch.shortName}`}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <IconTrash />
            Delete branch
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Branch card ─────────────────────────────────────────────────────────────

function BranchCard({
  branch,
  repoUrl,
  defaultBranch,
  projectClient,
  onDeleted,
}: {
  branch: SwarmBranch;
  repoUrl: string | null;
  defaultBranch: string;
  projectClient: ProjectClient;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState<BranchCommit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commitMsg =
    branch.lastCommit.message.length > 90
      ? branch.lastCommit.message.slice(0, 87) + '…'
      : branch.lastCommit.message;

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (commits !== null) {
      return;
    }
    setLoading(true);
    projectClient
      .fetchJson<{ commits: BranchCommit[] }>(
        `/branches/commits?branch=${encodeURIComponent(branch.name)}`,
        { allowMissingEnvelope: true },
      )
      .then((d: { commits: BranchCommit[] }) => {
        if (!projectClient.isStale()) {
          setCommits(d.commits);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const githubBranchUrl = repoUrl && branch.pushed ? `${repoUrl}/tree/${branch.name}` : null;

  const canExpand = branch.ahead > 0;

  return (
    <>
      {confirmDelete && (
        <DeleteBranchDialog
          branch={branch}
          defaultBranch={defaultBranch}
          projectClient={projectClient}
          onClose={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
      <div
        style={{
          background: 'var(--bg-1)',
          border: `1px solid ${branch.isCurrent ? 'var(--blue)' : 'var(--border)'}`,
          borderRadius: 'var(--r-lg)',
          overflow: 'visible',
          opacity: branch.merged && !branch.isCurrent ? 0.7 : 1,
        }}
      >
        {/* Summary row — clickable to expand */}
        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            cursor: canExpand ? 'pointer' : 'default',
          }}
          onClick={canExpand ? toggle : undefined}
        >
          {/* Row 1: name + chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                fontWeight: 600,
                color: branch.isCurrent ? 'var(--blue)' : 'var(--tx-1)',
              }}
            >
              ⎇ {branch.shortName}
            </span>
            <BranchStatus branch={branch} />
            <PrChip pr={branch.pr} />
            {githubBranchUrl && (
              <a
                href={githubBranchUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--tx-3)',
                  textDecoration: 'none',
                }}
                title="View branch on GitHub"
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--tx-1)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-3)')}
              >
                ↗ GitHub
              </a>
            )}
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--tx-3)',
              }}
            >
              {timeAgo(branch.lastCommit.date)}
            </span>
            {branch.ahead > 0 && !branch.merged && (
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--tx-3)',
                }}
              >
                {branch.ahead} commit{branch.ahead !== 1 ? 's' : ''}
              </span>
            )}
            {canExpand && (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--tx-3)',
                  userSelect: 'none',
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                  transition: 'transform 0.15s',
                }}
              >
                ▶
              </span>
            )}
            {!branch.isCurrent && (
              <BranchOverflowMenu branch={branch} onDelete={() => setConfirmDelete(true)} />
            )}
          </div>

          {/* Row 2: last commit message */}
          {commitMsg && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--tx-2)',
                fontFamily: 'var(--mono)',
                paddingLeft: 18,
              }}
            >
              {branch.lastCommit.hash && (
                <span style={{ color: 'var(--tx-3)', marginRight: 8 }}>
                  {branch.lastCommit.hash}
                </span>
              )}
              {commitMsg}
            </div>
          )}
        </div>

        {/* Expandable commit list */}
        {expanded && (
          <div
            style={{
              borderTop: '1px solid var(--border)',
              padding: '10px 18px 14px',
              background: 'var(--bg)',
            }}
          >
            {loading && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tx-3)',
                  fontFamily: 'var(--mono)',
                  padding: '8px 0',
                }}
              >
                Loading commits…
              </div>
            )}
            {error && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--red)',
                  fontFamily: 'var(--mono)',
                  padding: '8px 0',
                }}
              >
                ⚠ {error}
              </div>
            )}
            {commits !== null && commits.length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tx-3)',
                  fontFamily: 'var(--mono)',
                  padding: '8px 0',
                }}
              >
                No commits ahead of default branch.
              </div>
            )}
            {commits !== null && commits.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {commits.map(c => (
                  <CommitRow key={c.hash} commit={c} repoUrl={repoUrl} pushed={branch.pushed} />
                ))}
                {!branch.pushed && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--tx-3)',
                      fontFamily: 'var(--mono)',
                      marginTop: 10,
                      fontStyle: 'italic',
                    }}
                  >
                    Branch not yet pushed to remote — commit links unavailable
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        height: '100%',
        padding: 40,
        color: 'var(--tx-3)',
      }}
    >
      <span style={{ fontSize: 32 }}>⎇</span>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tx-2)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        No swarm branches yet
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--tx-3)',
          maxWidth: 320,
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        Branches are created automatically when you run a task with branch mode enabled. Complete a
        run to see it here.
      </div>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function Branches() {
  const projectClient = useProjectClient();
  const [branches, setBranches] = useState<SwarmBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<BranchStatusFilter>('all');
  const [mergedExpanded, setMergedExpanded] = useState(false);
  const [mergedVisibleCount, setMergedVisibleCount] = useState(DEFAULT_VISIBLE_MERGED_BRANCHES);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    projectClient
      .fetchJson<{ branches: SwarmBranch[]; defaultBranch: string; repoUrl?: string | null }>(
        '/branches',
        { allowMissingEnvelope: true },
      )
      .then((d: { branches: SwarmBranch[]; defaultBranch: string; repoUrl?: string | null }) => {
        if (!projectClient.isStale()) {
          setBranches(d.branches);
          setDefaultBranch(d.defaultBranch);
          if (d.repoUrl !== undefined) {
            setRepoUrl(d.repoUrl ?? null);
          }
          setLastFetched(Date.now());
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectClient]);

  // Load on mount and refresh every 30s
  useEffect(() => {
    const id = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const {
    openBranches,
    mergedBranches,
    visibleMergedBranches,
    hiddenMergedCount,
    hasActiveFilters,
    showMergedBranches,
  } = projectBranchSections(branches, search, status, mergedExpanded, mergedVisibleCount);

  const mergedDeletable = collectMergedDeletableBranches(branches);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const hasResults = openBranches.length > 0 || mergedBranches.length > 0;
  const showMergedToggle = mergedBranches.length > 0 && !hasActiveFilters;
  const mergedSummaryLabel = hasActiveFilters
    ? `Merged matches — ${mergedBranches.length}`
    : `Merged — ${mergedBranches.length}`;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}
    >
      {/* Header */}
      <div className="panel-head" style={{ padding: '0 20px', flexShrink: 0 }}>
        <span>Branches</span>
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--tx-3)',
            textTransform: 'none',
            letterSpacing: 0,
            marginLeft: 8,
          }}
        >
          vs <code style={{ fontFamily: 'var(--mono)' }}>{defaultBranch}</code>
        </span>
        <span className="spacer" />
        {lastFetched && (
          <span
            style={{
              fontSize: 11,
              fontFamily: 'var(--mono)',
              color: 'var(--tx-3)',
              marginRight: 10,
            }}
          >
            {timeAgo(new Date(lastFetched).toISOString())}
          </span>
        )}
        <button
          onClick={load}
          disabled={loading}
          style={{
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: loading ? 'var(--tx-3)' : 'var(--blue)',
            background: 'none',
            border: 'none',
            cursor: loading ? 'default' : 'pointer',
            padding: '0 4px',
          }}
        >
          {loading ? 'refreshing…' : '↺ refresh'}
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {error && (
          <div
            style={{
              fontSize: 12,
              fontFamily: 'var(--mono)',
              color: 'var(--red)',
              background: 'var(--red-d)',
              border: '1px solid rgba(240,90,82,0.25)',
              borderRadius: 8,
              padding: '10px 14px',
            }}
          >
            ⚠ {error}
          </div>
        )}

        {!loading && !error && branches.length === 0 && <EmptyState />}

        {!error && branches.length > 0 && (
          <section className="branches-toolbar" aria-label="Branch filters">
            <label className="search" style={{ marginLeft: 0, minWidth: 0, flex: '1 1 260px' }}>
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={search}
                onChange={event => {
                  setSearch(event.target.value);
                  setMergedVisibleCount(DEFAULT_VISIBLE_MERGED_BRANCHES);
                }}
                placeholder="Search branch, commit, or PR"
                aria-label="Search branches"
              />
            </label>
            <label className="branches-filter">
              <span>Status</span>
              <select
                value={status}
                onChange={event => {
                  setStatus(event.target.value as BranchStatusFilter);
                  setMergedVisibleCount(DEFAULT_VISIBLE_MERGED_BRANCHES);
                }}
              >
                <option value="all">All branches</option>
                <option value="open">Open only</option>
                <option value="merged">Merged only</option>
                <option value="current">Current branch</option>
              </select>
            </label>
            {(search || status !== 'all') && (
              <button
                type="button"
                className="branches-clear-filters"
                onClick={() => {
                  setSearch('');
                  setStatus('all');
                  setMergedVisibleCount(DEFAULT_VISIBLE_MERGED_BRANCHES);
                }}
              >
                Clear
              </button>
            )}
          </section>
        )}

        {!loading && !error && branches.length > 0 && !hasResults && (
          <div className="branches-empty-results" role="status">
            No branches match the current filters.
          </div>
        )}

        {openBranches.length > 0 && (
          <section>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--tx-3)',
                marginBottom: 10,
              }}
            >
              Open — {openBranches.length}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {openBranches.map(b => (
                <BranchCard
                  key={b.name}
                  branch={b}
                  repoUrl={repoUrl}
                  defaultBranch={defaultBranch}
                  projectClient={projectClient}
                  onDeleted={load}
                />
              ))}
            </div>
          </section>
        )}

        {mergedBranches.length > 0 && (
          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 10,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                className="branches-section-toggle"
                onClick={() => {
                  if (hasActiveFilters) {
                    return;
                  }
                  setMergedExpanded(current => !current);
                }}
                aria-expanded={showMergedBranches}
                disabled={hasActiveFilters}
              >
                {showMergedToggle ? (showMergedBranches ? '▾' : '▸') : '•'} {mergedSummaryLabel}
              </button>
              {showMergedToggle && hiddenMergedCount > 0 && (
                <span className="branches-section-meta">{hiddenMergedCount} hidden</span>
              )}
              {hasActiveFilters && (
                <span className="branches-section-meta">Showing filtered matches</span>
              )}
              <span style={{ flex: 1 }} />
              {mergedDeletable.length > 0 && (
                <button
                  onClick={() => setShowBulkDelete(true)}
                  title={`Delete all ${mergedDeletable.length} merged branch${mergedDeletable.length !== 1 ? 'es' : ''} in this project (safe — already merged)`}
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--mono)',
                    color: 'var(--tx-2)',
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '3px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Delete all merged ({mergedDeletable.length})
                </button>
              )}
            </div>
            {showMergedBranches && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visibleMergedBranches.map(b => (
                  <BranchCard
                    key={b.name}
                    branch={b}
                    repoUrl={repoUrl}
                    defaultBranch={defaultBranch}
                    projectClient={projectClient}
                    onDeleted={load}
                  />
                ))}
                {hiddenMergedCount > 0 && (
                  <button
                    type="button"
                    className="branches-show-more"
                    onClick={() =>
                      setMergedVisibleCount(current => current + DEFAULT_VISIBLE_MERGED_BRANCHES)
                    }
                  >
                    Show {Math.min(DEFAULT_VISIBLE_MERGED_BRANCHES, hiddenMergedCount)} more merged
                    branches
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {showBulkDelete && (
        <DeleteMergedDialog
          branches={mergedDeletable}
          projectClient={projectClient}
          onClose={() => setShowBulkDelete(false)}
          onDone={load}
        />
      )}
    </div>
  );
}
