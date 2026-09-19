// Background Service Worker: Orchestrates range-based channel switching & channel creation & deletion

let isRunning = false;
let isCreatingChannel = false;
let creationConfig = {
  channelName: "Messi",
  username: "Lion_________________1_Messi",
  count: 1,
};

// Batched-parallel creation state
// batchTabMap: { [tabId]: { batchIdx, watchdogTimer, done } }
let batchTabMap = {};
// Set of all tab IDs in the current running batch
let currentBatchTabIds = new Set();
// Global completed count across all batches
let creationCompletedCount = 0;
// The batchIdx where the next batch will start (1-based)
let nextBatchStartIdx = 1;
// Guard: prevents checkBatchCompletion from firing multiple times concurrently
let batchCompletionTriggered = false;

let BATCH_SIZE = 5;

// Batched-parallel deletion state
// deletionBatchMap: { [tabId]: { targetIdx, watchdogTimer, role } }
let deletionBatchMap = {};
let deletionCompletedTotal = 0;
let isDeletionActive = false;
let scoutReportReceived = false;
const DELETION_BATCH_MAX_SIZE = 3;
const DELETION_WATCHDOG_TIMEOUT_MS = 65000;

let activeJobs = {}; // tabId -> job data & watchdog timer
let config = {
  chatUrl: "https://www.youtube.com/live_chat?is_popout=1&v=5FW9ZVMR_7M",
  startIndex: 0,
  endIndex: 19,
};

const AUTOMATION_STEP_DELAY_MS = 1000;
const CREATION_STEP_DELAY_MS = 1500;
const TAB_WATCHDOG_TIMEOUT_MS = 16000;
const CREATION_WATCHDOG_TIMEOUT_MS = 50000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function addActivityLog(message, type = "info") {
  if (!message) return;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const entry = { id: Date.now() + "_" + Math.random().toString(36).substring(2, 6), time, message, type };
  try {
    const data = await chrome.storage.local.get("activityLogs");
    const logs = Array.isArray(data.activityLogs) ? data.activityLogs : [];
    const updated = [entry, ...logs].slice(0, 60);
    await chrome.storage.local.set({ activityLogs: updated });
  } catch (e) {}
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (message.action === "start_automation") {
    handleStartAutomation(message);
    sendResponse({ status: "started" });
  } else if (message.action === "stop_automation") {
    handleStopAutomation();
    sendResponse({ status: "stopped" });
  } else if (message.action === "start_parallel_paste") {
    handleStartParallelPaste(message);
    sendResponse({ status: "started_parallel_paste" });
  } else if (message.action === "stop_parallel_paste") {
    handleStopParallelPaste();
    sendResponse({ status: "stopped_parallel_paste" });
  } else if (message.action === "start_channel_creation") {
    handleStartChannelCreation(message);
    sendResponse({ status: "started_channel_creation" });
  } else if (message.action === "stop_channel_creation") {
    handleStopChannelCreation();
    sendResponse({ status: "stopped_channel_creation" });
  } else if (message.action === "channel_creation_status") {
    handleChannelCreationStatus(message.statusText);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_creation_submitted") {
    // Mark the specific tab as having submitted its form so we can watch for redirect
    if (tabId && batchTabMap[tabId]) {
      batchTabMap[tabId].formSubmitted = true;
    }
    console.log(`[Background] Channel creation form submitted for Channel #${message.batchIdx} (tab ${tabId}).`);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_creation_success") {
    handleChannelCreationSuccess(message, tabId);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_creation_error") {
    handleChannelCreationError(message.error, tabId);
    sendResponse({ status: "ack" });
  } else if (message.action === "start_delete_channels") {
    handleStartDeleteChannels();
    sendResponse({ status: "started_deletion" });
  } else if (message.action === "resume_delete_channels") {
    handleResumeDeleteChannels();
    sendResponse({ status: "resumed_deletion" });
  } else if (message.action === "stop_delete_channels") {
    handleStopDeleteChannels();
    sendResponse({ status: "stopped_deletion" });
  } else if (message.action === "delete_channel_status") {
    handleDeleteChannelStatus(message.statusText);
    sendResponse({ status: "ack" });
  } else if (message.action === "delete_channels_completed") {
    handleDeleteChannelsCompleted(message.count);
    sendResponse({ status: "ack" });
  } else if (message.action === "delete_channels_error") {
    handleDeleteChannelsError(message.error);
    sendResponse({ status: "ack" });
  } else if (message.action === "report_channel_count") {
    handleReportChannelCount(tabId, message.count);
    sendResponse({ status: "ack" });
  } else if (message.action === "get_deletion_tab_params") {
    const requestingTabId = tabId;
    const tabEntry = deletionBatchMap[requestingTabId];
    const targetIdx = tabEntry ? tabEntry.targetIdx : 0;
    sendResponse({ targetIdx });
  } else if (message.action === "deletion_out_of_bounds") {
    handleDeletionOutOfBounds(tabId);
    sendResponse({ status: "ack" });
  } else if (message.action === "deletion_tab_completed") {
    handleDeletionTabCompleted(tabId);
    sendResponse({ status: "ack" });
  } else if (message.action === "deletion_tab_error") {
    handleDeletionTabError(tabId, message.error);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_clicked") {
    handleChannelClicked(tabId, message.index);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_error") {
    handleChannelError(tabId, message.index, message.error);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_out_of_bounds") {
    handleOutOfBounds(tabId);
    sendResponse({ status: "ack" });
  } else if (message.action === "clear_activity_logs") {
    chrome.storage.local.set({ activityLogs: [] });
    sendResponse({ status: "cleared" });
  } else if (message.action === "get_creation_tab_params") {
    // Return the batchIdx specifically assigned to the requesting tab (not a global one)
    const requestingTabId = tabId;
    const tabEntry = batchTabMap[requestingTabId];
    const assignedIdx = tabEntry ? tabEntry.batchIdx : nextBatchStartIdx;
    const handle = incrementIdentifier(creationConfig.username, assignedIdx);
    sendResponse({
      job: {
        batchIdx: assignedIdx,
        name: creationConfig.channelName,
        handle,
      },
      baseName: creationConfig.channelName || "Messi",
      baseUsername: creationConfig.username || "",
    });
  }
  return true;
});

