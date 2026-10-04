// Smoke test: runs a fake Vikunja API, starts the MCP server against it,
// and drives every tool through a real MCP client. Run with: npm test
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "tk_test";
const SECRET = "s".repeat(40);
const NULL = "0001-01-01T00:00:00Z";

// ---- fake Vikunja ----
let nextId = 100;
const db = {
  projects: [{ id: 1, title: "Inbox", description: "", parent_project_id: 0, is_archived: false }],
  tasks: [
    { id: 10, title: "Fix gutter", description: "", done: false, project_id: 1, priority: 3, due_date: "2026-10-08T17:00:00Z", labels: [], assignees: [], created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" },
  ],
  labels: [{ id: 5, title: "home" }],
  comments: {},
  users: [{ id: 1, username: "scott", name: "Scott" }],
};
const calls = [];

const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace("/api/v1", "");
  calls.push(`${req.method} ${p}${url.search}`);
  const send = (s, d, h = {}) => {
    res.writeHead(s, { "content-type": "application/json", ...h });
    res.end(JSON.stringify(d));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "bad token" });
  const json = body ? JSON.parse(body) : {};
  let m;
  if (req.method === "GET" && p === "/user") return send(200, db.users[0]);
  if (req.method === "GET" && p === "/projects") return send(200, db.projects, { "x-pagination-total-pages": "1" });
  if (req.method === "PUT" && p === "/projects") { const pr = { id: nextId++, ...json }; db.projects.push(pr); return send(201, pr); }
  if ((m = p.match(/^\/projects\/(\d+)$/))) {
    const pr = db.projects.find((x) => x.id === +m[1]);
    if (!pr) return send(404, { message: "project not found" });
    if (req.method === "GET") return send(200, pr);
    if (req.method === "POST") { Object.assign(pr, json); return send(200, pr); }
  }
  if (req.method === "GET" && p === "/tasks") {
    let t = db.tasks;
    const f = url.searchParams.get("filter") ?? "";
    if (f.includes("done = false")) t = t.filter((x) => !x.done);
    return send(200, t, { "x-pagination-total-pages": "1" });
  }
  if ((m = p.match(/^\/projects\/(\d+)\/tasks$/)) && req.method === "PUT") {
    const t = { id: nextId++, done: false, labels: [], assignees: [], priority: 0, due_date: NULL, project_id: +m[1], created: "now", updated: "now", ...json };
    db.tasks.push(t); return send(201, t);
  }
  if ((m = p.match(/^\/tasks\/(\d+)$/))) {
    const t = db.tasks.find((x) => x.id === +m[1]);
    if (!t) return send(404, { message: "task not found" });
    if (req.method === "GET") return send(200, t);
    if (req.method === "POST") { if (!json.title) return send(400, { message: "full object required" }); Object.assign(t, json); return send(200, t); }
    if (req.method === "DELETE") { db.tasks = db.tasks.filter((x) => x !== t); return send(200, { message: "ok" }); }
  }
  if (req.method === "GET" && p === "/labels") {
    const s = (url.searchParams.get("s") ?? "").toLowerCase();
    return send(200, db.labels.filter((l) => l.title.toLowerCase().includes(s)), { "x-pagination-total-pages": "1" });
  }
  if (req.method === "PUT" && p === "/labels") { const l = { id: nextId++, ...json }; db.labels.push(l); return send(201, l); }
  if ((m = p.match(/^\/tasks\/(\d+)\/labels$/)) && req.method === "PUT") {
    const t = db.tasks.find((x) => x.id === +m[1]); t.labels.push(db.labels.find((l) => l.id === json.label_id)); return send(201, json);
  }
  if ((m = p.match(/^\/tasks\/(\d+)\/labels\/(\d+)$/)) && req.method === "DELETE") {
    const t = db.tasks.find((x) => x.id === +m[1]); t.labels = t.labels.filter((l) => l.id !== +m[2]); return send(200, {});
  }
  if ((m = p.match(/^\/tasks\/(\d+)\/comments$/))) {
    const list = (db.comments[m[1]] ??= []);
    if (req.method === "GET") return send(200, list);
    const c = { id: nextId++, comment: json.comment, author: db.users[0], created: "now" }; list.push(c); return send(201, c);
  }
  if ((m = p.match(/^\/tasks\/(\d+)\/assignees$/)) && req.method === "PUT") {
    const t = db.tasks.find((x) => x.id === +m[1]); t.assignees.push(db.users.find((u) => u.id === json.user_id)); return send(201, json);
  }
  if ((m = p.match(/^\/tasks\/(\d+)\/assignees\/(\d+)$/)) && req.method === "DELETE") {
    const t = db.tasks.find((x) => x.id === +m[1]); t.assignees = t.assignees.filter((u) => u.id !== +m[2]); return send(200, {});
  }
  if (req.method === "GET" && p === "/users") return send(200, db.users);
  send(404, { message: `no mock for ${req.method} ${p}` });
});

