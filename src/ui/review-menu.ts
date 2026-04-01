/**
 * Review Menu
 *
 * A menu for triggering skill-based reviews:
 * - Lists available skills (built-in and custom)
 * - Triggers review execution on selection or whole document
 */

import { getSkillsRegistry, type Skill } from '../agent/skills/registry';

// ============================================================================
// Types
// ============================================================================

interface ReviewMenuState {
  isOpen: boolean;
  element: HTMLElement | null;
  anchorElement: HTMLElement | null;
}

interface ReviewMenuCallbacks {
  onSkillSelect: (skill: Skill, scope: 'selection' | 'document') => void;
  onManageSkills?: () => void;
  onStopAllReviews?: () => void | Promise<void>;
}

// ============================================================================
// State
// ============================================================================

const state: ReviewMenuState = {
  isOpen: false,
  element: null,
  anchorElement: null,
};

let callbacks: ReviewMenuCallbacks = {
  onSkillSelect: () => {},
};

// ============================================================================
// Menu Rendering
// ============================================================================

function createMenuElement(hasSelection: boolean): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'review-menu';

  const registry = getSkillsRegistry();
  const skills = registry.getAllSkills();
  const hasFooterActions = Boolean(callbacks.onManageSkills || callbacks.onStopAllReviews);

  menu.innerHTML = `
    <div class="review-menu-content">
      <div class="review-menu-header">Run Review</div>
      <div class="review-menu-skills">
        ${skills
          .map(
            (skill) => `
          <button class="review-menu-skill" data-skill-id="${skill.id}">
            <span class="review-skill-icon">${skill.icon || '📋'}</span>
            <span class="review-skill-name">${skill.name}</span>
            <span class="review-skill-scope">${hasSelection ? 'Selection' : 'Document'}</span>
          </button>
        `
          )
          .join('')}
      </div>
      ${hasFooterActions ? `
        <div class="review-menu-footer">
          ${callbacks.onStopAllReviews ? `
            <button class="review-menu-stop">Stop All Reviews</button>
          ` : ''}
          ${callbacks.onManageSkills ? `
            <button class="review-menu-manage">+ Manage Skills...</button>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;

  // Add styles
  if (!document.getElementById('review-menu-styles')) {
    const style = document.createElement('style');
    style.id = 'review-menu-styles';
    style.textContent = `
      .review-menu {
        position: fixed;
        z-index: 10001;
        background: var(--agentdoc-bg, #ffffff);
        border: 1px solid var(--agentdoc-border, #e5e7eb);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        min-width: 220px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        opacity: 0;
        transform: scale(0.95);
        transform-origin: top left;
        transition: opacity 0.1s ease, transform 0.1s ease;
      }

      .review-menu.visible {
        opacity: 1;
        transform: scale(1);
      }

      .review-menu-header {
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--agentdoc-text-muted, #6b7280);
        border-bottom: 1px solid var(--agentdoc-border, #e5e7eb);
      }

      .review-menu-skills {
        padding: 4px 0;
      }

      .review-menu-skill {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 14px;
        background: none;
        border: none;
        text-align: left;
        cursor: pointer;
        color: var(--agentdoc-text, #1f2937);
        transition: background 0.1s ease;
      }

      .review-menu-skill:hover {
        background: var(--agentdoc-bg-hover, #f3f4f6);
      }

      .review-skill-icon {
        font-size: 16px;
        width: 20px;
        text-align: center;
      }

      .review-skill-name {
        flex: 1;
        font-weight: 500;
      }

      .review-skill-scope {
        font-size: 11px;
        color: var(--agentdoc-text-muted, #9ca3af);
        background: var(--agentdoc-bg-secondary, #f3f4f6);
        padding: 2px 6px;
        border-radius: 3px;
      }

      .review-menu-footer {
        padding: 4px 0;
        border-top: 1px solid var(--agentdoc-border, #e5e7eb);
      }

      .review-menu-stop {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 10px 14px;
        background: none;
        border: none;
        text-align: left;
        cursor: pointer;
        color: var(--agentdoc-danger, #b91c1c);
        font-size: 13px;
        font-weight: 600;
        transition: all 0.1s ease;
      }

      .review-menu-stop:hover {
        background: var(--agentdoc-danger-bg, rgba(185, 28, 28, 0.08));
        color: var(--agentdoc-danger-hover, #991b1b);
      }

      .review-menu-manage {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 10px 14px;
        background: none;
        border: none;
        text-align: left;
        cursor: pointer;
        color: var(--agentdoc-text-muted, #6b7280);
        font-size: 13px;
        transition: all 0.1s ease;
      }

      .review-menu-manage:hover {
        background: var(--agentdoc-bg-hover, #f3f4f6);
        color: var(--agentdoc-text, #1f2937);
      }

      /* Dark mode */
      @media (prefers-color-scheme: dark) {
        .review-menu {
          --agentdoc-bg: #1f2937;
          --agentdoc-bg-secondary: #374151;
          --agentdoc-bg-hover: #374151;
          --agentdoc-border: #4b5563;
          --agentdoc-text: #f9fafb;
          --agentdoc-text-muted: #9ca3af;
          --agentdoc-danger: #fca5a5;
          --agentdoc-danger-hover: #fecaca;
          --agentdoc-danger-bg: rgba(252, 165, 165, 0.12);
        }
      }
    `;
    document.head.appendChild(style);
  }

  return menu;
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const anchorRect = anchor.getBoundingClientRect();

  // Temporarily show to get dimensions
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();

  // Position below anchor by default
  let left = anchorRect.left;
  let top = anchorRect.bottom + 4;

  // Adjust to stay in viewport
  if (left + rect.width > viewportW - margin) {
    left = viewportW - rect.width - margin;
  }
  if (left < margin) {
    left = margin;
  }

  if (top + rect.height > viewportH - margin) {
    // Try above
    top = anchorRect.top - rect.height - 4;
    if (top < margin) {
      top = margin;
    }
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
    closeReviewMenu();
    e.preventDefault();
    e.stopPropagation();
  }
}

function handleClickOutside(e: MouseEvent): void {
  if (!state.isOpen || !state.element) return;

  if (!state.element.contains(e.target as Node)) {
    closeReviewMenu();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Show the review menu
 */
export function showReviewMenu(
  anchor: HTMLElement,
  hasSelection: boolean,
  options: ReviewMenuCallbacks
): void {
  // Close any existing menu
  if (state.isOpen) {
    closeReviewMenu();
  }

  callbacks = options;

  // Create and position menu
  const menu = createMenuElement(hasSelection);
  state.element = menu;
  state.anchorElement = anchor;
  state.isOpen = true;

  positionMenu(menu, anchor);

  // Animate in
  requestAnimationFrame(() => {
    menu.classList.add('visible');
  });

  // Wire up skill buttons
  const skillButtons = menu.querySelectorAll('.review-menu-skill');
  skillButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const skillId = (btn as HTMLElement).dataset.skillId;
      if (skillId) {
        const registry = getSkillsRegistry();
        const skill = registry.getSkill(skillId);
        if (skill) {
          callbacks.onSkillSelect(skill, hasSelection ? 'selection' : 'document');
        }
      }
      closeReviewMenu();
    });
  });

  // Wire up manage button
  const manageBtn = menu.querySelector('.review-menu-manage');
  manageBtn?.addEventListener('click', () => {
    callbacks.onManageSkills?.();
    closeReviewMenu();
  });

  // Wire up stop-all button
  const stopBtn = menu.querySelector('.review-menu-stop');
  stopBtn?.addEventListener('click', async () => {
    try {
      await callbacks.onStopAllReviews?.();
    } catch (error) {
      console.error('[review-menu] Failed to stop all reviews:', error);
    } finally {
      closeReviewMenu();
    }
  });

  // Global event listeners
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mousedown', handleClickOutside, true);
}

/**
 * Close the review menu
 */
export function closeReviewMenu(): void {
  if (!state.element) return;

  state.element.classList.remove('visible');

  setTimeout(() => {
    if (state.element && state.element.parentNode) {
      state.element.parentNode.removeChild(state.element);
    }
    state.element = null;
    state.anchorElement = null;
    state.isOpen = false;
  }, 100);

  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('mousedown', handleClickOutside, true);
}

/**
 * Check if menu is open
 */
export function isReviewMenuOpen(): boolean {
  return state.isOpen;
}

/**
 * Create a review button that can be added to the UI
 */
export function createReviewButton(
  hasSelection: boolean,
  onSkillSelect: (skill: Skill, scope: 'selection' | 'document') => void
): HTMLElement {
  const button = document.createElement('button');
  button.className = 'review-trigger-button';
  button.innerHTML = `
    <span class="review-trigger-icon">📋</span>
    <span class="review-trigger-text">Review</span>
    <span class="review-trigger-arrow">▼</span>
  `;

  button.addEventListener('click', () => {
    const handleStopAllReviews = async () => {
      if (!window.agentdoc?.stopAllReviews) {
        console.warn('[review-menu] stopAllReviews is not available on window.agentdoc');
        return;
      }
      await window.agentdoc.stopAllReviews();
    };
    showReviewMenu(button, hasSelection, { onSkillSelect, onStopAllReviews: handleStopAllReviews });
  });

  // Add button styles
  if (!document.getElementById('review-button-styles')) {
    const style = document.createElement('style');
    style.id = 'review-button-styles';
    style.textContent = `
      .review-trigger-button {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: var(--agentdoc-bg, #ffffff);
        border: 1px solid var(--agentdoc-border, #e5e7eb);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        color: var(--agentdoc-text, #1f2937);
        cursor: pointer;
        transition: all 0.1s ease;
      }

      .review-trigger-button:hover {
        background: var(--agentdoc-bg-hover, #f3f4f6);
        border-color: var(--agentdoc-border-hover, #d1d5db);
      }

      .review-trigger-icon {
        font-size: 14px;
      }

      .review-trigger-arrow {
        font-size: 10px;
        color: var(--agentdoc-text-muted, #9ca3af);
      }
    `;
    document.head.appendChild(style);
  }

  return button;
}

export default {
  showReviewMenu,
  closeReviewMenu,
  isReviewMenuOpen,
  createReviewButton,
};
