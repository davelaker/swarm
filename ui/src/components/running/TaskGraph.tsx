import { useRef, useEffect, useState, useCallback } from 'react';
import type { Task } from '../../types';
import { PERSONAS } from '../../data/personas';
import { STATUS_COLOR, STATUS_LABEL } from '../../data/runScript';

interface Edge { from: { x: number; y: number }; to: { x: number; y: number }; key: string; color: string }

export function TaskGraph({ tasks, agentSteps }: { tasks: Task[]; agentSteps: Record<string, string> }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const dotRefs  = useRef<Record<string, HTMLDivElement | null>>({});
  const [edges, setEdges] = useState<Edge[]>([]);

  const recompute = useCallback(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const base = inner.getBoundingClientRect();
    const pos: Record<string, { x: number; y: number }> = {};
    tasks.forEach(t => {
      const el = dotRefs.current[t.id];
      if (el) { const r = el.getBoundingClientRect(); pos[t.id] = { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 }; }
    });
    const es: Edge[] = [];
    tasks.forEach(t => t.deps.forEach(d => {
      if (pos[d] && pos[t.id]) {
        es.push({ from: pos[d], to: pos[t.id], key: `${d}-${t.id}`, color: STATUS_COLOR[t.status] === 'var(--grey)' ? '#2c323b' : 'rgba(255,255,255,0.14)' });
      }
    }));
    setEdges(es);
  }, [tasks]);

  useEffect(() => { const id = requestAnimationFrame(recompute); return () => cancelAnimationFrame(id); }, [recompute]);
  useEffect(() => {
    const ro = new ResizeObserver(recompute);
    if (innerRef.current) ro.observe(innerRef.current);
    window.addEventListener('resize', recompute);
    return () => { ro.disconnect(); window.removeEventListener('resize', recompute); };
  }, [recompute]);

  const doneCount = tasks.filter(t => t.status === 'done').length;

  return (
    <div className="run-graph">
      <div className="panel-head">
        <span>Task Graph</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11, color: 'var(--tx-3)', textTransform: 'none', letterSpacing: 0 }}>{doneCount}/{tasks.length} done</span>
      </div>
      <div className="graph-scroll">
        <div className="graph-inner" ref={innerRef}>
          <svg className="graph-edges">
            {edges.map(e => {
              const midY = (e.from.y + e.to.y) / 2;
              const d = `M ${e.from.x} ${e.from.y} C ${e.from.x} ${midY}, ${e.to.x} ${midY}, ${e.to.x} ${e.to.y}`;
              return <path key={e.key} d={d} fill="none" stroke={e.color} strokeWidth="1.5" />;
            })}
          </svg>
          {tasks.map(t => {
            const p = PERSONAS[t.assignee];
            const color = STATUS_COLOR[t.status];
            const isActive = t.status === 'in_progress';
            const step = isActive ? agentSteps[t.assignee] : null;
            return (
              <div key={t.id} className={`tnode ${t.status} ${t.late ? 'anim-in' : ''}`}>
                <div className="tnode-rail">
                  <div
                    className="tnode-dot"
                    ref={el => { dotRefs.current[t.id] = el; }}
                    style={{
                      left: 18 + t.lane * 20,
                      background: color,
                      boxShadow: isActive ? '0 0 0 4px rgba(77,141,244,0.18)' : 'none',
                      animation: isActive ? 'softpulse 1.3s infinite' : 'none',
                    }}
                  />
                </div>
                <div className="tnode-card">
                  <div className="tnode-top">
                    <span className="tnode-id">{t.id}</span>
                    <span className="tnode-title">{t.title}</span>
                  </div>
                  <div className="tnode-bottom">
                    <span className="tnode-assignee">
                      <span className="pdot" style={{ background: p?.color }} />
                      {p?.name}
                    </span>
                    <span className="tnode-status" style={{ color }}>{STATUS_LABEL[t.status]}</span>
                  </div>
                  {step && (
                    <div className="tnode-step" style={{ color: p?.color }}>
                      {step}<span className="cursor" style={{ color: p?.color }} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
