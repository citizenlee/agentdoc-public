# ADR: AgentDoc SDK Public Core

## Status

Accepted

## Decision

We are separating the hosted `AgentDoc` product from a reusable `AgentDoc SDK` core.

Inside this repo, the shared extraction boundary now lives under `packages/`:

- `@agentdoc/core`
- `@agentdoc/editor`
- `@agentdoc/server`
- `@agentdoc/sqlite`
- `@agentdoc/agent-bridge`

The hosted product keeps:

- hosted product auth and session flows
- hosted product branding and growth work
- product-specific agent UX and orchestration layers

The shared core keeps:

- document and provenance model
- editor-facing collaboration code
- generic document/share/collab server routes
- agent bridge protocol and typed client

## Consequences

- Shared changes should start at the package boundary, even before the public repo extraction happens.
- Hosted AgentDoc stays the user-facing product name.
- Public extraction target is `agentdoc-sdk`, with `AgentDoc SDK` as the project name and `AgentDoc` reserved for the hosted service.
