# AgentDoc Example

This workspace is the demo app for AgentDoc.

It demonstrates:

- creating a document
- loading a shared document
- collaborative editing
- agent bridge reads and writes
- anonymous or token-based access

## Agent Bridge Demo

Run the reference external-agent flow:

```bash
npm run agentdoc:demo:agent
```

Environment variables:

- `AGENTDOC_BASE_URL`: defaults to `http://127.0.0.1:4000`
- `AGENTDOC_DEMO_TITLE`: optional document title override
- `AGENTDOC_DEMO_MARKDOWN`: optional initial markdown override

The demo creates a document through `POST /documents`, then uses `@agentdoc/agent-bridge` to publish presence, read state, and add a comment through the `/documents/:slug/bridge/*` API.
