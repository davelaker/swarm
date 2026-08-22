import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Surface, SessionSnapshot } from './types';
import { Planning } from './components/planning/Planning';
import { Running } from './components/running/Running';
import { Branches } from './components/branches/Branches';
import { Marketplace } from './components/marketplace/Marketplace';
import { SessionsPanel } from './components/sessions/SessionsPanel';
import { ProjectSwitcher } from './components/common/ProjectSwitcher';
import { StaleServerBanner } from './components/common/StaleServerBanner';
import { ModelPolicyModal } from './components/common/ModelPolicyModal';
import { PermissionGate } from './components/running/PermissionGate';
import { useRealRun } from './hooks/useRealRun';
import { useRunNotifications } from './hooks/useRunNotifications';
import { IconGitHub, IconFolder } from './components/common/icons';
import { modelMeta, type AvailableProvider } from './data/models';
import {
  defaultModelPolicySnapshot,
  defaultModelLabel,
  modelPolicyButtonState,
  normalizeModelPolicyResponse,
  type ModelPolicyDraft,
  type ModelPolicyResponse,
  type ModelPolicySnapshot,
} from './data/modelPolicy';
import type { QuickTaskStartResult } from './data/quickTask';
import { envelopeFromResponse } from './project/envelope';
import { createProjectClient } from './project/projectClient';
import { ProjectClientProvider } from './project/ProjectClientContext';
import type { ProjectContextState, ProjectEnvelope } from './project/types';

export type ServerStatus = 'probing' | 'up' | 'down';

interface CapabilitiesResponse {
  playwright?: boolean;
  providers?: AvailableProvider[];
  modelPolicy?: ModelPolicyResponse;
}

interface HealthResponse {
  project?: string;
  driver?: string;
  model?: string | null;
  activeRun?: boolean;
  repoUrl?: string | null;
  root?: string;
  modelPolicy?: ModelPolicyResponse;
  activeProject?: ProjectEnvelope;
  envelope?: ProjectEnvelope;
  projectEnvelope?: ProjectEnvelope;
}

interface SwitchResponse {
  ok: boolean;
  project?: string;
  repoUrl?: string | null;
  root?: string;
  error?: string;
  activeProject?: ProjectEnvelope;
  envelope?: ProjectEnvelope;
  projectEnvelope?: ProjectEnvelope;
}

export interface TaskGraphEntry {
  id: string;
  assignee: 'coder' | 'tester' | 'security' | 'reviewer';
  title: string;
  depends_on: string[];
  model?: string; // PM-chosen model for this task (canonical id, e.g. claude-opus-4-8)
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  route?: TaskRoute;
}

export interface TaskRoute {
  provider: 'anthropic' | 'openai';
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  rationale: string;
  fallback: {
    provider: 'anthropic' | 'openai';
    model: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  } | null;
  requiresConfirmation: boolean;
  writeScope: string[];
}

export interface RunCharter {
  constraints: string[];
  nongoals: string[];
  questions: string[];
  branchMode?: 'branch' | 'main';
  branchName?: string; // user-set slug (no swarm/ prefix)
  taskGraph?: TaskGraphEntry[];
  planningHistory?: Array<{ from: 'pm' | 'you'; text: string }>;
}

// ─── Surface persistence ──────────────────────────────────────────────────────
// Survives HMR and accidental refreshes. Without this, pressing Execute and
// then triggering a hot-reload dumps the user back to Planning — with the
// Execute button re-enabled — while agents are still running server-side.
const SURFACE_KEY = 'swarm-surface-v1';
const ROOT_KEY = 'swarm-active-root';

function loadSurface(): Surface {
  try {
    const v = localStorage.getItem(SURFACE_KEY);
    if (
      v === 'running' ||
      v === 'planning' ||
      v === 'branches' ||
      v === 'marketplace' ||
      v === 'history'
    )
      {return v as Surface;}
  } catch {
    /* private mode or quota — ignore */
  }
  return 'planning';
}

function loadRememberedRoot(): string | null {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
}

