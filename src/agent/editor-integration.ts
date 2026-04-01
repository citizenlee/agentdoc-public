import type { EditorView } from '@milkdown/kit/prose/view';

export function initAgentIntegration(_view: EditorView): void {
  // OSS default: embedded agent loop is disabled.
}

export function handleMarksChange(_marks: unknown[], _view: EditorView): void {
  // OSS default: embedded agent loop is disabled.
}

export function sweepForActionableItems(_triggerOnFirstSweep = false): void {
  // OSS default: embedded agent loop is disabled.
}

export function setAlwaysOnEnabled(_enabled: boolean): void {
  // OSS default: embedded agent loop is disabled.
}

export function configureAgent(): void {
  // OSS default: embedded agent loop is disabled.
}

export function isAgentReady(): boolean {
  return false;
}

export function cleanupAgentIntegration(): void {
  // OSS default: embedded agent loop is disabled.
}