// Detect when an automated tab is closed by user or browser
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeJobs[tabId]) {
    handleTabClosed(tabId);
  }
  // NOTE: We intentionally do NOT mark batch tabs done here.
  // Closing all batch tabs is done inside checkBatchCompletion itself, and doing it
  // here would re-trigger checkBatchCompletion for in-progress tabs (race condition).
  // Hung/user-closed tabs are handled by per-tab watchdog timers instead.
});

// Intercept YouTube navigation and redirect to Live Chat URL for switcher jobs or detect post-submit redirect
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // If YouTube kicks to signin_prompt during creation, log warning without redirect loop
  if (isCreatingChannel && batchTabMap[tabId] && tab.url && tab.url.includes("signin_prompt")) {
    console.warn(`[Background] Detected signin_prompt on creation tab ${tabId}. User may need to sign in.`);
    addActivityLog("YouTube session requires sign-in. Please sign in to YouTube.", "warning");
    return;
  }

  // Detect post-submit redirect for any batch tab whose form was submitted
  const batchEntry = batchTabMap[tabId];
  if (
    isCreatingChannel &&
    batchEntry &&
    batchEntry.formSubmitted &&
    !batchEntry.redirectHandled &&
    tab.url &&
    !tab.url.includes("channel_switcher") &&
    !tab.url.includes("signin_prompt")
  ) {
    console.log(`[Background] Batch tab ${tabId} (Channel #${batchEntry.batchIdx}) confirmed redirect after submit to: ${tab.url}`);
    batchEntry.redirectHandled = true;
    handleBatchTabSuccess(tabId, batchEntry.batchIdx);
    return;
  }

  if (!activeJobs[tabId]) return;

  const job = activeJobs[tabId];

  // If channel was clicked and tab navigates to youtube.com or any non-switcher/non-chat page
  if (
    job.channelClicked &&
    !job.redirectHandled &&
    tab.url &&
    !tab.url.includes("channel_switcher") &&
    !isChatOrTargetUrl(tab.url, job.chatUrl)
  ) {
    console.log(`[Background] Tab ${tabId} navigated away from channel_switcher to: ${tab.url}. Redirecting to chat...`);
    completeJobAndRedirect(tabId);
  }
});

function isChatOrTargetUrl(currentUrl, targetUrl) {
  if (!currentUrl || !targetUrl) return false;
  if (currentUrl === targetUrl) return true;
  if (currentUrl.includes(targetUrl)) return true;

  // Check if video ID matches
  try {
    const currentParsed = new URL(currentUrl);
    const targetParsed = new URL(targetUrl);
    const currentV = currentParsed.searchParams.get("v");
    const targetV = targetParsed.searchParams.get("v");
    if (currentV && targetV && currentV === targetV) return true;
  } catch (e) {}

  return false;
}

// ==============================================================
// BATCHED-PARALLEL CHANNEL CREATION ORCHESTRATION
// Opens up to BATCH_SIZE (5) tabs at once. Waits for ALL in the batch to finish,
// then closes them all and moves to the next batch.
// ==============================================================

async function handleStartChannelCreation({ channelName, username, count }) {
  handleStopAutomation(); // Reset any other ongoing processes

  isCreatingChannel = true;
  creationCompletedCount = 0;
  nextBatchStartIdx = 1;
  batchTabMap = {};
  currentBatchTabIds = new Set();
  orderedBatchTabIds = [];

  const totalCount = Math.max(1, parseInt(count, 10) || 1);
  BATCH_SIZE = totalCount;
  const baseName = (channelName || "Messi").trim();
  const baseUsername = (username || "Lion_________________1_Messi").trim();

  creationConfig = {
    channelName: baseName,
    username: baseUsername,
    count: totalCount,
  };

  console.log(
    `[Background] Starting Batched Channel Creation: "${baseName}" (@${baseUsername}), Total: ${totalCount}, Batch size: ${BATCH_SIZE}`
  );

  await chrome.storage.local.set({
    isCreatingChannel: true,
    isRunning: false,
    isDeleting: false,
    creationBaseChannelName: baseName,
    creationBaseUsername: baseUsername,
    createBatchCurrent: 0,
    createBatchTotal: totalCount,
    statusText: `Initializing channel creation batch (1-${Math.min(BATCH_SIZE, totalCount)}/${totalCount})...`,
  });

  addActivityLog(`Starting batched channel creation (1 to ${totalCount}): "${baseName}" (@${baseUsername})`, "info");

  // Launch the first batch
  await launchBatch(1);
}

/**
 * Launch up to BATCH_SIZE tabs starting from batchStartIdx.
 * e.g. launchBatch(1) opens indices 1-5, launchBatch(6) opens 6-10, etc.
 */
async function launchBatch(batchStartIdx) {
  if (!isCreatingChannel || batchStartIdx > creationConfig.count) {
    if (isCreatingChannel) {
      isCreatingChannel = false;
      await chrome.storage.local.set({
        isCreatingChannel: false,
        createBatchCurrent: creationConfig.count,
        statusText: `🎉 All ${creationConfig.count} channels created successfully!`,
      });
      addActivityLog(`🎉 All ${creationConfig.count} channels created successfully!`, "success");
      console.log(`[Background] Finished all ${creationConfig.count} channel creations.`);
    }
    return;
  }

  const batchEnd = Math.min(batchStartIdx + BATCH_SIZE - 1, creationConfig.count);
  const batchSize = batchEnd - batchStartIdx + 1;

  nextBatchStartIdx = batchEnd + 1; // remember where next batch will start
  batchTabMap = {};
  currentBatchTabIds = new Set();
  orderedBatchTabIds = [];
  batchCompletionTriggered = false; // reset guard for this new batch

  console.log(`[Background] Launching batch: Channels #${batchStartIdx} to #${batchEnd} (${batchSize} tabs staggered)`);
  addActivityLog(`Opening batch: Channels #${batchStartIdx}–#${batchEnd} simultaneously`, "info");

  await chrome.storage.local.set({
    statusText: `Opening ${batchSize} tabs (Channels #${batchStartIdx}–#${batchEnd} / ${creationConfig.count})...`,
  });

  // Create tabs with a short stagger so YouTube doesn't throttle background tab loading.
  // First tab opens active so Chrome allocates full resources to it immediately.
  for (let idx = batchStartIdx; idx <= batchEnd; idx++) {
    const tabId = await openSingleCreationTab(idx, idx === batchStartIdx);
    if (tabId) orderedBatchTabIds.push(tabId);
    if (idx < batchEnd) await sleep(500); // stagger between tabs
  }

  console.log(`[Background] All ${batchSize} batch tabs launched. Waiting for completions...`);
}

