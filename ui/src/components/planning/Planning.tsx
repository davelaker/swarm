import { useState, useEffect, useRef } from 'react';
import type { CharterData, ChatMessage } from '../../types';
import { PLAN_SCRIPT } from '../../data/planScript';
import { Charter } from './Charter';
import { Message, TypingIndicator } from './Message';
import { IconSend } from '../common/icons';

interface PlanningProps {
  onExecute?: () => void;
  onExecutable: (v: boolean) => void;
}

export function Planning({ onExecutable }: PlanningProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [charter, setCharter]   = useState<CharterData>({ goal: '', constraints: [], nongoals: [], questions: [] });
  const [team, setTeam]         = useState<string[]>([]);
  const [typing, setTyping]     = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timers    = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startTime = useRef(Date.now());

  const fmt = () => {
    const s = Math.floor((Date.now() - startTime.current) / 1000);
    return `00:${String(s).padStart(2, '0')}`;
  };

  useEffect(() => {
    let acc = 0;
    PLAN_SCRIPT.forEach(step => {
      if (step.type === 'msg') {
        const showAt = acc - 450;
        if (showAt > 0) timers.current.push(setTimeout(() => setTyping(step.from), showAt));
      }
      acc += step.d;
      const at = acc;
      timers.current.push(setTimeout(() => {
        setTyping(null);
        switch (step.type) {
          case 'msg':
            setMessages(m => [...m, { from: step.from, text: step.text, time: fmt() }]);
            break;
          case 'charter':
            setCharter(c => ({ ...c, [step.field]: step.value }));
            break;
          case 'list':
            setCharter(c => ({ ...c, [step.field]: [...(c as any)[step.field], { text: step.value }] }));
            break;
          case 'q':
            setCharter(c => ({ ...c, questions: [...c.questions, { text: step.value }] }));
            break;
          case 'resolve':
            setCharter(c => ({ ...c, questions: c.questions.map((q, i) =>
              i === c.questions.length - 1 ? { text: q.text + '  →  ' + step.value, resolved: true } : q
            )}));
            break;
          case 'team':
            setTeam(t => [...t, step.value]);
            break;
          case 'enable':
            onExecutable(true);
            break;
        }
      }, at));
    });
    return () => timers.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, typing]);

  return (
    <div className="plan">
      <Charter charter={charter} team={team} />
      <div className="plan-right">
        <div className="panel-head">
          <span>PM Conversation</span>
          <span className="spacer" />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--tx-2)', fontSize: 11, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--mono)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
            scoping
          </span>
        </div>
        <div className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.map((m, i) => <Message key={i} m={m} />)}
            {typing && <TypingIndicator from={typing} />}
          </div>
          <div className="composer">
            <div className="composer-row">
              <textarea rows={1} placeholder="The PM is driving this conversation…" disabled />
              <button className="send-btn" tabIndex={-1}><IconSend /></button>
            </div>
            <div className="hint">Auto-piloted demo · the PM assembles the charter as you talk</div>
          </div>
        </div>
      </div>
    </div>
  );
}
