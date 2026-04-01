/**
 * Milkdown plugin for remark-frontmatter.
 */

import { $remark } from '@milkdown/kit/utils';
import remarkFrontmatter from 'remark-frontmatter';

/**
 * Register remark-frontmatter so YAML frontmatter is preserved.
 */
export const remarkFrontmatterPlugin = $remark('remarkFrontmatter', () => remarkFrontmatter, ['yaml']);
