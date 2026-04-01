/**
 * Agent Navigation
 *
 * Provides navigation to agent positions in the document:
 * - Single click: Toggle follow mode
 * - Escape: Exit follow mode
 * - Gutter indicators for agent locations
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import { getSessionManager, type AgentSession } from '../agent/session-manager';

// ============================================================================
// Types
// ============================================================================

interface NavigatorState {
  editorView: EditorView | null;
  followingAgent: string | null;
  positionUnsubscribe: (() => void) | null;
  gutterElement: HTMLElement | null;
  flashElement: HTMLElement | null;
  containerElement: HTMLElement | null;
  scrollParent: HTMLElement | null;
  manualScrollHandler: ((event: Event) => void) | null;
  isProgrammaticScroll: boolean;
}

// ============================================================================
// State
// ============================================================================

const state: NavigatorState = {
  editorView: null,
  followingAgent: null,
  positionUnsubscribe: null,
  gutterElement: null,
  flashElement: null,
  containerElement: null,
  scrollParent: null,
  manualScrollHandler: null,
  isProgrammaticScroll: false,
};

// ============================================================================
// Scroll and Highlight
// ============================================================================

/**
 * Scroll the editor to a position
 */
function scrollToPosition(view: EditorView, position: number, behavior: ScrollBehavior = 'auto'): void {
  try {
    // Clamp position to valid range
    const maxPos = view.state.doc.content.size;
    const clampedPos = Math.max(0, Math.min(position, maxPos));
    console.log('[AgentNavigation] scrollToPosition', {
      position,
      clampedPos,
      docSize: maxPos,
    });

    const coords = view.coordsAtPos(clampedPos);
    const editorContainer = getEditorContainer(view);
    const scrollParent = findScrollParent(editorContainer ?? view.dom);

    const domResult = view.domAtPos(clampedPos);
    let el: Node | null = domResult.node;

    while (el && !(el instanceof HTMLElement)) {
      el = el.parentNode;
    }

    let blockEl: HTMLElement | null = el instanceof HTMLElement ? el : null;
    while (blockEl && !(blockEl.tagName.match(/^(P|H[1-6]|LI|PRE|BLOCKQUOTE|DIV)$/i))) {
      blockEl = blockEl.parentElement;
    }

    if (blockEl) {
      recordDebug('scrollIntoView', {
        position: clampedPos,
        tag: blockEl.tagName,
        top: blockEl.getBoundingClientRect().top,
      });
      const beforeScrollTop = document.scrollingElement?.scrollTop ?? null;
      console.log('[AgentNavigation] scrollIntoView', {
        tag: blockEl.tagName,
        top: blockEl.getBoundingClientRect().top,
      });
      blockEl.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
      setTimeout(() => {
        const afterScrollTop = document.scrollingElement?.scrollTop ?? null;
        recordDebug('scrollResult', { beforeScrollTop, afterScrollTop });
        if (beforeScrollTop === afterScrollTop && scrollParent) {
          recordDebug('scrollFallbackAfterNoop', {
            position: clampedPos,
            coordsTop: coords.top,
            coordsBottom: coords.bottom,
            containerTag: editorContainer?.tagName ?? null,
            scrollParentTag: scrollParent?.tagName ?? null,
            scrollParentClass: scrollParent?.className ?? null,
          });
          const containerRect = scrollParent.getBoundingClientRect();
          const scrollTop = scrollParent === document.scrollingElement
            ? window.scrollY
            : scrollParent.scrollTop;
          const targetY = coords.top - containerRect.top + scrollTop;
          const scrollTarget = targetY - containerRect.height / 3;
          if (scrollParent === document.scrollingElement) {
            window.scrollTo({ top: Math.max(0, scrollTarget), behavior });
          } else {
            scrollParent.scrollTo({ top: Math.max(0, scrollTarget), behavior });
          }
        }
      }, 200);
      return;
    }

    // Fallback to coordinate-based scrolling if no block element found.
    recordDebug('scrollFallback', {
      position: clampedPos,
      coordsTop: coords.top,
      coordsBottom: coords.bottom,
      containerTag: editorContainer?.tagName ?? null,
      scrollParentTag: scrollParent?.tagName ?? null,
      scrollParentClass: scrollParent?.className ?? null,
    });
    console.log('[AgentNavigation] scrollFallback', {
      coordsTop: coords.top,
      coordsBottom: coords.bottom,
    });

    if (!scrollParent) return;

    const containerRect = scrollParent.getBoundingClientRect();
    const scrollTop = scrollParent === document.scrollingElement
      ? window.scrollY
      : scrollParent.scrollTop;
    const targetY = coords.top - containerRect.top + scrollTop;
    const scrollTarget = targetY - containerRect.height / 3;

    if (scrollParent === document.scrollingElement) {
      const beforeScrollTop = document.scrollingElement?.scrollTop ?? null;
      window.scrollTo({ top: Math.max(0, scrollTarget), behavior });
      setTimeout(() => {
        const afterScrollTop = document.scrollingElement?.scrollTop ?? null;
        recordDebug('scrollResult', { beforeScrollTop, afterScrollTop });
      }, 200);
    } else {
      const beforeScrollTop = scrollParent.scrollTop;
      scrollParent.scrollTo({ top: Math.max(0, scrollTarget), behavior });
      setTimeout(() => {
        recordDebug('scrollResult', { beforeScrollTop, afterScrollTop: scrollParent.scrollTop });
      }, 200);
    }
  } catch (error) {
    console.error('[AgentNavigation] Failed to scroll:', error);
  }
}

