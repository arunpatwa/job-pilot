let stopRequested = false;

const STATE_KEY = "automationState";
const DEBUG = true;
const MAX_INVITES_PER_RUN = 30;
const MIN_INVITE_DELAY_MS = 15000;
const MAX_INVITE_DELAY_MS = 25000;
const MAX_RUN_TIME_MS = 30 * 60 * 1000;
const PROFILE_OPEN_DELAY_MS = 4000;
const CONNECT_TO_MODAL_DELAY_MS = 1800;
const ADD_NOTE_TO_EDITOR_DELAY_MS = 900;
const NO_CONNECT_SKIP_DELAY_MS = 4000;
const BANNER_ID = "connect-automator-banner";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDebug(message, data) {
  if (!DEBUG) return;
  if (typeof data === "undefined") {
    console.debug(`[connect-automator] ${message}`);
    updateBanner(message);
    return;
  }
  console.debug(`[connect-automator] ${message}`, data);
  updateBanner(`${message} ${safeStringify(data)}`);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensureBanner() {
  if (document.getElementById(BANNER_ID)) return;
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.style.position = "fixed";
  banner.style.bottom = "16px";
  banner.style.right = "16px";
  banner.style.zIndex = "99999";
  banner.style.maxWidth = "420px";
  banner.style.background = "#0f172a";
  banner.style.color = "#f8fafc";
  banner.style.border = "1px solid #334155";
  banner.style.borderRadius = "10px";
  banner.style.padding = "10px 12px";
  banner.style.fontSize = "12px";
  banner.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  banner.style.boxShadow = "0 10px 24px rgba(15, 23, 42, 0.35)";
  banner.style.whiteSpace = "pre-wrap";
  banner.style.pointerEvents = "none";
  banner.textContent = "connect-automator: ready";
  document.body.appendChild(banner);
}

function updateBanner(text) {
  ensureBanner();
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;
  banner.textContent = `connect-automator: ${text}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalizeListUrl(rawUrl) {
  try {
    let s = String(rawUrl || "");
    // Prefer %20 over + for spaces in the keywords param
    s = s.replace(/(keywords=)([^&]*)/, (m, p1, p2) => p1 + p2.replace(/\+/g, "%20"));
    // Ensure a page param exists so next-page logic can increment it reliably
    if (!/([?&])page=/.test(s)) {
      s = s + (s.includes("?") ? "&" : "?") + "page=1";
    }
    return s;
  } catch {
    return rawUrl;
  }
}

function profilePath(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isInviteConnectEl(el) {
  if (!el || !isVisible(el)) return false;
  const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  return ariaLabel.includes("invite") && ariaLabel.includes("to connect");
}

// Keep alias so profile-page code still works
const isInviteConnectButton = isInviteConnectEl;


function collectProfileUrlsFromList() {
  // Only collect profile URLs that have a visible 'Connect' button
  const urls = [];
  const seen = new Set();

  // Find all visible 'Connect' buttons
  const connectButtons = Array.from(document.querySelectorAll("button, a")).filter((el) => {
    if (!isVisible(el)) return false;
    const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
    const text = (el.textContent || "").trim().toLowerCase();
    return (
      (ariaLabel.includes("connect") || text === "connect") &&
      !el.disabled
    );
  });

  logDebug("Connect buttons found", { count: connectButtons.length });

  connectButtons.forEach((btn, i) => {
    // Walk up to the card root, then find the profile anchor
    let node = btn.parentElement;
    let profileAnchor = null;
    let depth = 0;
    while (node && depth < 15) {
      // Try to find a profile link
      profileAnchor = node.querySelector("a[href*='/in/']");
      if (profileAnchor && isVisible(profileAnchor)) break;
      node = node.parentElement;
      depth++;
    }
    if (!profileAnchor) {
      logDebug(`No profile anchor found for connect btn ${i}`,
        {
          ariaLabel: (btn.getAttribute("aria-label") || "").slice(0, 80),
        });
      return;
    }
    const href = profileAnchor.getAttribute("href");
    if (!href || !href.includes("/in/")) return;
    const url = normalizeUrl(profileAnchor.href);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  });

  logDebug("Profile URLs collected", { count: urls.length, sample: urls.slice(0, 3) });
  return urls;
}

async function waitForElement(getter, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const element = getter();
    if (element) return element;
    await sleep(200);
  }
  return null;
}

async function waitForDialog(timeoutMs) {
  return waitForElement(() => querySelectorDeep("div[role='dialog']"), timeoutMs);
}

// Query selector that traverses shadow roots to find the first matching element.
function querySelectorDeep(selector, root = document) {
  try {
    if (!root) return null;
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch (e) {
    // some roots may throw; ignore
  }

  const stack = [root];
  while (stack.length) {
    const node = stack.shift();
    let children = [];
    try {
      children = Array.from(node.querySelectorAll('*'));
    } catch (e) {
      continue;
    }
    for (const el of children) {
      try {
        if (el.shadowRoot) {
          try {
            const found = el.shadowRoot.querySelector(selector);
            if (found) return found;
          } catch (e) {}
          stack.push(el.shadowRoot);
        }
      } catch (e) {
        continue;
      }
    }
  }
  return null;
}

// Like querySelectorDeep but returns all matches across shadow roots
function querySelectorDeepAll(selector, root = document) {
  const out = [];
  try {
    const direct = Array.from(root.querySelectorAll(selector));
    out.push(...direct);
  } catch (e) {}

  const stack = [root];
  while (stack.length) {
    const node = stack.shift();
    let children = [];
    try {
      children = Array.from(node.querySelectorAll('*'));
    } catch (e) {
      continue;
    }
    for (const el of children) {
      try {
        if (el.shadowRoot) {
          try {
            const found = Array.from(el.shadowRoot.querySelectorAll(selector));
            out.push(...found);
          } catch (e) {}
          stack.push(el.shadowRoot);
        }
      } catch (e) {
        continue;
      }
    }
  }
  return out;
}

function findProfileConnectButton() {
  // 1) Target LinkedIn's invite preload anchors directly (common pattern in screenshots)
  const preloadAnchor = document.querySelector("a[aria-label*='invite'][aria-label*='connect'], a[href*='preload/custom-invite'], a[href*='custom-invite']");
  if (preloadAnchor && isVisible(preloadAnchor) && !preloadAnchor.disabled) return preloadAnchor;

  // 2) Target explicit buttons/anchors with aria-label containing invite/connect
  const ariaCandidates = Array.from(document.querySelectorAll("[aria-label]"));
  for (const el of ariaCandidates) {
    try {
      if (!isVisible(el) || el.disabled) continue;
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      if (a.includes('invite') && a.includes('connect')) return el;
    } catch (e) {}
  }

  // 3) Fallback: Broadly search for any visible element that acts like a Connect control.
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div"));
  return candidates.find((el) => {
    if (!isVisible(el)) return false;
    if (el.disabled) return false;
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) || '';
    const ariaLower = String(aria).toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    // Common patterns: "connect", "invite to connect", or inner span containing "connect"
    if (ariaLower.includes('connect') || text === 'connect' || text.includes('connect')) return true;
    const innerSpan = el.querySelector && el.querySelector('span');
    if (innerSpan && (innerSpan.textContent || '').trim().toLowerCase() === 'connect') return true;
    return false;
  }) || null;
}

async function clickAddNote(dialog) {
  // Try explicit aria-labeled button first (several LinkedIn variants)
  // 1) Try explicit aria-labeled button inside the provided dialog
  try {
    const explicit = (dialog && dialog.querySelector) ? dialog.querySelector("[aria-label='Add a note'], [aria-label='add a note'], button[aria-label='Add a note']") : null;
    if (explicit && isVisible(explicit)) {
      const ok = await attemptClickElement(explicit);
      if (ok) return true;
    }
  } catch (e) {}

  // 2) Sometimes the modal is inside a shadow root or the 'Add a note' is outside the dialog node.
  // Use deep query to find any matching button anywhere in the document (including shadow DOM).
  try {
    const deepExplicit = querySelectorDeep("[aria-label='Add a note'], [aria-label='add a note'], button[aria-label='Add a note']");
    if (deepExplicit && isVisible(deepExplicit)) {
      const ok = await attemptClickElement(deepExplicit);
      if (ok) return true;
    }
  } catch (e) {}

  // 3) As a fallback, find all potential action elements and click the one whose text matches.
  try {
    const allCandidates = (dialog && dialog.querySelector) ? Array.from(dialog.querySelectorAll("[role='button'], button, a, div")) : querySelectorDeepAll("button, [role='button'], a, div");
    for (const el of allCandidates) {
      try {
        if (!isVisible(el)) continue;
        const ariaLabel = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
        const txt = (el.textContent || '').trim().toLowerCase();
        const aria = String(ariaLabel).toLowerCase();
        if (aria.includes('add a note') || aria.includes('add note') || txt === 'add a note' || txt === 'add note' || txt.includes('add a note') || txt.includes('add note')) {
          const ok = await attemptClickElement(el);
          if (ok) return true;
        }
      } catch (e) { continue; }
    }
  } catch (e) {}

  return false;
}

function fillNote(dialog, note) {
  // Support textarea or contenteditable editors; search deeply (shadow DOM included)
  try {
    const textarea = querySelectorDeep("textarea#custom-message, textarea[name='message'], textarea");
    if (textarea) {
      try {
        textarea.focus();
      } catch (e) {}
      // Use native setter when possible (helps React-controlled inputs)
      try {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(textarea, note);
        } else {
          textarea.value = note;
        }
      } catch (e) {
        textarea.value = note;
      }
      // Dispatch proper input events
      try {
        const event = new Event('input', { bubbles: true });
        textarea.dispatchEvent(event);
      } catch (e) {}
      try { textarea.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      try { textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' })); } catch (e) {}
      return true;
    }
  } catch (e) {}

  try {
    // LinkedIn often uses a div wrapper for the editor
    const wrapper = querySelectorDeep('div.connect-button-send-invite__custom-message-box') || querySelectorDeep("div[contenteditable='true'], [contenteditable='true']");
    if (wrapper) {
      // If there's a real editable inside, target it
      let editable = null;
      try { editable = wrapper.querySelector('textarea, input, [contenteditable="true"]'); } catch (e) {}
      if (!editable) editable = wrapper;
      try { editable.focus(); } catch (e) {}
      // For contenteditable
      if (editable.getAttribute && editable.getAttribute('contenteditable') === 'true') {
        try {
          // set innerText and dispatch input events
          editable.innerText = note;
        } catch (e) {
          try { editable.textContent = note; } catch (e2) {}
        }
        try { editable.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { editable.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        try { editable.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' })); } catch (e) {}
        return true;
      }

      // For textarea/input inside wrapper
      try {
        if ('value' in editable) {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editable), 'value');
          if (descriptor && descriptor.set) {
            descriptor.set.call(editable, note);
          } else {
            editable.value = note;
          }
          try { editable.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
          try { editable.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
          try { editable.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' })); } catch (e) {}
          return true;
        }
      } catch (e) {}
    }
  } catch (e) {}

  return false;
}

async function clickSend(dialog) {
  const sendButton = await waitForElement(() => {
    const exact = dialog.querySelector("button[aria-label='Send invitation']");
    if (exact && isVisible(exact) && !exact.disabled) return exact;

    const buttons = Array.from(dialog.querySelectorAll("button"));
    return (
      buttons.find((button) => {
        if (!isVisible(button) || button.disabled) return false;
        const ariaLabel = (button.getAttribute("aria-label") || "").toLowerCase();
        if (ariaLabel === "send invitation") return true;
        const text = button.textContent.trim().toLowerCase();
        return text === "send";
      }) || null
    );
  }, 4000);

  if (!sendButton) return false;
  sendButton.click();
  return true;
}

async function processProfile(note) {
  const connectButton = await waitForElement(findProfileConnectButton, 8000);
  if (!connectButton) {
    // collect a short candidate snapshot for debugging
    const rawCandidates = Array.from(document.querySelectorAll("button, a, [role='button'], div")).filter(isVisible).slice(0, 60);
    const candidates = rawCandidates.map((el) => ({
      tag: el.tagName,
      text: (el.textContent || "").trim().slice(0, 120),
      aria: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) || '',
      disabled: !!el.disabled,
      rect: (() => { try { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; } catch { return null; } })(),
    }));
    logDebug("STEP 3 FAILED: connect button not found", { count: candidates.length, sample: candidates.slice(0, 6) });
    // expose candidates to console for live debugging
    try { window.__connectCandidates = candidates; } catch (e) { /* ignore */ }
    return { ok: false, reason: "NO_CONNECT_BUTTON" };
  }

  connectButton.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(300);
  logDebug("STEP 3: attempt click connect");
  const clicked = await attemptClickElement(connectButton);
  if (!clicked) {
    logDebug("Primary click failed, attempting fallback click methods");
    const fallback = await tryFallbackClickConnect();
    if (!fallback) {
      logDebug("STEP 3 FAILED: connect click attempts exhausted");
      return { ok: false, reason: "NO_CONNECT_BUTTON" };
    }
  }

  logDebug("Connect clicked, waiting for modal DOM change", { delayMs: CONNECT_TO_MODAL_DELAY_MS });
  await sleep(CONNECT_TO_MODAL_DELAY_MS);

  const dialog = await waitForDialog(5000);
  if (!dialog) {
    logDebug("STEP 4 FAILED: connect dialog not found");
    logDebug("Connect dialog not found");
    return { ok: false, reason: "CONNECT_DIALOG_NOT_FOUND" };
  }

  logDebug("STEP 4: click add a note");
  const added = await clickAddNote(dialog);
  if (!added) {
    logDebug("STEP 4 FAILED: add a note not found");
    logDebug("Add note button not found");
    return { ok: false, reason: "ADD_NOTE_NOT_FOUND" };
  }

  logDebug("Add note clicked, waiting for textarea", { delayMs: ADD_NOTE_TO_EDITOR_DELAY_MS });
  // Wait for editor to appear (supports shadow DOM) instead of blind sleep
  await waitForElement(() => querySelectorDeep("textarea#custom-message, textarea[name='message'], textarea, div.connect-button-send-invite__custom-message-box, div[contenteditable='true']"), 5000);

  const filled = fillNote(dialog, note);
  if (!filled) {
    logDebug("STEP 5 FAILED: note textarea not found");
    logDebug("Note textarea not found");
    return { ok: false, reason: "NOTE_TEXTAREA_NOT_FOUND" };
  }
  logDebug("STEP 5: note template inserted", { characters: note.length });
  logDebug("Note template inserted", { characters: note.length });

  await sleep(500);
  logDebug("STEP 6: click send invitation");
  const sent = await clickSend(dialog);
  if (!sent) {
    logDebug("STEP 6 FAILED: send button not found");
    logDebug("Send button not found");
    return { ok: false, reason: "SEND_BUTTON_NOT_FOUND" };
  }
  logDebug("Send invitation clicked");

  await sleep(600);
  return { ok: true };
}

// Attempt to click an element using multiple strategies and verify the dialog appears
async function attemptClickElement(el) {
  try {
    // baseline: native click
    try { el.click(); } catch (e) { /* ignore */ }
    await sleep(300);
    if (await waitForDialog(2000)) return true;

    // synthesize pointer/mouse events as fallback
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const cx = rect.x + (rect.width || 0) / 2;
    const cy = rect.y + (rect.height || 0) / 2;
    const evOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    ['pointerover','pointerenter','pointermove','mousedown','mouseup','click'].forEach((type) => {
      try { el.dispatchEvent(new MouseEvent(type, evOpts)); } catch (e) { /* ignore */ }
    });
    await sleep(400);
    if (await waitForDialog(2500)) return true;

    return false;
  } catch (e) {
    logDebug('attemptClickElement error', e);
    return false;
  }
}

// Broad fallback: search for any element whose text/aria contains 'connect' or 'invite' and try clicking each
async function tryFallbackClickConnect() {
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div")).filter(isVisible);
  for (const el of candidates) {
    try {
      const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) || '';
      const txt = (el.textContent || '').trim().toLowerCase();
      const ariaLower = String(aria).toLowerCase();
      if (!(ariaLower.includes('connect') || ariaLower.includes('invite') || txt === 'connect' || txt.includes('connect') || txt.includes('invite'))) continue;
      logDebug('Trying fallback candidate for connect', { tag: el.tagName, text: (el.textContent||'').slice(0,60), aria: ariaLower.slice(0,60) });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(120);
      const ok = await attemptClickElement(el);
      if (ok) return true;
    } catch (e) {
      /* continue */
    }
  }
  return false;
}

function nextListPageUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("page")) {
      const page = parseInt(parsed.searchParams.get("page") || "1", 10);
      parsed.searchParams.set("page", String(page + 1));
      return parsed.toString();
    }
    if (parsed.searchParams.has("start")) {
      const start = parseInt(parsed.searchParams.get("start") || "0", 10);
      const nextStart = Number.isNaN(start) ? 10 : start + 10;
      parsed.searchParams.set("start", String(nextStart));
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function getNextPageUrlFromDom() {
  const nextAnchor =
    document.querySelector("a[aria-label='Next']") || document.querySelector("a[rel='next']");
  if (nextAnchor && nextAnchor.href) {
    return nextAnchor.href;
  }
  return null;
}

function clickNextPageButton() {
  const nextButton =
    document.querySelector("button[aria-label='Next']") ||
    document.querySelector("button[aria-label*='Next']");
  if (nextButton && !nextButton.disabled && isVisible(nextButton)) {
    nextButton.click();
    return true;
  }
  return false;
}

function goToNextPaginationPage() {
  const pageItems = Array.from(
    document.querySelectorAll("a[aria-label*='Page'], button[aria-label*='Page']")
  );
  if (!pageItems.length) return false;

  const currentIndex = pageItems.findIndex((item) => {
    const ariaCurrent = item.getAttribute("aria-current");
    if (ariaCurrent === "true" || ariaCurrent === "page") return true;
    const isPressed = item.getAttribute("aria-pressed");
    return isPressed === "true";
  });

  if (currentIndex === -1 || currentIndex >= pageItems.length - 1) return false;
  const nextItem = pageItems[currentIndex + 1];
  if (!nextItem) return false;

  if (nextItem.tagName.toLowerCase() === "a" && nextItem.href) {
    window.location.href = canonicalizeListUrl(nextItem.href) || nextItem.href;
    return true;
  }

  if (isVisible(nextItem) && !nextItem.disabled) {
    nextItem.click();
    return true;
  }

  return false;
}

async function goToNextListPage(state) {
  const listUrl = canonicalizeListUrl((state && state.listPageUrl) || normalizeUrl(window.location.href));
  if (!listUrl) {
    logDebug("Automation complete (no list page URL stored)");
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }

  // Only paginate if on a search/list page
  const currentUrl = window.location.href;
  if (!/\/search\/results\/people/.test(currentUrl)) {
    logDebug("Not on a list/search page, skipping pagination", { currentUrl });
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }

  // 1) Try to use the DOM 'next' link if available (keeps LinkedIn's full params)
  const domNext = getNextPageUrlFromDom();
  if (domNext) {
    const target = canonicalizeListUrl(domNext);
    logDebug("Advancing via DOM next link (canonicalized)", { domNext, target });
      const nextState = {
        ...(state || {}),
        listPageUrl: target,
        pendingListCollection: true,
        returnToListThenAdvance: false,
        waitingForCollectAt: Date.now() + 10000,
        queue: [],
      };
      await setAutomationState(nextState);
      window.location.href = target;
    return;
  }

  // 2) Try to compute the next URL using page/start params
  try {
    const base = canonicalizeListUrl(listUrl || currentUrl);
    const computed = nextListPageUrl(base);
    if (computed) {
      // Guard against runaway paging
      try {
        const parsed = new URL(computed);
        const pageNum = parseInt(parsed.searchParams.get("page") || "0", 10) || 0;
        const maxPages = 100;
        if (pageNum > 0 && pageNum >= maxPages) {
          logDebug("Automation complete (max page reached)", { pageNum });
          await clearAutomationState();
          await chrome.storage.sync.set({ automationRunning: false });
          return;
        }
      } catch (e) {
        /* ignore parse errors and continue */
      }
      const target = canonicalizeListUrl(computed);
      logDebug("Computed next page URL via params (canonicalized)", { computed, target });
        const nextState = {
          ...(state || {}),
          listPageUrl: target,
          pendingListCollection: true,
          returnToListThenAdvance: false,
          waitingForCollectAt: Date.now() + 10000,
          queue: [],
        };
        await setAutomationState(nextState);
        window.location.href = target;
      return;
    }
  } catch (e) {
    logDebug("Error computing next page URL", e);
  }

  // 3) Fallback: try clicking LinkedIn pagination controls
  const paged = goToNextPaginationPage();
  if (paged) {
    logDebug("Advanced via pagination control (page items)");
    const target = canonicalizeListUrl(window.location.href);
    const nextState = {
      ...(state || {}),
      listPageUrl: target,
      pendingListCollection: true,
      returnToListThenAdvance: false,
      waitingForCollectAt: Date.now() + 10000,
      queue: [],
    };
    await setAutomationState(nextState);
    return;
  }
  const clicked = clickNextPageButton();
  if (clicked) {
    logDebug("Clicked pagination 'Next' button");
    const target = canonicalizeListUrl(window.location.href);
    const nextState = {
      ...(state || {}),
      listPageUrl: target,
      pendingListCollection: true,
      returnToListThenAdvance: false,
      waitingForCollectAt: Date.now() + 10000,
      queue: [],
    };
    await setAutomationState(nextState);
    return;
  }

  // Nothing else to try — finish automation
  logDebug("Automation complete (no next page found)");
  await clearAutomationState();
  await chrome.storage.sync.set({ automationRunning: false });
}

async function collectAndContinue(state) {
  logDebug("On list page: collecting profiles with connect button");
  const currentListUrl = canonicalizeListUrl(window.location.href);
  const profileUrls = collectProfileUrlsFromList();

  if (!profileUrls.length) {
    logDebug("No profiles with connect found on this page, moving to next page");
    await goToNextListPage(state);
    return;
  }

  const remaining = MAX_INVITES_PER_RUN - (state.sentCount || 0);
  if (remaining <= 0) {
    logDebug("Invite cap reached, automation complete", { sentCount: state.sentCount });
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }

  const limitedUrls = profileUrls.slice(0, remaining);
  const newState = {
    ...state,
    listPageUrl: currentListUrl || state.listPageUrl,
    queue: limitedUrls,
    currentIndex: 0,
    nextAllowedAt: state.nextAllowedAt || Date.now(),
    pendingListCollection: false,
    returnToListThenAdvance: false,
  };
  await setAutomationState(newState);
  logDebug("Next page profiles queued", { count: limitedUrls.length, first: limitedUrls[0] });
  window.location.href = limitedUrls[0];
}

const INVITE_LOG_KEY = "inviteLog";

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getProfileNameFromPage() {
  const h1 = document.querySelector("h1");
  return h1 ? h1.textContent.trim() : "";
}

async function saveInviteRecord(profileUrl) {
  const name = getProfileNameFromPage();
  const date = todayDateString();
  const record = { date, name, profileUrl };

  const stored = await chrome.storage.local.get(INVITE_LOG_KEY);
  const log = Array.isArray(stored[INVITE_LOG_KEY]) ? stored[INVITE_LOG_KEY] : [];
  log.push(record);
  await chrome.storage.local.set({ [INVITE_LOG_KEY]: log });
  logDebug("Invite record saved", { date, name, profileUrl });
}

async function getAutomationState() {
  const stored = await chrome.storage.sync.get(["noteText", "automationRunning", STATE_KEY]);
  return {
    note: stored.noteText || "",
    running: !!stored.automationRunning,
    state: stored[STATE_KEY] || null,
  };
}

async function setAutomationState(state) {
  return chrome.storage.sync.set({ [STATE_KEY]: state });
}

async function clearAutomationState() {
  return chrome.storage.sync.remove(STATE_KEY);
}

async function startFromListPage() {
  const { note } = await getAutomationState();
  if (!note) {
    logDebug("No note set, aborting");
    return;
  }

  logDebug("STEP 1: collect profiles with connect");
  logDebug("Starting from list page", window.location.href);
  logDebug("List page diagnostics", {
    title: document.title,
    pathname: window.location.pathname,
    search: window.location.search,
  });
  const profileUrls = collectProfileUrlsFromList();

  if (!profileUrls.length) {
    logDebug("STEP 1 FAILED: no profiles with connect found");
    logDebug("No profile URLs found on list page");
    return;
  }

  const limitedProfileUrls = profileUrls.slice(0, MAX_INVITES_PER_RUN);
  logDebug("Run queue prepared", {
    discovered: profileUrls.length,
    queued: limitedProfileUrls.length,
    maxPerRun: MAX_INVITES_PER_RUN,
  });

  const state = {
    listPageUrl: canonicalizeListUrl(window.location.href),
    queue: limitedProfileUrls,
    currentIndex: 0,
    nextAllowedAt: Date.now(),
    sentCount: 0,
    failedCount: 0,
    startedAt: Date.now(),
  };
  await setAutomationState(state);

  logDebug("Step 1 complete: stored profile links", {
    queued: limitedProfileUrls.length,
    firstProfile: limitedProfileUrls[0],
  });
  logDebug("STEP 2: opening profile", { index: 1, total: limitedProfileUrls.length, url: limitedProfileUrls[0] });
  window.location.href = limitedProfileUrls[0];
}

async function continueAutomationOnPage() {
  const { note, running, state } = await getAutomationState();
  if (!running || stopRequested || !state || !note) {
    logDebug("Automation idle on page", {
      running,
      stopRequested,
      hasState: !!state,
      hasNote: !!note,
    });
    return;
  }

  if (state.startedAt && Date.now() - state.startedAt > MAX_RUN_TIME_MS) {
    logDebug("Automation stopped: max run time reached", { maxRunTimeMs: MAX_RUN_TIME_MS });
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }

  if (state.pendingListCollection) {
    // Only collect if queue is empty
    if (!state.queue || state.queue.length === 0) {
      // Wait for DOM to be fully loaded before scraping
      if (document.readyState !== "complete") {
        logDebug("Waiting for DOM to load before scraping next page");
        setTimeout(() => continueAutomationOnPage(), 500);
        return;
      }

      // Respect waitingForCollectAt timestamp (allow time for SPA content to settle)
      if (state.waitingForCollectAt && Date.now() < state.waitingForCollectAt) {
        const waitMs = Math.min(1000, state.waitingForCollectAt - Date.now());
        logDebug("Waiting before collecting DOM", { waitMs, waitingForCollectAt: state.waitingForCollectAt });
        setTimeout(() => continueAutomationOnPage(), waitMs);
        return;
      }
      const currentUrl = normalizeUrl(window.location.href);
      const listUrl = state.listPageUrl || currentUrl;
      if (state.returnToListThenAdvance && currentUrl && listUrl && currentUrl === listUrl) {
        const clearedState = { ...state, returnToListThenAdvance: false };
        await setAutomationState(clearedState);
        await goToNextListPage(clearedState);
        return;
      }
      await collectAndContinue(state);
      return;
    }
    // If queue is not empty, do nothing (wait for navigation or processing)
    return;
  }

  const { queue, currentIndex, nextAllowedAt = Date.now(), sentCount = 0, failedCount = 0 } = state;
  if (!Array.isArray(queue) || currentIndex >= queue.length) {
    const listUrl = state && state.listPageUrl ? state.listPageUrl : normalizeUrl(window.location.href);
    const currentNormalized = normalizeUrl(window.location.href);
    // If we're already on the list page, advance directly
    if (currentNormalized && listUrl && currentNormalized === normalizeUrl(listUrl)) {
      await goToNextListPage(state);
      return;
    }
    // Otherwise, return to list page and mark to advance when it loads
    const pendingState = { ...state, queue: [], pendingListCollection: true, returnToListThenAdvance: true };
    await setAutomationState(pendingState);
    if (listUrl) {
      logDebug("Returning to list page to advance", { listUrl });
      window.location.href = canonicalizeListUrl(listUrl);
      return;
    }
    // fallback: try advancing directly
    await goToNextListPage(state);
    return;
  }

  const currentUrl = normalizeUrl(window.location.href);
  const targetUrl = queue[currentIndex];
  const currentPath = profilePath(currentUrl);
  const targetPath = profilePath(targetUrl);
  logDebug("Automation position", {
    currentIndex,
    queueLength: queue.length,
    currentUrl,
    targetUrl,
    currentPath,
    targetPath,
    sentCount,
    failedCount,
  });

  if (currentPath !== targetPath) {
    // Guard: avoid infinite reload loops when LinkedIn mutates query params
    const navKey = targetUrl;
    const navAttempts = (state._navAttempts && state._navAttempts[navKey]) || { attempts: 0, lastAt: 0 };
    // reset attempts after 30s
    if (Date.now() - (navAttempts.lastAt || 0) > 30000) {
      navAttempts.attempts = 0;
    }
    if (navAttempts.attempts >= 3) {
      logDebug("Navigation attempts exceeded for profile, skipping", { targetUrl, attempts: navAttempts.attempts });
      const nextIndexAfterSkip = currentIndex + 1;
      const newState = { ...state, currentIndex: nextIndexAfterSkip };
      // clear navAttempts entry for this URL
      if (newState._navAttempts) delete newState._navAttempts[navKey];
      await setAutomationState(newState);
      if (nextIndexAfterSkip >= queue.length) {
        const listUrl = state && state.listPageUrl ? state.listPageUrl : normalizeUrl(window.location.href);
        const currentNormalized = normalizeUrl(window.location.href);
        if (currentNormalized && listUrl && currentNormalized === normalizeUrl(listUrl)) {
          await goToNextListPage(newState);
          return;
        }
        const pendingState = { ...newState, queue: [], pendingListCollection: true, returnToListThenAdvance: true };
        await setAutomationState(pendingState);
        if (listUrl) {
          window.location.href = canonicalizeListUrl(listUrl);
          return;
        }
        await goToNextListPage(newState);
        return;
      }
      logDebug("Opening next profile after skipping stuck one", { url: queue[nextIndexAfterSkip] });
      window.location.href = queue[nextIndexAfterSkip];
      return;
    }

    // record attempt and navigate
    navAttempts.attempts = (navAttempts.attempts || 0) + 1;
    navAttempts.lastAt = Date.now();
    const newNavState = { ...(state._navAttempts || {}) };
    newNavState[navKey] = navAttempts;
    await setAutomationState({ ...state, _navAttempts: newNavState });
    logDebug("STEP 2: navigating to target profile (attempt)", { targetUrl, attempt: navAttempts.attempts });
    window.location.href = targetUrl;
    return;
  }

  logDebug("STEP 2: profile opened, waiting before connect click", { delayMs: PROFILE_OPEN_DELAY_MS });
  await sleep(PROFILE_OPEN_DELAY_MS);

  const now = Date.now();
  if (now < nextAllowedAt) {
    const waitMs = nextAllowedAt - now;
    logDebug("Rate limiting before invite", { waitMs });
    await sleep(waitMs);
  }

  const result = await processProfile(note);
  if (!result.ok) {
    logDebug("Profile processing failed", { currentUrl, reason: result.reason });
    const nextIndexAfterFail = currentIndex + 1;
    const immediateSkip = result.reason === "NO_CONNECT_BUTTON";
    if (immediateSkip) {
      logDebug("Waiting before skipping profile without connect", { delayMs: NO_CONNECT_SKIP_DELAY_MS });
      await sleep(NO_CONNECT_SKIP_DELAY_MS);
    }
    const failState = {
      ...state,
      currentIndex: nextIndexAfterFail,
      failedCount: failedCount + 1,
      nextAllowedAt: immediateSkip ? Date.now() : Date.now() + randomInt(MIN_INVITE_DELAY_MS, MAX_INVITE_DELAY_MS),
    };
    if (immediateSkip) {
      logDebug("Skipping profile without connect button", { currentUrl });
    }
    await setAutomationState(failState);

    if (nextIndexAfterFail >= queue.length) {
      const listUrl = state && state.listPageUrl ? state.listPageUrl : normalizeUrl(window.location.href);
      const currentNormalized = normalizeUrl(window.location.href);
      if (currentNormalized && listUrl && currentNormalized === normalizeUrl(listUrl)) {
        await goToNextListPage(failState);
        return;
      }
      const pendingState = { ...failState, queue: [], pendingListCollection: true, returnToListThenAdvance: true };
      await setAutomationState(pendingState);
      if (listUrl) {
        window.location.href = canonicalizeListUrl(listUrl);
        return;
      }
      await goToNextListPage(failState);
      return;
    }

    logDebug("Opening next profile after failure", {
      index: nextIndexAfterFail + 1,
      total: queue.length,
      url: queue[nextIndexAfterFail],
    });
    window.location.href = queue[nextIndexAfterFail];
    return;
  }

  const nextIndex = currentIndex + 1;
  const nextDelay = randomInt(MIN_INVITE_DELAY_MS, MAX_INVITE_DELAY_MS);
  const nextState = {
    ...state,
    currentIndex: nextIndex,
    sentCount: sentCount + 1,
    nextAllowedAt: Date.now() + nextDelay,
  };
  // clear any navigation attempt record for this profile now that it's processed
  if (nextState._navAttempts) {
    try {
      const urlKey = currentUrl;
      if (nextState._navAttempts[urlKey]) {
        delete nextState._navAttempts[urlKey];
      }
    } catch (e) {
      /* ignore */
    }
  }
  logDebug("Invite sent, cooldown scheduled", { nextDelayMs: nextDelay, sentCount: sentCount + 1 });
  await saveInviteRecord(currentUrl);
  await setAutomationState(nextState);

  if (nextIndex >= queue.length) {
    const listUrl = state && state.listPageUrl ? state.listPageUrl : normalizeUrl(window.location.href);
    const currentNormalized = normalizeUrl(window.location.href);
    if (currentNormalized && listUrl && currentNormalized === normalizeUrl(listUrl)) {
      await goToNextListPage(nextState);
      return;
    }
    const pendingState = { ...nextState, queue: [], pendingListCollection: true, returnToListThenAdvance: true };
    await setAutomationState(pendingState);
    if (listUrl) {
      logDebug("Returning to list page to advance after finishing queue", { listUrl });
      window.location.href = canonicalizeListUrl(listUrl);
      return;
    }
    await goToNextListPage(nextState);
    return;
  }

  logDebug("Opening next profile", {
    index: nextIndex + 1,
    total: queue.length,
    url: queue[nextIndex],
  });
  window.location.href = queue[nextIndex];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START") {
    stopRequested = false;
    logDebug("Start received");
    startFromListPage();
    sendResponse({ ok: true, action: "START" });
    return;
  }
  if (message.type === "STOP") {
    stopRequested = true;
    logDebug("Stop received");
    chrome.storage.sync.set({ automationRunning: false });
    sendResponse({ ok: true, action: "STOP" });
    return;
  }
  sendResponse({ ok: false, reason: "UNKNOWN_MESSAGE" });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.automationRunning && !changes.automationRunning.newValue) {
    stopRequested = true;
    logDebug("Stop requested via storage");
  }
});

continueAutomationOnPage();