/** Opens a single creation tab for the given batchIdx and registers it in batchTabMap. */
async function openSingleCreationTab(batchIdx, isFirstInBatch = false) {
  const name = creationConfig.channelName;
  const handle = incrementIdentifier(creationConfig.username, batchIdx);

  // Encode ALL params in the QUERY STRING so they survive YouTube's 302 redirects
  // (YouTube strips hash fragments during auth/channel redirects)
  const queryParams = new URLSearchParams({
    create_channel: "true",
    batch_idx: String(batchIdx),
    batch_total: String(creationConfig.count),
    channel_name: name,
    channel_username: handle,
  });
  const creationUrl = `https://www.youtube.com/channel_switcher?${queryParams.toString()}`;

  console.log(`[Background] Opening tab for Channel #${batchIdx}/${creationConfig.count}: "${name}" (@${handle})`);

  try {
    const tab = await chrome.tabs.create({ url: creationUrl, active: isFirstInBatch });
    const tabId = tab.id;

    // Per-tab watchdog explicitly removed as requested. 
    // Tabs will wait patiently for focus indefinitely instead of timing out while in queue.
    const watchdogTimer = null;

    batchTabMap[tabId] = {
      batchIdx,
      watchdogTimer,
      formSubmitted: false,
      redirectHandled: false,
      done: false,
    };
    currentBatchTabIds.add(tabId);

    addActivityLog(`Tab opened for Channel #${batchIdx} (@${handle})`, "info");
    return tabId;
  } catch (err) {
    console.error(`[Background] Failed to open tab for Channel #${batchIdx}:`, err);
    addActivityLog(`Failed to open tab for Channel #${batchIdx}: ${err.message}`, "error");
    // Count it as done so the batch can still proceed
    // We add a dummy entry just to avoid hanging
    const fakeId = `err_${batchIdx}_${Date.now()}`;
    batchTabMap[fakeId] = { batchIdx, done: true, error: true };
    currentBatchTabIds.add(fakeId);
    checkBatchCompletion();
    return fakeId;
  }
}

/** Called when a tab's content.js reports successful channel creation. */
function handleBatchTabSuccess(tabId, batchIdx, msg = null) {
  if (!isCreatingChannel) return;

  const entry = batchTabMap[tabId];
  if (!entry || entry.done) return;

  const chHandle = msg?.channelUsername || incrementIdentifier(creationConfig.username, batchIdx);
  creationCompletedCount++;

  console.log(`[Background] ✅ [${creationCompletedCount}/${creationConfig.count}] Channel #${batchIdx} (@${chHandle}) done.`);
  addActivityLog(`✅ Channel #${batchIdx} (@${chHandle}) created!`, "success");

  chrome.storage.local.set({ createBatchCurrent: creationCompletedCount });

  markBatchTabDone(tabId, true);
}

/** Called when a tab's content.js reports an error. */
function handleBatchTabError(tabId, batchIdx, errorMsg) {
  if (!isCreatingChannel) return;

  const entry = batchTabMap[tabId];
  if (!entry || entry.done) return;

  console.warn(`[Background] ❌ Channel #${batchIdx} (tab ${tabId}) error: ${errorMsg}`);
  addActivityLog(`❌ Channel #${batchIdx} error: ${errorMsg}`, "error");

  markBatchTabDone(tabId, false);
}

/** Called when a tab's watchdog timer fires (hung tab). */
function handleBatchTabTimeout(tabId, batchIdx) {
  const entry = batchTabMap[tabId];
  if (!entry || entry.done) return;

  console.warn(`[Background] ⏰ Channel #${batchIdx} (tab ${tabId}) timed out.`);
  addActivityLog(`⏰ Channel #${batchIdx} timed out — moving on.`, "warning");

  markBatchTabDone(tabId, false);
}

/**
 * Marks a batch tab as done and checks if all tabs in the current batch are done.
 * If all done → close all batch tabs → launch next batch.
 */
function markBatchTabDone(tabId, success) {
  const entry = batchTabMap[tabId];
  if (!entry) return;

  if (entry.watchdogTimer) {
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = null;
  }
  entry.done = true;

  // Switch focus to the next tab in the batch!
  if (orderedBatchTabIds && orderedBatchTabIds.length > 0) {
    const currentIndex = orderedBatchTabIds.indexOf(tabId);
    if (currentIndex >= 0 && currentIndex < orderedBatchTabIds.length - 1) {
      const nextTabId = orderedBatchTabIds[currentIndex + 1];
      if (typeof nextTabId === "number") {
        console.log(`[Background] Tab ${tabId} done. Switching focus to next tab ${nextTabId}`);
        chrome.tabs.update(nextTabId, { active: true }).catch(() => {});
      }
    }
  }

  checkBatchCompletion();
}

/** Check if every tab in the current batch is done. If yes, close all and start next batch. */
async function checkBatchCompletion() {
  if (!isCreatingChannel) return;
  // Guard: only one concurrent call may proceed past this point
  if (batchCompletionTriggered) return;

  // Check if ALL registered tabs in the batch are done
  const allDone = [...currentBatchTabIds].every((id) => {
    const entry = batchTabMap[id];
    return entry && entry.done;
  });

  if (!allDone) return; // Still waiting for other tabs

  // Claim the lock — any further calls while we're closing/launching are no-ops
  batchCompletionTriggered = true;

  console.log(`[Background] Entire batch complete. Closing all batch tabs...`);
  addActivityLog(`Batch complete — closing all batch tabs`, "info");

  // Snapshot the tab IDs BEFORE resetting state so closing doesn't race with next batch
  const tabsToClose = [...currentBatchTabIds].filter(
    (id) => typeof id !== "string" || !id.startsWith("err_")
  );

  // Close every tab in the batch simultaneously
  await Promise.allSettled(tabsToClose.map(async (id) => {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }));

  // Brief pause between batches so YouTube backend isn't hammered
  await sleep(CREATION_STEP_DELAY_MS);

  if (!isCreatingChannel) return;

  // Launch next batch (batchCompletionTriggered is reset inside launchBatch)
  await launchBatch(nextBatchStartIdx);
}

