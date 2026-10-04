import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vikunja, slimTask, slimProject, toVikunjaDate } from "./vikunja.js";

const ok = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

// Wrap a handler so API errors come back to Claude as tool errors instead of crashing the request.
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const isoDate = z
  .string()
  .describe("ISO 8601 date-time, e.g. 2026-10-10T17:00:00-05:00. Include a timezone offset.");

const priority = z
  .number()
  .int()
  .min(0)
  .max(5)
  .describe("0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 do now");

// Fields that can be set on create and update.
const taskFields = {
  description: z.string().optional().describe("Task description. Vikunja renders HTML; plain text is fine."),
  due_date: isoDate.nullable().optional().describe("Due date (ISO 8601). null clears it."),
  start_date: isoDate.nullable().optional().describe("Start date (ISO 8601). null clears it."),
  end_date: isoDate.nullable().optional().describe("End date (ISO 8601). null clears it."),
  priority: priority.optional(),
  percent_done: z.number().min(0).max(1).optional().describe("Progress from 0 to 1, e.g. 0.5"),
  repeat_after_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Repeat interval in seconds (86400 = daily, 604800 = weekly). 0 disables repeating."),
  is_favorite: z.boolean().optional(),
  hex_color: z.string().optional().describe("Color without #, e.g. e8445a"),
};

type TaskFieldArgs = {
  description?: string;
  due_date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  priority?: number;
  percent_done?: number;
  repeat_after_seconds?: number;
  is_favorite?: boolean;
  hex_color?: string;
};

