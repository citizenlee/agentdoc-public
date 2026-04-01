import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'server', 'db.ts'), 'utf8');

  assert(
    source.includes("db.pragma('journal_mode = WAL')"),
    'Expected database to enable WAL mode',
  );
  assert(
    source.includes("db.pragma('synchronous = NORMAL')"),
    'Expected database to set synchronous=NORMAL for balanced durability',
  );
  assert(
    source.includes("db.pragma('busy_timeout = 5000')"),
    'Expected database to set busy_timeout=5000',
  );

  console.log('✓ database pragma durability tuning');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
