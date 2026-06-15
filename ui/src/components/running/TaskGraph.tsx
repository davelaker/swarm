import { useRef, useEffect, useState, useCallback } from 'react';
import type { ActivityEntry, Task } from '../../types';
import { resolveAgentPersona } from '../../data/personas';
import { STATUS_COLOR, STATUS_LABEL } from '../../data/runScript';
import { ActivityLog } from '../common/ActivityLog';

const TRUNCATE = 72; // chars shown before "more" toggle appears

// Compact wall-clock for a task card: "8s", "1m04s", "2m".
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${String(rem).padStart(2, '0')}` : `${m}m`;
}

interface Edge {
  from: { x: number; y: number };
  to: { x: number; y: number };
  key: string;
  color: string;
  fromId: string;
  toId: string;
}

// Returns the set of task IDs that should be highlighted when `taskId` is hovered:
// the task itself, its explicit deps, explicit dependents, and one level of inferred
// fix/check chain siblings.
function getConnectedSet(taskId: string, tasks: Task[]): Set<string> {
  const connected = new Set<string>([taskId]);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const hovered = taskById.get(taskId);
  if (!hovered) return connected;

  hovered.deps.forEach(d => connected.add(d));
  tasks.forEach(t => {
    if (t.deps.includes(taskId)) connected.add(t.id);
  });

  // Inferred parent (fix/check naming convention)
  const fixM = taskId.match(/^t_fix_(.+)$/);
  const chkM = taskId.match(/^t_chk_(.+)$/);
  const inferParent = fixM ? fixM[1] : chkM ? `t_fix_${chkM[1]}` : null;
  if (inferParent) connected.add(inferParent);

  // Inferred children of hovered
  tasks.forEach(t => {
    const fm = t.id.match(/^t_fix_(.+)$/);
    const cm = t.id.match(/^t_chk_(.+)$/);
    const p = fm ? fm[1] : cm ? `t_fix_${cm[1]}` : null;
    if (p === taskId) connected.add(t.id);
  });

  return connected;
}

function TaskCard({
  t,
  agentSteps,
  activity,
  durationMs,
  durationLive,
  isHovered,
  runActive,
  onSteer,
}: {
  t: Task;
  agentSteps: Record<string, string>;
  activity: ActivityEntry[];
  durationMs?: number | null;
  durationLive?: boolean;
  isHovered?: boolean;
  runActive?: boolean;
  onSteer?: (taskId: string, note: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [steering, setSteering] = useState(false);
  const [steerDraft, setSteerDraft] = useState('');
  const [steerBusy, setSteerBusy] = useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);
  const p = resolveAgentPersona(t.assignee);
  const color = STATUS_COLOR[t.status];
  const isActive = t.status === 'in_progress';
  const isSkipped = t.status === 'skipped';
  const step = isActive ? agentSteps[t.assignee] : null;
  const needsTruncation = t.title.length > TRUNCATE;
  // Steering is offered during an active run on tasks that aren't skipped.
  const canSteer = !!runActive && !!onSteer && !isSkipped;

  const submitSteer = async () => {
    const note = steerDraft.trim();
    if (!note || !onSteer) {
      return;
    }
    setSteerBusy(true);
    setSteerError(null);
    const r = await onSteer(t.id, note);
    setSteerBusy(false);
    if (r.ok) {
      setSteerDraft('');
      setSteering(false);
    } else {
      setSteerError(r.error ?? 'Could not steer');
    }
  };
  const displayTitle =
    needsTruncation && !expanded ? t.title.slice(0, TRUNCATE).trimEnd() + '…' : t.title;

  return (
    <div
      className="tnode-card"
      style={
        isHovered
          ? {
              borderColor: 'rgba(77,141,244,0.7)',
              boxShadow: '0 0 0 1px rgba(77,141,244,0.18), 0 0 18px -4px rgba(77,141,244,0.35)',
              background: '#0c1420',
            }
          : isSkipped
            ? { opacity: 0.55, borderStyle: 'dashed' }
            : {}
      }
    >
      <div className="tnode-top">
        <span className="tnode-id" style={isSkipped ? { textDecoration: 'line-through' } : {}}>
          {t.id}
        </span>
        <span className="tnode-title" style={isSkipped ? { color: 'var(--tx-3)' } : {}}>
          {displayTitle}
        </span>
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--tx-3)',
            marginTop: 3,
            display: 'block',
          }}
        >
          {expanded ? '▴ less' : '▾ more'}
        </button>
      )}
      <div className="tnode-bottom">
        <span className="tnode-assignee">
          <span className="pdot" style={{ background: isSkipped ? 'var(--tx-3)' : p?.color }} />
          {p?.name}
        </span>
        {durationMs != null && (
          <span
            className="tnode-duration"
            title={durationLive ? 'running…' : 'task duration'}
            style={durationLive ? { color: 'var(--blue)' } : undefined}
          >
            {fmtDuration(durationMs)}
          </span>
        )}
        {canSteer && !steering && (
          <button
            className="tnode-steer-btn"
            onClick={() => setSteering(true)}
            title="Steer this task — add guidance and re-dispatch it"
          >
            ⤳ steer
          </button>
        )}
        <span className="tnode-status" style={{ color }}>
          {STATUS_LABEL[t.status]}
        </span>
      </div>

      {steering && (
        <div className="tnode-steer">
          <textarea
            className="tnode-steer-input"
            autoFocus
            value={steerDraft}
            placeholder={
              isActive
                ? 'Pause the run first, then steer once this task lands…'
                : 'Add guidance — re-runs this task (and its downstream) with your note…'
            }
            rows={2}
            onChange={e => setSteerDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                submitSteer();
              } else if (e.key === 'Escape') {
                setSteering(false);
                setSteerError(null);
              }
            }}
          />
          {steerError && <div className="tnode-steer-error">⚠ {steerError}</div>}
          <div className="tnode-steer-actions">
            <button
              className="tnode-steer-cancel"
              onClick={() => {
                setSteering(false);
                setSteerError(null);
              }}
            >
              Cancel
            </button>
            <button
              className="tnode-steer-send"
              onClick={submitSteer}
              disabled={!steerDraft.trim() || steerBusy}
            >
              {steerBusy ? 'Steering…' : 'Steer ↵'}
            </button>
          </div>
        </div>
      )}
      {isSkipped && t.skip_reason && (
        <div className="tnode-step" style={{ color: 'var(--tx-3)', fontStyle: 'italic' }}>
          {t.skip_reason.replace(/^Skipped: /, '')}
        </div>
      )}
      {step && (
        <div className="tnode-step" style={{ color: p?.color }}>
          {step}
          <span className="cursor" style={{ color: p?.color }} />
        </div>
      )}
      <ActivityLog activity={activity} active={isActive} color={p?.color} />
    </div>
  );
}

// Per-lane dot offset from the rail's left edge (lane 0 always at BASE_OFFSET).
const BASE_OFFSET = 18;
const MAX_LANE_PX = 20; // unconstrained spacing between lanes
const MIN_LANE_PX = 6; // minimum spacing before dots fully merge

function computeRail(scrollW: number, maxLane: number): { railW: number; lanePx: number } {
  if (maxLane === 0) return { railW: 38, lanePx: MAX_LANE_PX };
  // Natural (unconstrained) rail width needed for this lane count
  const natural = BASE_OFFSET + maxLane * MAX_LANE_PX + 10;
  // Cap to 22% of the column's visible width, but never below 32px
  const budget = Math.max(32, Math.round(scrollW * 0.22));
  const railW = Math.min(natural, budget);
  const lanePx = Math.max(MIN_LANE_PX, (railW - BASE_OFFSET) / maxLane);
  return { railW, lanePx };
}

export function TaskGraph({
  tasks,
  agentSteps,
  taskActivity,
  taskTimings = {},
  hoveredTaskId,
  onHoverTask,
  runActive,
  onSteer,
}: {
  tasks: Task[];
  agentSteps: Record<string, string>;
  taskActivity: Record<string, ActivityEntry[]>;
  taskTimings?: Record<string, { startedAt: number; endedAt: number | null }>;
  hoveredTaskId: string | null;
  onHoverTask: (id: string | null) => void;
  runActive?: boolean;
  onSteer?: (taskId: string, note: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  // Tick once a second so the active task's live duration counts up. Idle when no
  // task is running (every timing has an endedAt or none has started).
  const anyRunning = tasks.some(t => t.status === 'in_progress');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [edges, setEdges] = useState<Edge[]>([]);
  const [railW, setRailW] = useState(56);
  const [lanePx, setLanePx] = useState(MAX_LANE_PX);

  const recompute = useCallback(() => {
    // ── Rail geometry (responsive to column width) ───────────────────────────
    const scrollW = scrollRef.current?.clientWidth ?? 0;
    const maxLane = tasks.length > 0 ? Math.max(0, ...tasks.map(t => t.lane)) : 0;
    const { railW: rw, lanePx: lp } = computeRail(scrollW, maxLane);
    setRailW(rw);
    setLanePx(lp);

    // ── Edge positions ───────────────────────────────────────────────────────
    const inner = innerRef.current;
    if (!inner) return;
    const base = inner.getBoundingClientRect();
    const pos: Record<string, { x: number; y: number }> = {};
    tasks.forEach(t => {
      const el = dotRefs.current[t.id];
      if (el) {
        const r = el.getBoundingClientRect();
        pos[t.id] = { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
      }
    });
    const es: Edge[] = [];
    const taskById = new Map(tasks.map(t => [t.id, t]));

    // ── Dep-declared edges ──────────────────────────────────────────────────
    tasks.forEach(t =>
      t.deps.forEach(d => {
        if (!pos[d] || !pos[t.id]) return;
        const parent = taskById.get(d);
        // Edges from a changes-req parent render in amber to show causal origin.
        const color =
          parent?.status === 'blocked'
            ? 'rgba(245,160,55,0.55)'
            : STATUS_COLOR[t.status] === 'var(--grey)'
              ? '#2c323b'
              : 'rgba(255,255,255,0.14)';
        es.push({ from: pos[d], to: pos[t.id], key: `${d}-${t.id}`, color, fromId: d, toId: t.id });
      }),
    );

    // ── Inferred structural edges ───────────────────────────────────────────
    // The PM doesn't always set depends_on on dynamically spawned fix/check
    // tasks, so recover the causal link from the naming convention:
    //   t_fix_X  → parent is X          (created to fix issues raised by X)
    //   t_chk_X  → parent is t_fix_X    (created to verify the fix of X)
    tasks.forEach(t => {
      const fixM = t.id.match(/^t_fix_(.+)$/);
      const chkM = t.id.match(/^t_chk_(.+)$/);
      const inferParentId = fixM ? fixM[1] : chkM ? `t_fix_${chkM[1]}` : null;
      if (!inferParentId) return;
      if (t.deps.includes(inferParentId)) return; // dep edge already covers it
      if (!pos[inferParentId] || !pos[t.id]) return;
      es.push({
        from: pos[inferParentId],
        to: pos[t.id],
        key: `inferred-${inferParentId}-${t.id}`,
        color: 'rgba(245,160,55,0.55)', // amber — always part of a fix chain
        fromId: inferParentId,
        toId: t.id,
      });
    });

    setEdges(es);
  }, [tasks]);

  useEffect(() => {
    const id = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(id);
  }, [recompute]);
  useEffect(() => {
    const ro = new ResizeObserver(recompute);
    if (innerRef.current) ro.observe(innerRef.current);
    if (scrollRef.current) ro.observe(scrollRef.current); // tracks column width changes
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [recompute]);

  // 'blocked' means "changes requested" — the task finished its work and handed off.
  // Count it alongside 'done' so the total reflects what's actually complete.
  const doneCount = tasks.filter(t => t.status === 'done' || t.status === 'blocked').length;
  const failCount = tasks.filter(t => t.status === 'failed').length;
  const skippedCount = tasks.filter(t => t.status === 'skipped').length;
  const countLabel =
    tasks.length === 0
      ? ''
      : [
          `${doneCount}/${tasks.length} done`,
          failCount > 0 ? `${failCount} failed` : '',
          skippedCount > 0 ? `${skippedCount} skipped` : '',
        ]
          .filter(Boolean)
          .join(' · ');

  const connected = hoveredTaskId ? getConnectedSet(hoveredTaskId, tasks) : null;

  return (
    <div className="run-graph">
      <div className="panel-head">
        <span>Task Graph</span>
        <span className="spacer" />
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}
        >
          {countLabel}
        </span>
      </div>
      <div className="graph-scroll" ref={scrollRef}>
        <div className="graph-inner" ref={innerRef} onMouseLeave={() => onHoverTask(null)}>
          <svg className="graph-edges">
            {edges.map(e => {
              const lit = !connected || (connected.has(e.fromId) && connected.has(e.toId));
              const midY = (e.from.y + e.to.y) / 2;
              const d = `M ${e.from.x} ${e.from.y} C ${e.from.x} ${midY}, ${e.to.x} ${midY}, ${e.to.x} ${e.to.y}`;
              return (
                <path
                  key={e.key}
                  d={d}
                  fill="none"
                  stroke={lit ? e.color : 'rgba(255,255,255,0.04)'}
                  strokeWidth={
                    lit && (e.fromId === hoveredTaskId || e.toId === hoveredTaskId) ? 2.5 : 1.5
                  }
                  style={{ transition: 'stroke 0.15s, stroke-width 0.15s' }}
                />
              );
            })}
          </svg>
          {tasks.map(t => {
            const isHovered = t.id === hoveredTaskId;
            const dimmed = connected != null && !connected.has(t.id);
            return (
              <div
                key={t.id}
                className={`tnode ${t.status} ${t.late ? 'anim-in' : ''}`}
                style={{ opacity: dimmed ? 0.15 : 1, transition: 'opacity 0.15s' }}
                onMouseEnter={() => onHoverTask(t.id)}
              >
                <div
                  className="tnode-rail"
                  style={{ flex: `0 0 ${railW}px`, transition: 'flex-basis 0.18s ease' }}
                >
                  <div
                    className="tnode-dot"
                    ref={el => {
                      dotRefs.current[t.id] = el;
                    }}
                    style={{
                      left: BASE_OFFSET + t.lane * lanePx,
                      background: STATUS_COLOR[t.status],
                      boxShadow:
                        t.status === 'in_progress' ? '0 0 0 4px rgba(77,141,244,0.18)' : 'none',
                      animation: t.status === 'in_progress' ? 'softpulse 1.3s infinite' : 'none',
                    }}
                  />
                </div>
                <TaskCard
                  t={t}
                  agentSteps={agentSteps}
                  activity={taskActivity[t.id] ?? []}
                  durationMs={(() => {
                    const tm = taskTimings[t.id];
                    if (!tm) return null;
                    return tm.endedAt != null ? tm.endedAt - tm.startedAt : now - tm.startedAt;
                  })()}
                  durationLive={taskTimings[t.id] != null && taskTimings[t.id].endedAt == null}
                  isHovered={isHovered}
                  runActive={runActive}
                  onSteer={onSteer}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
