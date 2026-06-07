import { useRef, useEffect } from 'react';
import { useRunSimulation } from '../../hooks/useRunSimulation';
import { TaskGraph } from './TaskGraph';
import { AgentsPanel } from './AgentsPanel';
import { FindingsFeed } from './FindingsFeed';
import { Message } from '../planning/Message';
import { IconSend } from '../common/icons';

export function Running() {
  const { tasks, agents, findings, pmMsgs, spend, status, spendCap, togglePause, abort } = useRunSimulation();
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [pmMsgs]);

  const statusMeta = {
    running: { cls: 'running', label: 'running' },
    paused:  { cls: 'paused',  label: 'paused' },
    done:    { cls: 'done',    label: 'done' },
    aborted: { cls: 'aborted', label: 'aborted' },
  }[status];

  const agentSteps = Object.fromEntries(
    Object.entries(agents).map(([k, v]) => [k, v.active ? v.step : ''])
  );

  return (
    <div className="run">
      {/* Run header */}
      <div className="run-head">
        <span className="pname">discord-rank-bot</span>
        <span className="badge amber">FEATURE</span>
        <span className={`run-status ${statusMeta.cls}`}>
          <span className="rdot" />
          {statusMeta.label}
        </span>
        <div className="spacer" />
        <button
          className="btn sm"
          onClick={togglePause}
          disabled={status === 'done' || status === 'aborted'}
        >
          {status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button
          className="btn sm danger"
          onClick={abort}
          disabled={status === 'done' || status === 'aborted'}
        >
          Abort
        </button>
        <div className="spend">
          <div className="spend-top">
            <span className="amt">${spend.toFixed(2)}</span>
            <span className="cap">/ ${spendCap.toFixed(2)}</span>
          </div>
          <div className="spend-bar">
            <i style={{ width: `${(spend / spendCap) * 100}%` }} />
          </div>
        </div>
      </div>

      {/* Left: Task graph */}
      <TaskGraph tasks={tasks} agentSteps={agentSteps} />

      {/* Right: Agents + Findings */}
      <div className="run-right">
        <AgentsPanel agents={agents} />
        <FindingsFeed findings={findings} />
      </div>

      {/* Bottom: PM Chat */}
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