function incrementIdentifier(template, batchIdx) {
  if (batchIdx <= 1 || !template) return template;
  const offset = batchIdx - 1;

  // 1. If template contains {i} or {n}, replace it
  if (/\{[in]\}/i.test(template)) {
    return template.replace(/\{[in]\}/gi, () => String(batchIdx));
  }

  // 2. Check if template contains any number (center, end, anywhere)
  const numberRegex = /(\d+)/;
  const match = template.match(numberRegex);
  if (match) {
    const originalNumStr = match[1];
    const originalNum = parseInt(originalNumStr, 10);
    const newNum = originalNum + offset;
    const formattedNum = originalNumStr.startsWith("0") && originalNumStr.length > 1
      ? String(newNum).padStart(originalNumStr.length, "0")
      : String(newNum);
    return template.replace(numberRegex, formattedNum);
  }

  // 3. If no number is present, append number
  const separator = template.includes("_") ? "_" : " ";
  return `${template}${separator}${batchIdx}`;
}

async function handleChannelCreationStatus(statusMsg) {
  if (!isCreatingChannel) return;
  console.log(`[Background] Channel Creation Status: ${statusMsg}`);
  await chrome.storage.local.set({
    isCreatingChannel: true,
    statusText: statusMsg,
  });
  addActivityLog(statusMsg, "info");
}

async function handleChannelCreationSuccess(msg, senderTabId) {
  if (!isCreatingChannel) return;
  const entry = batchTabMap[senderTabId];
  const batchIdx = entry ? entry.batchIdx : null;
  if (!batchIdx) return;
  handleBatchTabSuccess(senderTabId, batchIdx, msg);
}

async function handleChannelCreationError(errorMsg, senderTabId) {
  const entry = batchTabMap[senderTabId];
  const batchIdx = entry ? entry.batchIdx : "?";
  console.warn(`[Background] Channel creation error on Channel #${batchIdx} (tab ${senderTabId}): ${errorMsg}`);
  addActivityLog(`Channel #${batchIdx} error: ${errorMsg}`, "error");
  await chrome.storage.local.set({
    statusText: `⚠️ Channel #${batchIdx} error: ${errorMsg}`,
  });
  if (senderTabId) handleBatchTabError(senderTabId, batchIdx, errorMsg);
}

async function handleStopChannelCreation() {
  console.log("[Background] Channel creation stopped by user.");
  isCreatingChannel = false;

  // Clear all per-tab watchdogs
  for (const tabId of Object.keys(batchTabMap)) {
    const entry = batchTabMap[tabId];
    if (entry?.watchdogTimer) clearTimeout(entry.watchdogTimer);
  }

  // Close all open batch tabs
  for (const tabId of currentBatchTabIds) {
    if (typeof tabId === "string" && tabId.startsWith("err_")) continue;
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }

  batchTabMap = {};
  currentBatchTabIds = new Set();
  orderedBatchTabIds = [];

  await chrome.storage.local.set({
    isCreatingChannel: false,
    statusText: "Channel creation cancelled by user.",
  });
  addActivityLog("Channel creation cancelled by user", "warning");
}

// ==============================================================
// SWITCH & CHAT AUTOMATION
// ==============================================================

async function handleStartAutomation({
  chatUrl,
  startIndex,
  endIndex,
  automationMode = "chat",
  sendTextMessage = "",
  sendTextSelector = "",
}) {
  handleStopAutomation(); // Reset any existing active timers

  isRunning = true;
  activeJobs = {};

  config = {
    chatUrl: (chatUrl || config.chatUrl).trim(),
    startIndex: parseInt(startIndex, 10) || 0,
    endIndex: parseInt(endIndex, 10) || 0,
    automationMode: automationMode,
    sendTextMessage: sendTextMessage || "",
    sendTextSelector: sendTextSelector || "",
  };

  const totalTabs = Math.max(0, config.endIndex - config.startIndex + 1);
  console.log(
    `[Background] Starting range-based automation: Channels ${config.startIndex} to ${config.endIndex} (${totalTabs} tabs) [Mode: ${config.automationMode}]`
  );

  await chrome.storage.local.set({
    isRunning: true,
    isCreatingChannel: false,
    isDeleting: false,
    currentIndex: config.startIndex,
    startIndex: config.startIndex,
    endIndex: config.endIndex,
    liveChatUrl: config.chatUrl,
    automationMode: config.automationMode,
    sendTextMessage: config.sendTextMessage,
    sendTextSelector: config.sendTextSelector,
    statusText: `Launching Channel #${config.startIndex} (Range: ${config.startIndex} → ${config.endIndex})...`,
  });

  let modeLabel = "Switch & Chat";
  if (config.automationMode === "subscribe") modeLabel = "Subscribe";
  else if (config.automationMode === "send_text") modeLabel = "Send Text";

  addActivityLog(`Started ${modeLabel}: Channels ${config.startIndex} to ${config.endIndex}`, "info");

  // Launch initial tab
  await launchTabForIndex(config.startIndex);
}

