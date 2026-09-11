// Background Service Worker: Orchestrates range-based channel switching & channel creation & deletion

let isRunning = false;
let isCreatingChannel = false;
let creationConfig = {
  channelName: "Messi",
  username: "Lion_________________1_Messi",
  count: 1,
  delayMs: 2500,
  currentBatch: 1,
};
let creationActiveTabId = null;
let creationWatchdogTimer = null;

let activeJobs = {}; // tabId -> job data & watchdog timer
let config = {
  chatUrl: "https://www.youtube.com/live_chat?is_popout=1&v=5FW9ZVMR_7M",
  startIndex: 0,
  endIndex: 19,
  delayMs: 1000,
};

const TAB_WATCHDOG_TIMEOUT_MS = 16000;
const CREATION_WATCHDOG_TIMEOUT_MS = 50000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (message.action === "start_automation") {
    handleStartAutomation(message);
    sendResponse({ status: "started" });
  } else if (message.action === "stop_automation") {
    handleStopAutomation();
    sendResponse({ status: "stopped" });
  } else if (message.action === "start_channel_creation") {
    handleStartChannelCreation(message);
    sendResponse({ status: "started_channel_creation" });
  } else if (message.action === "stop_channel_creation") {
    handleStopChannelCreation();
    sendResponse({ status: "stopped_channel_creation" });
  } else if (message.action === "channel_creation_status") {
    handleChannelCreationStatus(message.statusText);
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
  } else if (message.action === "channel_clicked") {
    handleChannelClicked(tabId, message.index);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_error") {
    handleChannelError(tabId, message.index, message.error);
    sendResponse({ status: "ack" });
  } else if (message.action === "channel_out_of_bounds") {
    handleOutOfBounds(tabId);
    sendResponse({ status: "ack" });
  }
  return true;
});

// Detect when an automated tab is closed by user or browser
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeJobs[tabId]) {
    handleTabClosed(tabId);
  }
  if (creationActiveTabId === tabId) {
    handleCreationTabClosed();
  }
});

// Intercept YouTube navigation and redirect to Live Chat URL for switcher jobs or recover from signin_prompt
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // If YouTube kicks to signin_prompt during creation, bounce back immediately to channel_switcher
  if (isCreatingChannel && tabId === creationActiveTabId && tab.url && tab.url.includes("signin_prompt")) {
    console.log(`[Background] Detected signin_prompt during channel creation. Redirecting cleanly to channel_switcher...`);
    chrome.tabs.update(tabId, { url: "https://www.youtube.com/channel_switcher" });
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
// PARALLEL CHANNEL CREATION ORCHESTRATION
// ==============================================================

let parallelCreationJobs = {}; // tabId -> { batchIdx, name, handle, status }
let parallelTotalCount = 0;
let parallelCompletedCount = 0;

async function handleStartChannelCreation({ channelName, username, count, delayMs }) {
  handleStopAutomation(); // Reset any other ongoing processes

  isCreatingChannel = true;
  parallelCreationJobs = {};
  parallelCompletedCount = 0;
  parallelTotalCount = Math.max(1, parseInt(count, 10) || 1);
  const baseName = (channelName || "Messi").trim();
  const baseUsername = (username || "Lion_________________1_Messi").trim();
  const staggerDelay = Math.min(Math.max(300, parseInt(delayMs, 10) || 1000), 2000);

  console.log(
    `[Background] Starting Parallel Channel Creation: "${baseName}" (@${baseUsername}), Batch Count: ${parallelTotalCount}`
  );

  await chrome.storage.local.set({
    isCreatingChannel: true,
    isRunning: false,
    isDeleting: false,
    createBatchCurrent: 0,
    createBatchTotal: parallelTotalCount,
    statusText: `Opening ${parallelTotalCount} parallel tab(s) for channel creation...`,
  });

  // Open all tabs in parallel (staggered slightly for smooth browser loading)
  for (let i = 1; i <= parallelTotalCount; i++) {
    if (!isCreatingChannel) break;

    const { name, handle } = computeChannelIdentifiers(baseName, baseUsername, i, parallelTotalCount);

    const creationUrl = `https://www.youtube.com/channel_switcher#create_channel=true&channel_name=${encodeURIComponent(
      name
    )}&channel_username=${encodeURIComponent(handle)}&batch_idx=${i}&batch_total=${parallelTotalCount}`;

    try {
      const tab = await chrome.tabs.create({
        url: creationUrl,
        active: (i === 1), // Keep first tab active, rest in background
      });

      parallelCreationJobs[tab.id] = {
        batchIdx: i,
        name,
        handle,
        status: "running",
      };

      console.log(`[Background] Launched Parallel Tab ${i}/${parallelTotalCount} (ID: ${tab.id}) for @${handle}`);
    } catch (e) {
      console.error(`[Background] Failed to open tab for batch #${i}:`, e);
    }

    if (i < parallelTotalCount) {
      await sleep(staggerDelay);
    }
  }

  await chrome.storage.local.set({
    statusText: `All ${parallelTotalCount} tabs running in parallel. Creating channels...`,
  });
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
    const formattedNum = String(newNum).padStart(originalNumStr.length, "0");
    return template.replace(numberRegex, formattedNum);
  }

  // 3. If no number is present, append number
  const separator = template.includes("_") ? "_" : " ";
  return `${template}${separator}${batchIdx}`;
}

