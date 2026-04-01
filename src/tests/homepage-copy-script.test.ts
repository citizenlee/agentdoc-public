import vm from 'node:vm';
import { AGENT_TAB_UI_SCRIPT } from '../../server/homepage-script.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type ScriptHarness = {
  context: Record<string, any>;
  button: { textContent: string; getAttribute: (name: string) => string | null };
  timers: Array<() => void>;
  clipboardWrites: string[];
  execCommands: string[];
  appendedTextareas: Array<{ value: string }>;
};

type ToggleHarness = {
  context: Record<string, any>;
  tabAnyAgent: { classList: { contains: (token: string) => boolean } };
  tabCodex: { classList: { contains: (token: string) => boolean } };
  panelAnyAgent: { classList: { contains: (token: string) => boolean } };
  panelCodex: { classList: { contains: (token: string) => boolean } };
};

function createClassList(initial: string[] = []): {
  add: (token: string) => void;
  remove: (token: string) => void;
  contains: (token: string) => boolean;
} {
  const tokens = new Set(initial);
  return {
    add(token: string) {
      tokens.add(token);
    },
    remove(token: string) {
      tokens.delete(token);
    },
    contains(token: string) {
      return tokens.has(token);
    },
  };
}

function createHarness(options: {
  codeText: string;
  clipboardWrite?: (value: string) => Promise<void>;
  execCommandResult: boolean;
}): ScriptHarness {
  const button = {
    textContent: 'Copy',
    getAttribute(name: string) {
      return name === 'data-copy-label' ? 'Copy' : null;
    },
  };
  const timers: Array<() => void> = [];
  const clipboardWrites: string[] = [];
  const execCommands: string[] = [];
  const appendedTextareas: Array<{ value: string }> = [];

  let appended: { value: string } | null = null;
  const body = {
    appendChild(node: { value: string }) {
      appended = node;
      appendedTextareas.push(node);
    },
    removeChild(node: { value: string }) {
      if (appended !== node) {
        throw new Error('removeChild called with unexpected node');
      }
      appended = null;
    },
  };

  const codeBlock = {
    querySelector(selector: string) {
      return selector === '.copy-btn' ? button : null;
    },
    cloneNode() {
      const clone: {
        textContent: string;
        querySelector: (selector: string) => { remove: () => void } | null;
      } = {
        textContent: `Copy\n${options.codeText}`,
        querySelector(selector: string) {
          if (selector !== '.copy-btn') return null;
          return {
            remove() {
              clone.textContent = options.codeText;
            },
          };
        },
      };
      return clone;
    },
    textContent: `Copy\n${options.codeText}`,
  };

  const textareaFactory = () => ({
    value: '',
    style: {} as Record<string, string>,
    setAttribute() {
      // no-op
    },
    focus() {
      // no-op
    },
    select() {
      // no-op
    },
  });

  const context: Record<string, any> = {
    document: {
      body,
      createElement(tagName: string) {
        assert(tagName === 'textarea', `Expected textarea creation, got ${tagName}`);
        return textareaFactory();
      },
      execCommand(command: string) {
        execCommands.push(command);
        return options.execCommandResult;
      },
      getElementById(id: string) {
        return id === 'code-block' ? codeBlock : null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {
        // no-op
      },
    },
    navigator: options.clipboardWrite
      ? {
          clipboard: {
            async writeText(value: string) {
              clipboardWrites.push(value);
              await options.clipboardWrite!(value);
            },
          },
        }
      : {},
    window: {
      event: null,
      addEventListener() {
        // no-op
      },
      removeEventListener() {
        // no-op
      },
    },
    setTimeout(fn: () => void) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {
      // no-op
    },
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(AGENT_TAB_UI_SCRIPT, context);

  return { context, button, timers, clipboardWrites, execCommands, appendedTextareas };
}

function createSwitchTabHarness(): ToggleHarness {
  const tabAnyAgent = { classList: createClassList(['active']) };
  const tabCodex = { classList: createClassList() };
  const panelAnyAgent = { classList: createClassList(['active']) };
  const panelCodex = { classList: createClassList() };

  const context: Record<string, any> = {
    document: {
      querySelectorAll(selector: string) {
        if (selector === '.agent-tab') return [tabAnyAgent, tabCodex];
        if (selector === '.panel-content') return [panelAnyAgent, panelCodex];
        return [];
      },
      getElementById(id: string) {
        if (id === 'tab-any-agent') return panelAnyAgent;
        if (id === 'tab-codex') return panelCodex;
        return null;
      },
      addEventListener() {
        // no-op
      },
    },
    window: {
      event: null,
      addEventListener() {
        // no-op
      },
      removeEventListener() {
        // no-op
      },
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {
      // no-op
    },
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(AGENT_TAB_UI_SCRIPT, context);

  return { context, tabAnyAgent, tabCodex, panelAnyAgent, panelCodex };
}

async function run(): Promise<void> {
  assert(
    AGENT_TAB_UI_SCRIPT.includes("document.execCommand('copy')"),
    'copy script should keep the execCommand fallback for restricted clipboard contexts',
  );
  const switchTabHarness = createSwitchTabHarness();
  switchTabHarness.context.switchTab('codex', switchTabHarness.tabCodex);
  assert(!switchTabHarness.tabAnyAgent.classList.contains('active'), 'switchTab should clear active state on previously selected tab');
  assert(switchTabHarness.tabCodex.classList.contains('active'), 'switchTab should set active state on clicked tab without relying on window.event');
  assert(!switchTabHarness.panelAnyAgent.classList.contains('active'), 'switchTab should clear active panel state');
  assert(switchTabHarness.panelCodex.classList.contains('active'), 'switchTab should activate selected panel');

  const preserveCopyPrefix = createHarness({
    codeText: 'Copy this command exactly\nline 2',
    clipboardWrite: async () => {},
    execCommandResult: true,
  });
  await preserveCopyPrefix.context.copyCode('code-block');
  assert(
    preserveCopyPrefix.clipboardWrites[0] === 'Copy this command exactly\nline 2',
    'copy script should preserve command text that starts with "Copy"',
  );
  assert(preserveCopyPrefix.button.textContent === 'Copied!', 'button should show copied state on success');
  preserveCopyPrefix.timers.forEach((timer) => timer());
  assert(preserveCopyPrefix.button.textContent === 'Copy', 'button should reset to Copy after timeout');

  const clipboardRejected = createHarness({
    codeText: 'echo fallback',
    clipboardWrite: async () => {
      throw new Error('clipboard blocked');
    },
    execCommandResult: true,
  });
  await clipboardRejected.context.copyCode('code-block');
  assert(clipboardRejected.execCommands.includes('copy'), 'clipboard rejection should fall back to execCommand copy');
  assert(clipboardRejected.appendedTextareas.length === 1, 'fallback should create a hidden textarea');
  assert(clipboardRejected.appendedTextareas[0].value === 'echo fallback', 'fallback textarea should contain copied text');
  assert(clipboardRejected.button.textContent === 'Copied!', 'button should show copied state when fallback succeeds');

  const fallbackFailure = createHarness({
    codeText: 'echo fail',
    execCommandResult: false,
  });
  await fallbackFailure.context.copyCode('code-block');
  assert(fallbackFailure.button.textContent === 'Copy failed', 'button should show failure state when copy fails');

  const externalTrigger = {
    textContent: 'Copy for your agent',
    getAttribute(name: string) {
      return name === 'data-copy-label' ? 'Copy for your agent' : null;
    },
  };
  const externalCopyHarness = createHarness({
    codeText: 'echo external trigger',
    clipboardWrite: async () => {},
    execCommandResult: true,
  });
  await externalCopyHarness.context.copyCode('code-block', externalTrigger);
  assert(externalTrigger.textContent === 'Copied!', 'external trigger button should show copied state on success');
  externalCopyHarness.timers.forEach((timer) => timer());
  assert(externalTrigger.textContent === 'Copy for your agent', 'external trigger button should restore its custom label after timeout');

  console.log('✓ homepage tab + copy script behavior is stable');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