async function launchTabForIndex(index) {
  if (!isRunning || index > config.endIndex) {
    if (isRunning) {
      isRunning = false;
      await chrome.storage.local.set({
        isRunning: false,
        statusText: `Completed channels ${config.startIndex} to ${config.endIndex}!`,
      });
      addActivityLog(`Completed channels ${config.startIndex} to ${config.endIndex}!`, "success");
      console.log(`[Background] Finished all channels in range (${config.startIndex} -> ${config.endIndex}).`);
    }
    return;
  }

  // Include both ?next= and hash param for maximum compatibility
  const switcherUrl = `https://www.youtube.com/channel_switcher?next=${encodeURIComponent(
    config.chatUrl
  )}#target_index=${index}&chat_url=${encodeURIComponent(config.chatUrl)}`;

  console.log(`[Background] Opening Tab for Channel Index ${index} (Range: ${config.startIndex} → ${config.endIndex})...`);

  await chrome.storage.local.set({
    currentIndex: index,
    statusText: `Processing Channel #${index} (${index - config.startIndex + 1}/${config.endIndex - config.startIndex + 1})...`,
  });
  addActivityLog(`Processing Channel #${index} (${index - config.startIndex + 1}/${config.endIndex - config.startIndex + 1})`, "info");

  try {
    const tab = await chrome.tabs.create({
      url: switcherUrl,
      active: true,
    });

    const tabId = tab.id;

    // Set a watchdog timer to guarantee process never hangs on a single tab
    const watchdogTimer = setTimeout(() => {
      handleJobTimeout(tabId);
    }, TAB_WATCHDOG_TIMEOUT_MS);

    activeJobs[tabId] = {
      index,
      chatUrl: config.chatUrl,
      startIndex: config.startIndex,
      endIndex: config.endIndex,
      channelClicked: false,
      redirectHandled: false,
      tabId,
      watchdogTimer,
    };
  } catch (err) {
    console.error(`[Background] Failed to open tab for index ${index}:`, err);
    addActivityLog(`Failed to open tab for index ${index}: ${err.message}`, "error");
    // Even if tabs.create fails, proceed to next tab after brief sleep so it doesn't hang!
    scheduleNext(index + 1);
  }
}

async function handleChannelClicked(tabId, index) {
  if (!tabId || !activeJobs[tabId]) return;

  const job = activeJobs[tabId];
  console.log(`[Background] Tab ${tabId} reported channel #${index} clicked.`);
  job.channelClicked = true;
  addActivityLog(`Channel #${index} switched. Redirecting to chat...`, "success");

  // Short delay to let YouTube register account switch cookies before navigating to live chat
  setTimeout(() => {
    if (activeJobs[tabId] && !activeJobs[tabId].redirectHandled) {
      completeJobAndRedirect(tabId);
    }
  }, 700);
}

async function handleChannelError(tabId, index, errorMsg) {
  console.warn(`[Background] Tab ${tabId} (Channel #${index}) encountered an error: ${errorMsg}`);
  addActivityLog(`Channel #${index} error: ${errorMsg}`, "error");
  
  if (tabId && activeJobs[tabId]) {
    clearTimeout(activeJobs[tabId].watchdogTimer);
    delete activeJobs[tabId];
  }

  // Advance to next index rather than hanging
  scheduleNext(index + 1);
}

async function handleJobTimeout(tabId) {
  if (!activeJobs[tabId]) return;

  const job = activeJobs[tabId];
  console.warn(`[Background] Watchdog timeout triggered for tab ${tabId} (Channel #${job.index}).`);

  clearTimeout(job.watchdogTimer);

  // Attempt redirect if not already handled
  if (!job.redirectHandled) {
    job.redirectHandled = true;
    try {
      await chrome.tabs.update(tabId, { url: job.chatUrl });
    } catch (e) {}
  }

  const nextIndex = job.index + 1;
  delete activeJobs[tabId];

  scheduleNext(nextIndex);
}

async function handleTabClosed(tabId) {
  if (!activeJobs[tabId]) return;

  const job = activeJobs[tabId];
  console.log(`[Background] Automated tab ${tabId} (Channel #${job.index}) was closed.`);

  clearTimeout(job.watchdogTimer);
  const nextIndex = job.index + 1;
  delete activeJobs[tabId];

  // Continue to next channel if automation is still running
  scheduleNext(nextIndex);
}

async function completeJobAndRedirect(tabId) {
  if (!activeJobs[tabId] || activeJobs[tabId].redirectHandled) return;

  const job = activeJobs[tabId];
  job.redirectHandled = true;

  clearTimeout(job.watchdogTimer);

  console.log(`[Background] Redirecting Tab ${tabId} (Channel Index ${job.index}) to: ${job.chatUrl}`);

  try {
    await chrome.tabs.update(tabId, { url: job.chatUrl });
  } catch (e) {
    console.warn(`[Background] Could not update tab ${tabId}:`, e);
  }

  const nextIndex = job.index + 1;
  delete activeJobs[tabId];

  scheduleNext(nextIndex);
}

async function scheduleNext(nextIndex) {
  if (isRunning && nextIndex <= config.endIndex) {
    console.log(`[Background] Waiting ${AUTOMATION_STEP_DELAY_MS}ms before launching Channel #${nextIndex}...`);
    await sleep(AUTOMATION_STEP_DELAY_MS);
    if (isRunning) {
      await launchTabForIndex(nextIndex);
    }
  } else if (isRunning) {
    isRunning = false;
    await chrome.storage.local.set({
      isRunning: false,
      statusText: `Finished channels ${config.startIndex} to ${config.endIndex}!`,
    });
    addActivityLog(`Finished channels ${config.startIndex} to ${config.endIndex}!`, "success");
    console.log(`[Background] Automation complete.`);
  }
}

async function handleOutOfBounds(tabId) {
  console.log(`[Background] Reached end of available channels.`);
  isRunning = false;

  if (tabId && activeJobs[tabId]) {
    clearTimeout(activeJobs[tabId].watchdogTimer);
    delete activeJobs[tabId];
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}
  }

  await chrome.storage.local.set({
    isRunning: false,
    statusText: "Finished (All available channels processed)",
  });
  addActivityLog("Finished (All available channels processed)", "info");
}

// ==============================================================
// BRAND ACCOUNT DELETION ORCHESTRATION (SCOUT-TAB & DYNAMIC SIZING)
// ==============================================================

async function handleStartDeleteChannels() {
  handleStopAutomation();

  console.log("[Background] Starting Brand Account / Channel Deletion automation...");
  isDeletionActive = true;
  deletionCompletedTotal = 0;

  await chrome.storage.local.set({
    isDeleting: true,
    isDeletingPaused: false,
    isRunning: false,
    isCreatingChannel: false,
    statusText: "Opening Google Brand Accounts (Detecting channels)...",
  });
  addActivityLog("Starting Brand Account deletion...", "info");

  startDeletionBatch(true);
}

async function handleResumeDeleteChannels() {
  console.log("[Background] Resuming Brand Account / Channel Deletion automation...");
  isDeletionActive = true;
  await chrome.storage.local.set({
    isDeleting: true,
    isDeletingPaused: false,
    statusText: "Resuming channel deletion...",
  });
  addActivityLog("Resumed Brand Account deletion", "info");

  // If no tabs currently running, launch batch
  if (Object.keys(deletionBatchMap).length === 0) {
    startDeletionBatch(true);
  }
}

