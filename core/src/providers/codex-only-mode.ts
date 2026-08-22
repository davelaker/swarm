import { execFileSync } from 'node:child_process';
import type { CliProbe } from './discovery.js';

export type ProviderMode = 'normal' | 'codex_only';

let mode: ProviderMode = 'normal';
let revision = 0;

function commandIsAvailable(command: string): boolean {
  try {
    // --version is deliberately the only command run: it establishes that the
    // executable is usable without querying, logging, or exposing credentials.
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function getProviderMode(): ProviderMode {
  return mode;
}

export function isCodexOnlyModeEnabled(): boolean {
  return mode === 'codex_only';
}

export function providerModeRevision(): number {
  return revision;
}

export function codexCliSubscriptionTransportAvailable(
  probe: CliProbe = commandIsAvailable,
): boolean {
  return probe('codex');
}

export function setProviderMode(nextMode: ProviderMode): void {
  if (mode === nextMode) {
    return;
  }
  mode = nextMode;
  revision += 1;
}

export function enableCodexOnlyMode(probe: CliProbe = commandIsAvailable): void {
  if (!codexCliSubscriptionTransportAvailable(probe)) {
    throw new Error('Codex-only mode requires the local Codex CLI subscription transport.');
  }
  setProviderMode('codex_only');
}

export function disableCodexOnlyMode(): void {
  setProviderMode('normal');
}

