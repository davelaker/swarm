import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react';
import { usePlanningSession } from '../../hooks/usePlanningSession';
import { useContextFiles }    from '../../hooks/useContextFiles';
import { Charter }            from './Charter';
import { Message, TypingIndicator } from './Message';
import { IconSend }           from '../common/icons';
import type { ServerStatus, RunCharter } from '../../App';

interface PlanningProps {
  onExecute?:    () => void;
  onExecutable:  (v: boolean, goal?: string, charter?: RunCharter, team?: string[], reason?: string) => void;
  serverStatus?: ServerStatus;
  recapMessage?: string | null;
  planNextKey?:  number;
}

export function Planning({ onExecutable, serverStatus = 'probing', recapMessage, planNextKey }: PlanningProps) {
  const [projectName, setProjectName] = useState<string | undefined>();

  // Consume the one-shot switch flag set by ProjectSwitcher before reload.
  const [justSwitchedPath] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem('swarm-just-switched');
      if (v) { localStorage.removeItem('swarm-just-switched'); return v; }
    } catch { /* private mode */ }
    return null;
  });

  const session    = usePlanningSession(onExecutable, projectName ?? 'default', recapMessage);
  const context    = useContextFiles();
  const [input, setInput]           = useState('');
  const scrollRef   = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // When App asks us to start a fresh session (after a run completes), call
  // newSession(). The planNextKey increments each time — skip the initial 0.
  const prevPlanNextKey = useRef(planNextKey ?? 0);
  useEffect(() => {
    if (!planNextKey || planNextKey === prevPlanNextKey.current) return;
    prevPlanNextKey.current = planNextKey;
    session.newSession();
  }, [planNextKey, session.newSession]);

  // Start the PM opening message once we have project context.
  // We wait up to 1.5s for /state and /context to load before falling back
  // to the generic greeting so the PM can reference the existing project.
  const initFired = useRef(false);

  // When the user hits "New session", sessionKey increments — reset the guard
  // BEFORE the init effect runs (React fires effects in definition order).
  useEffect(() => {
    initFired.current = false;
  }, [session.sessionKey]);

  useEffect(() => {
    if (initFired.current) return;
    // Extract a short stack summary from PROJECT.md (first tech stack bullet)
    const stackLine = context.projectMd?.content
      ?.split('\n')
      .find(l => l.match(/^\s*[-*]\s*(language|runtime|tech|stack)/i));
    const stackHint = stackLine
      ? stackLine.replace(/^\s*[-*]\s*/i, '').replace(/\*\*/g, '').slice(0, 60)
      : undefined;
    if (projectName || context.projectMd) {
      initFired.current = true;
      session.init(projectName, stackHint, justSwitchedPath ?? undefined);
    }
  }, [projectName, context.projectMd, justSwitchedPath, session.sessionKey]);

  // Fallback: fire after 1.5s even if context never arrives
  useEffect(() => {
    const t = setTimeout(() => {
      if (!initFired.current) {
        initFired.current = true;
        session.init(undefined, undefined, justSwitchedPath ?? undefined);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [justSwitchedPath, session.sessionKey]);

  // Try to fetch the real project name from the backend
  useEffect(() => {
    fetch('/state')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s?.project) setProjectName(s.project); })
      .catch(() => {});
  }, []);

  // Auto-scroll on new messages / typing indicator
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session.messages, session.typing]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || session.typing) return;
    setInput('');
    session.send(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Pre-fill the textarea and focus it — used by "ask PM" on context files
  const handleAskPm = (message: string) => {
    setInput(message);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(message.length, message.length);
    }, 0);
  };

  // Conversation phase label
  const phaseLabel = session.executable ? 'ready'
                   : session.phase === 'start' ? 'initialising' : 'scoping';
  const phaseDot   = session.executable ? 'var(--green)' : 'var(--amber)';

  // Server-mode label shown in panel header
  const modeLabel  = serverStatus === 'up'      ? null
                   : serverStatus === 'probing' ? 'connecting'
                   : 'preview mode';
  const modeDot    = serverStatus === 'up'      ? 'var(--green)'
                   : serverStatus === 'probing' ? 'var(--tx-3)'
                   : 'var(--tx-3)';

  // Composer hint
  const hint = serverStatus === 'down'
    ? 'Planning works without a server — Enter to send · agents need `swarm dev` to execute'
    : 'Enter to send · Shift+Enter for newline';

  return (
    <div className="plan">
      <Charter
        charter={session.charter}
        team={session.team}
        phase={session.phase}
        projectName={projectName}
        projectMd={context.projectMd}
        contextFiles={context.contextFiles}
        onAskPm={handleAskPm}
      />
      <div className="plan-right">
        <div className="panel-head">
          <span>PM Conversation</span>
          <button
            className="new-session-btn"
            onClick={session.newSession}
            title="Clear conversation and start fresh"
          >
            New session
          </button>
          <span className="spacer" />
          <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--mono)', fontSize: 11, textTransform: 'none', letterSpacing: 0 }}>
            {modeLabel && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--tx-3)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: modeDot }} />
                {modeLabel}
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--tx-2)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: phaseDot }} />
              {phaseLabel}
            </span>
          </span>
        </div>
        <div className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {session.messages.map((m, i) => <Message key={i} m={m} />)}
            {session.typing && <TypingIndicator from={session.typing} />}
          </div>
          {session.suggestCompact && (
            <div className="compact-banner">
              <span className="compact-icon">⚠</span>
              <span className="compact-text">This conversation is getting long — compact it to save context.</span>
              <button className="compact-btn" onClick={session.compact} disabled={!!session.typing}>
                Compact
              </button>
            </div>
          )}
          <div className="composer">
            <div className="composer-row">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={session.phase === 'start' ? 'Waiting for PM…' : session.typing ? 'PM is typing…' : 'Reply to the PM — Enter to send'}
                disabled={session.phase === 'start' || !!session.typing}
                style={{ opacity: (session.phase === 'start' || !!session.typing) ? 0.5 : 1 }}
              />
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim() || !!session.typing}
              >
                <IconSend />
              </button>
            </div>
            <div className="hint">{hint}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