async function handleStopDeleteChannels() {
  console.log("[Background] Channel deletion stopped by user.");
  isDeletionActive = false;

  for (const tid of Object.keys(deletionBatchMap)) {
    if (deletionBatchMap[tid]?.watchdogTimer) {
      clearTimeout(deletionBatchMap[tid].watchdogTimer);
    }
    try {
      await chrome.tabs.remove(Number(tid));
    } catch (e) {}
  }
  deletionBatchMap = {};

  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: "Channel deletion stopped",
  });
  addActivityLog("Brand Account deletion cancelled by user", "warning");
}

async function handleDeleteChannelStatus(statusText) {
  console.log(`[Background] Deletion Status: ${statusText}`);
  await chrome.storage.local.set({
    isDeleting: true,
    statusText,
  });
  addActivityLog(statusText, "info");
}

async function handleDeleteChannelsCompleted(count = 0) {
  console.log(`[Background] All channels deleted successfully! Total: ${count}`);
  isDeletionActive = false;
  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: `All channels deleted (${count} total)!`,
  });
  addActivityLog(`All brand channels deleted (${count} total)!`, "success");
}

async function handleDeleteChannelsError(errorMessage) {
  console.warn(`[Background] Deletion error: ${errorMessage}`);
  isDeletionActive = false;
  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: `Deletion error: ${errorMessage}`,
  });
  addActivityLog(`Deletion error: ${errorMessage}`, "error");
}

async function startDeletionBatch(isInitial = false) {
  if (!isDeletionActive) return;

  console.log("[Background] Launching Scout Tab (Worker 0)...");

  // Clean up any old timers
  for (const tid of Object.keys(deletionBatchMap)) {
    if (deletionBatchMap[tid]?.watchdogTimer) {
      clearTimeout(deletionBatchMap[tid].watchdogTimer);
    }
  }
  deletionBatchMap = {};
  scoutReportReceived = false;

  try {
    const url = "https://myaccount.google.com/brandaccounts#auto_delete=true&delete_idx=0";
    const scoutTab = await chrome.tabs.create({ url, active: isInitial });

    const watchdogTimer = setTimeout(() => {
      handleDeletionTabWatchdog(scoutTab.id);
    }, DELETION_WATCHDOG_TIMEOUT_MS);

    deletionBatchMap[scoutTab.id] = {
      targetIdx: 0,
      role: "scout_and_worker",
      watchdogTimer,
    };
    console.log(`[Background] Opened Scout Tab ${scoutTab.id} (assigned targetIdx: 0)`);
  } catch (e) {
    console.error("[Background] Failed to open Scout Tab", e);
    handleDeleteChannelsError("Failed to open Brand Accounts tab: " + e.message);
  }
}

async function handleReportChannelCount(tabId, count) {
  if (!isDeletionActive) return;
  if (scoutReportReceived) return;
  scoutReportReceived = true;

  console.log(`[Background] Scout tab ${tabId} reported ${count} available channel(s).`);

  if (count <= 0) {
    console.log("[Background] 0 channels remaining. Deletion complete!");
    if (deletionBatchMap[tabId]) {
      clearTimeout(deletionBatchMap[tabId].watchdogTimer);
      delete deletionBatchMap[tabId];
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}
    await handleDeleteChannelsCompleted(deletionCompletedTotal);
    return;
  }

  const totalTabsNeeded = Math.min(count, DELETION_BATCH_MAX_SIZE);
  console.log(`[Background] Dynamically opening ${totalTabsNeeded} tab(s) for ${count} remaining channel(s).`);

  await chrome.storage.local.set({
    statusText: `Deleting batch of ${totalTabsNeeded} channel(s) (${count} remaining)...`,
  });

  // Open remaining worker tabs (indices 1 to totalTabsNeeded - 1)
  for (let idx = 1; idx < totalTabsNeeded; idx++) {
    try {
      const url = `https://myaccount.google.com/brandaccounts#auto_delete=true&delete_idx=${idx}`;
      const workerTab = await chrome.tabs.create({ url, active: false });

      const watchdogTimer = setTimeout(() => {
        handleDeletionTabWatchdog(workerTab.id);
      }, DELETION_WATCHDOG_TIMEOUT_MS);

      deletionBatchMap[workerTab.id] = {
        targetIdx: idx,
        role: "worker",
        watchdogTimer,
      };
      console.log(`[Background] Opened worker tab ${workerTab.id} (assigned targetIdx: ${idx})`);
    } catch (e) {
      console.error(`[Background] Failed to open worker tab for idx ${idx}`, e);
    }
  }
}

async function handleDeletionOutOfBounds(tabId) {
  if (deletionBatchMap[tabId]) {
    console.log(`[Background] Deletion tab ${tabId} reported out of bounds.`);
    clearTimeout(deletionBatchMap[tabId].watchdogTimer);
    delete deletionBatchMap[tabId];
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}
    checkDeletionBatchCompletion();
  }
}

async function handleDeletionTabCompleted(tabId) {
  if (deletionBatchMap[tabId]) {
    console.log(`[Background] Deletion tab ${tabId} completed successfully.`);
    clearTimeout(deletionBatchMap[tabId].watchdogTimer);
    delete deletionBatchMap[tabId];
    deletionCompletedTotal++;

    addActivityLog(`Deleted brand channel successfully (${deletionCompletedTotal} total)`, "success");

    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}

    checkDeletionBatchCompletion();
  }
}

async function handleDeletionTabError(tabId, errorMessage) {
  if (deletionBatchMap[tabId]) {
    console.warn(`[Background] Deletion tab ${tabId} reported error: ${errorMessage}`);
    clearTimeout(deletionBatchMap[tabId].watchdogTimer);
    delete deletionBatchMap[tabId];
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}
    checkDeletionBatchCompletion();
  }
}

async function handleDeletionTabWatchdog(tabId) {
  if (deletionBatchMap[tabId]) {
    console.warn(`[Background] Deletion tab ${tabId} timed out in watchdog (65s). Closing.`);
    delete deletionBatchMap[tabId];
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {}
    checkDeletionBatchCompletion();
  }
}

