---
name: agentdoc
description: Write a shareable document to the AgentDoc instance. Use when the user says "write this as an agentdoc", "share this as a doc", "create an agentdoc", or wants to publish something for team feedback.
allowed-tools: Bash, Read, Grep, Glob, WebFetch
argument-hint: [topic or content description]
---

# AgentDoc

Write content to a shared AgentDoc document so others can view, comment, and collaborate.

## Workflow

**Do everything in a single Bash call** using a python3 heredoc. No temp files. The markdown content goes inside the python heredoc, python handles JSON encoding, and posts to the API — all in one invocation.

### Create a new document

```bash
python3 << 'PYEOF'
import json, urllib.request, subprocess, os

author = subprocess.check_output(['id', '-F'], stderr=subprocess.DEVNULL).decode().strip()
email = subprocess.check_output(['git', 'config', 'user.email'], stderr=subprocess.DEVNULL).decode().strip() if True else ''
title = "TITLE_HERE"

content = r"""
YOUR MARKDOWN CONTENT HERE
"""

payload = json.dumps({'title': title, 'ownerId': author, 'ownerEmail': email, 'markdown': content.strip()})
req = urllib.request.Request(
    'https://agentdoc.up.railway.app/documents',
    data=payload.encode(),
    headers={'Content-Type': 'application/json'},
    method='POST'
)
data = json.loads(urllib.request.urlopen(req).read())

# Save state for future updates
state_dir = os.path.join(os.getcwd(), '.agentdoc')
os.makedirs(state_dir, exist_ok=True)
with open(os.path.join(state_dir, 'state.json'), 'w') as f:
    json.dump({'slug': data['slug'], 'accessToken': data['accessToken'],
               'ownerSecret': data['ownerSecret'], 'title': title}, f, indent=2)

print(f'https://agentdoc.up.railway.app/d/{data["slug"]}')
PYEOF
```

### Update an existing document

If `.agentdoc/state.json` exists in the working directory, update instead of create:

```bash
python3 << 'PYEOF'
import json, urllib.request, subprocess, os

author = subprocess.check_output(['id', '-F'], stderr=subprocess.DEVNULL).decode().strip()
base_url = 'https://agentdoc.up.railway.app'

# Load state
with open(os.path.join(os.getcwd(), '.agentdoc', 'state.json')) as f:
    state = json.load(f)
slug, token = state['slug'], state['accessToken']

# Get current revision
req = urllib.request.Request(f'{base_url}/documents/{slug}/state',
                             headers={'Authorization': f'Bearer {token}'})
revision = json.loads(urllib.request.urlopen(req).read())['revision']

content = r"""
YOUR UPDATED MARKDOWN CONTENT HERE
"""

payload = json.dumps({'type': 'rewrite.apply', 'by': author,
                      'baseRevision': revision, 'content': content.strip()})
req = urllib.request.Request(
    f'{base_url}/documents/{slug}/ops',
    data=payload.encode(),
    headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
    method='POST'
)
urllib.request.urlopen(req)
print(f'{base_url}/d/{slug}')
PYEOF
```

## Key Rules

1. **One Bash call, one python3 heredoc, no temp files.** The markdown goes inside `content = r"""..."""` in the python script.
2. **Create vs update**: Check if `.agentdoc/state.json` exists. If yes, update. If no, create.
3. **Show the URL without token** — the token parameter creates an anonymous magic link. Just print `https://agentdoc.up.railway.app/d/{slug}`.
4. **State is saved automatically** to `.agentdoc/state.json` on create. Do not commit this file (contains tokens).
5. Always attribute content with the user's name (from `id -F`), NOT "ai:claude-code".

## Content Guidelines

- Write polished, well-structured markdown
- Use a clear H1 title as the first line
- Include sections with H2/H3 headings for longer content
- For technical content: include code blocks, tables, and diagrams where helpful
- For research/analysis: include sources, key findings, and recommendations
