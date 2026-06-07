import { useRef, useEffect, useState } from 'react';
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

// ─── Running: tries real backend, falls back to mock ─────────────────────────

export function Running() {
  const real = useRealRun();
  const mock = useRunSimulation();

  // While the real hook is connecting (null = still trying), show a brief spinner.
  // After the first response — either real state or confirmed unavailable — pick a mode.
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    // real is null while fetching; it becomes an object (connected or not) once resolved
    if (real !== null || decided) setDecided(true);
    // Give it 1s to connect before falling through to mock
    const t = setTimeout(() => setDecided(true), 1000);
    return () => clearTimeout(t);
  }, [real]);

  if (!decided) {
    return (
      <div className="run" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
          connecting to swarm server…
        </span>
      </div>
    );
  }

  // Real backend is available
  if (real?.connected || real?.tasks.length) {
    return (
      <RunView
        project   = {real.project}
        tier      = {real.tier}
        tasks     = {real.tasks}
        agents    = {real.agents}
        findings  = {real.findings}
        pmMsgs    = {real.pmMsgs}
        spend     = {0}
        spendCap  = {5}
        status    = {real.status}
        connected = {real.connected}
      />
    );
  }

  // No backend — mock demo
  return (
    <RunView
      project    = "discord-rank-bot"
      tier       = "feature"
      tasks      = {mock.tasks}
      agents     = {mock.agents}
      findings   = {mock.findings}
      pmMsgs     = {mock.pmMsgs}
      spend      = {mock.spend}
      spendCap   = {mock.spendCap}
      status     = {mock.status}
      onPause    = {mock.togglePause}
      onAbort    = {mock.abort}
    />
  );
}