/**
 * Flash highlight at a position
 */
function flashHighlight(view: EditorView, position: number): void {
  try {
    // Remove existing flash
    if (state.flashElement && state.flashElement.parentNode) {
      state.flashElement.parentNode.removeChild(state.flashElement);
    }

    // Clamp position
    const maxPos = view.state.doc.content.size;
    const clampedPos = Math.max(0, Math.min(position, maxPos));

    // Get coordinates
    const coords = view.coordsAtPos(clampedPos);
    const lineStartCoords = view.coordsAtPos(Math.max(0, clampedPos - 50));
    const lineEndCoords = view.coordsAtPos(Math.min(maxPos, clampedPos + 50));

    // Create flash element
    const flash = document.createElement('div');
    flash.className = 'agent-navigation-flash';
    flash.style.cssText = `
      position: fixed;
      left: ${Math.min(lineStartCoords.left, coords.left) - 8}px;
      top: ${coords.top - 4}px;
      width: ${Math.max(lineEndCoords.right - lineStartCoords.left, 100) + 16}px;
      height: ${coords.bottom - coords.top + 8}px;
      background: rgba(37, 99, 235, 0.2);
      border-radius: 4px;
      pointer-events: none;
      z-index: 9999;
      animation: flashPulse 0.5s ease-out forwards;
    `;

    document.body.appendChild(flash);
    state.flashElement = flash;

    // Remove after animation
    setTimeout(() => {
      if (flash.parentNode) {
        flash.parentNode.removeChild(flash);
      }
      if (state.flashElement === flash) {
        state.flashElement = null;
      }
    }, 500);
  } catch (error) {
    console.error('[AgentNavigation] Failed to create flash:', error);
  }
}

// ============================================================================
// DOM Helpers
// ============================================================================

type AgentNavDebugEvent = Record<string, unknown>;

function recordDebug(event: string, data: AgentNavDebugEvent = {}): void {
  const win = window as Window & { __agentNavigationDebug?: AgentNavDebugEvent[] };
  const store = win.__agentNavigationDebug ?? [];
  store.push({ event, at: Date.now(), ...data });
  if (store.length > 200) store.shift();
  win.__agentNavigationDebug = store;
}

function getEditorContainer(view: EditorView): HTMLElement | null {
  const dom = view.dom as HTMLElement;
  return dom.closest('#editor') as HTMLElement
    || dom.closest('#editor-container') as HTMLElement
    || dom.closest('.editor') as HTMLElement
    || dom.closest('#app') as HTMLElement
    || dom.parentElement;
}

function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
        && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

// ============================================================================
// Follow State Sync
// ============================================================================

function markProgrammaticScroll(): void {
  state.isProgrammaticScroll = true;
  setTimeout(() => {
    state.isProgrammaticScroll = false;
  }, 100);
}

function scrollToPositionProgrammatic(position: number): void {
  if (!state.editorView) return;
  markProgrammaticScroll();
  scrollToPosition(state.editorView, position, 'auto');
}

/**
 * Show follow mode indicator (pulsing border)
 */
function showFollowIndicator(): void {
  if (!state.editorView) return;

  const editorEl = getEditorContainer(state.editorView) ?? state.editorView.dom;
  editorEl.classList.add('editor-follow-mode');
}

/**
 * Hide follow mode indicator
 */
function hideFollowIndicator(): void {
  if (!state.editorView) return;

  const editorEl = getEditorContainer(state.editorView) ?? state.editorView.dom;
  editorEl.classList.remove('editor-follow-mode');
}

// ============================================================================
// Gutter Indicators
// ============================================================================