async function checkDeletionBatchCompletion() {
  const remaining = Object.keys(deletionBatchMap).length;
  console.log(`[Background] Checking batch completion. Remaining tabs in current batch: ${remaining}`);

  if (remaining === 0) {
    if (!isDeletionActive) {
      console.log("[Background] Deletion was stopped or completed. Not launching next batch.");
      return;
    }

    console.log("[Background] All tabs in current batch finished! Waiting 2s before launching next batch...");
    await sleep(2000);
    if (isDeletionActive) {
      startDeletionBatch(false);
    }
  }
}

async function handleStopAutomation() {
  console.log("[Background] All automations stopped.");
  const wasRunning = isRunning || isCreatingChannel;
  isRunning = false;
  isCreatingChannel = false;

  // Clear all batch creation watchdogs
  for (const tabId of Object.keys(batchTabMap)) {
    const entry = batchTabMap[tabId];
    if (entry?.watchdogTimer) clearTimeout(entry.watchdogTimer);
  }
  batchTabMap = {};
  currentBatchTabIds = new Set();

  // Clear all switcher job watchdogs
  for (const tabId of Object.keys(activeJobs)) {
    if (activeJobs[tabId]?.watchdogTimer) {
      clearTimeout(activeJobs[tabId].watchdogTimer);
    }
  }
  activeJobs = {};

  isDeletionActive = false;
  // Close all deletion batch tabs
  for (const tid of Object.keys(deletionBatchMap)) {
    if (deletionBatchMap[tid]?.watchdogTimer) {
      clearTimeout(deletionBatchMap[tid].watchdogTimer);
    }
    try {
      await chrome.tabs.remove(Number(tid));
    } catch (e) {}
  }
  deletionBatchMap = {};

  await chrome.storage.local.set({
    isRunning: false,
    isDeleting: false,
    isDeletingPaused: false,
    isCreatingChannel: false,
    statusText: "Stopped",
  });
  if (wasRunning) {
    addActivityLog("Switch & Chat automation cancelled", "warning");
  }
}

// ==============================================================
// AUTO PASTE & ENTER (PARALLEL BACKGROUND EXECUTION ACROSS OPEN TABS)
// ==============================================================

let isPasteRunning = false;
let isPasteLooping = false;
let pasteLoopTimer = null;
let pasteConfig = {
  text: "",
  selector: "",
  targetScope: "all",
  urlFilter: "",
  pressEnter: true,
  clickSubmit: true,
  isLoop: false,
  loopIntervalSec: 5,
};

async function handleStartParallelPaste(params) {
  handleStopParallelPaste();

  isPasteRunning = true;
  isPasteLooping = Boolean(params.isLoop);
  pasteConfig = { ...params };

  await chrome.storage.local.set({
    isPasteRunning: true,
    isPasteLooping: isPasteLooping,
    pasteInputText: params.text,
    pasteTargetScope: params.targetScope,
    pasteUrlFilter: params.urlFilter,
    pasteSelector: params.selector,
    pastePressEnter: params.pressEnter,
    pasteClickSubmit: params.clickSubmit,
    pasteIsLoop: params.isLoop,
    pasteLoopInterval: params.loopIntervalSec,
    statusText: `Starting parallel paste across open tabs...`,
  });

  addActivityLog(`Starting parallel background paste (Ctrl+V & Enter) [Scope: ${params.targetScope}]`, "info");

  // Run immediately
  await executeParallelPasteCycle();

  // If loop is enabled, schedule recurring execution
  if (isPasteLooping && isPasteRunning) {
    const intervalMs = Math.max(1000, (params.loopIntervalSec || 5) * 1000);
    pasteLoopTimer = setInterval(async () => {
      if (isPasteRunning) {
        await executeParallelPasteCycle();
      } else {
        clearInterval(pasteLoopTimer);
      }
    }, intervalMs);
  }
}

function handleStopParallelPaste() {
  if (pasteLoopTimer) {
    clearInterval(pasteLoopTimer);
    pasteLoopTimer = null;
  }
  isPasteRunning = false;
  isPasteLooping = false;

  chrome.storage.local.set({
    isPasteRunning: false,
    isPasteLooping: false,
    statusText: "Background paste stopped by user",
  });
  addActivityLog("Background paste stopped", "warning");
}

async function executeParallelPasteCycle() {
  if (!isPasteRunning) return;

  try {
    const tabs = await chrome.tabs.query({});
    const scope = pasteConfig.targetScope || "all";
    const filterKeyword = (pasteConfig.urlFilter || "").toLowerCase().trim();

    // Filter valid target tabs (excluding system/internal browser pages)
    const targetTabs = tabs.filter((t) => {
      const u = t.url || "";
      if (
        u.startsWith("chrome://") ||
        u.startsWith("chrome-extension://") ||
        u.startsWith("edge://") ||
        u.startsWith("about:") ||
        u.startsWith("devtools://")
      )
        return false;
      if (scope === "active") return t.active;
      if (scope === "youtube_google") return u.includes("youtube.com") || u.includes("google.com");
      if (scope === "filter" && filterKeyword) return u.toLowerCase().includes(filterKeyword);
      return true;
    });

    if (targetTabs.length === 0) {
      const msg = `No matching open tabs found for scope "${scope}".`;
      console.warn(`[Background] ${msg}`);
      await chrome.storage.local.set({
        pasteCompletedCount: 0,
        pasteTotalCount: 0,
        statusText: msg,
      });
      addActivityLog(msg, "warning");
      if (!isPasteLooping) {
        isPasteRunning = false;
        await chrome.storage.local.set({ isPasteRunning: false });
      }
      return;
    }

    console.log(`[Background] Executing parallel paste on ${targetTabs.length} open tab(s)...`);
    await chrome.storage.local.set({
      pasteCompletedCount: 0,
      pasteTotalCount: targetTabs.length,
      statusText: `Injecting paste & Enter across ${targetTabs.length} tab(s) in parallel...`,
    });

    let completedCount = 0;

    // Parallel execution across all matching tabs (true background multi-threading)
    const workerPromises = targetTabs.map(async (tab) => {
      try {
        let response = null;
        try {
          response = await chrome.tabs.sendMessage(tab.id, {
            action: "execute_paste_and_enter",
            text: pasteConfig.text,
            selector: pasteConfig.selector,
            pressEnter: pasteConfig.pressEnter,
            clickSubmit: pasteConfig.clickSubmit,
          });
        } catch (msgErr) {
          // Fallback: If content script is not yet listening on this tab, dynamically inject worker function
          const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            func: injectedPasteAndEnterWorker,
            args: [
              pasteConfig.text,
              pasteConfig.selector,
              pasteConfig.pressEnter,
              pasteConfig.clickSubmit,
            ],
          });
          response = injectionResults?.[0]?.result;
        }

        completedCount++;
        const tabTitle = tab.title ? tab.title.substring(0, 30) : `Tab #${tab.id}`;
        console.log(`[Background] Tab ${tab.id} ("${tabTitle}") completed paste.`);
        addActivityLog(`[Tab ${tab.id}] Pasted & Pressed Enter on "${tabTitle}"`, "success");
        await chrome.storage.local.set({ pasteCompletedCount: completedCount });
        return { tabId: tab.id, success: true, response };
      } catch (err) {
        console.error(`[Background] Error injecting paste into tab ${tab.id}:`, err);
        addActivityLog(`[Tab ${tab.id}] Injection error: ${err.message}`, "error");
        return { tabId: tab.id, success: false, error: err.message };
      }
    });

    await Promise.allSettled(workerPromises);

    const summaryText = isPasteLooping
      ? `Loop active: Injected ${completedCount}/${targetTabs.length} tab(s). Repeating...`
      : `Completed paste & Enter on ${completedCount}/${targetTabs.length} tab(s) in parallel!`;

    console.log(`[Background] ${summaryText}`);
    await chrome.storage.local.set({
      pasteCompletedCount: completedCount,
      pasteTotalCount: targetTabs.length,
      statusText: summaryText,
      ...(isPasteLooping ? {} : { isPasteRunning: false }),
    });

    if (!isPasteLooping) {
      isPasteRunning = false;
      addActivityLog(summaryText, "success");
    }
  } catch (err) {
    console.error("[Background] Global error during parallel paste:", err);
  }
}

