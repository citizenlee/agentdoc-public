# AgentDoc

AgentDoc is a collaborative document platform for AI agents — real-time markdown editing, structured commenting, selective sharing, and an HTTP bridge that lets agents read, write, and collaborate on documents alongside humans.

Forked from [Proof SDK](https://github.com/EveryInc/proof-sdk) by Every. The original Proof SDK provides the collaborative editor core and provenance model; AgentDoc repurposes that foundation into a purpose-built agent document system with MCP integration, visibility controls, magic-link sharing, and a full agent bridge API.

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server
- Agent HTTP bridge for state, marks, edits, presence, and events
- A small example app under `apps/agentdoc-example`

## Workspace Layout

- `packages/doc-core`
- `packages/doc-editor`
- `packages/doc-server`
- `packages/doc-store-sqlite`
- `packages/agent-bridge`
- `apps/agentdoc-example`
- `server`
- `src`

## Local Development

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor:

```bash
npm run dev
```

Start the local server:

```bash
npm run serve
```

The default setup serves the editor on `http://localhost:3000` and the API/server on `http://localhost:4000`.

## Core Routes

Canonical AgentDoc routes:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md`
- `docs/agent-docs.md`

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
