# Vikunja connector for Claude

A small remote MCP server that lets Claude read and manage tasks in a self-hosted
[Vikunja](https://vikunja.io) instance (built for `projects.wambach-house.com`, Vikunja v2.4).
It runs as a Docker container on your home server, is published through a Cloudflare Tunnel,
and is added to Claude as a **custom connector**.

```
Claude ──HTTPS──> Cloudflare Tunnel ──> vikunja-mcp container ──API token──> Vikunja
```

## What Claude can do

| Area | Tools |
| --- | --- |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project` (rename, move, archive) |
| Tasks | `search_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`, `move_task`, `delete_task` |
| Labels | `list_labels`, `add_label`, `remove_label` (labels are created on the fly when needed) |
| Collaboration | `add_comment`, `find_users`, `assign_task` |

`search_tasks` covers the common cases with simple parameters (project, due before/after, minimum
priority, label, assignee) and also accepts a raw Vikunja filter such as
`due_date < now+7d && priority >= 3`. It returns open tasks only unless asked otherwise.

## Setup

### 1. Create a Vikunja API token

In Vikunja, open **Settings → API Tokens → Create a token**. Give it permission for projects, tasks,
labels, task comments, task assignees and users. Copy the token.

### 2. Configure

On your home server:

```bash
git clone https://github.com/scwambach/projects-custom-container.git
cd projects-custom-container
cp .env.example .env
openssl rand -hex 32        # paste the output into MCP_SECRET
nano .env                   # fill in VIKUNJA_TOKEN and MCP_SECRET
```

If Vikunja runs on the same Docker host, `VIKUNJA_URL` can be its internal address
(e.g. `http://vikunja:3456`) so the traffic never leaves the machine. Put both containers on a shared
network in that case.

### 3. Run it behind a Cloudflare Tunnel

**Option A: you already have cloudflared running** (for Vikunja itself):

1. Start the connector: `docker compose up -d --build`
2. Connect your cloudflared container to the connector's network:
   `docker network connect vikunja-mcp <your-cloudflared-container>`
3. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels → your tunnel → Public hostnames),
   add a hostname such as `mcp.wambach-house.com` pointing to `http://vikunja-mcp:3000`.

**Option B: a separate tunnel just for this:**

1. Create a new tunnel in the Cloudflare dashboard and copy its token into `CLOUDFLARE_TUNNEL_TOKEN`.
2. Add a public hostname such as `mcp.wambach-house.com` pointing to `http://vikunja-mcp:3000`.
3. Start both containers: `docker compose --profile tunnel up -d --build`

Check that it's up: `curl https://mcp.wambach-house.com/healthz` should return `{"ok":true}`, and
`docker compose logs vikunja-mcp` should show `Connected to … as <your username>`.

> Don't put this hostname behind Cloudflare Access: Claude's servers can't complete an Access login.
> The secret URL is what protects it.

### 4. Add it to Claude

In claude.ai go to **Settings → Connectors → Add custom connector** and enter:

- **Name:** Vikunja
- **URL:** `https://mcp.wambach-house.com/mcp/<your MCP_SECRET>`

Leave the OAuth fields empty. Then enable the connector in a chat and try
"what's due this week in Vikunja?".

## Security notes

- Anyone with the full connector URL can act as you in Vikunja, so treat it like a password.
  Requests to any other path return 404.
- To rotate, generate a new `MCP_SECRET`, run `docker compose up -d`, and update the connector URL in
  Claude. To cut off access entirely, revoke the API token in Vikunja.
- The server is stateless and stores nothing; it only forwards calls to Vikunja with your token.
- Delete is exposed only for single tasks, and it's marked destructive so Claude asks before using it.

## Updating

```bash
git pull && docker compose up -d --build
```

## Development

```bash
npm install
npm test          # builds, then runs every tool against a mock Vikunja
VIKUNJA_URL=… VIKUNJA_TOKEN=… MCP_SECRET=… npm start
```

Code layout: `src/index.ts` (HTTP server and secret check), `src/tools.ts` (tool definitions),
`src/vikunja.ts` (API client and response shaping).
