import { useRef, useEffect } from 'react';
import { useRunSimulation }  from '../../hooks/useRunSimulation';
import { useRealRun }        from '../../hooks/useRealRun';
import { TaskGraph }         from './TaskGraph';
import { AgentsPanel }       from './AgentsPanel';
import { FindingsFeed }      from './FindingsFeed';
import { Message }           from '../planning/Message';
import { IconSend }          from '../common/icons';
import type { RunStatus }    from '../../types';

// ─── Shared view ──────────────────────────────────────────────────────────────

interface RunViewProps {
  project:       string;
  tier:          string;
  tasks:         ReturnType<typeof useRunSimulation>['tasks'];
  agents:        ReturnType<typeof useRunSimulation>['agents'];
  findings:      ReturnType<typeof useRunSimulation>['findings'];
  pmMsgs:        ReturnType<typeof useRunSimulation>['pmMsgs'];
  spend:         number;
  spendCap:      number;
  status:        RunStatus;
  connected?:    boolean;
  onPause?:      () => void;
  onAbort?:      () => void;
}

function RunView({
  project, tier, tasks, agents, findings, pmMsgs,
  spend, spendCap, status, connected = true,
  onPause, onAbort,
}: RunViewProps) {
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [pmMsgs]);

  const tierColour = tier === 'tweak' ? 'blue' : tier === 'greenfield' ? 'green' : 'amber';
  const statusMeta: Record<RunStatus, { cls: string; label: string }> = {
    running: { cls: 'running', label: 'running' },
    paused:  { cls: 'paused',  label: 'paused'  },
    done:    { cls: 'done',    label: 'done'     },
    aborted: { cls: 'aborted', label: 'aborted'  },
  };
  const { cls, label } = statusMeta[status] ?? statusMeta.running;

  const agentSteps = Object.fromEntries(
    Object.entries(agents).map(([k, v]) => [k, v.active ? v.step : ''])
  );

  return (
    <div className="run">
      <div className="run-head">
        <span className="pname">{project}</span>
        <span className={`badge ${tierColour}`}>{tier.toUpperCase()}</span>
        {!connected && (
          <span style={{ fontSize: 11, color: 'var(--amber)', fontFamily: 'var(--mono)', marginLeft: 4 }}>
            ⚠ reconnecting…
          </span>
        )}
        <span className={`run-status ${cls}`}>
          <span className="rdot" />{label}
        </span>
        <div className="spacer" />
        {onPause && (
          <button className="btn sm" onClick={onPause} disabled={status === 'done' || status === 'aborted'}>
            {status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
        {onAbort && (
          <button className="btn sm danger" onClick={onAbort} disabled={status === 'done' || status === 'aborted'}>
            Abort
          </button>
        )}
        <div className="spend">
          <div className="spend-top">
            <span className="amt">${spend.toFixed(2)}</span>
            <span className="cap">/ ${spendCap.toFixed(2)}</span>
          </div>
          <div className="spend-bar">
            <i style={{ width: `${Math.min(100, (spend / spendCap) * 100)}%` }} />
          </div>
        </div>
      </div>

      <TaskGraph tasks={tasks} agentSteps={agentSteps} />

      <div className="run-right">
        <AgentsPanel agents={agents} />
        <FindingsFeed findings={findings} />
      </div>

      <div className="run-chat">
        <div className="panel-head"><span>PM Chat</span></div>
        <div className="chat" style={{ minHeight: 0 }}>
          <div className="chat-scroll" ref={chatRef}>
            {pmMsgs.map((m, i) => <Message key={i} m={m} />)}
          </div>
          <div className="composer">
            <div className="composer-row">
              <textarea rows={1} placeholder="Message the PM — pause the run to intervene…" />
              <button className="send-btn"><IconSend /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Server-down screen ───────────────────────────────────────────────────────

function ServerDown() {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 28, padding: 40,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tx-3)', marginBottom: 10 }}>
          Swarm server not running
        </div>
        <div style={{ color: 'var(--tx-2)', fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
          Start the server in one terminal, then run a task in another.
          This panel will connect automatically.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 560 }}>
        <Step n={1} label="Start the server">
          <Code>cd /path/to/swarm/core</Code>
          <Code>npm run dev</Code>
        </Step>
        <Step n={2} label="Run a task in your project">
          <Code>cd /your/project</Code>
          <Code>swarm init</Code>
          <Code>swarm new "describe what you want to build"</Code>
        </Step>
        <Step n={3} label="Watch it here">
          <div style={{ color: 'var(--tx-2)', fontSize: 12, fontFamily: 'var(--mono)', padding: '8px 12px' }}>
            This panel updates live as agents run.
          </div>
        </Step>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: 'var(--tx-3)', fontSize: 11, fontFamily: 'var(--mono)',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tx-3)', animation: 'softpulse 1.4s infinite', display: 'inline-block' }} />
        retrying every 3 seconds…
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: 'var(--tx-2)', fontFamily: 'var(--mono)', flexShrink: 0,
        }}>{n}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx-1)' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tx)',
      background: 'var(--bg)', border: '1px solid var(--border-soft)',
      borderRadius: 5, padding: '6px 10px',
    }}>
      <span style={{ color: 'var(--tx-3)', userSelect: 'none' }}>$ </span>
      {children}
    </div>
  );
}

// ─── Running: real backend or server-down screen ──────────────────────────────

export function Running() {
  const { serverStatus, state } = useRealRun();

  if (serverStatus === 'probing') {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
          connecting…
        </span>
      </div>
    );
  }

  if (serverStatus === 'down' || !state) {
    return <ServerDown />;
  }

  const pause = () => fetch('/run/pause',  { method: 'POST' }).catch(() => {});
  const abort = () => fetch('/run/abort',  { method: 'POST' }).catch(() => {});
  const resume = () => fetch('/run/resume', { method: 'POST' }).catch(() => {});

  return (
    <RunView
      project   = {state.project}
      tier      = {state.tier}
      tasks     = {state.tasks}
      agents    = {state.agents}
      findings  = {state.findings}
      pmMsgs    = {state.pmMsgs}
      spend     = {state.spend}
      spendCap  = {state.spendCap}
      status    = {state.status}
      connected = {state.connected}
      onPause   = {state.status === 'paused' ? resume : pause}
      onAbort   = {abort}
    />
  );
}
