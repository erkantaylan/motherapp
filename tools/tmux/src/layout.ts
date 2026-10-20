// The tmux tool's declarative page: one list, one row per session, Copy and Kill on each row.
import type { Widget } from "@motherapp/tool-sdk";

export const layout: Widget[] = [
  // "No tmux server running on …" or an error; absent while sessions can be listed.
  { type: "text", bind: "status", style: "muted" },
  {
    type: "list",
    bind: "sessions",
    sort: "name",
    empty: "No tmux sessions.",
    item: {
      label: "{name}",
      sublabel: "{detail}",
      widgets: [
        { type: "button", label: "Copy attach command", copy: { bind: "sessions.{key}.attachCommand" } },
        { type: "button", label: "Kill", action: "kill", args: { id: "{key}" }, confirm: "Kill tmux session '{name}'?{attachedNote}" },
      ],
    },
  },
];
