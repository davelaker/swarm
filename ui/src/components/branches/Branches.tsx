import { useState, useEffect, useCallback } from 'react';
import type { SwarmBranch, BranchCommit } from '../../types';
import { IconTrash } from '../common/icons';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
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
  onClose,
  onDeleted,
}: {
  branch: SwarmBranch;
  defaultBranch: string;
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
    fetch('/branches/delete', {
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

// ─── Status chip ──────────────────────────────────────────────────────────────

function BranchStatus({ branch }: { branch: SwarmBranch }) {
  if (branch.isCurrent) return <span className="vchip complete">CURRENT</span>;
  if (branch.merged) return <span className="vchip pass">MERGED</span>;
  return <span className="vchip changes">OPEN</span>;
}

// ─── PR chip ─────────────────────────────────────────────────────────────────

function PrChip({ pr }: { pr: SwarmBranch['pr'] }) {
  if (!pr) return null;
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

// ─── Branch card ─────────────────────────────────────────────────────────────

function BranchCard({
  branch,
  repoUrl,
  defaultBranch,
  onDeleted,
}: {
  branch: SwarmBranch;
  repoUrl: string | null;
  defaultBranch: string;
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
    if (commits !== null) return; // already fetched
    setLoading(true);
    fetch(`/branches/commits?branch=${encodeURIComponent(branch.name)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d: { commits: BranchCommit[] }) => setCommits(d.commits))
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
          onClose={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
      <div
        style={{
          background: 'var(--bg-1)',
          border: `1px solid ${branch.isCurrent ? 'var(--blue)' : 'var(--border)'}`,
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
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
              <button
                onClick={e => {
                  e.stopPropagation();
                  setConfirmDelete(true);
                }}
                title={`Delete branch ${branch.shortName}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'transparent',
                  border: 'none',
                  padding: '2px 4px',
                  marginLeft: 2,
                  cursor: 'pointer',
                  color: 'var(--tx-3)',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-3)')}
              >
                <IconTrash />
              </button>
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
  const [branches, setBranches] = useState<SwarmBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/branches')
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d: { branches: SwarmBranch[]; defaultBranch: string; repoUrl?: string | null }) => {
        setBranches(d.branches);
        setDefaultBranch(d.defaultBranch);
        if (d.repoUrl !== undefined) setRepoUrl(d.repoUrl ?? null);
        setLastFetched(Date.now());
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Load on mount and refresh every 30s
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const open = branches.filter(b => !b.merged);
  const merged = branches.filter(b => b.merged);

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

        {open.length > 0 && (
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
              Open — {open.length}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {open.map(b => (
                <BranchCard
                  key={b.name}
                  branch={b}
                  repoUrl={repoUrl}
                  defaultBranch={defaultBranch}
                  onDeleted={load}
                />
              ))}
            </div>
          </section>
        )}

        {merged.length > 0 && (
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
              Merged — {merged.length}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {merged.map(b => (
                <BranchCard
                  key={b.name}
                  branch={b}
                  repoUrl={repoUrl}
                  defaultBranch={defaultBranch}
                  onDeleted={load}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
