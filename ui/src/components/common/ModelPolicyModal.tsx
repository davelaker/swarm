import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { ServerStatus } from '../../App';
import {
  createModelPolicyDraft,
  modelPolicyGroups,
  modelPolicySaveState,
  reduceModelPolicyDraft,
  type ModelPolicyDraft,
  type ModelPolicySnapshot,
} from '../../data/modelPolicy';

interface ModelPolicyModalProps {
  snapshot: ModelPolicySnapshot;
  serverStatus: ServerStatus;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onDismissError: () => void;
  onSave: (draft: ModelPolicyDraft) => void;
}

export function ModelPolicyModal({
  snapshot,
  serverStatus,
  pending,
  error,
  onClose,
  onDismissError,
  onSave,
}: ModelPolicyModalProps) {
  const [draft, dispatch] = useReducer(
    (state: ModelPolicyDraft, action: Parameters<typeof reduceModelPolicyDraft>[2]) =>
      reduceModelPolicyDraft(snapshot.providers, state, action),
    snapshot,
    createModelPolicyDraft,
  );
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();
  const errorId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(pending);
  const [collapsedProviders, setCollapsedProviders] = useState<string[]>([]);
  const [activeProviderNotice, setActiveProviderNotice] = useState<string | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
    pendingRef.current = pending;
  }, [onClose, pending]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) {
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const groups = useMemo(
    () => modelPolicyGroups(snapshot.providers, draft.enabledModelIds),
    [draft.enabledModelIds, snapshot.providers],
  );
  const saveState = useMemo(
    () =>
      modelPolicySaveState({
        serverStatus,
        pending,
        snapshot,
        draft,
      }),
    [draft, pending, serverStatus, snapshot],
  );
  const activeError = error ?? (saveState.dirty && saveState.disabled ? saveState.reason : null);
  const helperCopy =
    !activeError && snapshot.activeRun
      ? 'An active run is in progress. Review the policy now, then save after the run ends.'
      : !activeError && !saveState.dirty
        ? 'Enabled models affect new PM planning turns and new task route choices immediately after save.'
        : null;

  const handleSave = useCallback(() => {
    if (!saveState.disabled) {
      onSave(draft);
    }
  }, [draft, onSave, saveState.disabled]);

  return (
    <div className="scrim" onClick={() => !pending && onClose()}>
      <div
        className="modal model-policy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={activeError ? `${bodyId} ${errorId}` : `${bodyId} ${noteId}`}
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" id={titleId}>
              Model policy
            </div>
            <div className="modal-sub">
              Choose which local models Swarm may route and which one the PM prefers.
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="model-policy-close"
            onClick={onClose}
            disabled={pending}
            aria-label="Close model policy"
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="model-policy-copy" id={bodyId}>
            Model policy controls which models stay available to Swarm and which planning-capable
            model is the project default for new PM turns.
          </p>
          <div className="model-policy-legend">
            <div>
              <strong>Available model</strong>: Swarm may route new work to it.
            </div>
            <div>
              <strong>Project default</strong>: the PM uses it for planning unless a task needs a
              different effective route.
            </div>
            <div>
              <strong>Agent preference</strong>: set per agent in My Team and used as that agent's
              baseline.
            </div>
            <div>
              <strong>Effective route</strong>: the concrete model shown at Execute time for a
              specific task.
            </div>
          </div>
          <div className="model-policy-groups">
            {groups.map(group => {
              const modelsId = `${titleId}-${group.provider}-models`;
              const reasonId = `${titleId}-${group.provider}-reason`;
              const expanded = group.policyEnabled && !collapsedProviders.includes(group.provider);
              const providerToggleReason = !group.available
                ? group.unavailableReason
                : !group.canDisable && group.policyEnabled
                  ? 'At least one provider must remain enabled.'
                  : null;
              return (
                <fieldset key={group.provider} className="model-policy-group" disabled={pending}>
                  <legend className="sr-only">{group.label}</legend>
                  <div className={`model-policy-provider${group.available ? '' : ' unavailable'}`}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={group.policyEnabled}
                      aria-disabled={!group.available || (!group.canDisable && group.policyEnabled)}
                      aria-describedby={providerToggleReason ? reasonId : undefined}
                      className="model-policy-provider-toggle"
                      title={providerToggleReason ?? `Enable or disable ${group.label}`}
                      onClick={() => {
                        if (!group.available) {
                          setActiveProviderNotice(group.provider);
                          return;
                        }
                        if (group.policyEnabled && !group.canDisable) {
                          return;
                        }
                        setActiveProviderNotice(null);
                        setCollapsedProviders(current =>
                          group.policyEnabled
                            ? [...new Set([...current, group.provider])]
                            : current.filter(provider => provider !== group.provider),
                        );
                        dispatch({
                          type: group.policyEnabled ? 'disable-provider' : 'enable-provider',
                          provider: group.provider,
                        });
                      }}
                    >
                      <span className="model-policy-switch" aria-hidden="true">
                        <span />
                      </span>
                      <span className="model-policy-provider-copy">
                        <strong>{group.label}</strong>
                        <span>
                          {group.available
                            ? group.policyEnabled
                              ? `${group.models.filter(model => model.enabled).length} models enabled`
                              : 'Available · off'
                            : 'Unavailable'}
                        </span>
                      </span>
                    </button>
                    {group.policyEnabled ? (
                      <button
                        type="button"
                        className="model-policy-disclosure"
                        aria-expanded={expanded}
                        aria-controls={modelsId}
                        aria-label={`${expanded ? 'Hide' : 'Show'} ${group.label} model options`}
                        onClick={() =>
                          setCollapsedProviders(current =>
                            expanded
                              ? [...new Set([...current, group.provider])]
                              : current.filter(provider => provider !== group.provider),
                          )
                        }
                      >
                        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                      </button>
                    ) : null}
                  </div>
                  {providerToggleReason ? (
                    <div
                      id={reasonId}
                      className={`model-policy-provider-reason${
                        activeProviderNotice === group.provider ? ' visible' : ''
                      }`}
                      role={activeProviderNotice === group.provider ? 'tooltip' : undefined}
                    >
                      {providerToggleReason}
                    </div>
                  ) : null}
                  {expanded ? (
                    <div className="model-policy-list" id={modelsId}>
                      {group.models.map(model => {
                        const enabled = model.enabled;
                        const isOnlyEnabled = enabled && draft.enabledModelIds.length === 1;
                        return (
                          <div
                            key={model.id}
                            className={`model-policy-row${enabled ? ' enabled' : ''}${
                              model.planningCapable ? '' : ' not-planning'
                            }`}
                          >
                            <label className="model-policy-enable">
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={pending || isOnlyEnabled}
                                onChange={() =>
                                  dispatch({
                                    type: 'toggle-model',
                                    modelId: model.id,
                                  })
                                }
                              />
                              <span className="model-policy-model">
                                <span className="model-policy-model-label">
                                  {model.label}
                                  {draft.defaultModelId === model.id && (
                                    <span className="model-policy-row-badge">Project default</span>
                                  )}
                                </span>
                                <span className="model-policy-model-meta">
                                  {model.tier} tier
                                  {model.planningCapable
                                    ? ' · planning-ready'
                                    : ' · coder/reviewer only'}
                                </span>
                              </span>
                            </label>
                            <label className="model-policy-default">
                              <input
                                type="radio"
                                name="default-planning-model"
                                checked={draft.defaultModelId === model.id}
                                disabled={pending || !enabled || !model.planningCapable}
                                onChange={() =>
                                  dispatch({
                                    type: 'select-default',
                                    modelId: model.id,
                                  })
                                }
                              />
                              <span>
                                {model.planningCapable ? 'Project default' : 'Unavailable for PM'}
                              </span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </fieldset>
              );
            })}
          </div>
          {activeError ? (
            <div className="model-policy-error" id={errorId} role="alert">
              <span>{activeError}</span>
              {error ? (
                <button
                  type="button"
                  className="model-policy-error-dismiss"
                  onClick={onDismissError}
                  title="Dismiss model-policy error"
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : (
            <p className="model-policy-note" id={noteId}>
              {helperCopy ??
                'Agent preference lives in My Team. The effective task route is shown in Planning before you Execute.'}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleSave}
            disabled={saveState.disabled}
            title={saveState.reason ?? undefined}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