function rememberRoot(projectRoot: string): void {
  try {
    localStorage.setItem(ROOT_KEY, projectRoot);
  } catch {
    /* private mode */
  }
}

function forgetRememberedRoot(): void {
  try {
    localStorage.removeItem(ROOT_KEY);
  } catch {
    /* private mode */
  }
}

export function App() {
  const [surface, setSurface] = useState<Surface>(loadSurface);
  const [marketplaceFocus, setMarketplaceFocus] = useState<string | null>(null);
  const [executable, setExecutable] = useState(false);
  // Why Execute is unavailable — surfaced as the tooltip on the amber "PLANNING" dot.
  const [executableReason, setExecutableReason] = useState(
    'Complete the planning conversation to unlock Execute',
  );
  const [runGoal, setRunGoal] = useState('');
  const [runCharter, setRunCharter] = useState<RunCharter | null>(null);
  const [runTeam, setRunTeam] = useState<string[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus>('probing');
  const [projectState, setProjectState] = useState<ProjectContextState>({
    status: 'booting',
    generation: 0,
  });
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [completionRecap, setCompletionRecap] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [runDone, setRunDone] = useState(false);
  const [planNextKey, setPlanNextKey] = useState(0);
  const [runConnectionKey, setRunConnectionKey] = useState(0);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [isInitiating, setIsInitiating] = useState(false);
  const [historicalSession, setHistoricalSession] = useState<SessionSnapshot | null>(null);
  // "Re-open in Planning": seed an editable plan from a past session.
  const [reopenSeed, setReopenSeed] = useState<SessionSnapshot | null>(null);
  const [reopenKey, setReopenKey] = useState(0);
  // null = unknown (don't nag); false = visual verification disabled (Playwright missing).
  const [playwrightAvailable, setPlaywrightAvailable] = useState<boolean | null>(null);
  const [modelPolicy, setModelPolicy] = useState<ModelPolicySnapshot>(defaultModelPolicySnapshot);
  const [modelPolicyPending, setModelPolicyPending] = useState(false);
  const [modelPolicyError, setModelPolicyError] = useState<string | null>(null);
  const [modelPolicyOpen, setModelPolicyOpen] = useState(false);
  // Last activeRun seen by the probe — the running-tab snap fires on the
  // false→true transition only (see the probe below).
  const prevActiveRun = useRef(false);
  const projectStateRef = useRef<ProjectContextState>(projectState);
  const projectGenerationRef = useRef(0);
  const previousReadyProjectRef = useRef<ProjectEnvelope | null>(null);
  const projectAbortRef = useRef(new AbortController());

  useEffect(() => {
    projectStateRef.current = projectState;
  }, [projectState]);

  const readyProject = projectState.status === 'ready' ? projectState.project : null;
  const projectClient = useMemo(() => {
    if (!readyProject) {
      return null;
    }
    return createProjectClient({
      project: readyProject,
      generation: projectState.generation,
      signal: projectAbortRef.current.signal,
      isCurrentGeneration: generation => generation === projectGenerationRef.current,
    });
  }, [readyProject, projectState.generation]);
  const projectSurfaceKey = projectClient
    ? `${projectClient.project.projectId}:${projectClient.generation}`
    : `project-${projectState.status}-${projectState.generation}`;

  const resetProjectDerivedState = useCallback(() => {
    setMarketplaceFocus(null);
    setExecutable(false);
    setExecutableReason('Complete the planning conversation to unlock Execute');
    setRunGoal('');
    setRunCharter(null);
    setRunTeam([]);
    setExecuteError(null);
    setCompletionRecap(null);
    setRunDone(false);
    setPlanNextKey(k => k + 1);
    setHistoricalSession(null);
    setReopenSeed(null);
    setReopenKey(k => k + 1);
    setIsInitiating(false);
    setRunConnectionKey(k => k + 1);
  }, []);

  const beginProjectSwitch = useCallback(
    (requestedRoot: string): number => {
      const generation = projectGenerationRef.current + 1;
      projectGenerationRef.current = generation;
      previousReadyProjectRef.current =
        projectStateRef.current.status === 'ready' ? projectStateRef.current.project : null;
      projectAbortRef.current.abort();
      projectAbortRef.current = new AbortController();
      resetProjectDerivedState();
      setProjectState({ status: 'switching', generation, requestedRoot });
      return generation;
    },
    [resetProjectDerivedState],
  );

  const acceptReadyProject = useCallback(
    (generation: number, project: ProjectEnvelope, nextRepoUrl?: string | null) => {
      if (generation !== projectGenerationRef.current) {
        return;
      }
      previousReadyProjectRef.current = project;
      setProjectState(previous => {
        if (
          previous.status === 'ready' &&
          previous.generation === generation &&
          previous.project.projectId === project.projectId &&
          previous.project.projectRoot === project.projectRoot &&
          previous.readiness.repoUrl === nextRepoUrl
        ) {
          return previous;
        }
        return { status: 'ready', generation, project, readiness: { repoUrl: nextRepoUrl } };
      });
      setRepoUrl(nextRepoUrl ?? null);
    },
    [],
  );

  const restorePreviousProject = useCallback((generation: number, message: string) => {
    if (generation !== projectGenerationRef.current) {
      return;
    }

    const previous = previousReadyProjectRef.current;
    if (previous) {
      setProjectState({ status: 'ready', generation, project: previous, readiness: {} });
      return;
    }

    setProjectState({ status: 'error', generation, message });
  }, []);

  const switchProject = useCallback(
    async (path: string): Promise<{ ok: boolean; error?: string }> => {
      const previous =
        projectStateRef.current.status === 'ready' ? projectStateRef.current.project : null;
      const generation = beginProjectSwitch(path);
      try {
        const response = await fetch('/project/switch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(previous ? { 'X-Swarm-Project-Id': previous.projectId } : {}),
          },
          body: JSON.stringify({ path }),
        });
        const data = (await response.json().catch(() => ({}))) as SwitchResponse;
        if (!response.ok || !data.ok) {
          const error = data.error ?? `HTTP ${response.status}`;
          restorePreviousProject(generation, error);
          return { ok: false, error };
        }

        const project =
          (await envelopeFromResponse(data)) ??
          (await envelopeFromResponse({
            root: data.root ?? path,
            project: data.project,
          }));
        if (!project) {
          const error = 'Switch succeeded without a project identity.';
          restorePreviousProject(generation, error);
          return { ok: false, error };
        }

        rememberRoot(project.projectRoot);
        try {
          localStorage.setItem('swarm-just-switched', project.projectRoot);
        } catch {
          /* private mode */
        }
        acceptReadyProject(generation, project, data.repoUrl);
        return { ok: true };
      } catch {
        const error = 'Network error';
        restorePreviousProject(generation, error);
        return { ok: false, error };
      }
    },
    [acceptReadyProject, beginProjectSwitch, restorePreviousProject],
  );

  // The live run connection lives HERE, above the surface switch: switching
  // tabs must never close the SSE stream, wipe live transcripts/spend, or —
  // worst of all — hide a pending permission request until it auto-denies.
  const run = useRealRun(projectClient, `${projectSurfaceKey}:${runConnectionKey}`);
  useRunNotifications(run.state?.status ?? 'running', run.state?.pendingPermission != null);

  const refreshCapabilities = useCallback(async () => {
    const response = await fetch('/capabilities', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      throw new Error('Swarm could not refresh provider capabilities.');
    }
    const data = (await response.json()) as CapabilitiesResponse;
    setPlaywrightAvailable(!!data.playwright);
    if (data.modelPolicy) {
      setModelPolicy(previous => normalizeModelPolicyResponse(data.modelPolicy, previous));
    }
  }, []);

  const refreshModelPolicy = useCallback(async () => {
    const response = await fetch('/providers/models', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      throw new Error('Swarm could not read model policy.');
    }
    const data = (await response.json()) as ModelPolicyResponse;
    setModelPolicy(previous => normalizeModelPolicyResponse(data, previous));
  }, []);

  useEffect(() => {
    // Initial capability/model-policy sync belongs to app bootstrap.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCapabilities().catch(() => {});
    void refreshModelPolicy().catch(() => {});
  }, [refreshCapabilities, refreshModelPolicy]);

  // Single server probe — retries every 3s, also reads project name when up. Hits the
  // lightweight /health endpoint (not /state) so this frequent poll doesn't re-read every
  // finding file from disk each tick; /state is fetched only by the Running view, which
  // needs the full task snapshot.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    let switchInFlight = false; // guards against overlapping /project/switch calls

    const probe = () => {
      const currentProject =
        projectStateRef.current.status === 'ready' ? projectStateRef.current.project : null;
      fetch('/health', {
        headers: currentProject ? { 'X-Swarm-Project-Id': currentProject.projectId } : undefined,
        signal: AbortSignal.timeout(2000),
      })
        .then(r => {
          if (!r.ok) {throw new Error();}
          return r.json();
        })
        .then(async (s: HealthResponse) => {
            if (!mounted) {return;}
            setServerStatus('up');
            const healthProject = await envelopeFromResponse(s);

            // Auto-sync: keep the server pointed at the remembered project. The server
            // resets its root to process.cwd() on every restart, so re-assert on EVERY
            // probe that shows drift — not just the first — or a run triggered after a
            // mid-session restart targets the wrong repo. We hold projectSynced=false
            // until a pending switch resolves so the Running tab never renders the wrong
            // project's state.
            const localRoot = loadRememberedRoot();
            const rootMismatch = !!(
              localRoot &&
              healthProject?.projectRoot &&
              localRoot !== healthProject.projectRoot
            );

            if (rootMismatch && !switchInFlight) {
              switchInFlight = true;
              const generation = beginProjectSwitch(localRoot!);
              const previous = previousReadyProjectRef.current;
              // setProjectRoot and setProjectSynced land in the same .then() so React
              // batches them into one render — <Running> always mounts with the right key.
              fetch('/project/switch', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(previous ? { 'X-Swarm-Project-Id': previous.projectId } : {}),
                },
                body: JSON.stringify({ path: localRoot }),
              })
                .then(
                  r =>
                    r.json() as Promise<{
                      ok: boolean;
                      project?: string;
                      repoUrl?: string | null;
                      root?: string;
                      activeProject?: ProjectEnvelope;
                      envelope?: ProjectEnvelope;
                      projectEnvelope?: ProjectEnvelope;
                    }>,
                )
                .then(async d => {
                  switchInFlight = false;
                  if (!mounted) {return;}
                  if (d.ok) {
                    const project =
                      (await envelopeFromResponse(d)) ??
                      (await envelopeFromResponse({
                        root: d.root ?? localRoot,
                        project: d.project,
                      }));
                    if (project) {
                      acceptReadyProject(generation, project, d.repoUrl);
                    } else {
                      restorePreviousProject(
                        generation,
                        'Switch succeeded without a project identity.',
                      );
                    }
                  } else {
                    // Saved path no longer valid — forget it so we stop retrying.
                    forgetRememberedRoot();
                    if (healthProject) {
                      acceptReadyProject(generation, healthProject, s.repoUrl);
                    } else {
                      restorePreviousProject(generation, 'Saved project path is no longer valid.');
                    }
                  }
                })
                .catch(() => {
                  switchInFlight = false;
                  // Network error — unblock with the server's root (already set above)
                  if (mounted && healthProject) {
                    acceptReadyProject(generation, healthProject, s.repoUrl);
                  }
                });
            } else if (!rootMismatch && healthProject && projectStateRef.current.status !== 'switching') {
              // On the right project (or nothing remembered) — unblock Running.
              acceptReadyProject(projectGenerationRef.current, healthProject, s.repoUrl);
            }

            // If a run has just STARTED (or the page was reopened mid-run), snap to
            // the Running tab. Transition-guarded: only fires when activeRun flips
            // false→true, never on every 3s probe — the un-guarded version yanked
            // the user back from Branches/Agents/History for the whole run.
            if (s.activeRun && !prevActiveRun.current) {setSurface('running');}
            prevActiveRun.current = !!s.activeRun;
            setModelPolicy(prev =>
              s.modelPolicy
                ? normalizeModelPolicyResponse(s.modelPolicy, prev)
                : { ...prev, activeRun: !!s.activeRun },
            );
            if (s.model) {
              setModelLabel(modelMeta(s.model)?.label ?? s.model.replace(/^claude-/, ''));
            }
          })
        .catch(() => {
          if (!mounted) {return;}
          setServerStatus('down');
          setModelPolicy(prev => ({ ...prev, activeRun: false }));
          // Don't touch projectSynced here — server being offline is not the
          // same as "confirmed on correct project". When server comes back up
          // the probe fires again, auto-sync runs, and projectSynced is set
          // properly. Running will mount below because serverStatus === 'down'
          // bypasses the spinner gate.
        })
        .finally(() => {
          if (mounted) {timer = setTimeout(probe, 3000);}
        });
    };

    probe();
    return () => {
      mounted = false;
      if (timer) {clearTimeout(timer);}
    };
  }, [acceptReadyProject, beginProjectSwitch, restorePreviousProject]);

  useEffect(() => {
    if (serverStatus !== 'up') {
      return;
    }
    // Server reconnection should refresh the latest model policy and capabilities.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCapabilities().catch(() => {});
    void refreshModelPolicy().catch(() => {});
  }, [refreshCapabilities, refreshModelPolicy, serverStatus]);

  // Persist surface so HMR / refresh restores the active tab.
  useEffect(() => {
    try {
      localStorage.setItem(SURFACE_KEY, surface);
    } catch {
      /* ignore */
    }
  }, [surface]);

  // Kick off a run with explicit values (no reliance on async state settling) —
  // used both by the Execute button (via goExecute) and by review auto-execute.
  const startRun = useCallback((goal: string, charter: RunCharter | null, team: string[]) => {
    if (!goal) {return;}
    if (!projectClient) {
      setExecuteError('Project is still loading.');
      return;
    }
    setExecuteError(null);

    // Optimistic: switch to Running immediately so the tab feels instant.
    // If the POST or the early SSE watch detects a failure we snap back to
    // Planning and surface the reason.
    setSurface('running');
    setIsInitiating(true);

    projectClient.fetchResponse('/run/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, charter, team }),
    })
      .then(r => {
        if (!r.ok)
          {return r.json().then((d: { error?: string }) => {
            throw new Error(d.error ?? `HTTP ${r.status}`);
          });}

        // Open a short-lived SSE listener. If the run gets blocked before the
        // first task arrives (e.g. git-dirty check), snap back to Planning with
        // the reason. Close after 20 s regardless — by then success is confirmed.
        const es = projectClient.eventSource('/events');
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            es.close();
          }
        };
        const timer = setTimeout(finish, 20_000);

        es.onmessage = ev => {
          let msg: { type: string; reason?: string; task?: unknown };
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (!projectClient.acceptsEvent(msg)) {
            return;
          }

          if (msg.type === 'task.created' || msg.type === 'run.classified') {
            setIsInitiating(false); // first task landed — hide spinner
            clearTimeout(timer);
            finish();
          } else if (msg.type === 'run.blocked') {
            clearTimeout(timer);
            finish();
            setIsInitiating(false);
            setExecuteError(msg.reason ?? 'Run was blocked before it could start');
            setSurface('planning');
          }
        };
        es.onerror = () => {
          clearTimeout(timer);
          finish();
        };
      })
      .catch((err: Error) => {
        if (projectClient.isStale()) {
          return;
        }
        // POST failed (409 conflict, network error, etc.) — snap back to Planning.
        setIsInitiating(false);
        setExecuteError(err.message);
        setSurface('planning');
      });
  }, [projectClient]);

  const startQuickTask = useCallback(async (instruction: string): Promise<QuickTaskStartResult> => {
    if (!projectClient) {
      throw new Error('Project is still loading.');
    }
    setExecuteError(null);
    const response = await projectClient.fetchResponse('/run/quick-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      status?: string;
      goal?: string;
      escalationReason?: string;
      riskSignals?: unknown;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    if (body.status === 'escalated') {
      return {
        status: 'escalated',
        escalationReason:
          body.escalationReason ?? 'Quick task preflight requires a broader workflow.',
        riskSignals: Array.isArray(body.riskSignals)
          ? body.riskSignals.filter((signal): signal is string => typeof signal === 'string')
          : [],
      };
    }
    if (body.status !== 'started' || !body.goal) {
      throw new Error('Quick task server returned an invalid start response.');
    }

    setRunGoal(body.goal);
    setRunCharter(null);
    setRunTeam([]);
    setRunDone(false);
    setIsInitiating(false);
    setRunConnectionKey(key => key + 1);
    setSurface('running');

    return { status: 'started' };
  }, [projectClient]);

  const handleExecutable = useCallback(
    (v: boolean, goal?: string, charter?: RunCharter, team?: string[], reason?: string) => {
      setExecutable(v);
      if (!v && reason) {setExecutableReason(reason);}
      if (v) {setExecutableReason('');}
      if (goal) {setRunGoal(goal);}
      if (charter) {setRunCharter(charter);}
      if (team) {setRunTeam(team);}
    },
    [],
  );

  const goExecute = useCallback(
    (goal = runGoal, charter = runCharter, team = runTeam) => startRun(goal, charter, team),
    [startRun, runGoal, runCharter, runTeam],
  );

  const handlePlanNext = useCallback(() => {
    setRunDone(false);
    setPlanNextKey(k => k + 1);
    setSurface('planning');
  }, []);

  // Seed an editable planning session from a viewed historical run, then leave history.
  const handleReopen = useCallback((snap: SessionSnapshot) => {
    setReopenSeed(snap);
    setReopenKey(k => k + 1);
    setHistoricalSession(null);
    setSurface('planning');
  }, []);

  // Called by Running when a PR is successfully created.
  // The URL flows down to Planning as recapMessage, where usePlanningSession
  // injects a completion chip and a PM "what's next?" prompt.
  const onPrCreated = useCallback((url: string) => {
    setCompletionRecap(url);
    setSurface('planning');
  }, []);

  const serverDot =
    serverStatus === 'up'
      ? 'var(--green)'
      : serverStatus === 'probing'
        ? 'var(--tx-3)'
        : 'var(--amber)';
  const serverLabel =
    serverStatus === 'up'
      ? 'agents ready'
      : serverStatus === 'probing'
        ? 'connecting…'
        : 'agents offline';
  const activeModelLabel = modelLabel ?? defaultModelLabel(modelPolicy) ?? 'PM model';
  const modelPolicyButton = modelPolicyButtonState({
    serverStatus,
    snapshot: {
      ...modelPolicy,
      activeRun: modelPolicy.activeRun || isInitiating,
    },
  });

  const submitModelPolicyChange = useCallback(async (draft: ModelPolicyDraft) => {
    setModelPolicyPending(true);
    setModelPolicyError(null);
    try {
      const response = await fetch('/providers/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = (await response.json().catch(() => ({}))) as ModelPolicyResponse;
      if (!response.ok) {
        throw new Error(data.error ?? 'Swarm could not change model policy.');
      }
      const nextPolicy = normalizeModelPolicyResponse(data, modelPolicy);
      setModelPolicy(nextPolicy);
      await refreshCapabilities();
      setModelLabel(defaultModelLabel(nextPolicy));
      setModelPolicyOpen(false);
    } catch (error) {
      setModelPolicyError(
        error instanceof Error ? error.message : 'Swarm could not change model policy.',
      );
    } finally {
      setModelPolicyPending(false);
    }
  }, [modelPolicy, refreshCapabilities]);

  return (
    <div className="app">
      <StaleServerBanner />
      <div className="topbar">
        <div className="brand">
          <span className="glyph">
            <i />
            <i />
            <i />
          </span>
          Agent&nbsp;Swarm
          {readyProject && (
            <>
              <span className="sep">/</span>
              <span className="proj" title={readyProject.projectRoot}>
                {readyProject.projectName}
              </span>
            </>
          )}
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={repoUrl}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: 'var(--tx-3)',
                textDecoration: 'none',
                marginLeft: 6,
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--tx-1)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--tx-3)')}
            >
              <IconGitHub />
            </a>
          )}
          <button
            className="folder-switch-btn"
            onClick={() => setShowSwitcher(true)}
            title="Switch project folder"
          >
            <IconFolder size={13} />
          </button>
        </div>
        <div className="nav">
          <button
            className={surface === 'planning' ? 'on' : ''}
            onClick={() => setSurface('planning')}
          >
            Planning
          </button>
          <button
            className={surface === 'running' ? 'on' : ''}
            onClick={() => setSurface('running')}
          >
            Running
          </button>
          <button
            className={surface === 'branches' ? 'on' : ''}
            onClick={() => setSurface('branches')}
          >
            Branches
          </button>
          <button
            className={surface === 'marketplace' ? 'on' : ''}
            onClick={() => setSurface('marketplace')}
          >
            Agents
          </button>
          <button
            className={surface === 'history' ? 'on' : ''}
            onClick={() => setSurface('history')}
          >
            History
          </button>
        </div>
        {historicalSession && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              color: 'var(--amber)',
              background: 'rgba(255,170,0,0.08)',
              border: '1px solid rgba(255,170,0,0.2)',
              borderRadius: 6,
              padding: '3px 10px',
              marginLeft: 6,
            }}
          >
            <span>⏱ history</span>
            <button
              onClick={() => historicalSession && handleReopen(historicalSession)}
              style={{ color: 'var(--blue)', fontSize: 11, lineHeight: 1 }}
              title="Seed a new, editable planning session from this run"
            >
              ↻ Re-open in Planning
            </button>
            <button
              onClick={() => setHistoricalSession(null)}
              style={{ color: 'var(--tx-3)', fontSize: 13, lineHeight: 1 }}
              title="Return to live"
            >
              ×
            </button>
          </span>
        )}
        {surface === 'running' && runDone && (
          <button className="btn primary" onClick={handlePlanNext} style={{ marginLeft: 10 }}>
            ← Plan next task
          </button>
        )}
        <div className="spacer" />

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--tx-2)',
            marginRight: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: serverDot,
              ...(serverStatus === 'probing' ? { animation: 'softpulse 1.4s infinite' } : {}),
            }}
          />
          {serverLabel}
          {serverStatus === 'up' && (
            <>
              <span style={{ color: 'var(--tx-3)', userSelect: 'none' }}>·</span>
              <button
                type="button"
                className="model-policy-trigger"
                onClick={() => setModelPolicyOpen(true)}
                disabled={modelPolicyButton.disabled}
                title={modelPolicyButton.reason ?? 'Choose enabled models and the PM default.'}
              >
                <span className="model-policy-trigger-label">{activeModelLabel}</span>
                <span className="model-policy-trigger-meta">
                  {modelPolicy.enabledModelIds.length
                    ? `${modelPolicy.enabledModelIds.length} enabled`
                    : 'configure'}
                </span>
              </button>
            </>
          )}
        </span>

        {surface === 'planning' && (
          <>
            {executeError ? (
              <span
                title={executeError}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--red)',
                  background: 'var(--red-d)',
                  border: '1px solid rgba(240,90,82,0.25)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  maxWidth: 420,
                }}
              >
                <span style={{ flexShrink: 0 }}>✗</span>
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {executeError.split('\n')[0]}
                </span>
                <button
                  onClick={() => setExecuteError(null)}
                  style={{
                    flexShrink: 0,
                    color: 'var(--red)',
                    opacity: 0.7,
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                  title="Dismiss"
                >
                  ×
                </button>
              </span>
            ) : (
              <span
                className="pill"
                title={executable ? 'Charter ready to execute' : executableReason}
              >
                <span
                  className="dot"
                  style={{ background: executable ? 'var(--green)' : 'var(--amber)' }}
                />
                PLANNING
              </span>
            )}
          </>
        )}
      </div>

      {showSwitcher && (
        <ProjectSwitcher
          currentRoot={readyProject?.projectRoot ?? null}
          onSwitchProject={switchProject}
          onClose={() => setShowSwitcher(false)}
        />
      )}

      <div className="surface">
        <ProjectClientProvider client={projectClient}>
          {!projectClient || projectState.status !== 'ready' ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
              }}
            >
              <span className="ps-spinner" style={{ width: 22, height: 22, borderWidth: 2.5 }} />
              <span style={{ color: 'var(--tx-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                {projectState.status === 'switching'
                  ? 'Switching project…'
                  : projectState.status === 'error'
                    ? projectState.message
                    : 'Loading project…'}
              </span>
            </div>
          ) : (
            <>
              <div
                key={`planning-${projectSurfaceKey}`}
                style={{
                  height: '100%',
                  display: surface === 'planning' ? 'block' : 'none',
                }}
              >
                <Planning
                  onExecute={goExecute}
                  onQuickTask={startQuickTask}
                  onExecutable={handleExecutable}
                  onNewSession={() => {
                    setRunGoal('');
                    setRunCharter(null);
                    setRunTeam([]);
                    setRunDone(false);
                  }}
                  onHire={agentId => {
                    setMarketplaceFocus(agentId);
                    setSurface('marketplace');
                  }}
                  serverStatus={serverStatus}
                  recapMessage={completionRecap}
                  planNextKey={planNextKey}
                  reopenKey={reopenKey}
                  reopenSeed={reopenSeed}
                  playwrightAvailable={playwrightAvailable}
                  runBlockedReason={executeError}
                  historicalSession={historicalSession ?? undefined}
                  modelPolicy={modelPolicy}
                  project={projectState.project}
                />
              </div>
              {surface === 'running' && (
                <Running
                  key={`running-${projectSurfaceKey}`}
                  run={run}
                  onPrCreated={onPrCreated}
                  onRunDone={() => setRunDone(true)}
                  isInitiating={isInitiating}
                  noActiveRun={!runGoal && !historicalSession}
                  historicalSession={historicalSession ?? undefined}
                />
              )}
              {surface === 'branches' && <Branches key={`branches-${projectSurfaceKey}`} />}
              {surface === 'marketplace' && (
                <Marketplace
                  key={`marketplace-${projectSurfaceKey}`}
                  projectName={projectState.project.projectName}
                  focusAgentId={marketplaceFocus}
                  onFocusConsumed={() => setMarketplaceFocus(null)}
                />
              )}
              {surface === 'history' && (
                <SessionsPanel
                  key={`history-${projectSurfaceKey}`}
                  projectClient={projectClient}
                  onSelectSession={session => {
                    setHistoricalSession(session);
                    setSurface('running');
                  }}
                  activeSessionId={historicalSession?.id}
                />
              )}
            </>
          )}
        </ProjectClientProvider>
      </div>

      {/* Above the surface switch: an agent blocked on approval must be visible
          (and answerable) from EVERY tab, not just Running — before this hoist
          the request silently auto-denied if you happened to be elsewhere. */}
      {run.state?.pendingPermission && (
        <PermissionGate request={run.state.pendingPermission} onResolve={run.resolvePermission} />
      )}

      {modelPolicyOpen && (
        <ModelPolicyModal
          snapshot={modelPolicy}
          serverStatus={serverStatus}
          pending={modelPolicyPending}
          error={modelPolicyError}
          onClose={() => setModelPolicyOpen(false)}
          onDismissError={() => setModelPolicyError(null)}
          onSave={draft => void submitModelPolicyChange(draft)}
        />
      )}
    </div>
  );
}
