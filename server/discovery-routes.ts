import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './env.js';
import { resolveShareMarkdownAuthMode } from './hosted-auth.js';
import {
  AGENT_DOCS_PATH,
  ALT_SHARE_TOKEN_HEADER_FORMAT,
  AUTH_HEADER_FORMAT,
  CANONICAL_CREATE_API_PATH,
} from './agent-guidance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const discoveryRoutes = Router();

function trustProxyHeaders(): boolean {
  const value = (env('AGENTDOC_TRUST_PROXY_HEADERS', 'PROOF_TRUST_PROXY_HEADERS') || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getPublicBaseUrl(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedProtoHeader = req.header('x-forwarded-proto');
    const forwardedHostHeader = req.header('x-forwarded-host');
    const forwardedProto = typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim()
      : '';
    const forwardedHost = typeof forwardedHostHeader === 'string'
      ? forwardedHostHeader.split(',')[0]?.trim()
      : '';
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }

  const configuredBase = (env('AGENTDOC_PUBLIC_BASE_URL', 'PROOF_PUBLIC_BASE_URL') || '').trim();
  if (configuredBase) {
    return configuredBase.replace(/\/+$/, '');
  }

  const host = req.get('host') || '';
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}

const textSearchDirs = [
  path.resolve(__dirname, '..'),
  path.resolve(process.cwd()),
];

function loadRepoText(fileName: string): string | null {
  for (const dir of textSearchDirs) {
    try {
      return readFileSync(path.join(dir, fileName), 'utf8');
    } catch {
      // continue
    }
  }
  return null;
}

function loadAgentDocsMarkdown(): string | null {
  const docs = loadRepoText(path.join('docs', 'agent-docs.md'));
  if (docs) return docs;
  return loadRepoText('AGENT_CONTRACT.md');
}

discoveryRoutes.get('/.well-known/agent.json', (req: Request, res: Response) => {
  const base = getPublicBaseUrl(req);
  const apiBase = base ? `${base}/api` : '/api';
  const docsUrl = base ? `${base}${AGENT_DOCS_PATH}` : AGENT_DOCS_PATH;
  const skillUrl = base ? `${base}/agentdoc.SKILL.md` : '/agentdoc.SKILL.md';
  const setupUrl = base ? `${base}/agent-setup` : '/agent-setup';
  const shareBase = base || '';

  const authMode = resolveShareMarkdownAuthMode(base);
  const authMethods = authMode === 'none'
    ? ['none']
    : authMode === 'api_key'
      ? ['api_key']
      : authMode === 'oauth_or_api_key'
        ? ['api_key', 'oauth']
        : ['oauth'];

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    name: 'Agentdoc Editor',
    description: 'Agent-native markdown editor with collaborative sharing and provenance tracking',
    api_base: apiBase,
    docs_url: docsUrl,
    skill_url: skillUrl,
    setup_url: setupUrl,
    capabilities: ['create_document', 'share', 'comment', 'suggest', 'rewrite', 'collab', 'provenance'],
    auth: {
      methods: authMethods,
      api_key_header: 'Authorization: Bearer <key>',
      no_auth_allowed: authMode === 'none',
      shared_link: {
        token_from_url: '?token=<token>',
        preferred_header: AUTH_HEADER_FORMAT,
        alt_header: ALT_SHARE_TOKEN_HEADER_FORMAT,
      },
    },
    quickstart: {
      received_link: {
        description: 'Given an Agentdoc share URL, read it (and discover state/ops) in one step.',
        method: 'GET',
        url: `${shareBase}/d/{slug}?token={token}`,
        headers: { Accept: 'application/json' },
        returns: 'markdown + _links + agent.auth',
      },
      create_and_share: {
        method: 'POST',
        url: CANONICAL_CREATE_API_PATH,
        body: { markdown: '# Hello World', title: 'My Document' },
        returns: 'shareUrl (editable link to share with anyone)',
      },
    },
  });
});

function replaceBaseUrl(content: string, req: Request): string {
  const base = getPublicBaseUrl(req);
  if (!base) return content;
  return content.replace(/http:\/\/localhost:4000/g, base);
}

discoveryRoutes.get('/agentdoc.SKILL.md', (req: Request, res: Response) => {
  const skill = loadRepoText(path.join('docs', 'agentdoc.SKILL.md'));
  if (!skill) {
    res.status(404).type('text/plain').send('agentdoc.SKILL.md not found');
    return;
  }
  res.type('text/markdown; charset=utf-8').send(replaceBaseUrl(skill, req));
});

discoveryRoutes.get('/AGENT_CONTRACT.md', (req: Request, res: Response) => {
  const contract = loadRepoText('AGENT_CONTRACT.md');
  if (!contract) {
    res.status(404).type('text/plain').send('AGENT_CONTRACT.md not found');
    return;
  }
  res.type('text/markdown; charset=utf-8').send(replaceBaseUrl(contract, req));
});

discoveryRoutes.get('/agent-docs', (req: Request, res: Response) => {
  const doc = loadAgentDocsMarkdown();
  if (!doc) {
    res.status(404).type('text/plain').send('agent-docs not found');
    return;
  }
  res.type('text/markdown; charset=utf-8').send(replaceBaseUrl(doc, req));
});