/**
 * Create/update gutter indicators for agent positions
 */
function updateGutterIndicators(): void {
  if (!state.editorView) return;

  // Remove existing gutter
  if (state.gutterElement && state.gutterElement.parentNode) {
    state.gutterElement.parentNode.removeChild(state.gutterElement);
  }

  const sessionManager = getSessionManager();
  const activeSessions = sessionManager.getActiveSessions();

  if (activeSessions.length === 0) return;

  // Create gutter container
  const gutter = document.createElement('div');
  gutter.className = 'agent-gutter-indicators';
  state.gutterElement = gutter;

  // Get editor position
  const editorContainer = getEditorContainer(state.editorView) ?? state.editorView.dom;
  const editorRect = editorContainer.getBoundingClientRect();

  gutter.style.cssText = `
    position: fixed;
    left: ${editorRect.left - 20}px;
    top: ${editorRect.top}px;
    width: 16px;
    height: ${editorRect.height}px;
    pointer-events: none;
    z-index: 100;
  `;

  // Add indicator for each active agent with a position
  for (const session of activeSessions) {
    if (session.documentPosition === null) continue;

    try {
      const maxPos = state.editorView.state.doc.content.size;
      const clampedPos = Math.max(0, Math.min(session.documentPosition, maxPos));
      const coords = state.editorView.coordsAtPos(clampedPos);

      const isExternal = session.id.startsWith('external-');
      const indicator = document.createElement('div');
      indicator.className = `agent-gutter-dot ${session.status} ${isExternal ? 'external' : 'embedded'}`;
      indicator.dataset.sessionId = session.id;
      indicator.title = session.skill || 'Agent';

      const relativeTop = coords.top - editorRect.top;
      indicator.style.cssText = `
        position: absolute;
        left: 4px;
        top: ${relativeTop}px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: ${isExternal ? 'var(--human-color, #6EE7B7)' : 'var(--ai-color, #A5B4FC)'};
        animation: pulse 1.5s ease-in-out infinite;
        pointer-events: auto;
        cursor: pointer;
      `;

      // Click to navigate
      indicator.addEventListener('click', () => {
        navigateToAgent(session.id);
      });

      gutter.appendChild(indicator);
    } catch {
      // Skip invalid positions
    }
  }

  document.body.appendChild(gutter);
}

function handleSessionChange(): void {
  updateGutterIndicators();

  if (!state.followingAgent) return;

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(state.followingAgent);
  if (!session || ['completed', 'error', 'cancelled'].includes(session.status)) {
    stopFollowing();
    return;
  }
}

function handleManualScroll(event: Event): void {
  if (!state.followingAgent) return;
  if (state.isProgrammaticScroll) return;
  stopFollowing();
}

// ============================================================================
// Navigation Functions
// ============================================================================

/**
 * Navigate to an agent's location
 */
export function navigateToAgent(sessionId: string): void {
  if (!state.editorView) return;

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);

  const position = session?.documentPosition ?? 0;

  scrollToPosition(state.editorView, position, 'auto');
  flashHighlight(state.editorView, position);
}

/**
 * Start following an agent
 */
export function startFollowing(sessionId: string): void {
  if (!state.editorView) return;

  if (state.followingAgent === sessionId) {
    // Keep follow mode on repeated follow requests (e.g. double-click).
    // Re-center on the latest known position instead of toggling off.
    const session = getSessionManager().getSession(sessionId);
    const position = session?.documentPosition ?? 0;
    scrollToPositionProgrammatic(position);
    return;
  }

  if (state.followingAgent) {
    stopFollowing();
  }

  state.followingAgent = sessionId;
  showFollowIndicator();

  // Subscribe to position updates
  const sessionManager = getSessionManager();
  state.positionUnsubscribe = sessionManager.onPositionChange(sessionId, (position) => {
    if (state.editorView && state.followingAgent === sessionId) {
      recordDebug('onPositionChange', { sessionId, position });
      console.log('[AgentNavigation] onPositionChange', { sessionId, position });
      scrollToPositionProgrammatic(position);
    }
  });

  // Navigate immediately
  const session = sessionManager.getSession(sessionId);
  const position = session?.documentPosition ?? 0;
  scrollToPositionProgrammatic(position);
}

export function followAgent(sessionId: string): void {
  startFollowing(sessionId);
}

/**
 * Stop following
 */
export function stopFollowing(_showToast: boolean = false): void {
  if (state.positionUnsubscribe) {
    state.positionUnsubscribe();
    state.positionUnsubscribe = null;
  }

  const previous = state.followingAgent;
  state.followingAgent = null;
  state.isProgrammaticScroll = false;
  hideFollowIndicator();
}

