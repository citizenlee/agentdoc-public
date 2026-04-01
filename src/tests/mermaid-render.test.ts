import { isMermaidCodeBlockLanguage, renderAgentdocMermaidSvg } from '../editor/plugins/mermaid-diagrams';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

test('mermaid language detection is case-insensitive', () => {
  assert(isMermaidCodeBlockLanguage('mermaid'), 'Expected lowercase mermaid to match');
  assert(isMermaidCodeBlockLanguage(' Mermaid '), 'Expected whitespace-trimmed Mermaid to match');
  assert(!isMermaidCodeBlockLanguage('markdown'), 'Expected non-mermaid language to be ignored');
});

test('agentdoc mermaid renderer returns inline svg markup', () => {
  const svg = renderAgentdocMermaidSvg([
    'flowchart LR',
    '  A["Monologue client"] -->|WebSocket| B["Realtime gateway"]',
    '  B --> C["ASR provider"]',
  ].join('\n'));

  assert(svg.startsWith('<svg'), 'Expected renderer to return SVG markup');
  assert(svg.includes('Monologue client'), 'Expected rendered SVG to include node label text');
  assert(svg.includes('Realtime gateway'), 'Expected rendered SVG to include downstream node label text');
});

test('agentdoc mermaid renderer rejects dangling edges', () => {
  let threw = false;
  try {
    renderAgentdocMermaidSvg([
      'flowchart LR',
      '  A -->',
    ].join('\n'));
  } catch (error) {
    threw = true;
    assert(error instanceof Error && error.message.includes('Dangling Mermaid edge'), 'Expected dangling edge validation error');
  }

  assert(threw, 'Expected malformed Mermaid edge to throw');
});

test('agentdoc mermaid renderer rejects dangling labeled edges', () => {
  let threw = false;
  try {
    renderAgentdocMermaidSvg([
      'flowchart LR',
      '  A -->|WebSocket|',
    ].join('\n'));
  } catch (error) {
    threw = true;
    assert(error instanceof Error && error.message.includes('Dangling Mermaid edge'), 'Expected dangling labeled edge validation error');
  }

  assert(threw, 'Expected malformed labeled Mermaid edge to throw');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