await new Promise((r) => mock.listen(4401, r));

// ---- MCP server under test ----
const srv = spawn("node", ["dist/index.js"], {
  env: { ...process.env, VIKUNJA_URL: "http://127.0.0.1:4401", VIKUNJA_TOKEN: TOKEN, MCP_SECRET: SECRET, PORT: "4402" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 1200));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

try {
  // Wrong secret must 404
  const bad = await fetch("http://127.0.0.1:4402/mcp/wrong", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("wrong secret rejected", bad.status === 404);
  const noSecret = await fetch("http://127.0.0.1:4402/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("missing secret rejected", noSecret.status === 404);

  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:4402/mcp/${SECRET}`)));
  const { tools } = await client.listTools();
  check("tools listed", tools.length === 17, `(${tools.map((t) => t.name).join(", ")})`);

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return { err: r.isError, data: r.isError ? text : JSON.parse(text) };
  };

  let r = await call("list_projects", {});
  check("list_projects", r.data[0].title === "Inbox");
  r = await call("create_project", { title: "House" });
  const houseId = r.data.id;
  check("create_project", r.data.title === "House");
  r = await call("update_project", { project_id: houseId, description: "Home stuff" });
  check("update_project keeps title", r.data.title === "House" && r.data.description === "Home stuff");
  r = await call("search_tasks", { min_priority: 2, due_before: "now+7d" });
  check("search_tasks", r.data.count === 1 && r.data.tasks[0].priority === "3 (high)");
  check("search_tasks filter sent", calls.some((c) => c.includes("filter=done+%3D+false+%26%26+due_date+%3C+now%2B7d+%26%26+priority+%3E%3D+2")));
  r = await call("create_task", { project_id: houseId, title: "Paint fence", due_date: "2026-10-12T17:00:00-05:00", labels: ["home", "outside"], assignee_user_ids: [1] });
  const tid = r.data.id;
  check("create_task with labels+assignee", r.data.labels.length === 2 && r.data.assignees[0].username === "scott");
  check("create_task created missing label", calls.includes("PUT /labels"));
  r = await call("update_task", { task_id: tid, priority: 4, due_date: null });
  check("update_task merges", r.data.title === "Paint fence" && r.data.priority === "4 (urgent)" && r.data.due_date === undefined);
  r = await call("add_comment", { task_id: tid, comment: "Buy primer first" });
  check("add_comment", r.data.comment === "Buy primer first");
  r = await call("get_task", { task_id: tid });
  check("get_task with comments", r.data.comments.length === 1 && r.data.url.endsWith(`/tasks/${tid}`));
  r = await call("remove_label", { task_id: tid, label: "outside" });
  check("remove_label", r.data.removed_label === "outside");
  r = await call("remove_label", { task_id: tid, label: "nope" });
  check("remove_label unknown is tool error", r.err === true);
  r = await call("find_users", { search: "sc" });
  check("find_users", r.data[0].id === 1);
  r = await call("assign_task", { task_id: tid, user_id: 1, unassign: true });
  check("assign_task unassign", r.data.assignees === undefined);
  r = await call("move_task", { task_id: tid, project_id: 1 });
  check("move_task", r.data.project_id === 1);
  r = await call("complete_task", { task_id: tid });
  check("complete_task", r.data.done === true);
  r = await call("get_project", { project_id: 1 });
  check("get_project hides done", r.data.tasks.every((t) => !t.done));
  r = await call("list_labels", {});
  check("list_labels", r.data.length === 2);
  r = await call("add_label", { task_id: tid, label: "home" });
  check("add_label", r.data.added_label.title === "home");
  r = await call("delete_task", { task_id: tid });
  check("delete_task", r.data.deleted === tid);
  r = await call("get_task", { task_id: 99999 });
  check("API 404 surfaces as tool error", r.err === true && r.data.includes("404"));
  await client.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  srv.kill();
  mock.close();
}
console.log(log.trim().split("\n").map((l) => "  server> " + l).join("\n"));
console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
