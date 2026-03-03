const noteInput = document.getElementById("note");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusText = document.getElementById("status");
const todayCountEl = document.getElementById("today-count");
const downloadCsvButton = document.getElementById("download-csv");

const INVITE_LOG_KEY = "inviteLog";

function setStatus(text) {
  statusText.textContent = text;
}

function logDebug(message, data) {
  if (typeof data === "undefined") {
    console.debug(`[connect-automator][popup] ${message}`);
    return;
  }
  console.debug(`[connect-automator][popup] ${message}`, data);
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}

function saveNote(note) {
  return chrome.storage.sync.set({ noteText: note });
}

function setRunning(running) {
  return chrome.storage.sync.set({ automationRunning: running });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function init() {
  const stored = await chrome.storage.sync.get(["noteText", "automationRunning"]);
  noteInput.value = stored.noteText || "";
  setStatus(stored.automationRunning ? "Running" : "Idle");
  logDebug("Popup initialized", {
    running: !!stored.automationRunning,
    noteLength: (stored.noteText || "").length,
  });
  await refreshTodayCount();
}

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getInviteLog() {
  const stored = await chrome.storage.local.get(INVITE_LOG_KEY);
  return Array.isArray(stored[INVITE_LOG_KEY]) ? stored[INVITE_LOG_KEY] : [];
}

async function refreshTodayCount() {
  const log = await getInviteLog();
  const today = todayDateString();
  const todayCount = log.filter((r) => r.date === today).length;
  todayCountEl.textContent = `Today (${today}): ${todayCount} invite${todayCount !== 1 ? "s" : ""} sent`;
}

function escapeCsvField(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generateCsv(log) {
  const lines = ["Date,Name,Profile URL"];

  // Group by date
  const byDate = {};
  log.forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });

  const sortedDates = Object.keys(byDate).sort();
  sortedDates.forEach((date) => {
    byDate[date].forEach((r) => {
      lines.push(
        [escapeCsvField(r.date), escapeCsvField(r.name), escapeCsvField(r.profileUrl)].join(",")
      );
    });
    lines.push(`,,Total invites on ${date}: ${byDate[date].length}`);
    lines.push(""); // blank separator between days
  });

  return lines.join("\n");
}

async function downloadCsv() {
  const log = await getInviteLog();
  if (!log.length) {
    setStatus("No records yet");
    return;
  }
  const csv = generateCsv(log);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const filename = `linkedin-invites-${todayDateString()}.csv`;
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
    setStatus("CSV downloaded");
    logDebug("CSV downloaded", { records: log.length, filename });
  });
}

startButton.addEventListener("click", async () => {
  const note = noteInput.value.trim();
  if (!note) {
    setStatus("Enter note text");
    logDebug("Start blocked: empty note");
    return;
  }

  await saveNote(note);
  logDebug("Note saved", { noteLength: note.length });
  const tab = await getActiveTab();
  logDebug("Active tab resolved", tab ? { id: tab.id, url: tab.url } : null);
  if (!tab || !tab.id) {
    setStatus("No active tab");
    return;
  }

  if (!tab.url || !tab.url.includes("linkedin.com")) {
    setStatus("Open a LinkedIn tab");
    logDebug("Start blocked: non-LinkedIn tab", tab.url);
    return;
  }

  await setRunning(true);
  setStatus("Starting...");
  logDebug("Sending START message", { tabId: tab.id });
  try {
    const response = await sendTabMessage(tab.id, { type: "START" });
    logDebug("START response", response);
    setStatus("Running");
  } catch (error) {
    await setRunning(false);
    setStatus("Reload LinkedIn tab");
    logDebug("Start message failed", error.message);
  }
});

stopButton.addEventListener("click", async () => {
  await setRunning(false);
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus("No active tab");
    return;
  }

  logDebug("Sending STOP message", { tabId: tab.id });
  sendTabMessage(tab.id, { type: "STOP" }).catch(() => null).finally(() => {
    setStatus("Stopped");
    logDebug("Stopped status set");
  });
});

downloadCsvButton.addEventListener("click", () => {
  downloadCsv();
});

init();
