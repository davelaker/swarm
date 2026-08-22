import { useCallback, useEffect, useId, useMemo, useReducer, useRef } from 'react';
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

  useEffect(() => {
    dispatch({ type: 'reset', draft: createModelPolicyDraft(snapshot) });
  }, [snapshot]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, pending]);

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
            <div className="modal-sub">Choose which local models Swarm may route and which one the PM prefers.</div>
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
            Checked models stay available for new routes. The PM default must stay enabled and can
            only be chosen from planning-capable models.
          </p>
          <div className="model-policy-groups">
            {groups.map(group => (
              <fieldset key={group.provider} className="model-policy-group" disabled={pending}>
                <legend>{group.label}</legend>
                <div className="model-policy-list">
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
                            <span className="model-policy-model-label">{model.label}</span>
                            <span className="model-policy-model-meta">
                              {model.tier} tier
                              {model.planningCapable ? ' · planning-ready' : ' · coder/reviewer only'}
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
                          <span>{model.planningCapable ? 'Default PM model' : 'Unavailable for PM'}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
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
              {helperCopy}
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