function computeChannelIdentifiers(baseName, baseHandle, batchIdx, totalBatch) {
  if (totalBatch <= 1 || batchIdx === 1) {
    return { name: baseName, handle: baseHandle };
  }
  const name = baseName;
  const handle = incrementIdentifier(baseHandle, batchIdx);
  return { name, handle };
}

async function handleChannelCreationStatus(statusMsg) {
  if (!isCreatingChannel) return;
  console.log(`[Background] Channel Creation Status: ${statusMsg}`);
  await chrome.storage.local.set({
    isCreatingChannel: true,
    statusText: statusMsg,
  });
}

async function handleChannelCreationSuccess(msg, senderTabId) {
  if (!isCreatingChannel) return;

  const batchIdx = msg?.batchIdx;
  const chName = msg?.channelName;
  const chHandle = msg?.channelUsername;

  parallelCompletedCount++;
  console.log(`[Background] ✅ [${parallelCompletedCount}/${parallelTotalCount}] Channel #${batchIdx} ("${chName}" / @${chHandle}) created successfully!`);

  await chrome.storage.local.set({
    createBatchCurrent: parallelCompletedCount,
    statusText: `✅ Created ${parallelCompletedCount}/${parallelTotalCount} channels: "${chName}" (@${chHandle})`,
  });

  if (senderTabId) {
    delete parallelCreationJobs[senderTabId];
  }

  // Check if all parallel jobs completed
  if (parallelCompletedCount >= parallelTotalCount || Object.keys(parallelCreationJobs).length === 0) {
    isCreatingChannel = false;
    await chrome.storage.local.set({
      isCreatingChannel: false,
      statusText: `🎉 All ${parallelTotalCount} channels created successfully in parallel!`,
    });
  }
}

async function handleChannelCreationError(errorMsg, senderTabId) {
  console.warn(`[Background] Channel creation error: ${errorMsg}`);
  if (senderTabId) {
    delete parallelCreationJobs[senderTabId];
  }
  await chrome.storage.local.set({
    statusText: `⚠️ Channel creation error: ${errorMsg}`,
  });
}

async function handleStopChannelCreation() {
  console.log("[Background] Channel creation stopped by user.");
  isCreatingChannel = false;
  parallelCreationJobs = {};
  await chrome.storage.local.set({
    isCreatingChannel: false,
    statusText: "Parallel channel creation stopped.",
  });
}

// ==============================================================
// SWITCH & CHAT AUTOMATION
// ==============================================================

async function handleStartAutomation({ chatUrl, startIndex, endIndex, delayMs }) {
  handleStopAutomation(); // Reset any existing active timers

  isRunning = true;
  activeJobs = {};

  config = {
    chatUrl: (chatUrl || config.chatUrl).trim(),
    startIndex: parseInt(startIndex, 10) || 0,
    endIndex: parseInt(endIndex, 10) || 0,
    delayMs: Math.max(200, parseInt(delayMs, 10) || 1000),
  };

  const totalTabs = Math.max(0, config.endIndex - config.startIndex + 1);
  console.log(
    `[Background] Starting range-based automation: Channels ${config.startIndex} to ${config.endIndex} (${totalTabs} tabs), Delay: ${config.delayMs}ms`
  );

  await chrome.storage.local.set({
    isRunning: true,
    isCreatingChannel: false,
    isDeleting: false,
    currentIndex: config.startIndex,
    startIndex: config.startIndex,
    endIndex: config.endIndex,
    liveChatUrl: config.chatUrl,
    statusText: `Launching Channel #${config.startIndex} (Range: ${config.startIndex} → ${config.endIndex})...`,
  });

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
      delayMs: config.delayMs,
      channelClicked: false,
      redirectHandled: false,
      tabId,
      watchdogTimer,
    };
  } catch (err) {
    console.error(`[Background] Failed to open tab for index ${index}:`, err);
    // Even if tabs.create fails, proceed to next tab after brief sleep so it doesn't hang!
    scheduleNext(index + 1);
  }
}

