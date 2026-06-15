import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrontendFile, filesToRoutes } from './visual.js';

test('isFrontendFile accepts components, rejects tests/hooks/non-frontend', () => {
  assert.equal(isFrontendFile('app/wars/page.tsx'), true);
  assert.equal(isFrontendFile('components/eclipse/war-view.tsx'), true);
  assert.equal(isFrontendFile('lib/queries/wars.ts'), false);
  assert.equal(isFrontendFile('app/page.test.tsx'), false);
  assert.equal(isFrontendFile('src/hooks/useThing.tsx'), false);
});

test('filesToRoutes maps Next app + pages routers and skips dynamic segments', () => {
  const { routes, skippedDynamic } = filesToRoutes([
    'app/page.tsx',
    'app/wars/page.tsx',
    'app/(marketing)/about/page.tsx',
    'app/wars/[warId]/page.tsx',
    'pages/roster.tsx',
    'pages/index.tsx',
    'components/eclipse/war-view.tsx', // not a route file → ignored
  ]);
  assert.deepEqual(routes.sort(), ['/', '/about', '/roster', '/wars'].sort());
  assert.deepEqual(skippedDynamic, ['/wars/[warId]']);
});