function applyTaskFields(target: any, a: TaskFieldArgs) {
  if (a.description !== undefined) target.description = a.description;
  if (a.due_date !== undefined) target.due_date = toVikunjaDate(a.due_date);
  if (a.start_date !== undefined) target.start_date = toVikunjaDate(a.start_date);
  if (a.end_date !== undefined) target.end_date = toVikunjaDate(a.end_date);
  if (a.priority !== undefined) target.priority = a.priority;
  if (a.percent_done !== undefined) target.percent_done = a.percent_done;
  if (a.repeat_after_seconds !== undefined) target.repeat_after = a.repeat_after_seconds;
  if (a.is_favorite !== undefined) target.is_favorite = a.is_favorite;
  if (a.hex_color !== undefined) target.hex_color = a.hex_color.replace(/^#/, "");
  return target;
}

export function registerTools(server: McpServer, v: Vikunja) {
  const fe = v.frontendUrl;

  // Vikunja's update endpoints replace the whole object, so read-modify-write.
  async function updateTask(id: number, mutate: (t: any) => void) {
    const task = await v.get(`/tasks/${id}`);
    mutate(task);
    return slimTask(await v.post(`/tasks/${id}`, task), fe);
  }

  async function findOrCreateLabel(title: string, create: boolean) {
    const matches = await v.getAll<any>("/labels", { s: title });
    const exact = matches.find((l) => l.title.toLowerCase() === title.toLowerCase());
    if (exact) return exact;
    if (!create) throw new Error(`No label named "${title}". Set create_if_missing to true to create it.`);
    return v.put("/labels", { title });
  }

  // ---------------- Projects ----------------

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List Vikunja projects the user can access, including nested ones (see parent_project_id). Use this to find project IDs.",
      inputSchema: {
        search: z.string().optional().describe("Filter projects by title"),
        include_archived: z.boolean().optional().describe("Include archived projects (default false)"),
      },
      annotations: READ,
    },
    safe(async ({ search, include_archived }) => {
      const projects = await v.getAll<any>("/projects", {
        s: search,
        is_archived: include_archived ? true : undefined,
      });
      // Saved filters show up as projects with negative IDs; mark them.
      return projects.map((p) => ({ ...slimProject(p, fe), saved_filter: p.id < 0 || undefined }));
    }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get one project and its open tasks.",
      inputSchema: {
        project_id: z.number().int(),
        include_done: z.boolean().optional().describe("Also return completed tasks (default false)"),
      },
      annotations: READ,
    },
    safe(async ({ project_id, include_done }) => {
      const project = await v.get(`/projects/${project_id}`);
      const tasks = await v.getAll<any>("/tasks", {
        filter: include_done ? `project = ${project_id}` : `project = ${project_id} && done = false`,
        sort_by: "due_date",
        order_by: "asc",
      });
      return { project: slimProject(project, fe), tasks: tasks.map((t) => slimTask(t, fe)) };
    }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a new project, optionally nested under a parent project.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        parent_project_id: z.number().int().optional(),
        hex_color: z.string().optional().describe("Color without #"),
      },
      annotations: WRITE,
    },
    safe(async ({ title, description, parent_project_id, hex_color }) =>
      slimProject(
        await v.put("/projects", {
          title,
          description: description ?? "",
          parent_project_id: parent_project_id ?? 0,
          hex_color: hex_color?.replace(/^#/, "") ?? "",
        }),
        fe,
      ),
    ),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description: "Rename, re-describe, move, archive or unarchive a project. Only the fields you pass change.",
      inputSchema: {
        project_id: z.number().int(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        parent_project_id: z.number().int().optional().describe("0 moves it to the top level"),
        is_archived: z.boolean().optional(),
        hex_color: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ project_id, ...a }) => {
      const p = await v.get(`/projects/${project_id}`);
      if (a.title !== undefined) p.title = a.title;
      if (a.description !== undefined) p.description = a.description;
      if (a.parent_project_id !== undefined) p.parent_project_id = a.parent_project_id;
      if (a.is_archived !== undefined) p.is_archived = a.is_archived;
      if (a.hex_color !== undefined) p.hex_color = a.hex_color.replace(/^#/, "");
      return slimProject(await v.post(`/projects/${project_id}`, p), fe);
    }),
  );

  // ---------------- Tasks ----------------

  server.registerTool(
    "search_tasks",
    {
      title: "Search tasks",
      description:
        "Search and filter tasks across all projects. By default returns only open tasks, soonest due first. " +
        "Convenience parameters are combined with AND. For anything else, pass a raw Vikunja filter, e.g. " +
        "`priority >= 3 && labels in 4` or `due_date < now+7d && done = false`.",
      inputSchema: {
        search: z.string().optional().describe("Text to match in title/description"),
        project_id: z.number().int().optional(),
        include_done: z.boolean().optional().describe("Include completed tasks (default false)"),
        due_before: z
          .string()
          .optional()
          .describe("Date or relative time, e.g. 2026-10-15 or now+7d"),
        due_after: z.string().optional().describe("Date or relative time, e.g. now or 2026-10-01"),
        min_priority: priority.optional(),
        label_id: z.number().int().optional(),
        assignee_username: z.string().optional(),
        filter: z.string().optional().describe("Raw Vikunja filter expression, ANDed with the parameters above"),
        sort_by: z
          .enum(["due_date", "priority", "created", "updated", "title", "id", "position", "done_at"])
          .optional()
          .describe("Default due_date"),
        order: z.enum(["asc", "desc"]).optional().describe("Default asc"),
        limit: z.number().int().min(1).max(200).optional().describe("Max tasks to return (default 50)"),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const parts: string[] = [];
      if (!a.include_done) parts.push("done = false");
      if (a.project_id !== undefined) parts.push(`project = ${a.project_id}`);
      if (a.due_before) parts.push(`due_date < ${a.due_before}`);
      if (a.due_after) parts.push(`due_date > ${a.due_after}`);
      if (a.min_priority !== undefined) parts.push(`priority >= ${a.min_priority}`);
      if (a.label_id !== undefined) parts.push(`labels in ${a.label_id}`);
      if (a.assignee_username) parts.push(`assignees in ${a.assignee_username}`);
      if (a.filter) parts.push(`(${a.filter})`);

      const limit = a.limit ?? 50;
      const tasks = await v.getAll<any>(
        "/tasks",
        {
          s: a.search,
          filter: parts.join(" && ") || undefined,
          // Sorting by due date pushes undated tasks last; break ties by id.
          sort_by: a.sort_by ?? "due_date",
          order_by: a.order ?? "asc",
          filter_include_nulls: a.due_before || a.due_after ? false : undefined,
        },
        Math.ceil(limit / 50),
      );
      return { count: Math.min(tasks.length, limit), tasks: tasks.slice(0, limit).map((t) => slimTask(t, fe)) };
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get full details of one task, including its comments.",
      inputSchema: {
        task_id: z.number().int(),
        include_comments: z.boolean().optional().describe("Default true"),
      },
      annotations: READ,
    },
    safe(async ({ task_id, include_comments }) => {
      const task = await v.get(`/tasks/${task_id}`);
      const out: any = slimTask(task, fe);
      if (task.related_tasks && Object.keys(task.related_tasks).length) {
        out.related_tasks = Object.fromEntries(
          Object.entries(task.related_tasks).map(([kind, list]: [string, any]) => [
            kind,
            (list ?? []).map((r: any) => ({ id: r.id, title: r.title, done: r.done })),
          ]),
        );
      }
      if (include_comments !== false) {
        const comments = await v.get<any[]>(`/tasks/${task_id}/comments`).catch(() => []);
        out.comments = (comments ?? []).map((c) => ({
          id: c.id,
          author: c.author?.username,
          comment: c.comment,
          created: c.created,
        }));
      }
      return out;
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in a project. Labels are given by name and are created if they don't exist yet.",
      inputSchema: {
        project_id: z.number().int(),
        title: z.string().min(1),
        ...taskFields,
        labels: z.array(z.string()).optional().describe("Label names to attach"),
        assignee_user_ids: z.array(z.number().int()).optional().describe("User IDs from find_users"),
      },
      annotations: WRITE,
    },
    safe(async ({ project_id, title, labels, assignee_user_ids, ...fields }) => {
      const created = await v.put(`/projects/${project_id}/tasks`, applyTaskFields({ title }, fields));
      for (const name of labels ?? []) {
        const label = await findOrCreateLabel(name, true);
        await v.put(`/tasks/${created.id}/labels`, { label_id: label.id });
      }
      for (const user_id of assignee_user_ids ?? []) {
        await v.put(`/tasks/${created.id}/assignees`, { user_id });
      }
      return slimTask(
        labels?.length || assignee_user_ids?.length ? await v.get(`/tasks/${created.id}`) : created,
        fe,
      );
    }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change a task. Only the fields you pass change. Use complete_task to mark done, move_task to change project.",
      inputSchema: {
        task_id: z.number().int(),
        title: z.string().min(1).optional(),
        ...taskFields,
      },
      annotations: WRITE,
    },
    safe(async ({ task_id, title, ...fields }) =>
      updateTask(task_id, (t) => {
        if (title !== undefined) t.title = title;
        applyTaskFields(t, fields);
      }),
    ),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Mark a task done (or reopen it with done=false). Repeating tasks roll forward to their next date instead of closing.",
      inputSchema: {
        task_id: z.number().int(),
        done: z.boolean().optional().describe("Default true"),
      },
      annotations: WRITE,
    },
    safe(async ({ task_id, done }) =>
      updateTask(task_id, (t) => {
        t.done = done ?? true;
      }),
    ),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description: "Move a task to another project.",
      inputSchema: { task_id: z.number().int(), project_id: z.number().int() },
      annotations: WRITE,
    },
    safe(async ({ task_id, project_id }) =>
      updateTask(task_id, (t) => {
        t.project_id = project_id;
      }),
    ),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a task. Confirm with the user first.",
      inputSchema: { task_id: z.number().int() },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ task_id }) => {
      await v.delete(`/tasks/${task_id}`);
      return { deleted: task_id };
    }),
  );

  // ---------------- Labels ----------------

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description: "List all labels the user can use.",
      inputSchema: { search: z.string().optional() },
      annotations: READ,
    },
    safe(async ({ search }) =>
      (await v.getAll<any>("/labels", { s: search })).map((l) => ({
        id: l.id,
        title: l.title,
        hex_color: l.hex_color || undefined,
      })),
    ),
  );

  server.registerTool(
    "add_label",
    {
      title: "Add label to task",
      description: "Attach a label to a task by name.",
      inputSchema: {
        task_id: z.number().int(),
        label: z.string().min(1).describe("Label name"),
        create_if_missing: z.boolean().optional().describe("Create the label if it doesn't exist (default true)"),
      },
      annotations: WRITE,
    },
    safe(async ({ task_id, label, create_if_missing }) => {
      const l = await findOrCreateLabel(label, create_if_missing ?? true);
      await v.put(`/tasks/${task_id}/labels`, { label_id: l.id });
      return { task_id, added_label: { id: l.id, title: l.title } };
    }),
  );

  server.registerTool(
    "remove_label",
    {
      title: "Remove label from task",
      description: "Detach a label from a task by name.",
      inputSchema: { task_id: z.number().int(), label: z.string().min(1) },
      annotations: WRITE,
    },
    safe(async ({ task_id, label }) => {
      const l = await findOrCreateLabel(label, false);
      await v.delete(`/tasks/${task_id}/labels/${l.id}`);
      return { task_id, removed_label: l.title };
    }),
  );

  // ---------------- Comments ----------------

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a comment to a task.",
      inputSchema: { task_id: z.number().int(), comment: z.string().min(1) },
      annotations: WRITE,
    },
    safe(async ({ task_id, comment }) => {
      const c = await v.put(`/tasks/${task_id}/comments`, { comment });
      return { id: c.id, task_id, comment: c.comment, created: c.created };
    }),
  );

  // ---------------- People ----------------

  server.registerTool(
    "find_users",
    {
      title: "Find users",
      description: "Search Vikunja users by username, name or email to get user IDs for assigning tasks.",
      inputSchema: { search: z.string().min(1) },
      annotations: READ,
    },
    safe(async ({ search }) =>
      ((await v.get<any[]>("/users", { s: search })) ?? []).map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name || undefined,
      })),
    ),
  );

  server.registerTool(
    "assign_task",
    {
      title: "Assign or unassign task",
      description: "Add or remove an assignee on a task.",
      inputSchema: {
        task_id: z.number().int(),
        user_id: z.number().int(),
        unassign: z.boolean().optional().describe("true removes the assignee"),
      },
      annotations: WRITE,
    },
    safe(async ({ task_id, user_id, unassign }) => {
      if (unassign) await v.delete(`/tasks/${task_id}/assignees/${user_id}`);
      else await v.put(`/tasks/${task_id}/assignees`, { user_id });
      return slimTask(await v.get(`/tasks/${task_id}`), fe);
    }),
  );
}
