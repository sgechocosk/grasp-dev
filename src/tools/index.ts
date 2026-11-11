import { bashTool } from './bash';
import { editTool, writeTool } from './edit';
import { readTool } from './read';
import { globTool, grepTool } from './search';
import { todoWriteTool } from './todo';
import { ToolRegistry } from './tool';

export * from './tool';

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [readTool, globTool, grepTool, editTool, writeTool, bashTool, todoWriteTool]) {
    registry.register(tool);
  }
  return registry;
}