export function unfollowAgent(showToast: boolean = false): void {
  stopFollowing(showToast);
}

/**
 * Toggle follow mode for an agent
 */
export function toggleFollow(sessionId: string): void {
  if (state.followingAgent === sessionId) {
    stopFollowing(false);
  } else {
    startFollowing(sessionId);
  }
}

/**
 * Check if following an agent
 */
export function isFollowing(): boolean {
  return state.followingAgent !== null;
}

/**
 * Get the currently followed agent
 */
export function getFollowedAgent(): string | null {
  return state.followingAgent;
}

// ============================================================================
// Keyboard Handler
// ============================================================================

function handleKeydown(event: KeyboardEvent): void {
  // Escape exits follow mode
  if (event.key === 'Escape' && state.followingAgent) {
    stopFollowing(false);
    event.preventDefault();
  }
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize agent navigation
 */
export function initAgentNavigation(view: EditorView): () => void {
  state.editorView = view;
  state.containerElement = getEditorContainer(view);

  // Add styles
  if (!document.getElementById('agent-navigation-styles')) {
    const style = document.createElement('style');
    style.id = 'agent-navigation-styles';
    style.textContent = `
      @keyframes flashPulse {
        0% { opacity: 0.8; transform: scale(1); }
        100% { opacity: 0; transform: scale(1.1); }
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(0.9); }
      }

      .editor-follow-mode {
        position: relative;
        z-index: 0;
      }

      .editor-follow-mode::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 8px;
        box-shadow:
          inset 0 0 0 2px rgba(139, 92, 246, 0.5),
          inset 0 0 20px rgba(139, 92, 246, 0.15);
        pointer-events: none;
        animation: followPulse 2s ease-in-out infinite;
        z-index: 2;
      }

      @keyframes followPulse {
        0%, 100% { opacity: 0.8; }
        50% { opacity: 1; }
      }

      @media (prefers-reduced-motion: reduce) {
        .editor-follow-mode::before {
          animation: none;
        }
      }

      .agent-gutter-dot {
        transition: transform 0.15s ease;
      }

      .agent-gutter-dot:hover {
        transform: scale(1.3);
      }

      .agent-gutter-dot.acting {
        background: var(--agentdoc-warning, #f59e0b);
      }
    `;
    document.head.appendChild(style);
  }

  // Add keyboard handler
  document.addEventListener('keydown', handleKeydown);

  state.scrollParent = findScrollParent(state.containerElement ?? view.dom);
  state.manualScrollHandler = handleManualScroll;
  const scrollTarget: EventTarget = state.scrollParent ?? document;
  scrollTarget.addEventListener('wheel', handleManualScroll, { passive: true });
  scrollTarget.addEventListener('touchmove', handleManualScroll, { passive: true });
  scrollTarget.addEventListener('scroll', handleManualScroll, { passive: true });

  // Subscribe to session changes to update gutter
  const sessionManager = getSessionManager();
  const unsubscribe = sessionManager.onSessionChange(() => {
    handleSessionChange();
  });

  // Initial gutter update
  updateGutterIndicators();

  // Set up periodic gutter updates (for scroll)
  const gutterInterval = setInterval(() => {
    if (state.editorView) {
      updateGutterIndicators();
    }
  }, 500);

  // Return cleanup function
  return () => {
    document.removeEventListener('keydown', handleKeydown);
    const cleanupScrollTarget: EventTarget = state.scrollParent ?? document;
    if (state.manualScrollHandler) {
      cleanupScrollTarget.removeEventListener('wheel', state.manualScrollHandler);
      cleanupScrollTarget.removeEventListener('touchmove', state.manualScrollHandler);
      cleanupScrollTarget.removeEventListener('scroll', state.manualScrollHandler);
    }
    unsubscribe();
    clearInterval(gutterInterval);
    stopFollowing();

    if (state.gutterElement && state.gutterElement.parentNode) {
      state.gutterElement.parentNode.removeChild(state.gutterElement);
    }
    if (state.flashElement && state.flashElement.parentNode) {
      state.flashElement.parentNode.removeChild(state.flashElement);
    }

    state.editorView = null;
    state.containerElement = null;
    state.scrollParent = null;
    state.manualScrollHandler = null;
    state.gutterElement = null;
    state.flashElement = null;
  };
}

export default {
  initAgentNavigation,
  navigateToAgent,
  startFollowing,
  stopFollowing,
  followAgent,
  unfollowAgent,
  toggleFollow,
  isFollowing,
  getFollowedAgent,
};
