type EnvValue = string | boolean | undefined;
type ImportMetaWithEnv = ImportMeta & { env?: Record<string, EnvValue> };

const env = (import.meta as ImportMetaWithEnv).env ?? {};

type TelemetryConfig = {
  windowId?: string;
  documentId?: string;
};

function readNonEmptyString(value: EnvValue): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const APP_VERSION = readNonEmptyString(env.VITE_APP_VERSION) ?? 'dev';

export function isTelemetryEnabled(): boolean {
  return false;
}

export function initTelemetry(_config: TelemetryConfig = {}): void {
  void APP_VERSION;
}

export function captureEvent(_event: string, _properties?: Record<string, unknown>): void {
  // OSS default: no telemetry.
}