async function handleChannelClicked(tabId, index) {
  if (!tabId || !activeJobs[tabId]) return;

  const job = activeJobs[tabId];
  console.log(`[Background] Tab ${tabId} reported channel #${index} clicked.`);
  job.channelClicked = true;

  // Short delay to let YouTube register account switch cookies before navigating to live chat
  setTimeout(() => {
    if (activeJobs[tabId] && !activeJobs[tabId].redirectHandled) {
      completeJobAndRedirect(tabId);
    }
  }, 700);
}

async function handleChannelError(tabId, index, errorMsg) {
  console.warn(`[Background] Tab ${tabId} (Channel #${index}) encountered an error: ${errorMsg}`);
  
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
    console.log(`[Background] Waiting ${config.delayMs}ms before launching Channel #${nextIndex}...`);
    await sleep(config.delayMs);
    if (isRunning) {
      await launchTabForIndex(nextIndex);
    }
  } else if (isRunning) {
    isRunning = false;
    await chrome.storage.local.set({
      isRunning: false,
      statusText: `Finished channels ${config.startIndex} to ${config.endIndex}!`,
    });
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
}

// ==============================================================
// BRAND ACCOUNT DELETION ORCHESTRATION
// ==============================================================

async function handleStartDeleteChannels() {
  handleStopAutomation();

  console.log("[Background] Starting Brand Account / Channel Deletion automation...");

  await chrome.storage.local.set({
    isDeleting: true,
    isDeletingPaused: false,
    isRunning: false,
    isCreatingChannel: false,
    statusText: "Starting deletion on Google Brand Accounts...",
  });

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs && tabs[0];

    if (currentTab?.url && currentTab.url.startsWith("https://myaccount.google.com/brandaccounts")) {
      // Update active tab directly
      await chrome.tabs.update(currentTab.id, {
        url: "https://myaccount.google.com/brandaccounts#auto_delete=true",
      });
    } else {
      // Open new tab if not already on brandaccounts
      await chrome.tabs.create({
        url: "https://myaccount.google.com/brandaccounts#auto_delete=true",
        active: true,
      });
    }
  } catch (err) {
    console.error("[Background] Failed to initialize Google Brand Accounts deletion:", err);
    await chrome.storage.local.set({
      isDeleting: false,
      isDeletingPaused: false,
      statusText: "Error initializing deletion",
    });
  }
}

async function handleResumeDeleteChannels() {
  console.log("[Background] Resuming Brand Account / Channel Deletion automation...");
  await chrome.storage.local.set({
    isDeleting: true,
    isDeletingPaused: false,
    statusText: "Resuming channel deletion...",
  });
}

async function handleStopDeleteChannels() {
  console.log("[Background] Channel deletion stopped by user.");
  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: "Channel deletion stopped",
  });
}

async function handleDeleteChannelStatus(statusText) {
  console.log(`[Background] Deletion Status: ${statusText}`);
  await chrome.storage.local.set({
    isDeleting: true,
    statusText,
  });
}

async function handleDeleteChannelsCompleted(count = 0) {
  console.log(`[Background] All channels deleted successfully! Total: ${count}`);
  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: `All channels deleted (${count} total)!`,
  });
}

async function handleDeleteChannelsError(errorMessage) {
  console.warn(`[Background] Deletion error: ${errorMessage}`);
  await chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: `Deletion error: ${errorMessage}`,
  });
}

async function handleStopAutomation() {
  console.log("[Background] All automations stopped.");
  isRunning = false;
  isCreatingChannel = false;

  if (creationWatchdogTimer) {
    clearTimeout(creationWatchdogTimer);
    creationWatchdogTimer = null;
  }
  creationActiveTabId = null;

  // Clear all pending watchdogs
  for (const tabId of Object.keys(activeJobs)) {
    if (activeJobs[tabId]?.watchdogTimer) {
      clearTimeout(activeJobs[tabId].watchdogTimer);
    }
  }
  activeJobs = {};

  await chrome.storage.local.set({
    isRunning: false,
    isDeleting: false,
    isDeletingPaused: false,
    isCreatingChannel: false,
    statusText: "Stopped",
  });
}
