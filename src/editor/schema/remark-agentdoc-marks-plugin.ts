/**
 * Milkdown plugin for remark-agentdoc-marks
 *
 * Uses $remark to properly integrate the remark plugin with Milkdown's
 * parsing pipeline.
 */

import { $remark } from '@milkdown/kit/utils';
import { remarkAgentdocMarks as remarkAgentdocMarksCore } from '../../formats/remark-agentdoc-marks.js';

/**
 * Milkdown plugin that integrates remarkAgentdocMarks with the parsing pipeline.
 * This ensures the remark plugin runs during both parsing and serialization.
 *
 * Note: $remark expects () => () => transformer signature
 */
export const remarkAgentdocMarksPlugin = $remark('remarkAgentdocMarks', () => () => remarkAgentdocMarksCore());
