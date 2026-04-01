/**
 * Context Menu for Agentdoc
 *
 * Provides right-click menu with agent options:
 * - Ask Agentdoc... (opens input dialog)
 * - Quick Actions submenu
 * - Add Comment for Agentdoc
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import { showAgentInputDialog } from './agent-input-dialog';
import { comment as addComment } from '../editor/plugins/marks';
import { getCurrentActor } from '../editor/actor';
import type { AgentInputContext } from '../editor/plugins/keybindings';
import { getTextForRange } from '../editor/utils/text-range';

// ============================================================================
// Types
// ============================================================================

interface ContextMenuState {
  isOpen: boolean;
  element: HTMLElement | null;
  editorView: EditorView | null;
  selectionContext: {
    text: string;
    from: number;
    to: number;
  } | null;
}

type QuickAction = 'fix-grammar' | 'improve-clarity' | 'make-shorter';

// ============================================================================
// State
// ============================================================================

const state: ContextMenuState = {
  isOpen: false,
  element: null,
  editorView: null,
  selectionContext: null,
};

// ============================================================================
// Menu Element
// ============================================================================

function createMenuElement(): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'agentdoc-context-menu';
  menu.innerHTML = `
    <div class="agentdoc-context-menu-items">
      <button class="agentdoc-context-menu-item" data-action="ask-agentdoc">
        <span class="agentdoc-context-menu-icon">💬</span>
        <span>Ask Agentdoc...</span>
        <span class="agentdoc-context-menu-shortcut">⇧⌘P</span>
      </button>
      <div class="agentdoc-context-menu-item has-submenu" data-action="quick-actions">
        <span class="agentdoc-context-menu-icon">⚡</span>
        <span>Quick Actions</span>
        <span class="agentdoc-context-menu-arrow">▶</span>
        <div class="agentdoc-context-submenu">
          <button class="agentdoc-context-menu-item" data-quick-action="fix-grammar">
            Fix grammar
          </button>
          <button class="agentdoc-context-menu-item" data-quick-action="improve-clarity">
            Improve clarity
          </button>
          <button class="agentdoc-context-menu-item" data-quick-action="make-shorter">
            Make it shorter
          </button>
        </div>
      </div>
      <div class="agentdoc-context-menu-separator"></div>
      <button class="agentdoc-context-menu-item" data-action="add-comment">
        <span class="agentdoc-context-menu-icon">📝</span>
        <span>Add Comment for Agentdoc</span>
        <span class="agentdoc-context-menu-shortcut">⇧⌘K</span>
      </button>
    </div>
  `;

  // Add styles if not already added
  if (!document.getElementById('agentdoc-context-menu-styles')) {
    const style = document.createElement('style');
    style.id = 'agentdoc-context-menu-styles';
    style.textContent = `
      .agentdoc-context-menu {
        position: fixed;
        z-index: 10001;
        background: var(--agentdoc-bg, #ffffff);
        border: 1px solid var(--agentdoc-border, #e5e7eb);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        min-width: 220px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        padding: 4px 0;
        opacity: 0;
        transform: scale(0.95);
        transform-origin: top left;
        transition: opacity 0.1s ease, transform 0.1s ease;
      }

      .agentdoc-context-menu.visible {
        opacity: 1;
        transform: scale(1);
      }

      .agentdoc-context-menu-items {
        display: flex;
        flex-direction: column;
      }

      .agentdoc-context-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: none;
        border: none;
        text-align: left;
        cursor: pointer;
        color: var(--agentdoc-text, #1f2937);
        width: 100%;
        position: relative;
      }

      .agentdoc-context-menu-item:hover {
        background: var(--agentdoc-bg-hover, #f3f4f6);
      }

      .agentdoc-context-menu-item:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .agentdoc-context-menu-icon {
        width: 20px;
        text-align: center;
        font-size: 14px;
      }

      .agentdoc-context-menu-shortcut {
        margin-left: auto;
        color: var(--agentdoc-text-muted, #9ca3af);
        font-size: 11px;
      }

      .agentdoc-context-menu-arrow {
        margin-left: auto;
        color: var(--agentdoc-text-muted, #9ca3af);
        font-size: 10px;
      }

      .agentdoc-context-menu-separator {
        height: 1px;
        background: var(--agentdoc-border, #e5e7eb);
        margin: 4px 0;
      }

      .agentdoc-context-menu-item.has-submenu {
        position: relative;
      }

      .agentdoc-context-submenu {
        position: absolute;
        left: 100%;
        top: -4px;
        background: var(--agentdoc-bg, #ffffff);
        border: 1px solid var(--agentdoc-border, #e5e7eb);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        min-width: 160px;
        padding: 4px 0;
        opacity: 0;
        visibility: hidden;
        transform: translateX(-8px);
        transition: opacity 0.1s ease, transform 0.1s ease, visibility 0.1s;
      }

      .agentdoc-context-menu-item.has-submenu:hover .agentdoc-context-submenu {
        opacity: 1;
        visibility: visible;
        transform: translateX(0);
      }

      /* Dark mode support */
      @media (prefers-color-scheme: dark) {
        .agentdoc-context-menu {
          --agentdoc-bg: #1f2937;
          --agentdoc-bg-hover: #374151;
          --agentdoc-border: #4b5563;
          --agentdoc-text: #f9fafb;
          --agentdoc-text-muted: #9ca3af;
        }
      }
    `;
    document.head.appendChild(style);
  }

  return menu;
}

// ============================================================================
// Menu Positioning
// ============================================================================

function positionMenu(menu: HTMLElement, x: number, y: number): void {
  const margin = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Temporarily show to get dimensions
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();

  // Adjust position to stay within viewport
  let left = x;
  let top = y;

  if (left + rect.width > viewportW - margin) {
    left = viewportW - rect.width - margin;
  }
  if (left < margin) {
    left = margin;
  }

  if (top + rect.height > viewportH - margin) {
    top = viewportH - rect.height - margin;
  }
  if (top < margin) {
    top = margin;
  }

  menu.style.visibility = '';
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// ============================================================================
// Event Handlers
// ============================================================================

function handleKeyDown(e: KeyboardEvent): void {
  if (!state.isOpen) return;

  if (e.key === 'Escape') {
    closeMenu();
    e.preventDefault();
    e.stopPropagation();
  }
}

function handleClickOutside(e: MouseEvent): void {
  if (!state.isOpen || !state.element) return;

  if (!state.element.contains(e.target as Node)) {
    closeMenu();
  }
}

function handleAction(action: string): void {
  if (!state.editorView || !state.selectionContext) return;

  const view = state.editorView;
  const { text, from, to } = state.selectionContext;
  const coords = view.coordsAtPos(from);

  switch (action) {
    case 'ask-agentdoc': {
      const context: AgentInputContext = {
        selection: text,
        range: { from, to },
        position: { top: coords.top, left: coords.left },
      };
      showAgentInputDialog(context, {
        onSubmit: async (prompt: string) => {
          const event = new CustomEvent('agentdoc:invoke-agent', {
            detail: { prompt, context },
          });
          window.dispatchEvent(event);
        },
        onCancel: () => {},
      });
      break;
    }

    case 'add-comment': {
      if (text.trim()) {
        const actor = getCurrentActor();
        addComment(view, text, actor, '[For @agentdoc to review]', { from, to });
      }
      break;
    }
  }

  closeMenu();
}

function handleQuickAction(action: QuickAction): void {
  if (!state.editorView || !state.selectionContext) return;

  const { text, from, to } = state.selectionContext;
  const coords = state.editorView.coordsAtPos(from);

  const prompts: Record<QuickAction, string> = {
    'fix-grammar': 'Fix any grammar issues in this text',
    'improve-clarity': 'Improve the clarity of this text while keeping the meaning',
    'make-shorter': 'Make this text more concise without losing important information',
  };

  const context: AgentInputContext = {
    selection: text,
    range: { from, to },
    position: { top: coords.top, left: coords.left },
  };

  const event = new CustomEvent('agentdoc:invoke-agent', {
    detail: { prompt: prompts[action], context },
  });
  window.dispatchEvent(event);

  closeMenu();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Show the context menu at the given position
 */
export function showContextMenu(
  view: EditorView,
  x: number,
  y: number
): void {
  // Close any existing menu
  if (state.isOpen) {
    closeMenu();
  }

  // Get selection context
  const { from, to } = view.state.selection;
  const selectedText = getTextForRange(view.state.doc, { from, to });

  state.editorView = view;
  state.selectionContext = {
    text: selectedText,
    from,
    to,
  };

  // Create and position menu
  const menu = createMenuElement();
  state.element = menu;
  state.isOpen = true;

  positionMenu(menu, x, y);

  // Animate in
  requestAnimationFrame(() => {
    menu.classList.add('visible');
  });

  // Disable items if no selection
  if (!selectedText.trim()) {
    const items = menu.querySelectorAll('[data-action="ask-agentdoc"], [data-action="quick-actions"], [data-action="add-comment"]');
    items.forEach((item) => {
      (item as HTMLButtonElement).disabled = true;
    });
  }

  // Wire up event handlers
  const askAgentdocBtn = menu.querySelector('[data-action="ask-agentdoc"]') as HTMLButtonElement;
  const addCommentBtn = menu.querySelector('[data-action="add-comment"]') as HTMLButtonElement;
  const quickActionBtns = menu.querySelectorAll('[data-quick-action]');

  askAgentdocBtn?.addEventListener('click', () => handleAction('ask-agentdoc'));
  addCommentBtn?.addEventListener('click', () => handleAction('add-comment'));

  quickActionBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.quickAction as QuickAction;
      handleQuickAction(action);
    });
  });

  // Global event listeners
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mousedown', handleClickOutside, true);
}

/**
 * Close the context menu
 */
export function closeMenu(): void {
  if (!state.element) return;

  state.element.classList.remove('visible');

  setTimeout(() => {
    if (state.element && state.element.parentNode) {
      state.element.parentNode.removeChild(state.element);
    }
    state.element = null;
    state.isOpen = false;
    state.editorView = null;
    state.selectionContext = null;
  }, 100);

  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('mousedown', handleClickOutside, true);
}

/**
 * Check if context menu is currently open
 */
export function isContextMenuOpen(): boolean {
  return state.isOpen;
}

/**
 * Initialize context menu for the editor
 * Sets up right-click handler
 */
export function initContextMenu(view: EditorView): () => void {
  const handleContextMenu = (e: MouseEvent) => {
    // Only show our menu if clicking in the editor
    if (view.dom.contains(e.target as Node)) {
      e.preventDefault();
      showContextMenu(view, e.clientX, e.clientY);
    }
  };

  view.dom.addEventListener('contextmenu', handleContextMenu);

  // Return cleanup function
  return () => {
    view.dom.removeEventListener('contextmenu', handleContextMenu);
    closeMenu();
  };
}
