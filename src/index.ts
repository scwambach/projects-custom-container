import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Vikunja } from "./vikunja.js";
import { registerTools } from "./tools.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const VIKUNJA_URL = requireEnv("VIKUNJA_URL");
const VIKUNJA_TOKEN = requireEnv("VIKUNJA_TOKEN");
const MCP_SECRET = requireEnv("MCP_SECRET");
const PORT = Number(process.env.PORT ?? 3000);

if (MCP_SECRET.length < 32) {
  console.error("MCP_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
  process.exit(1);
}

const vikunja = new Vikunja(VIKUNJA_URL, VIKUNJA_TOKEN);

function buildServer() {
  const server = new McpServer(
    { name: "vikunja", version: "1.0.0" },
    {
      instructions:
        "Tools for the user's self-hosted Vikunja task manager. Use list_projects to find project IDs, " +
        "search_tasks to find tasks, and get_task for details. Dates are ISO 8601; include the user's " +
        "timezone offset. Confirm before deleting anything.",
    },
  );
  registerTools(server, vikunja);
  return server;
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The connector URL is https://<host>/mcp/<MCP_SECRET>. A Bearer header with the secret also works,
// for clients that support custom headers.
function checkSecret(req: Request, res: Response, next: NextFunction) {
  const fromPath = typeof req.params.secret === "string" ? req.params.secret : "";
  const header = req.headers.authorization ?? "";
  const fromHeader = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (safeEqual(fromPath, MCP_SECRET) || safeEqual(fromHeader, MCP_SECRET)) return next();
  res.status(404).json({ error: "Not found" });
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server and transport per request, nothing kept in memory.
async function handleMcp(req: Request, res: Response) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
};

for (const path of ["/mcp/:secret", "/mcp"]) {
  app.post(path, checkSecret, handleMcp);
  app.get(path, checkSecret, methodNotAllowed);
  app.delete(path, checkSecret, methodNotAllowed);
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Vikunja MCP server listening on :${PORT}`);
  try {
    const user = await vikunja.get("/user");
    console.log(`Connected to ${VIKUNJA_URL} as ${user.username}`);
  } catch (err) {
    console.error(`Warning: could not reach Vikunja with the configured token: ${(err as Error).message}`);
  }
});
