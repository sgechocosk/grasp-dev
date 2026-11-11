import { err, type Tool } from './tool';

export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
interface Input { todos: TodoItem[] }

export const todoWriteTool: Tool<Input> = {
  name: 'TodoWrite',
  description: `Creates and updates a task list for the current work, shown to the user.
- Use it for tasks with three or more distinct steps, or when the user gives multiple tasks. Skip it for trivial single-step work.
- Each call replaces the whole list. Statuses: pending, in_progress, completed.
- Keep exactly one task in_progress while working. Mark a task completed immediately after finishing it, and only when it is fully done.`,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs to be done' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  permission: 'none',
  summarize: (i) => {
    const todos = Array.isArray(i.todos) ? i.todos : [];
    return `${todos.filter((t) => t.status === 'completed').length}/${todos.length} 完了`;
  },

  async execute(input) {
    if (!Array.isArray(input.todos)) return err('todos must be an array.');
    return { content: 'Todo list updated. Continue with the current task and keep the list up to date.' };
  },
};
