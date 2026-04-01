import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const serverSource = readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');
  const buildInfoSource = readFileSync(path.resolve(process.cwd(), 'server/build-info.ts'), 'utf8');

  const healthStart = serverSource.indexOf("app.get('/health', (_req, res) => {");
  assert(healthStart !== -1, 'Expected /health route in server/index.ts');

  const healthEnd = serverSource.indexOf("\n  app.get('/api/capabilities'", healthStart);
  assert(healthEnd !== -1, 'Expected to isolate /health route body');

  const healthBlock = serverSource.slice(healthStart, healthEnd);
  assert(healthBlock.includes('const buildInfo = getBuildInfo();'), 'Expected /health route to resolve build metadata via getBuildInfo()');

  const railwayIdx = buildInfoSource.indexOf('process.env.RAILWAY_GIT_COMMIT_SHA');
  const githubIdx = buildInfoSource.indexOf('process.env.GITHUB_SHA');
  const commitIdx = buildInfoSource.indexOf('process.env.COMMIT_SHA');
  const generatedIdx = buildInfoSource.indexOf('readGeneratedBuildInfo()?.sha');
  const agentdocIdx = buildInfoSource.indexOf('AGENTDOC_BUILD_SHA');

  assert(railwayIdx !== -1, 'Expected build-info helper to read RAILWAY_GIT_COMMIT_SHA');
  assert(githubIdx !== -1, 'Expected build-info helper to read GITHUB_SHA');
  assert(commitIdx !== -1, 'Expected build-info helper to read COMMIT_SHA');
  assert(generatedIdx !== -1, 'Expected build-info helper to read generated build metadata');
  assert(agentdocIdx !== -1, 'Expected build-info helper to read AGENTDOC_BUILD_SHA');
  assert(
    railwayIdx < generatedIdx && githubIdx < generatedIdx && commitIdx < generatedIdx && generatedIdx < agentdocIdx,
    'Regression guard: runtime deploy SHA env vars must win first, generated deploy metadata must win next, and fallback AGENTDOC_BUILD_SHA must stay last so stale manual env values do not lie about the active deployment',
  );

  console.log('✓ build-info helper preserves runtime SHA precedence before generated metadata and fallback AGENTDOC_BUILD_SHA');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
