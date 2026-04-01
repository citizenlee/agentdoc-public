/**
 * Compile smoke test for the share server entrypoint.
 *
 * Catches syntax regressions in server/index.ts (including large template
 * literals) without requiring runtime boot or native module loading.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], sourceFile: ts.SourceFile): string {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (diagnostic.start === undefined) return message;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      return `${line + 1}:${character + 1} ${message}`;
    })
    .join('\n');
}

function run(): void {
  const serverPath = path.resolve(process.cwd(), 'server', 'index.ts');
  const dbPath = path.resolve(process.cwd(), 'server', 'db.ts');
  const collabPath = path.resolve(process.cwd(), 'server', 'collab.ts');
  const sourceText = readFileSync(serverPath, 'utf8');
  const dbSource = readFileSync(dbPath, 'utf8');
  const collabSource = readFileSync(collabPath, 'utf8');
  const sourceFile = ts.createSourceFile(serverPath, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  const transpiled = ts.transpileModule(sourceText, {
    fileName: serverPath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });

  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert(
    errors.length === 0,
    `server/index.ts should transpile without syntax errors:\n${formatDiagnostics(errors, sourceFile)}`,
  );

  assert(
    dbSource.includes('export function cleanupIdempotencyKeys'),
    'db.ts should expose cleanupIdempotencyKeys for startup maintenance',
  );
  assert(
    dbSource.includes('export function cleanupMutationOutbox'),
    'db.ts should expose cleanupMutationOutbox for startup maintenance',
  );
  assert(
    sourceText.includes('cleanupIdempotencyKeys'),
    'server/index.ts should schedule idempotency cleanup',
  );
  assert(
    sourceText.includes('cleanupMutationOutbox'),
    'server/index.ts should schedule mutation outbox cleanup',
  );
  assert(
    collabSource.includes('const docLastAccessedAt = new Map<string, number>();'),
    'collab runtime should track document access timestamps for eviction',
  );
  assert(
    collabSource.includes('const docEvictionInterval = setInterval'),
    'collab runtime should schedule periodic in-memory document eviction',
  );

  console.log('✓ compile smoke test: server/index.ts transpiles cleanly');
}

try {
  run();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
