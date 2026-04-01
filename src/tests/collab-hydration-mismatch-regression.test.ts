import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');

  assert(
    source.includes('yXmlFragmentToProseMirrorRootNode'),
    'Expected collab hydration guard to compare editor content against the live Yjs fragment',
  );
  assert(
    source.includes('private normalizeCollabHydrationText(text: string): string {')
      && source.includes('private getEditorHydrationText(): string | null {')
      && source.includes('private getYjsFragmentHydrationText(fragment: unknown): string | null {'),
    'Expected explicit collab hydration text helpers for editor + fragment comparison',
  );
  assert(
    source.includes('const fragmentText = this.getYjsFragmentHydrationText(fragment);')
      && source.includes('const editorText = this.getEditorHydrationText();')
      && source.includes('return editorText === fragmentText;'),
    'Expected collab hydration to require matching editor + fragment text before enabling editing',
  );
  assert(
    !source.includes("if (this.isYjsFragmentStructurallyEmpty(fragment)) return true;\n    return !this.isEditorDocStructurallyEmpty();"),
    'Did not expect the legacy non-empty editor doc shortcut to remain in collab hydration',
  );

  console.log('✓ collab hydration mismatch guard checks');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
