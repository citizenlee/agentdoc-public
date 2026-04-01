import { Schema, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  handleTaskCheckboxEvent,
  handleTaskCheckboxKeydown,
  shouldRebuildTaskCheckboxDecorations,
  toggleTaskAtPos,
} from '../editor/plugins/task-checkboxes.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function createSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      text: { group: 'inline' },
      paragraph: {
        group: 'block',
        content: 'text*',
        toDOM: () => ['p', 0],
        parseDOM: [{ tag: 'p' }],
      },
      bullet_list: {
        group: 'block',
        content: 'list_item+',
        toDOM: () => ['ul', 0],
        parseDOM: [{ tag: 'ul' }],
      },
      list_item: {
        content: 'paragraph block*',
        attrs: {
          checked: { default: null },
        },
        toDOM: () => ['li', 0],
        parseDOM: [{ tag: 'li' }],
      },
    },
    marks: {},
  });
}

const schema = createSchema();

function createDoc(checked: boolean): ProseMirrorNode {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Intro')]),
    schema.node('bullet_list', null, [
      schema.node('list_item', { checked }, [
        schema.node('paragraph', null, [schema.text('Task item')]),
      ]),
    ]),
  ]);
}

function findTaskPos(doc: ProseMirrorNode): number {
  let taskPos = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === 'list_item') {
      taskPos = pos;
      return false;
    }
    return true;
  });
  if (taskPos < 0) throw new Error('Expected a task list item in fixture doc');
  return taskPos;
}

function createMockView(initialState: EditorState, editable = true): EditorView {
  const view = {
    state: initialState,
    editable,
    dispatch(tr) {
      this.state = this.state.apply(tr);
    },
  };
  return view as unknown as EditorView;
}

function withFakeInputClass(run: () => void): void {
  const globalObject = globalThis as { HTMLInputElement?: unknown };
  const previous = globalObject.HTMLInputElement;

  class FakeInput {
    dataset: Record<string, string>;

    constructor(dataset: Record<string, string>) {
      this.dataset = dataset;
    }
  }

  globalObject.HTMLInputElement = FakeInput;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete globalObject.HTMLInputElement;
    } else {
      globalObject.HTMLInputElement = previous;
    }
  }
}

