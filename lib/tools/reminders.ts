import { ToolDefinition } from "./index";
import { insertReminder, listReminders, completeReminder } from "../db";

const addReminder: ToolDefinition = {
  name: "add_reminder",
  description:
    "Add a reminder or task for the user to a persistent to-do list. If the user gives a time or " +
    "date (e.g. 'tomorrow at 5pm'), convert it to an absolute ISO 8601 datetime using the current " +
    "date/time already in your system prompt, and pass it as due_at -- don't pass relative phrases " +
    "through unconverted. Leave due_at unset for an undated task.",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "What to remind the user about." },
      due_at: {
        type: "string",
        description: "Absolute ISO 8601 datetime for when this is due, if the user gave one.",
      },
    },
    required: ["content"],
  },
  handler: async (input) => {
    const content = input.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Missing required 'content' field");
    }
    const dueAt = typeof input.due_at === "string" && input.due_at.trim().length > 0 ? input.due_at.trim() : null;
    const id = insertReminder(content.trim(), dueAt);
    return { id, content: content.trim(), due_at: dueAt };
  },
};

const listRemindersTool: ToolDefinition = {
  name: "list_reminders",
  description:
    "List the user's reminders/tasks. By default only shows open (not yet completed) ones -- pass " +
    "include_completed to also see completed ones.",
  input_schema: {
    type: "object",
    properties: {
      include_completed: { type: "boolean", description: "Include already-completed reminders. Defaults to false." },
    },
    required: [],
  },
  handler: async (input) => {
    const includeCompleted = input.include_completed === true;
    return { reminders: listReminders(includeCompleted) };
  },
};

const completeReminderTool: ToolDefinition = {
  name: "complete_reminder",
  description: "Mark a reminder as done, given its id (from list_reminders).",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The reminder's id." },
    },
    required: ["id"],
  },
  handler: async (input) => {
    const id = input.id;
    if (typeof id !== "number") {
      throw new Error("Missing required numeric 'id' field");
    }
    const completed = completeReminder(id);
    if (!completed) {
      throw new Error(`No reminder found with id ${id}`);
    }
    return { id, completed: true };
  },
};

export const reminderTools: ToolDefinition[] = [addReminder, listRemindersTool, completeReminderTool];
