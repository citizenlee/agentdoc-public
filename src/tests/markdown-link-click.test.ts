import {
  extractLinkTargetFromEvent,
  getEditModeLinkCardState,
  isLinkModifierActive,
  normalizeAndValidateHref,
  shouldOpenLinkForEvent,
  type LinkClickEventLike,
  type LinkModifierEventLike,
} from '../editor/plugins/markdown-link-click';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${String(expected)}, got: ${String(actual)}`);
  }
}

function createEvent(overrides: Partial<LinkClickEventLike> = {}): LinkClickEventLike {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

function createModifierEvent(overrides: Partial<LinkModifierEventLike> = {}): LinkModifierEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

type SelectorMap = {
  markWrapper?: MockClosestTarget | null;
  anchor?: MockClosestTarget | null;
};

class MockClosestTarget {
  private selectors: SelectorMap;
  private attrs: Record<string, string>;

  constructor(selectors: SelectorMap = {}, attrs: Record<string, string> = {}) {
    this.selectors = selectors;
    this.attrs = attrs;
  }

  closest(selector: string): unknown {
    if (selector === '[data-mark-id]') return this.selectors.markWrapper ?? null;
    if (selector === 'a[href]') return this.selectors.anchor ?? null;
    return null;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

class MockTextNode {
  parentElement: MockClosestTarget | null;

  constructor(parentElement: MockClosestTarget | null) {
    this.parentElement = parentElement;
  }
}

function testShouldOpenLinkForEvent(): void {
  assertEqual(
    shouldOpenLinkForEvent(createEvent(), false),
    true,
    'Read-only mode should open link on plain primary click',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent(), true),
    false,
    'Editable mode should require modifier key',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent({ ctrlKey: true }), true),
    true,
    'Editable mode should allow Ctrl+click',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent({ metaKey: true }), true),
    true,
    'Editable mode should allow Cmd+click',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent({ button: 1 }), false),
    false,
    'Non-primary click should never trigger link opening',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent({ defaultPrevented: true }), false),
    false,
    'Read-only default-prevented events should not open links',
  );
  assertEqual(
    shouldOpenLinkForEvent(createEvent({ defaultPrevented: true, metaKey: true }), true),
    true,
    'Editable mode should allow Cmd+click even when default is already prevented',
  );
}

function testModifierAndCardState(): void {
  assertEqual(
    isLinkModifierActive(createModifierEvent({ metaKey: true })),
    true,
    'Meta key should arm markdown link opening',
  );
  assertEqual(
    isLinkModifierActive(createModifierEvent({ ctrlKey: true })),
    true,
    'Ctrl key should arm markdown link opening',
  );
  assertEqual(
    isLinkModifierActive(createModifierEvent()),
    false,
    'No modifier should keep markdown link opening unarmed',
  );

  const macIdle = getEditModeLinkCardState(true, false);
  assertEqual(macIdle.openLabel, 'Open link', 'Card open button copy should describe the action clearly');
  assertEqual(macIdle.modifierTitle, 'Cmd+click also works', 'Mac shortcut tooltip should mention Cmd');
  assertEqual(macIdle.armed, false, 'Idle card state should not be armed');

  const windowsIdle = getEditModeLinkCardState(false, false);
  assertEqual(windowsIdle.modifierTitle, 'Ctrl+click also works', 'Windows shortcut tooltip should mention Ctrl');

  const armed = getEditModeLinkCardState(true, true);
  assertEqual(armed.openLabel, 'Open link', 'Armed card should keep the explicit open-action copy');
  assertEqual(armed.armed, true, 'Armed card state should be marked armed');
}

function testNormalizeAndValidateHref(): void {
  const base = 'https://agentdoc.com/d/doc-1';

  assertEqual(
    normalizeAndValidateHref('https://example.com/path', base),
    'https://example.com/path',
    'https links should be allowed',
  );
  assertEqual(
    normalizeAndValidateHref('mailto:test@example.com', base),
    'mailto:test@example.com',
    'mailto links should be allowed',
  );
  assertEqual(
    normalizeAndValidateHref('tel:+15551231234', base),
    'tel:+15551231234',
    'tel links should be allowed',
  );

  const relativePath = normalizeAndValidateHref('/docs/getting-started', base);
  assert(relativePath === 'https://agentdoc.com/docs/getting-started', 'Relative links should normalize to same-origin URL');

  const queryOnly = normalizeAndValidateHref('?focus=1', base);
  assert(queryOnly === 'https://agentdoc.com/d/doc-1?focus=1', 'Query-only links should stay same-origin');

  const fragment = normalizeAndValidateHref('#intro', base);
  assert(fragment === 'https://agentdoc.com/d/doc-1#intro', 'Fragment links should be allowed');

  assertEqual(
    normalizeAndValidateHref('//evil.example/path', base),
    null,
    'Protocol-relative cross-origin URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('javascript:alert(1)', base),
    null,
    'javascript URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('data:text/html;base64,AAAA', base),
    null,
    'data URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('ftp://example.com/file.txt', base),
    null,
    'Disallowed protocols should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('https://[invalid', base),
    null,
    'Malformed URLs should be blocked',
  );
}

function testExtractLinkTargetFromEvent(): void {
  const anchor = new MockClosestTarget({}, { href: 'https://example.com' });
  const target = new MockClosestTarget({ anchor });
  const event = { target } as Pick<MouseEvent, 'target'>;
  const extracted = extractLinkTargetFromEvent(event);
  assert(extracted === anchor, 'Should return closest anchor for non-mark clicks');

  const markWrapper = new MockClosestTarget();
  const insideMark = new MockClosestTarget({ markWrapper, anchor });
  const markEvent = { target: insideMark } as Pick<MouseEvent, 'target'>;
  const blocked = extractLinkTargetFromEvent(markEvent);
  assert(blocked === null, 'Should not return anchor when click is inside mark wrapper');

  const noClosestEvent = { target: { nodeType: 3 } } as Pick<MouseEvent, 'target'>;
  const noClosest = extractLinkTargetFromEvent(noClosestEvent);
  assert(noClosest === null, 'Should return null for targets without closest()');

  const textNodeEvent = { target: new MockTextNode(target) } as Pick<MouseEvent, 'target'>;
  const textNodeExtracted = extractLinkTargetFromEvent(textNodeEvent);
  assert(textNodeExtracted === anchor, 'Should resolve text-node clicks via parentElement.closest()');
}

function run(): void {
  testShouldOpenLinkForEvent();
  testModifierAndCardState();
  testNormalizeAndValidateHref();
  testExtractLinkTargetFromEvent();
  console.log('✓ markdown link click behavior guards');
}

run();
