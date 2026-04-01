import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

type TaskCheckboxState = {
  decorations: DecorationSet;
  hasTaskItems: boolean;
};

const taskCheckboxesKey = new PluginKey<TaskCheckboxState>('task-checkboxes');
const TASK_ITEM_CLASS = 'agentdoc-task-item';
const TASK_ITEM_CHECKED_CLASS = 'agentdoc-task-item-checked';
const TASK_ITEM_UNCHECKED_CLASS = 'agentdoc-task-item-unchecked';

function isTaskCheckboxInput(target: EventTarget | null): target is HTMLInputElement {
  return typeof HTMLInputElement !== 'undefined'
    && target instanceof HTMLInputElement
    && target.dataset.taskCheckbox === 'true';
}

function collectTaskAnchorsInRange(doc: ProseMirrorNode, from: number, to: number): string[] {
  const docSize = doc.content.size;
  const safeFrom = Math.max(0, Math.min(from, docSize));
  const safeTo = Math.max(safeFrom, Math.min(to, docSize));
  const scanFrom = safeFrom === safeTo ? Math.max(0, safeFrom - 1) : safeFrom;
  const scanTo = safeFrom === safeTo ? Math.min(docSize, safeTo + 1) : safeTo;
  if (scanFrom === scanTo) return [];

  const anchors: string[] = [];
  doc.nodesBetween(scanFrom, scanTo, (node, pos) => {
    if (node.type.name === 'list_item' && node.attrs?.checked != null) {
      anchors.push(`${pos}:${node.attrs.checked ? 1 : 0}`);
    }
    return true;
  });
  anchors.sort();
  return anchors;
}

export function shouldRebuildTaskCheckboxDecorations(
  tr: Transaction,
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode
): boolean {
  if (!tr.docChanged) return false;
  if (tr.getMeta(taskCheckboxesKey) === 'toggle') return true;

  let needsRebuild = false;
  for (const stepMap of tr.mapping.maps) {
    stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (needsRebuild) return;

      const oldAnchors = collectTaskAnchorsInRange(oldDoc, oldStart, oldEnd);
      const newAnchors = collectTaskAnchorsInRange(newDoc, newStart, newEnd);
      if (oldAnchors.length !== newAnchors.length) {
        needsRebuild = true;
        return;
      }

      for (let i = 0; i < oldAnchors.length; i += 1) {
        if (oldAnchors[i] !== newAnchors[i]) {
          needsRebuild = true;
          return;
        }
      }

      // Task nodes can be present in both ranges during text edits inside an item.
      // If anchors are unchanged, mapped decorations remain valid.
    });
    if (needsRebuild) break;
  }

  return needsRebuild;
}

function buildDecorationsState(doc: ProseMirrorNode): TaskCheckboxState {
  const decorations: Decoration[] = [];
  let hasTaskItems = false;

  doc.descendants((node, pos) => {
    if (node.type.name !== 'list_item') return;
    const checked = node.attrs?.checked;
    if (checked == null) return;
    hasTaskItems = true;
    const isChecked = Boolean(checked);
    const taskItemClass = isChecked ? TASK_ITEM_CHECKED_CLASS : TASK_ITEM_UNCHECKED_CLASS;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `${TASK_ITEM_CLASS} ${taskItemClass}`,
      })
    );

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'agentdoc-task-checkbox';
    checkbox.checked = isChecked;
    checkbox.tabIndex = 0;
    checkbox.setAttribute('contenteditable', 'false');
    checkbox.setAttribute('data-task-checkbox', 'true');
    checkbox.setAttribute('data-task-pos', String(pos));
    checkbox.setAttribute('aria-label', isChecked ? 'Mark task as incomplete' : 'Mark task as complete');

    decorations.push(
      Decoration.widget(pos + 1, checkbox, {
        side: -1,
        key: `task-checkbox-${pos}-${isChecked ? 1 : 0}`,
      })
    );
  });

  return {
    decorations: DecorationSet.create(doc, decorations),
    hasTaskItems,
  };
}

function resolveTaskPos(view: EditorView, target: HTMLInputElement): number | null {
  try {
    const domPos = view.posAtDOM(target, 0);
    const $pos = view.state.doc.resolve(domPos);
    for (let depth = $pos.depth; depth >= 0; depth -= 1) {
      const node = $pos.node(depth);
      if (node.type.name === 'list_item' && node.attrs?.checked != null) {
        return $pos.before(depth);
      }
    }
  } catch {
    // Ignore DOM lookup errors and fall back to dataset.
  }

  const datasetPos = Number(target.dataset.taskPos);
  return Number.isFinite(datasetPos) ? datasetPos : null;
}

export function toggleTaskAtPos(view: EditorView, pos: number): boolean {
  if (!view.editable) return false;
  if (!Number.isFinite(pos)) return false;

  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'list_item') return false;
  const checked = node.attrs?.checked;
  if (checked == null) return false;

  const tr = state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    checked: !checked,
  }).setMeta(taskCheckboxesKey, 'toggle');
  view.dispatch(tr);
  return true;
}

export function handleTaskCheckboxEvent(view: EditorView, event: Event): boolean {
  const target = event.target;
  if (!isTaskCheckboxInput(target)) return false;

  event.preventDefault();
  if (!view.editable) return true;
  const pos = resolveTaskPos(view, target);
  if (pos == null) return false;
  return toggleTaskAtPos(view, pos);
}

export function handleTaskCheckboxKeydown(view: EditorView, event: KeyboardEvent): boolean {
  const target = event.target;
  if (!isTaskCheckboxInput(target)) return false;
  if (event.key !== ' ' && event.key !== 'Enter') return false;

  event.preventDefault();
  if (!view.editable) return true;
  const pos = resolveTaskPos(view, target);
  if (pos == null) return false;
  return toggleTaskAtPos(view, pos);
}

export const taskCheckboxesPlugin = $prose(() => {
  return new Plugin<TaskCheckboxState>({
    key: taskCheckboxesKey,
    state: {
      init: (_, state) => buildDecorationsState(state.doc),
      apply(tr, pluginState, oldState, newState) {
        if (!tr.docChanged) return pluginState;
        const mappedDecorations = pluginState.decorations.map(tr.mapping, newState.doc);
        if (!shouldRebuildTaskCheckboxDecorations(tr, oldState.doc, newState.doc)) {
          if (pluginState.hasTaskItems && mappedDecorations.find().length === 0) {
            // Rare recovery path: mapped set unexpectedly dropped all task widgets.
            return buildDecorationsState(newState.doc);
          }
          return {
            decorations: mappedDecorations,
            hasTaskItems: pluginState.hasTaskItems,
          };
        }
        return buildDecorationsState(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return taskCheckboxesKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target;
          if (isTaskCheckboxInput(target)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        click(view, event) {
          return handleTaskCheckboxEvent(view, event);
        },
        keydown(view, event) {
          if (!(event instanceof KeyboardEvent)) return false;
          return handleTaskCheckboxKeydown(view, event);
        },
      },
    },
  });
});