function run(): void {
  const baseState = EditorState.create({
    schema,
    doc: createDoc(false),
  });
  const taskPos = findTaskPos(baseState.doc);

  const editableView = createMockView(baseState, true) as EditorView & {
    state: EditorState;
    editable: boolean;
  };

  const cursorPos = taskPos + 2;
  editableView.state = editableView.state.apply(editableView.state.tr.setSelection(TextSelection.create(editableView.state.doc, cursorPos)));
  const beforeSelection = editableView.state.selection.from;
  assert(toggleTaskAtPos(editableView, taskPos), 'Expected toggleTaskAtPos to toggle checkbox when editable');
  assert(editableView.state.doc.nodeAt(taskPos)?.attrs?.checked === true, 'Expected task to be checked after toggle');
  assert(editableView.state.selection.from === beforeSelection, 'Expected toggleTaskAtPos to preserve selection position');

  const readOnlyView = createMockView(baseState, false) as EditorView & {
    state: EditorState;
    editable: boolean;
  };
  assert(!toggleTaskAtPos(readOnlyView, taskPos), 'Expected toggleTaskAtPos to no-op in read-only mode');
  assert(readOnlyView.state.doc.nodeAt(taskPos)?.attrs?.checked === false, 'Expected read-only toggle to keep checkbox unchecked');

  withFakeInputClass(() => {
    const clickableView = createMockView(baseState, true) as EditorView & {
      state: EditorState;
      editable: boolean;
    };
    const clickEvent = {
      target: new (globalThis as any).HTMLInputElement({ taskCheckbox: 'true', taskPos: String(taskPos) }),
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    assert(handleTaskCheckboxEvent(clickableView, clickEvent as unknown as Event), 'Expected checkbox click to be handled');
    assert(clickEvent.prevented, 'Expected checkbox click handler to prevent default browser behavior');
    assert(clickableView.state.doc.nodeAt(taskPos)?.attrs?.checked === true, 'Expected checkbox click to toggle checked state');

    const readOnlyClickView = createMockView(baseState, false) as EditorView & {
      state: EditorState;
      editable: boolean;
    };
    const readOnlyClickEvent = {
      target: new (globalThis as any).HTMLInputElement({ taskCheckbox: 'true', taskPos: String(taskPos) }),
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    assert(handleTaskCheckboxEvent(readOnlyClickView, readOnlyClickEvent as unknown as Event), 'Expected read-only checkbox click to be consumed');
    assert(readOnlyClickEvent.prevented, 'Expected read-only click path to prevent native checkbox toggle');
    assert(readOnlyClickView.state.doc.nodeAt(taskPos)?.attrs?.checked === false, 'Expected read-only click to avoid document mutation');

    const keyboardView = createMockView(baseState, true) as EditorView & {
      state: EditorState;
      editable: boolean;
    };
    const keydownEvent = {
      key: 'Enter',
      target: new (globalThis as any).HTMLInputElement({ taskCheckbox: 'true', taskPos: String(taskPos) }),
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    assert(handleTaskCheckboxKeydown(keyboardView, keydownEvent as unknown as KeyboardEvent), 'Expected Enter key to toggle checkbox');
    assert(keydownEvent.prevented, 'Expected keyboard toggle to prevent default');
    assert(keyboardView.state.doc.nodeAt(taskPos)?.attrs?.checked === true, 'Expected keyboard interaction to toggle checked state');

    const ignoredKeyEvent = {
      key: 'Escape',
      target: new (globalThis as any).HTMLInputElement({ taskCheckbox: 'true', taskPos: String(taskPos) }),
      preventDefault() {},
    };
    assert(!handleTaskCheckboxKeydown(keyboardView, ignoredKeyEvent as unknown as KeyboardEvent), 'Expected non-toggle keys to be ignored');
  });

  const nonTaskEditState = EditorState.create({
    schema,
    doc: createDoc(false),
  });
  const nonTaskEditTr = nonTaskEditState.tr.insertText('!', 2);
  const nonTaskEditNext = nonTaskEditState.apply(nonTaskEditTr);
  assert(
    !shouldRebuildTaskCheckboxDecorations(nonTaskEditTr, nonTaskEditState.doc, nonTaskEditNext.doc),
    'Expected plain text edits away from task items to skip full decoration rebuild',
  );

  const taskToggleState = EditorState.create({
    schema,
    doc: createDoc(false),
  });
  const taskTogglePos = findTaskPos(taskToggleState.doc);
  const taskTextEditTr = taskToggleState.tr.insertText(' updated', taskTogglePos + 3);
  const taskTextEditNext = taskToggleState.apply(taskTextEditTr);
  assert(
    !shouldRebuildTaskCheckboxDecorations(taskTextEditTr, taskToggleState.doc, taskTextEditNext.doc),
    'Expected text edits inside existing task items to skip full decoration rebuild',
  );

  const taskNode = taskToggleState.doc.nodeAt(taskTogglePos);
  assert(taskNode !== null, 'Expected task node at known position');
  const taskToggleTr = taskToggleState.tr.setNodeMarkup(taskTogglePos, undefined, {
    ...(taskNode?.attrs ?? {}),
    checked: true,
  });
  const taskToggleNext = taskToggleState.apply(taskToggleTr);
  assert(
    shouldRebuildTaskCheckboxDecorations(taskToggleTr, taskToggleState.doc, taskToggleNext.doc),
    'Expected task checkbox attribute updates to trigger decoration rebuild',
  );

  console.log('✓ task checkboxes interactions, accessibility, and rebuild heuristics');
}

run();
