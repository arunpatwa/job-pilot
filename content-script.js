let stopRequested = false;

const STATE_KEY = "automationState";
const DEBUG = true;
const MAX_INVITES_PER_RUN = 25;
const MIN_INVITE_DELAY_MS = 15000;
const MAX_INVITE_DELAY_MS = 25000;
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
  // Find all connect anchors: <a aria-label="Invite X to connect">
  const connectEls = Array.from(
    document.querySelectorAll("a[aria-label*='Invite'][aria-label*='connect'], button[aria-label*='Invite'][aria-label*='connect']")
  ).filter(isInviteConnectEl);

  logDebug("Connect elements found", { count: connectEls.length });

  const urls = [];
  const seen = new Set();

  connectEls.forEach((connectEl, i) => {
    // Walk up the DOM to find the result card, then get the profile title anchor
    let node = connectEl.parentElement;
    let profileAnchor = null;
    let depth = 0;
    while (node && depth < 15) {
      profileAnchor = node.querySelector("a[data-view-name='search-result-lockup-title']");
      if (profileAnchor) break;
      node = node.parentElement;
      depth++;
    }

    if (!profileAnchor) {
      logDebug(`No profile anchor found for connect el ${i}`, {
        ariaLabel: (connectEl.getAttribute("aria-label") || "").slice(0, 80),
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
  return waitForElement(() => document.querySelector("div[role='dialog']"), timeoutMs);
}

function findProfileConnectButton() {
  const buttons = Array.from(document.querySelectorAll("button[aria-label*='Invite'][aria-label*='connect']"));
  return buttons.find((button) => isInviteConnectButton(button));
}

async function clickAddNote(dialog) {
  const ariaTarget = dialog.querySelector("button[aria-label='Add a note']");
  if (ariaTarget && isVisible(ariaTarget)) {
    ariaTarget.click();
    await sleep(300);
    return true;
  }

  const addNoteButtons = Array.from(dialog.querySelectorAll("button"));
  const target = addNoteButtons.find((button) => {
    if (!isVisible(button)) return false;
    const ariaLabel = (button.getAttribute("aria-label") || "").toLowerCase();
    if (ariaLabel === "add a note") return true;
    const text = button.textContent.trim().toLowerCase();
    return text === "add a note" || text === "add note";
  });
  if (target) {
    target.click();
    await sleep(300);
    return true;
  }
  return false;
}

function fillNote(dialog, note) {
  const textarea = dialog.querySelector("textarea#custom-message") || dialog.querySelector("textarea[name='message']") || dialog.querySelector("textarea");
  if (!textarea) return false;
  textarea.focus();
  textarea.value = note;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  return true;
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
    logDebug("STEP 3 FAILED: connect button not found");
    logDebug("Connect button not found on profile");
    return { ok: false, reason: "NO_CONNECT_BUTTON" };
  }
  connectButton.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(300);
  logDebug("STEP 3: click connect");
  connectButton.click();

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
  await sleep(ADD_NOTE_TO_EDITOR_DELAY_MS);

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

function nextListPageUrl(url) {
  try {
    const parsed = new URL(url);
    const page = parseInt(parsed.searchParams.get("page") || "1", 10);
    parsed.searchParams.set("page", String(page + 1));
    return parsed.toString();
  } catch {
    return null;
  }
}

async function goToNextListPage(state) {
  const listUrl = state.listPageUrl;
  if (!listUrl) {
    logDebug("Automation complete (no list page URL stored)");
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }
  const nextUrl = nextListPageUrl(listUrl);
  if (!nextUrl) {
    logDebug("Automation complete (could not compute next page URL)");
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
    return;
  }
  logDebug("Page done, going to next search page", { nextUrl });
  const newState = {
    ...state,
    listPageUrl: nextUrl,
    queue: [],
    currentIndex: 0,
    pendingListCollection: true,
  };
  await setAutomationState(newState);
  window.location.href = nextUrl;
}

async function collectAndContinue(state) {
  logDebug("On list page: collecting profiles with connect button");
  const profileUrls = collectProfileUrlsFromList();

  if (!profileUrls.length) {
    logDebug("No profiles with connect found on this page, automation complete");
    await clearAutomationState();
    await chrome.storage.sync.set({ automationRunning: false });
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
    queue: limitedUrls,
    currentIndex: 0,
    nextAllowedAt: state.nextAllowedAt || Date.now(),
    pendingListCollection: false,
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
    listPageUrl: window.location.href,
    queue: limitedProfileUrls,
    currentIndex: 0,
    nextAllowedAt: Date.now(),
    sentCount: 0,
    failedCount: 0,
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

  if (state.pendingListCollection) {
    await collectAndContinue(state);
    return;
  }

  const { queue, currentIndex, nextAllowedAt = Date.now(), sentCount = 0, failedCount = 0 } = state;
  if (!Array.isArray(queue) || currentIndex >= queue.length) {
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
    logDebug("STEP 2: navigating to target profile", targetUrl);
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
  logDebug("Invite sent, cooldown scheduled", { nextDelayMs: nextDelay, sentCount: sentCount + 1 });
  await saveInviteRecord(currentUrl);
  await setAutomationState(nextState);

  if (nextIndex >= queue.length) {
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
