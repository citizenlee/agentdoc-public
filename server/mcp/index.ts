/**
 * MCP Server for AgentDoc.
 *
 * Provides:
 * - OAuth 2.0 authorization (wrapping Google OAuth) for MCP clients
 * - MCP Streamable HTTP transport at /mcp
 * - Document tools: read, list, create, edit, share, list_comments, resolve_comment
 *
 * Mount with: mountMcp(app) in the main Express server.
 */
import { randomUUID } from 'crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { AgentDocOAuthProvider } from './oauth-provider.js';
import { registerTools } from './tools.js';
import { cleanupExpiredTokens } from './token-store.js';

const oauthProvider = new AgentDocOAuthProvider();

function getPublicUrl(): string {
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * Create a fresh MCP server instance with all tools registered.
 */
function createMcpServer(): McpServer {
  const mcp = new McpServer(
    {
      name: 'agentdoc',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(mcp);
  return mcp;
}

/**
 * Mount all MCP endpoints on the Express app.
 *
 * Endpoints:
 * - GET  /.well-known/oauth-protected-resource  (auto from mcpAuthRouter)
 * - GET  /.well-known/oauth-authorization-server (auto from mcpAuthRouter)
 * - POST /oauth/register                        (dynamic client registration)
 * - GET  /oauth/authorize                        (→ redirects to Google)
 * - POST /oauth/token                            (code → token exchange)
 * - POST /oauth/revoke                           (token revocation)
 * - GET  /mcp/oauth/google-callback              (Google OAuth callback)
 * - POST /mcp                                    (MCP Streamable HTTP)
 * - GET  /mcp                                    (MCP SSE stream)
 * - DELETE /mcp                                  (MCP session cleanup)
 */
export function mountMcp(app: Express): void {
  const publicUrl = getPublicUrl();
  if (!publicUrl) {
    console.warn('[mcp] PUBLIC_URL not set — MCP OAuth will not work correctly without it');
  }

  const issuerUrl = new URL(publicUrl || 'http://localhost:4000');

  // --- OAuth routes (metadata, registration, authorize, token, revoke) ---
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      serviceDocumentationUrl: new URL('/install', issuerUrl),
      scopesSupported: ['read', 'write'],
      resourceName: 'AgentDoc',
    }),
  );

  // --- Google OAuth callback (step 3 of the flow) ---
  app.get('/mcp/oauth/google-callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    if (error) {
      res.status(403).send(`Authentication failed: ${error}`);
      return;
    }

    if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
      res.status(400).send('Missing authorization code or state');
      return;
    }

    try {
      const result = await oauthProvider.handleGoogleCallback(code, state);

      // Redirect back to the MCP client's redirect_uri with our authorization code
      const redirectUrl = new URL(result.redirectUri);
      redirectUrl.searchParams.set('code', result.code);
      if (result.state) {
        redirectUrl.searchParams.set('state', result.state);
      }

      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error('[mcp] Google callback error:', err);
      const message = err instanceof Error ? err.message : 'Authentication failed';
      res.status(403).send(message);
    }
  });

  // --- MCP Streamable HTTP transport ---
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: `${issuerUrl.origin}/.well-known/oauth-protected-resource`,
  });

  // POST /mcp — main MCP request handler
  app.post('/mcp', bearerAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session — create transport and server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, transport);
          transport.onclose = () => {
            transports.delete(sessionId);
          };
        },
      });

      const mcp = createMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] Error handling POST /mcp:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    try {
      await transports.get(sessionId)!.handleRequest(req, res);
    } catch (err) {
      console.error('[mcp] Error handling GET /mcp:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // DELETE /mcp — session cleanup
  app.delete('/mcp', bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      try {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
      } catch (err) {
        console.error('[mcp] Error closing session:', err);
      }
    }
    res.status(200).end();
  });

  // --- Periodic cleanup ---
  setInterval(() => {
    try {
      cleanupExpiredTokens();
    } catch (err) {
      console.error('[mcp] Token cleanup error:', err);
    }
  }, 60 * 60 * 1000); // every hour

  console.log('[mcp] MCP server mounted at /mcp with OAuth at /oauth/*');
}
