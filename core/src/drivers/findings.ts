// Finding markdown builders — shared by both drivers.
// Conforms to DESIGN.md §6.2a finding gate contract.

import type { Task } from '../state/types.js';
import type { SecurityFinding } from './types.js';

export function coderFinding(task: Task, summary: string, files: string[]): string {
  const list = files.length ? files.map(f => `  - ${f}`).join('\n') : '  (none recorded)';
  return [
    '---',
    `task: ${task.id}`,
    `agent: coder`,
    `schema: coder-finding`,
    `verdict: COMPLETE`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `## ${summary}`,
    '',
    '### Files changed',
    list,
    '',
  ].join('\n');
}

export function testerFinding(task: Task, verdict: string, summary: string, detail?: string): string {
  return [
    '---',
    `task: ${task.id}`,
    `agent: tester`,
    `schema: tester-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `## ${verdict}: ${summary}`,
    '',
    ...(detail ? [detail, ''] : []),
  ].join('\n');
}

export function securityFinding(task: Task, verdict: string, summary: string, items: SecurityFinding[]): string {
  const findingsList = items.length
    ? items.map(f =>
        `  - id: ${f.id}\n    severity: ${f.severity}\n    type: ${f.type}\n    location: ${f.location}`
      ).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: security`,
    `schema: security-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = items.length
    ? items.map(f => [
        `### ${f.id} — ${f.severity}: ${f.type}`,
        `**Location:** \`${f.location}\``,
        `**Fix:** ${f.fix}`,
        '',
      ].join('\n')).join('\n')
    : verdict === 'APPROVED'
      ? 'No security issues found.\n'
      : '';

  return header + `## ${verdict}: ${summary}\n\n` + body;
}
