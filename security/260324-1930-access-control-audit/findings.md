# Security Audit Findings — 2026-03-24

## Critical Findings (Fixed)

### 1. PUT /documents/:slug/title — No Authentication (FIXED)
- **Severity**: CRITICAL
- **OWASP**: A01:2021 Broken Access Control
- **STRIDE**: Tampering, Elevation of Privilege
- **File**: `server/routes.ts:1297`
- **Attack**: Any unauthenticated user could change any document's title by sending `PUT /documents/:slug/title` with a JSON body. Only needed to know/guess the 8-character slug.
- **Proof**: `curl -X PUT .../documents/f1ivgc8m/title -d '{"title":"HACKED"}'` returned 200.
- **Fix**: Added auth check requiring session (owner) or valid access token with editor role. Now returns 403.

### 2. POST /documents — No Authentication (FIXED)
- **Severity**: HIGH
- **OWASP**: A01:2021 Broken Access Control
- **STRIDE**: Elevation of Privilege
- **File**: `server/routes.ts:813`
- **Attack**: Anyone could create documents on the server without any authentication. Could be used for spam, storage abuse, or as a stepping stone for other attacks.
- **Proof**: `curl -X POST .../documents -d '{"markdown":"test","title":"spam"}'` returned 200 with full access credentials.
- **Fix**: Added auth check requiring session, bearer token, or API key. Now returns 401.

## Passed Checks

| Vector | Result |
|--------|--------|
| Private doc access (IDOR) | 401 — properly blocked |
| Shared/org doc access | 401 — properly blocked |
| Slug enumeration | Same 401 for real and fake slugs — no information leak |
| WebSocket auth bypass | Connection opens but closes immediately with 0 data leaked |
| Document deletion | Requires owner auth |
| Share management | Requires sign-in |
| Document operations (ops) | Has authorizeDocumentOp check |
| Document editing (PUT) | Has getAccessRole check |

## Architectural Strengths

- All SQL queries use parameterized statements (zero SQL injection risk)
- Timing-safe comparisons for all secret verification
- SHA256 hashing for access tokens, owner secrets, refresh tokens
- CSRF protection via SameSite cookies + OAuth state parameter
- Rate limiting on mutation endpoints
- WebSocket auth with epoch-based revocation

## Recommendations (not yet addressed)

1. **Magic token expiration**: Add `expires_at` to document_shares magic tokens
2. **Refresh token rotation**: Rotate MCP refresh tokens on use
3. **Remove 'null' from default CORS origins**: Prevents cross-origin attacks from sandboxed iframes
4. **Hash magic tokens**: Currently stored plaintext, should be SHA256-hashed like access tokens
5. **Distributed rate limiting**: Current in-memory implementation resets on restart
