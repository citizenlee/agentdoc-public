export const AGENT_TAB_UI_SCRIPT = String.raw`function switchTab(id, triggerEl) {
  document.querySelectorAll('.agent-tab').forEach(function (tab) { tab.classList.remove('active'); });
  document.querySelectorAll('.panel-content').forEach(function (panel) { panel.classList.remove('active'); });
  var activeTab = triggerEl || null;
  if (!activeTab && typeof window !== 'undefined' && window.event && window.event.target) {
    var target = window.event.target;
    if (target && target.nodeType === 3 && target.parentElement) target = target.parentElement;
    if (target && typeof target.closest === 'function') {
      activeTab = target.closest('.agent-tab');
    } else {
      activeTab = target;
    }
  }
  if (activeTab && activeTab.classList && typeof activeTab.classList.add === 'function') {
    activeTab.classList.add('active');
  }
  var panel = document.getElementById('tab-' + id);
  if (panel) panel.classList.add('active');
}
function extractCodeBlockText(el) {
  if (!el) return '';
  try {
    var clone = el.cloneNode(true);
    var button = clone && typeof clone.querySelector === 'function' ? clone.querySelector('.copy-btn') : null;
    if (button && typeof button.remove === 'function') button.remove();
    return (clone && clone.textContent ? clone.textContent : '').trim();
  } catch (_error) {
    return (el.textContent || '').replace(/^Copy/, '').trim();
  }
}
async function writeTextToClipboard(text) {
  if (typeof navigator !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      // Fall back to execCommand for blocked clipboard APIs.
    }
  }
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
    return false;
  }
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  if (typeof textarea.focus === 'function') textarea.focus();
  if (typeof textarea.select === 'function') textarea.select();
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch (_error) {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
function flashCopyState(button, label) {
  if (!button) return;
  var defaultLabel = button.getAttribute('data-copy-label') || button.textContent || 'Copy';
  button.textContent = label;
  setTimeout(function () { button.textContent = defaultLabel; }, 1500);
}
async function copyCode(id, triggerEl) {
  var el = document.getElementById(id);
  if (!el) return;
  var button = triggerEl || el.querySelector('.copy-btn');
  var text = extractCodeBlockText(el);
  if (!text) {
    flashCopyState(button, 'Copy failed');
    return;
  }
  var copied = await writeTextToClipboard(text);
  flashCopyState(button, copied ? 'Copied!' : 'Copy failed');
}
document.querySelectorAll('.auth-link').forEach(function (link) {
  link.addEventListener('click', function () {
    link.textContent = 'Connecting…';
    link.style.pointerEvents = 'none';
    link.setAttribute('aria-disabled', 'true');
  }, { once: true });
});
var HOME_AUTH_REFRESH_KEY = 'agentdoc-home-auth-refresh-at';
function hasSessionCookie() {
  return document.cookie.split(';').some(function (part) {
    var trimmed = part.trim();
    return trimmed.indexOf('agentdoc_session=') === 0 || trimmed.indexOf('proof_session=') === 0;
  });
}
function homepageShowsSignedOutChrome() {
  return !!document.querySelector('.utility-auth .auth-link');
}
function clearPendingHomepageRefresh() {
  try {
    sessionStorage.removeItem(HOME_AUTH_REFRESH_KEY);
  } catch (_error) {
    // best-effort
  }
}
function maybeRefreshHomepageAuthChrome() {
  if (!hasSessionCookie() || !homepageShowsSignedOutChrome()) {
    clearPendingHomepageRefresh();
    return;
  }
  try {
    var lastRefreshAt = Number.parseInt(sessionStorage.getItem(HOME_AUTH_REFRESH_KEY) || '0', 10);
    if (Number.isFinite(lastRefreshAt) && lastRefreshAt > 0 && (Date.now() - lastRefreshAt) < 5000) {
      return;
    }
    sessionStorage.setItem(HOME_AUTH_REFRESH_KEY, String(Date.now()));
  } catch (_error) {
    // sessionStorage best-effort
  }
  window.location.reload();
}
window.addEventListener('pageshow', function (event) {
  var navEntries = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
    ? performance.getEntriesByType('navigation')
    : [];
  var navType = navEntries && navEntries[0] && navEntries[0].type;
  if (event.persisted || navType === 'back_forward') {
    maybeRefreshHomepageAuthChrome();
  }
});
`;
