import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectEnvelopeForRoot } from '../state/project-identity.js';
import { getRoot, setRoot } from '../state/repo.js';
import { startServer } from './index.js';

async function availablePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as AddressInfo).port;
  server.close();
  await once(server, 'close');
  return port;
}

async function closeServer(server: ReturnType<typeof startServer>): Promise<void> {
  server.close();
  await once(server, 'close');
}

test('project-bound requests with a stale expected project id fail closed', async () => {
  const originalRoot = getRoot();
  const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-active-project-'));
  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-stale-project-'));
  const activeProject = projectEnvelopeForRoot(activeRoot);
  const staleProject = projectEnvelopeForRoot(staleRoot);
  const port = await availablePort();
  setRoot(activeRoot);
  const server = startServer(port);

  try {
    await once(server, 'listening');

    const response = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: {
        'X-Swarm-Project-Id': staleProject.projectId,
      },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'project_mismatch',
      expectedProjectId: staleProject.projectId,
      activeProject,
    });
  } finally {
    await closeServer(server);
    setRoot(originalRoot);
    fs.rmSync(activeRoot, { recursive: true, force: true });
    fs.rmSync(staleRoot, { recursive: true, force: true });
  }
});
