// Persisted review draft — the comments a user leaves on a run's diff before asking
// for fixes. Stored under .swarm/ so they survive a reload and (phase 3) can be read
// by the coder that applies them. Single-user local tool: the whole comment set is
// written/read as one JSON document.

import fs from 'node:fs';
import path from 'node:path';
import { swarmDir } from '../state/repo.js';

export type ReviewStatus = 'open' | 'submitted' | 'planned' | 'fixing' | 'resolved';

export interface ReviewComment {
  id: string;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  body: string;
  status: ReviewStatus;
  createdAt: number;
}

function reviewDir(): string {
  return path.join(swarmDir(), 'review');
}

function reviewFile(): string {
  return path.join(reviewDir(), 'draft.json');
}

export function readReview(): ReviewComment[] {
  try {
    const raw = fs.readFileSync(reviewFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch {
    return [];
  }
}

export function writeReview(comments: ReviewComment[]): void {
  fs.mkdirSync(reviewDir(), { recursive: true });
  const tmp = reviewFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ comments }, null, 2));
  fs.renameSync(tmp, reviewFile());
}

export function clearReview(): void {
  try {
    fs.rmSync(reviewFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
}
