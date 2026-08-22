import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILTINS } from '../../data/marketAgents';
import { PERSONAS } from '../../data/personas';
import { AgentIcon, RoleChip, LockBadge } from './shared';
import { ToolGlyph } from '../common/ToolIcon';
import { IconLock, IconChevronLeft } from '../common/icons';
import { modelMeta } from '../../data/models';
import {
  defaultModelLabel,
  modelPolicyPreferenceOptions,
  modelPolicyPreferenceState,
} from '../../data/modelPolicy';
import { useProjectModelPolicy } from '../../hooks/useProjectModelPolicy';
import { useProjectClient } from '../../project/ProjectClientContext';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const SENS_LABEL: Record<string, string> = {
  read: 'Read access — can inspect any file in the codebase',
  write: 'Write access — can create and modify source files',
  shell: 'Shell access — can execute scripts, tests, and builds',
  network: 'Network access — can fetch external data and CVE databases',
};

interface BuiltinDrawerProps {
  agentId: string;
  onClose: () => void;
}

export function BuiltinDrawer({ agentId, onClose }: BuiltinDrawerProps) {
  const projectClient = useProjectClient();
  const modelPolicy = useProjectModelPolicy();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const builtin = BUILTINS.find(b => b.id === agentId);
  const persona = PERSONAS[agentId];
  const modelState = useMemo(
    () => modelPolicyPreferenceState(modelPolicy, model),
    [model, modelPolicy],
  );
  const modelOptions = useMemo(
    () => modelPolicyPreferenceOptions(modelPolicy, model),
    [model, modelPolicy],
  );
  const projectDefault = defaultModelLabel(modelPolicy);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      projectClient
        .fetchJson<Record<string, string> | null>('/agent-prompts', { allowMissingEnvelope: true })
        .catch(() => null),
      projectClient
        .fetchJson<Record<string, string> | null>('/agent-instructions', {
          allowMissingEnvelope: true,
        })
        .catch(() => null),
      projectClient
        .fetchJson<Record<string, string> | null>('/agent-models', { allowMissingEnvelope: true })
        .catch(() => null),
    ]).then(
      ([prompts, instrs, models]: [
        Record<string, string> | null,
        Record<string, string> | null,
        Record<string, string> | null,
      ]) => {
        if (cancelled) return;
        setPrompt(prompts?.[agentId] ?? null);
        setInstructions(instrs?.[agentId] ?? '');
        setModel(models?.[agentId] ?? DEFAULT_MODEL);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, projectClient]);

  function handleInstructionsChange(value: string) {
    setInstructions(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await projectClient.fetchResponse('/agent-instructions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [agentId]: value }),
        });
      } finally {
        setSaving(false);
      }
    }, 800);
  }

  function handleModelChange(value: string) {
    setModel(value);
    if (modelTimer.current) clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => {
      projectClient.fetchResponse('/agent-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [agentId]: value }),
      }).catch(() => {});
    }, 400);
  }

  if (!builtin || !persona) return null;

  return (
    <div className="agent-page">
      {/* ── Nav bar ──────────────────────────────────────────── */}
      <div className="agent-page-nav">
        <button className="ap-back" onClick={onClose}>
          <IconChevronLeft size={13} /> My Team
        </button>
        <div className="ap-nav-center">
          <AgentIcon name={builtin.name} color={persona.color} size={22} />
          <span className="ap-nav-name">{builtin.name}</span>
          <RoleChip role={builtin.role} />
          <LockBadge>
            <IconLock size={9} /> built-in
          </LockBadge>
        </div>
        <LockBadge>non-removable</LockBadge>
      </div>

      {/* ── Two-column body ──────────────────────────────────── */}
      <div className="agent-page-body">
        {/* Left: identity + prompt */}
        <div className="ap-col ap-col-left">
          <div className="ap-header">
            <AgentIcon name={builtin.name} color={persona.color} size={52} />
            <div>
              <div className="ap-name">{builtin.name}</div>
              <div className="acard-sub" style={{ marginTop: 5 }}>
                <RoleChip role={builtin.role} />
                <LockBadge>
                  <IconLock size={9} /> built-in
                </LockBadge>
              </div>
            </div>
          </div>

          <div className="dsec">
            <div className="meta-grid">
              <div className="mg">
                <div className="k">Removable</div>
                <div className="v">no — always on roster</div>
              </div>
            </div>
          </div>

          <div className="dsec ap-prompt-sec">
            <div className="dsec-label">
              <IconLock size={11} /> System prompt · read-only
            </div>
            <div className="prompt-block ap-prompt-block" style={{ position: 'relative' }}>
              <span className="prompt-lock">
                <IconLock size={10} /> locked
              </span>
              {loading && (
                <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  Loading…
                </span>
              )}
              {!loading && prompt === null && (
                <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  Server offline — start <code>swarm dev</code> to view the prompt.
                </span>
              )}
              {!loading && prompt !== null && prompt}
            </div>
          </div>
        </div>

        {/* Right: tools + instructions */}
        <div className="ap-col ap-col-right">
          <div className="dsec">
            <div className="dsec-label">Tool permissions</div>
            {builtin.tools.map((t, i) => (
              <div key={i} className={`toolitem ${t.sens !== 'read' ? 'caution' : ''} ${t.sens}`}>
                <span
                  className={`tool-i ${t.sens}`}
                  style={{ flex: '0 0 26px', width: 26, height: 26 }}
                >
                  <ToolGlyph sens={t.sens} size={13} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="ti-desc">{SENS_LABEL[t.sens] ?? t.sens}</div>
                </div>
                <span className={`sens-tag ${t.sens}`}>{t.sens}</span>
              </div>
            ))}
          </div>

          <div className="dsec">
            <div className="dsec-label">Agent model preference</div>
            <select className="sel" value={model} onChange={e => handleModelChange(e.target.value)}>
              {modelOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {option.provider === 'openai' ? 'OpenAI · ' : option.provider === 'anthropic' ? 'Anthropic · ' : ''}
                  {option.label}
                  {option.enabledForNewRuns ? '' : ' · unavailable for new runs'}
                </option>
              ))}
            </select>
            <div
              className="helper"
              style={
                modelState?.enabledForNewRuns
                  ? undefined
                  : {
                      color: 'var(--amber)',
                    }
              }
            >
              {modelState?.enabledForNewRuns
                ? `Available for new runs. This agent prefers ${modelState.label}, while Planning shows the effective route per task.`
                : modelState
                  ? `Unavailable for new runs — ${modelState.summary} ${modelState.remediation ?? ''}`.trim()
                  : `This agent prefers ${modelMeta(model)?.label ?? model}.`}
            </div>
            {projectDefault && (
              <div className="helper">Project default for new PM planning turns: {projectDefault}.</div>
            )}
          </div>

          <div className="dsec">
            <div className="dsec-label">
              Additional instructions
              {saving && (
                <span
                  style={{
                    fontWeight: 400,
                    color: 'var(--tx-3)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {' '}
                  · saving…
                </span>
              )}
            </div>
            <textarea
              className="ta"
              value={instructions}
              onChange={e => handleInstructionsChange(e.target.value)}
              placeholder={`Rules or context appended to the ${builtin.name}'s system prompt on every run.`}
              style={{ height: 140 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
