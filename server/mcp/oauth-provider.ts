/**
 * MCP OAuth Server Provider that wraps Google OAuth for authentication.
 *
 * Flow:
 * 1. MCP client sends user to /oauth/authorize
 * 2. We redirect to Google OAuth
 * 3. Google authenticates, redirects back to our /mcp/oauth/google-callback
 * 4. We verify the Google user (must be in allowed domain), create an auth code
 * 5. Redirect back to the MCP client's redirect_uri with the auth code
 * 6. Client exchanges code at /oauth/token for an access token
 */
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  getClient,
  registerClient,
  createAuthCode,
  getAuthCode,
  markAuthCodeUsed,
  createAccessToken,
  verifyToken,
  revokeToken,
  createRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from './token-store.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';

/**
 * In-memory store for pending authorization flows.
 * Maps a random state token → the MCP client's original authorization params.
 */
const pendingFlows = new Map<string, {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
  createdAt: number;
}>();

// Clean up old pending flows every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, flow] of pendingFlows) {
    if (flow.createdAt < cutoff) pendingFlows.delete(key);
  }
}, 10 * 60 * 1000);

function getGoogleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID || '';
}

function getGoogleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET || '';
}

function getPublicUrl(): string {
  return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * Clients store backed by SQLite.
 */
class AgentDocClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const stored = getClient(clientId);
    if (!stored) return undefined;
    // Return redirect_uris as strings (not URL objects) because the SDK's
    // authorize handler compares them with Array.includes(string).
    // URL objects would never === a string, causing "Unregistered redirect_uri".
    return {
      client_id: stored.client_id,
      client_secret: stored.client_secret,
      client_id_issued_at: stored.client_id_issued_at,
      redirect_uris: stored.redirect_uris,
      client_name: stored.client_name,
    } as OAuthClientInformationFull;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const redirectUris = client.redirect_uris.map((u) => u.toString());
    const stored = registerClient({
      redirect_uris: redirectUris,
      client_name: client.client_name,
    });
    // Return strings — see getClient() comment for rationale.
    return {
      client_id: stored.client_id,
      client_secret: stored.client_secret,
      client_id_issued_at: stored.client_id_issued_at,
      redirect_uris: stored.redirect_uris,
      client_name: stored.client_name,
    } as OAuthClientInformationFull;
  }
}

/**
 * The main OAuth provider that wraps Google OAuth.
 */
export class AgentDocOAuthProvider implements OAuthServerProvider {
  get clientsStore(): OAuthRegisteredClientsStore {
    return new AgentDocClientsStore();
  }

  /**
   * Start the authorization flow by redirecting to Google OAuth.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const googleClientId = getGoogleClientId();
    if (!googleClientId) {
      res.status(503).json({ error: 'Google OAuth not configured' });
      return;
    }

    // Generate a unique state for this flow that links back to the MCP client's params
    const googleState = crypto.randomUUID();
    pendingFlows.set(googleState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
      createdAt: Date.now(),
    });

    const publicUrl = getPublicUrl();
    const callbackUrl = `${publicUrl}/mcp/oauth/google-callback`;

    const googleParams = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: googleState,
      hd: ALLOWED_DOMAIN,
      prompt: 'select_account',
    });

    res.redirect(`${GOOGLE_AUTH_URL}?${googleParams.toString()}`);
  }

  /**
   * Handle the Google OAuth callback and redirect back to the MCP client.
   * This is called from the Express route handler, not the MCP SDK.
   */
  async handleGoogleCallback(googleCode: string, googleState: string): Promise<{
    redirectUri: string;
    code: string;
    state?: string;
  }> {
    const flow = pendingFlows.get(googleState);
    if (!flow) {
      throw new Error('Invalid or expired authorization state');
    }
    pendingFlows.delete(googleState);

    const publicUrl = getPublicUrl();
    const callbackUrl = `${publicUrl}/mcp/oauth/google-callback`;

    // Exchange Google code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: googleCode,
        client_id: getGoogleClientId(),
        client_secret: getGoogleClientSecret(),
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[mcp-oauth] Google token exchange failed:', body);
      throw new Error('Google token exchange failed');
    }

    const tokens = (await tokenRes.json()) as { access_token: string };

    // Fetch Google user info
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) {
      throw new Error('Failed to fetch Google user info');
    }

    const userInfo = (await userRes.json()) as {
      email: string;
      name: string;
      picture: string;
      hd?: string;
    };

    // Enforce domain restriction
    const emailDomain = userInfo.email.split('@')[1];
    if (emailDomain !== ALLOWED_DOMAIN) {
      throw new Error(`Access denied. Only ${ALLOWED_DOMAIN} accounts are allowed. Got: ${userInfo.email}`);
    }

    // Create our own authorization code linked to this user
    const mcpCode = createAuthCode({
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.codeChallenge,
      userEmail: userInfo.email,
      userName: userInfo.name,
      userPicture: userInfo.picture,
      scope: flow.scopes?.join(' '),
    });

    return {
      redirectUri: flow.redirectUri,
      code: mcpCode,
      state: flow.state,
    };
  }

  /**
   * Return the code challenge for a given authorization code.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const stored = getAuthCode(authorizationCode);
    if (!stored) throw new Error('Unknown authorization code');
    if (stored.used) throw new Error('Authorization code already used');
    if (stored.expires_at < Math.floor(Date.now() / 1000)) throw new Error('Authorization code expired');
    return stored.code_challenge;
  }

  /**
   * Exchange an authorization code for tokens.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const stored = getAuthCode(authorizationCode);
    if (!stored) throw new Error('Unknown authorization code');
    if (stored.used) throw new Error('Authorization code already used');
    if (stored.expires_at < Math.floor(Date.now() / 1000)) throw new Error('Authorization code expired');
    if (stored.client_id !== client.client_id) throw new Error('Client ID mismatch');

    markAuthCodeUsed(authorizationCode);

    const { token, expiresIn } = createAccessToken({
      clientId: client.client_id,
      userEmail: stored.user_email,
      userName: stored.user_name,
      userPicture: stored.user_picture,
      scope: stored.scope,
    });

    const refreshToken = createRefreshToken({
      clientId: client.client_id,
      userEmail: stored.user_email,
      userName: stored.user_name,
      userPicture: stored.user_picture,
      scope: stored.scope,
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: stored.scope || undefined,
    };
  }

  /**
   * Exchange a refresh token for a new access token.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    // Rotate: verify + revoke old refresh token, issue a new one atomically.
    const rotated = rotateRefreshToken(refreshToken);
    if (!rotated) throw new Error('Invalid or expired refresh token');
    if (rotated.stored.client_id !== client.client_id) throw new Error('Client ID mismatch');

    const { token, expiresIn } = createAccessToken({
      clientId: client.client_id,
      userEmail: rotated.stored.user_email,
      userName: rotated.stored.user_name,
      userPicture: rotated.stored.user_picture,
      scope: rotated.stored.scope,
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: rotated.newRefreshToken,
      scope: rotated.stored.scope || undefined,
    };
  }

  /**
   * Verify an access token and return auth info.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = verifyToken(token);
    if (!stored) throw new Error('Invalid or expired access token');

    return {
      token,
      clientId: stored.client_id,
      scopes: stored.scope ? stored.scope.split(' ') : [],
      expiresAt: stored.expires_at,
      extra: {
        userEmail: stored.user_email,
        userName: stored.user_name,
        userPicture: stored.user_picture,
      },
    };
  }

  /**
   * Revoke a token.
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    if (request.token_type_hint === 'refresh_token') {
      revokeRefreshToken(request.token);
    } else {
      revokeToken(request.token);
    }
  }
}
