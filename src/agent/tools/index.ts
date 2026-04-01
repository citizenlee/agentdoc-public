/**
 * Agent Tools Registry
 *
 * Aggregates and exports all tools available to the Agentdoc agent.
 * Tools are organized into categories:
 * - Agentdoc tools: Document manipulation (wraps existing MCP tools)
 * - File tools: File system operations
 * - Web tools: Web search and fetching
 */

import type { DocumentContext, AgentTool } from '../types';
import { getAgentdocTools } from './agentdoc-tools';
import { getFileTools } from './file-tools';
import { getWebTools } from './web-tools';

// ============================================================================
// Tool Registry
// ============================================================================

/**
 * Get all tools available to the agent for a given context
 */
export function getAllTools(context: DocumentContext): AgentTool[] {
  const agentdocTools = getAgentdocTools(context);
  const fileTools = getFileTools();
  const webTools = getWebTools();

  return [
    ...agentdocTools,
    ...fileTools,
    ...webTools,
  ];
}

// ============================================================================
// Tool Execution
// ============================================================================

// Store tool handlers for execution
const toolHandlers: Map<string, AgentTool['handler']> = new Map();

/**
 * Register a tool's handler
 */
export function registerToolHandler(name: string, handler: AgentTool['handler']): void {
  toolHandlers.set(name, handler);
}

/**
 * Execute a tool by name
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: DocumentContext
): Promise<unknown> {
  // First check registered handlers
  const handler = toolHandlers.get(name);
  if (handler) {
    return handler(args);
  }

  // Use stored context or create empty one
  const toolContext = context || { documentContent: '' };

  // Then check category-specific tools
  const agentdocTools = getAgentdocTools(toolContext);
  const agentdocTool = agentdocTools.find(t => t.name === name);
  if (agentdocTool) {
    return agentdocTool.handler(args);
  }

  const fileTools = getFileTools();
  const fileTool = fileTools.find(t => t.name === name);
  if (fileTool) {
    return fileTool.handler(args);
  }

  const webTools = getWebTools();
  const webTool = webTools.find(t => t.name === name);
  if (webTool) {
    return webTool.handler(args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ============================================================================
// Exports
// ============================================================================

export { getAgentdocTools } from './agentdoc-tools';
export { getFileTools } from './file-tools';
export { getWebTools } from './web-tools';