// Injected fallback worker that runs inside tab context
function injectedPasteAndEnterWorker(text, selector, pressEnter, clickSubmit) {
  const querySelectorDeep = (sel, root = document) => {
    const list = [];
    const walk = (node) => {
      if (!node) return;
      try {
        node.querySelectorAll(sel).forEach((el) => list.push(el));
      } catch (e) {}
      try {
        node.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === "IFRAME") {
            try {
              const doc = el.contentDocument || el.contentWindow?.document;
              if (doc) walk(doc);
            } catch (e) {}
          }
        });
      } catch (e) {}
    };
    walk(root);
    return list;
  };

  let target = null;
  if (selector && selector.trim()) {
    const matches = querySelectorDeep(selector.trim());
    target = matches.find((el) => el.offsetParent !== null || el.getBoundingClientRect().width > 0);
  }

  if (!target) {
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable ||
        active.getAttribute("contenteditable") === "true")
    ) {
      target = active;
    }
  }

  if (!target) {
    const candidateSelectors = [
      'div#input[contenteditable="true"]',
      'yt-live-chat-text-input-field-renderer #input',
      'yt-live-chat-message-input-renderer #input',
      '#input.yt-live-chat-text-input-field-renderer',
      '#input[contenteditable="true"]',
      '#contenteditable-root',
      'ytd-commentbox #contenteditable-root',
      '#comment-dialog #contenteditable-root',
      'textarea[name="q"]',
      'input[name="q"]',
      'textarea.gLFyf',
      'input.gLFyf',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      'tp-yt-paper-input-container input',
      'paper-input input',
      'textarea',
      'input[type="text"]:not([type="hidden"])',
      'input[type="search"]',
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
    ];

    try {
      const placeholder = querySelectorDeep("#placeholder-area, #simplebox-placeholder").find(
        (el) => el.offsetParent !== null || el.getBoundingClientRect().width > 0
      );
      if (placeholder) placeholder.click();
    } catch (e) {}

    for (const sel of candidateSelectors) {
      const found = querySelectorDeep(sel).find(
        (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      );
      if (found) {
        target = found;
        break;
      }
    }
  }

  if (!target) {
    return { success: false, error: "No editable input found on page" };
  }

  target.scrollIntoView({ behavior: "instant", block: "center" });
  target.focus();
  target.dispatchEvent(new Event("focus", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (typeof target.click === "function") target.click();

  // Simulate Ctrl+V clipboard paste event
  try {
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: new DataTransfer(),
    });
    pasteEvent.clipboardData.setData("text/plain", text);
    target.dispatchEvent(pasteEvent);
  } catch (e) {}

  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);

    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (e) {}

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (e) {}

    if (!inserted || !target.textContent.includes(text)) {
      target.innerText = text;
      target.textContent = text;
    }

    try {
      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          cancelable: true,
          data: text,
          inputType: "insertFromPaste",
        })
      );
    } catch (e) {}

    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  } else {
    target.value = "";
    if (typeof target.select === "function") target.select();
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (e) {}

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (e) {}

    if (!inserted || target.value !== text) {
      const nativeSetter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(target, text);
      } else {
        target.value = text;
      }
    }

    try {
      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          cancelable: true,
          data: text,
          inputType: "insertFromPaste",
        })
      );
    } catch (e) {}

    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // Press Enter Key
  if (pressEnter) {
    const enterInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", enterInit));
    target.dispatchEvent(new KeyboardEvent("keypress", enterInit));
    target.dispatchEvent(new KeyboardEvent("keyup", enterInit));
  }

  // Click Submit/Send button if found
  if (clickSubmit) {
    try {
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Search" i]',
        'button[aria-label*="Comment" i]',
        "#send-button button",
        "yt-live-chat-send-button-renderer button",
        "ytd-button-renderer#submit-button button",
        "button.yt-spec-button-shape-next--filled",
        "button.Tg7LZd",
      ];
      for (const btnSel of submitSelectors) {
        const btns = querySelectorDeep(btnSel);
        const activeBtn = btns.find(
          (b) => (b.offsetParent !== null || b.getBoundingClientRect().width > 0) && !b.disabled
        );
        if (activeBtn) {
          activeBtn.click();
          break;
        }
      }
    } catch (e) {}
  }

  return { success: true, tag: target.tagName, id: target.id };
}

