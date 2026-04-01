/**
 * Agent Configuration
 *
 * Manages configuration for the Agentdoc agent including:
 * - API key storage
 * - Model selection
 * - Timeout settings
 */

import type { AgentConfig } from './types';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: AgentConfig = {
  apiKey: '', // Will be set from environment or settings
  model: 'claude-sonnet-4-20250514', // Sonnet 4 with extended thinking support
  timeoutMs: 5 * 60 * 1000, // 5 minutes
};

// ============================================================================
// Configuration State
// ============================================================================

let currentConfig: AgentConfig = { ...DEFAULT_CONFIG };

// ============================================================================
// Configuration Functions
// ============================================================================

/**
 * Get the current agent configuration
 */
export function getAgentConfig(): AgentConfig {
  return currentConfig;
}

/**
 * Set the API key
 */
export function setApiKey(apiKey: string): void {
  currentConfig.apiKey = apiKey;
}

/**
 * Set the model
 */
export function setModel(model: AgentConfig['model']): void {
  currentConfig.model = model;
}

/**
 * Set the timeout
 */
export function setTimeout(ms: number): void {
  currentConfig.timeoutMs = ms;
}

/**
 * Update full configuration
 */
export function updateConfig(config: Partial<AgentConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Check if agent is configured (has API key)
 */
export function isConfigured(): boolean {
  return Boolean(getAgentConfig().apiKey);
}

/**
 * Reset to default configuration
 */
export function resetConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ============================================================================
// Exports
// ============================================================================

export type { AgentConfig };
