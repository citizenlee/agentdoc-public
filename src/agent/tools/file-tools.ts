/**
 * File System Tools
 *
 * Tools for reading files and directories.
 * Uses an optional host bridge when file-system access is available.
 */

import type { AgentTool } from '../types';

// ============================================================================
// File Bridge Interface
// ============================================================================

// File operations use an optional host bridge when provided.
let fileBridge: FileBridgeInterface | null = null;

interface FileBridgeInterface {
  readFile(path: string): Promise<string>;
  listDirectory(path: string): Promise<string[]>;
  searchFiles(pattern: string, directory?: string): Promise<string[]>;
}

export function setFileBridge(bridge: FileBridgeInterface): void {
  fileBridge = bridge;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get file system tools
 */
export function getFileTools(): AgentTool[] {
  return [
    // Read file
    {
      name: 'read_file',
      description: 'Read the contents of a file from the file system.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read (absolute or relative to current document)',
          },
          encoding: {
            type: 'string',
            enum: ['utf8', 'binary'],
            description: 'File encoding (default: utf8)',
          },
        },
        required: ['path'],
      },
      handler: async (args) => {
        const { path, encoding = 'utf8' } = args as { path: string; encoding?: string };

        if (fileBridge) {
          try {
            const content = await fileBridge.readFile(path);
            return {
              success: true,
              path,
              content,
              encoding,
            };
          } catch (error) {
            return {
              success: false,
              path,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // Fallback: try to use fetch for local files in development
        try {
          const response = await fetch(path);
          if (response.ok) {
            const content = await response.text();
            return {
              success: true,
              path,
              content,
              encoding,
            };
          }
        } catch {
          // File access not available
        }

        return {
          success: false,
          path,
          error: 'File bridge not available',
        };
      },
    },

    // List directory
    {
      name: 'list_files',
      description: 'List files in a directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list',
          },
          pattern: {
            type: 'string',
            description: 'Optional glob pattern to filter files (e.g., "*.md")',
          },
          recursive: {
            type: 'boolean',
            description: 'Include subdirectories (default: false)',
          },
        },
        required: ['path'],
      },
      handler: async (args) => {
        const { path, pattern, recursive: _recursive = false } = args as {
          path: string;
          pattern?: string;
          recursive?: boolean;
        };

        if (fileBridge) {
          try {
            const files = await fileBridge.listDirectory(path);

            // Filter by pattern if provided
            // Note: recursive option not yet implemented in fileBridge
            let filteredFiles = files;
            if (pattern) {
              const regex = globToRegex(pattern);
              filteredFiles = files.filter(f => regex.test(f));
            }

            return {
              success: true,
              path,
              files: filteredFiles,
              count: filteredFiles.length,
            };
          } catch (error) {
            return {
              success: false,
              path,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        return {
          success: false,
          path,
          error: 'File bridge not available',
        };
      },
    },

    // Search files
    {
      name: 'search_files',
      description: 'Search for files matching a pattern or containing specific text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (file name pattern or text to find)',
          },
          directory: {
            type: 'string',
            description: 'Directory to search in (default: current document directory)',
          },
          type: {
            type: 'string',
            enum: ['name', 'content'],
            description: 'Search type: "name" for file names, "content" for file contents',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const { query, directory, type = 'name' } = args as {
          query: string;
          directory?: string;
          type?: 'name' | 'content';
        };

        if (fileBridge) {
          try {
            const files = await fileBridge.searchFiles(query, directory);
            return {
              success: true,
              query,
              directory,
              type,
              files,
              count: files.length,
            };
          } catch (error) {
            return {
              success: false,
              query,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        return {
          success: false,
          query,
          error: 'File bridge not available',
        };
      },
    },
  ];
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Convert a simple glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${escaped}$`, 'i');
}
