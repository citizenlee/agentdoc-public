import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_BUILD_INFO_PATH = path.resolve(__dirname, '..', '.agentdoc-build-info.json');

type GeneratedBuildInfo = {
  sha?: string | null;
  env?: string | null;
  generatedAt?: string | null;
};

export type RuntimeBuildInfo = {
  sha: string | null;
  env: string;
  generatedAt: string | null;
};

let cachedGeneratedBuildInfo: GeneratedBuildInfo | null | undefined;

function readNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEnvironment(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'development';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'stage' || normalized === 'staging') return 'staging';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'local') return 'development';
  if (normalized === 'test' || normalized === 'testing') return 'test';
  return normalized;
}

function readGeneratedBuildInfo(): GeneratedBuildInfo | null {
  if (cachedGeneratedBuildInfo !== undefined) {
    return cachedGeneratedBuildInfo;
  }

  try {
    const raw = readFileSync(GENERATED_BUILD_INFO_PATH, 'utf8');
    const parsed = JSON.parse(raw) as GeneratedBuildInfo;
    cachedGeneratedBuildInfo = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedGeneratedBuildInfo = null;
  }

  return cachedGeneratedBuildInfo;
}

function resolveRuntimeBuildSha(): string | null {
  return readNonEmptyString(process.env.RAILWAY_GIT_COMMIT_SHA)
    ?? readNonEmptyString(process.env.GITHUB_SHA)
    ?? readNonEmptyString(process.env.COMMIT_SHA)
    ?? readNonEmptyString(readGeneratedBuildInfo()?.sha)
    ?? readNonEmptyString(env('AGENTDOC_BUILD_SHA', 'PROOF_BUILD_SHA'));
}

export function getRuntimeEnvironment(): string {
  return normalizeEnvironment(
    readNonEmptyString(env('AGENTDOC_ENV', 'PROOF_ENV'))
      ?? readNonEmptyString(process.env.RAILWAY_ENVIRONMENT_NAME)
      ?? readNonEmptyString(process.env.RAILWAY_ENVIRONMENT)
      ?? readNonEmptyString(readGeneratedBuildInfo()?.env)
      ?? readNonEmptyString(process.env.NODE_ENV),
  );
}

export function getBuildInfo(): RuntimeBuildInfo {
  const generated = readGeneratedBuildInfo();
  return {
    sha: resolveRuntimeBuildSha(),
    env: getRuntimeEnvironment(),
    generatedAt: readNonEmptyString(generated?.generatedAt),
  };
}
