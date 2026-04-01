/**
 * Web Tools
 *
 * Tools for searching the web and fetching content from URLs.
 */

import type { AgentTool } from '../types';

// ============================================================================
// Web Bridge Interface
// ============================================================================

// Web operations may be delegated to an optional host bridge.
let webBridge: WebBridgeInterface | null = null;

interface WebBridgeInterface {
  search(query: string): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchResult>;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface FetchResult {
  content: string;
  contentType: string;
  title?: string;
}

export function setWebBridge(bridge: WebBridgeInterface): void {
  webBridge = bridge;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get web tools
 */
export function getWebTools(): AgentTool[] {
  return [
    // Web search
    {
      name: 'web_search',
      description: 'Search the web for information.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 5)',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const { query, limit = 5 } = args as { query: string; limit?: number };

        if (webBridge) {
          try {
            const results = await webBridge.search(query);
            return {
              success: true,
              query,
              results: results.slice(0, limit),
              count: Math.min(results.length, limit),
            };
          } catch (error) {
            return {
              success: false,
              query,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // Fallback: return a message that search is not available
        return {
          success: false,
          query,
          error: 'Web search is not available. The web bridge has not been configured.',
          suggestion: 'Try using fetch_url if you have a specific URL to retrieve.',
        };
      },
    },

    // Fetch URL
    {
      name: 'fetch_url',
      description: 'Fetch content from a URL and extract readable text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to extract specific content',
          },
          format: {
            type: 'string',
            enum: ['text', 'html', 'markdown'],
            description: 'Output format (default: text)',
          },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const { url, selector: _selector, format = 'text' } = args as {
          url: string;
          selector?: string;
          format?: 'text' | 'html' | 'markdown';
        };

        // Note: selector not yet implemented in webBridge
        // Validate URL
        try {
          new URL(url);
        } catch {
          return {
            success: false,
            url,
            error: 'Invalid URL format',
          };
        }

        if (webBridge) {
          try {
            const result = await webBridge.fetch(url);
            return {
              success: true,
              url,
              title: result.title,
              content: result.content,
              contentType: result.contentType,
              format,
            };
          } catch (error) {
            return {
              success: false,
              url,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // Fallback: try direct fetch (may be limited by CORS)
        try {
          const response = await fetch(url, {
            headers: {
              'Accept': 'text/html,application/json,text/plain',
            },
          });

          if (!response.ok) {
            return {
              success: false,
              url,
              error: `HTTP ${response.status}: ${response.statusText}`,
            };
          }

          const contentType = response.headers.get('content-type') || '';
          let content = await response.text();

          // Extract text from HTML if needed
          if (contentType.includes('html') && format === 'text') {
            content = extractTextFromHtml(content);
          }

          // Convert to markdown if requested
          if (format === 'markdown' && contentType.includes('html')) {
            content = htmlToMarkdown(content);
          }

          return {
            success: true,
            url,
            content: truncateContent(content, 10000),
            contentType,
            format,
          };
        } catch (error) {
          return {
            success: false,
            url,
            error: error instanceof Error ? error.message : String(error),
            suggestion: 'This URL may be blocked by CORS. Consider using the web bridge.',
          };
        }
      },
    },

    // Extract text from URL
    {
      name: 'extract_text',
      description: 'Fetch a URL and extract the main readable content (article text).',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to extract text from',
          },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const { url } = args as { url: string };

        // This is a convenience wrapper around fetch_url
        try {
          new URL(url);
        } catch {
          return {
            success: false,
            url,
            error: 'Invalid URL format',
          };
        }

        if (webBridge) {
          try {
            const result = await webBridge.fetch(url);
            return {
              success: true,
              url,
              title: result.title,
              text: extractMainContent(result.content),
            };
          } catch (error) {
            return {
              success: false,
              url,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // Fallback: try direct fetch
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const html = await response.text();
          const text = extractMainContent(html);

          return {
            success: true,
            url,
            text: truncateContent(text, 10000),
          };
        } catch (error) {
          return {
            success: false,
            url,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  ];
}

// ============================================================================
// Content Processing Utilities
// ============================================================================

/**
 * Extract text from HTML
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style elements
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Simple HTML to Markdown conversion
 */
function htmlToMarkdown(html: string): string {
  let md = html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
    // Convert paragraphs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    // Convert line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Convert bold
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    // Convert italic
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    // Convert links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Convert lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Clean up entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md;
}

/**
 * Extract main content from HTML (simplified article extraction)
 */
function extractMainContent(html: string): string {
  // Try to find main content containers
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of contentPatterns) {
    const match = html.match(pattern);
    if (match) {
      return extractTextFromHtml(match[1]);
    }
  }

  // Fall back to full text extraction
  return extractTextFromHtml(html);
}

/**
 * Truncate content to a maximum length
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Try to truncate at a word boundary
  const truncated = content.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}
