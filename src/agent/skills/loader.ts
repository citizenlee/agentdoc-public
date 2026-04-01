/**
 * Skill Loader
 *
 * Parses SKILL.md files to load custom skills.
 *
 * SKILL.md format:
 * ---
 * id: skill-id
 * name: Skill Name
 * description: Short description
 * icon: 📝
 * parallelStrategy: single | per-section | orchestrated
 * maxAgents: 10
 * batchSize: 5
 * conflictsWith:
 *   - other-skill-id
 * tools:
 *   - create_suggestion
 *   - add_comment
 * ---
 *
 * # Skill Prompt
 *
 * The rest of the file is the prompt...
 */

import type { Skill, ParallelStrategy } from './registry';

// ============================================================================
// Types
// ============================================================================

interface SkillFrontmatter {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  debugLoop?: string;
  parallelStrategy?: ParallelStrategy;
  maxAgents?: number;
  batchSize?: number;
  singleWriter?: boolean;
  mechanicalPasses?: string[];
  conflictsWith?: string[];
  tools?: string[];
}

interface ParseResult {
  success: boolean;
  skill?: Skill;
  error?: string;
}

// ============================================================================
// YAML-like Frontmatter Parser
// ============================================================================

/**
 * Simple YAML-like frontmatter parser
 * Handles basic key-value pairs and arrays
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  // Check for frontmatter delimiters
  if (!content.startsWith('---')) {
    return null;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterText = content.slice(3, endIndex).trim();
  const body = content.slice(endIndex + 3).trim();

  // Parse YAML-like content
  const frontmatter: Record<string, unknown> = {};
  const lines = frontmatterText.split('\n');

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Check for array item
    if (trimmed.startsWith('- ') && currentKey && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Check for key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    // Save previous array if any
    if (currentKey && currentArray !== null) {
      frontmatter[currentKey] = currentArray;
      currentArray = null;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    currentKey = key;

    // Check if value is empty (indicating an array follows)
    if (!value) {
      currentArray = [];
    } else {
      frontmatter[key] = value;
      currentArray = null;
    }
  }

  // Save final array if any
  if (currentKey && currentArray !== null) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const sanitized = Math.floor(value);
    return sanitized > 0 ? sanitized : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Validate and extract frontmatter into typed SkillFrontmatter
 */
function validateFrontmatter(frontmatter: Record<string, unknown>): SkillFrontmatter | null {
  // Required fields
  if (typeof frontmatter.id !== 'string' || !frontmatter.id) {
    return null;
  }
  if (typeof frontmatter.name !== 'string' || !frontmatter.name) {
    return null;
  }

  const result: SkillFrontmatter = {
    id: frontmatter.id,
    name: frontmatter.name,
  };

  // Optional string fields
  if (typeof frontmatter.description === 'string') {
    result.description = frontmatter.description;
  }
  if (typeof frontmatter.icon === 'string') {
    result.icon = frontmatter.icon;
  }
  if (typeof frontmatter.debugLoop === 'string') {
    result.debugLoop = frontmatter.debugLoop;
  }

  // Parallel strategy
  if (frontmatter.parallelStrategy) {
    const strategy = frontmatter.parallelStrategy as string;
    if (['single', 'per-section', 'orchestrated'].includes(strategy)) {
      result.parallelStrategy = strategy as ParallelStrategy;
    }
  }

  const maxAgents = parsePositiveInt(frontmatter.maxAgents);
  if (maxAgents !== null) {
    result.maxAgents = maxAgents;
  }

  const batchSize = parsePositiveInt(frontmatter.batchSize);
  if (batchSize !== null) {
    result.batchSize = batchSize;
  }

  const singleWriter = parseBoolean(frontmatter.singleWriter);
  if (singleWriter !== null) {
    result.singleWriter = singleWriter;
  }

  const mechanicalPasses = parseStringArray(frontmatter.mechanicalPasses);
  if (mechanicalPasses.length > 0) {
    result.mechanicalPasses = mechanicalPasses;
  }

  // Arrays
  if (Array.isArray(frontmatter.conflictsWith)) {
    result.conflictsWith = frontmatter.conflictsWith.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(frontmatter.tools)) {
    result.tools = frontmatter.tools.filter((s): s is string => typeof s === 'string');
  }

  return result;
}

// ============================================================================
// Skill Loading
// ============================================================================

/**
 * Parse a SKILL.md file content into a Skill
 */
export function parseSkillFile(content: string, filePath?: string): ParseResult {
  // Parse frontmatter
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return {
      success: false,
      error: 'Invalid or missing frontmatter. SKILL.md must start with ---',
    };
  }

  // Validate frontmatter
  const frontmatter = validateFrontmatter(parsed.frontmatter);
  if (!frontmatter) {
    return {
      success: false,
      error: 'Missing required fields: id and name are required in frontmatter',
    };
  }

  // Check for prompt content
  if (!parsed.body.trim()) {
    return {
      success: false,
      error: 'SKILL.md must have prompt content after the frontmatter',
    };
  }

  // Build skill
  const skill: Skill = {
    id: frontmatter.id,
    name: frontmatter.name,
    description: frontmatter.description || `Custom skill: ${frontmatter.name}`,
    icon: frontmatter.icon,
    debugLoop: frontmatter.debugLoop,
    prompt: parsed.body.trim(),
    tools: frontmatter.tools || ['create_suggestion', 'add_comment'],
    conflictsWith: frontmatter.conflictsWith,
    parallelStrategy: frontmatter.parallelStrategy || 'single',
    maxAgents: frontmatter.maxAgents,
    batchSize: frontmatter.batchSize,
    orchestration: frontmatter.singleWriter === true ? { singleWriter: true } : undefined,
    mechanicalPasses: frontmatter.mechanicalPasses?.map((id) => ({ id, enabled: true })),
    source: 'custom',
    filePath,
  };

  return {
    success: true,
    skill,
  };
}

/**
 * Load a skill from a SKILL.md file path
 * This would typically be used with a file system API
 */
export async function loadSkillFromFile(filePath: string): Promise<ParseResult> {
  try {
    // In browser context, this would use fetch or a bridge API
    // For now, return an error since we can't access the file system directly
    return {
      success: false,
      error: 'File loading not available in this context. Use parseSkillFile with content instead.',
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to load skill file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Generate a template SKILL.md file
 */
export function generateSkillTemplate(name: string, id?: string): string {
  const skillId = id || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  return `---
id: ${skillId}
name: ${name}
description: Brief description of what this skill does
icon: 🔧
debugLoop: Optional developer-facing debug workflow notes
parallelStrategy: single
conflictsWith:
  - grammar
tools:
  - create_suggestion
  - add_comment
---

# ${name}

You are an expert editor. Review the document for specific issues related to this skill.

## Guidelines

1. Focus on specific, actionable improvements
2. Explain the reasoning for each suggestion
3. Maintain the author's voice and intent

## Actions

- Use \`create_suggestion\` with type "insert", "replace", or "delete" to propose text changes
- Use \`add_comment\` to flag items for review without changing text

Add brief comments when context or rationale is needed.
`;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  parseSkillFile,
  loadSkillFromFile,
  generateSkillTemplate,
};
