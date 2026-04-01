import { backfillLegacyMarkRanges } from './marks-range-backfill.js';

const stats = backfillLegacyMarkRanges();
console.log('[backfill] Legacy mark range backfill run complete', stats);
