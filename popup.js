const DEFAULT_URL = "https://www.youtube.com/live_chat?is_popout=1&v=5FW9ZVMR_7M";

// Switch & Chat Elements
const chatUrlInput = document.getElementById("chatUrl");
const startIndexInput = document.getElementById("startIndex");
const endIndexInput = document.getElementById("endIndex");
const startBtn = document.getElementById("startBtn");
const switchTabStatus = document.getElementById("switchTabStatus");
const switchTabDot = document.getElementById("switchTabDot");

// Create Channel Elements
const channelNameInput = document.getElementById("channelName");
const channelUsernameInput = document.getElementById("channelUsername");
const createCountInput = document.getElementById("createCount");
const createChannelBtn = document.getElementById("createChannelBtn");
const createTabStatus = document.getElementById("createTabStatus");
const createTabDot = document.getElementById("createTabDot");

// Delete Channels Elements
const deleteChannelsBtn = document.getElementById("deleteChannelsBtn");
const resumeDeleteBtn = document.getElementById("resumeDeleteBtn");
const deleteBtnNotice = document.getElementById("deleteBtnNotice");
const deleteTabStatus = document.getElementById("deleteTabStatus");
const deleteTabDot = document.getElementById("deleteTabDot");

// Subs Elements
const subUrlInput = document.getElementById("subUrl");
const subStartIndexInput = document.getElementById("subStartIndex");
const subEndIndexInput = document.getElementById("subEndIndex");
const startSubBtn = document.getElementById("startSubBtn");
const subsTabStatus = document.getElementById("subsTabStatus");
const subsTabDot = document.getElementById("subsTabDot");

// Tracks Interface Elements
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const indexBadge = document.getElementById("indexBadge");
const tracksTabDot = document.getElementById("tracksTabDot");

const trackCardSwitch = document.getElementById("trackCardSwitch");
const tracksSwitchStatus = document.getElementById("tracksSwitchStatus");
const tracksSwitchInfo = document.getElementById("tracksSwitchInfo");
const cancelSwitchBtn = document.getElementById("cancelSwitchBtn");

const trackCardCreate = document.getElementById("trackCardCreate");
const tracksCreateStatus = document.getElementById("tracksCreateStatus");
const tracksCreateInfo = document.getElementById("tracksCreateInfo");
const cancelCreateBtn = document.getElementById("cancelCreateBtn");

const trackCardDelete = document.getElementById("trackCardDelete");
const tracksDeleteStatus = document.getElementById("tracksDeleteStatus");
const tracksDeleteInfo = document.getElementById("tracksDeleteInfo");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");

const trackCardSubs = document.getElementById("trackCardSubs");
const tracksSubsStatus = document.getElementById("tracksSubsStatus");
const tracksSubsInfo = document.getElementById("tracksSubsInfo");
const cancelSubBtn = document.getElementById("cancelSubBtn");

const activityLogList = document.getElementById("activityLogList");
const clearLogBtn = document.getElementById("clearLogBtn");

// Navigation Elements
const tabButtons = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

let isOnBrandAccountsPage = false;
let currentActiveTabName = "tracksTab";

// Tab Switching logic
function switchTab(targetTab) {
  if (!targetTab) return;
  tabButtons.forEach((b) => b.classList.remove("active"));
  tabContents.forEach((c) => c.classList.remove("active"));

  const activeBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
  const activeContent = document.getElementById(targetTab);

  if (activeBtn) activeBtn.classList.add("active");
  if (activeContent) activeContent.classList.add("active");
  currentActiveTabName = targetTab;
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.getAttribute("data-tab");
    switchTab(targetTab);
  });
});

function checkActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    const url = activeTab?.url || "";
    isOnBrandAccountsPage = url.startsWith("https://myaccount.google.com/brandaccounts");

    chrome.storage.local.get(
      [
        "isRunning",
        "isDeleting",
        "isDeletingPaused",
        "isCreatingChannel",
        "isSubscribing",
        "currentIndex",
        "startIndex",
        "endIndex",
        "liveChatUrl",
        "subUrl",
        "statusText",
        "channelName",
        "channelUsername",
        "createCount",
        "createBatchCurrent",
        "createBatchTotal",
        "activityLogs",
      ],
      (result) => {
        updateUI(result);
      }
    );
  });
}

function updateUI(state) {
  const isSwitchBusy = Boolean(state.isRunning);
  const isCreateBusy = Boolean(state.isCreatingChannel);
  const isDeleteBusy = Boolean(state.isDeleting || state.isDeletingPaused);
  const isSubBusy = Boolean(state.isSubscribing);
  const isAnyBusy = isSwitchBusy || isCreateBusy || isDeleteBusy || isSubBusy;

  const currentIndex = state.currentIndex ?? 0;
  const startIndex = state.startIndex ?? 0;
  const endIndex = state.endIndex ?? 19;
  const customStatus = state.statusText || "Idle (All operations free)";

  // ---------------------------------------------------------------------------
  // 1. SPECIFIC TABS: Strictly show only Free or Busy (no detailed messages/errors)
  // ---------------------------------------------------------------------------
  // Tab 1: Switch & Chat
  if (switchTabStatus) {
    switchTabStatus.textContent = isSwitchBusy ? "Busy" : "Free";
    switchTabStatus.className = `tab-status-pill ${isSwitchBusy ? "status-busy" : "status-free"}`;
  }
  if (switchTabDot) {
    switchTabDot.className = `tab-dot ${isSwitchBusy ? "busy" : ""}`;
  }
  startBtn.disabled = isAnyBusy;

  // Tab 2: Create Channel
  if (createTabStatus) {
    createTabStatus.textContent = isCreateBusy ? "Busy" : "Free";
    createTabStatus.className = `tab-status-pill ${isCreateBusy ? "status-busy" : "status-free"}`;
  }
  if (createTabDot) {
    createTabDot.className = `tab-dot ${isCreateBusy ? "busy" : ""}`;
  }
  createChannelBtn.disabled = isAnyBusy;

  // Tab 3: Delete Brand Accounts
  if (deleteTabStatus) {
    deleteTabStatus.textContent = isDeleteBusy ? "Busy" : "Free";
    deleteTabStatus.className = `tab-status-pill ${isDeleteBusy ? "status-busy" : "status-free"}`;
  }
  if (deleteTabDot) {
    deleteTabDot.className = `tab-dot ${isDeleteBusy ? "busy" : ""}`;
  }

  // Delete Tab actions
  if (state.isDeletingPaused) {
    deleteChannelsBtn.style.display = "none";
    resumeDeleteBtn.style.display = "inline-flex";
    resumeDeleteBtn.disabled = false;
    if (deleteBtnNotice) {
      deleteBtnNotice.textContent = "🔑 Verification required in active tab. Complete it & click Resume Deletion.";
      deleteBtnNotice.style.color = "#ffb300";
    }
  } else {
    deleteChannelsBtn.style.display = "inline-flex";
    resumeDeleteBtn.style.display = "none";
    deleteChannelsBtn.disabled = isAnyBusy || !isOnBrandAccountsPage;

    if (deleteBtnNotice) {
      if (isOnBrandAccountsPage) {
        deleteBtnNotice.textContent = "✅ Active on Google Brand Accounts";
        deleteBtnNotice.style.color = "#00e676";
      } else {
        deleteBtnNotice.textContent = "⚠️ Active only on https://myaccount.google.com/brandaccounts";
        deleteBtnNotice.style.color = "#8d96a7";
      }
    }
  }

  // Tab 5: Subscribe Channel
  if (subsTabStatus) {
    subsTabStatus.textContent = isSubBusy ? "Busy" : "Free";
    subsTabStatus.className = `tab-status-pill ${isSubBusy ? "status-busy" : "status-free"}`;
  }
  if (subsTabDot) {
    subsTabDot.className = `tab-dot ${isSubBusy ? "busy" : ""}`;
  }
  startSubBtn.disabled = isAnyBusy;

  // ---------------------------------------------------------------------------
  // 2. TRACKS INTERFACE: Displays all status with message, telemetry & cancel buttons
  // ---------------------------------------------------------------------------
  if (tracksTabDot) {
    tracksTabDot.className = `tab-dot ${isAnyBusy ? "busy" : ""}`;
  }

  // Global Tracks Status Banner
  statusDot.className = "status-dot";
  if (isCreateBusy) {
    statusDot.classList.add("active-create");
    statusText.textContent = customStatus;
    statusText.style.color = "var(--create-accent)";
    indexBadge.textContent = `Batch: ${state.createBatchCurrent || 1}/${state.createBatchTotal || 1}`;
  } else if (state.isDeletingPaused) {
    statusDot.classList.add("active-paused");
    statusText.textContent = customStatus;
    statusText.style.color = "var(--warning)";
    indexBadge.textContent = "Paused";
  } else if (state.isDeleting) {
    statusDot.classList.add("active-delete");
    statusText.textContent = customStatus;
    statusText.style.color = "#ff5252";
    indexBadge.textContent = "Deleting";
  } else if (isSwitchBusy) {
    statusDot.classList.add("active");
    statusText.textContent = customStatus;
    statusText.style.color = "var(--success)";
    indexBadge.textContent = `Channel: ${currentIndex}/${endIndex}`;
  } else if (isSubBusy) {
    statusDot.classList.add("active");
    statusText.textContent = customStatus;
    statusText.style.color = "#ff007b";
    indexBadge.textContent = `Channel: ${currentIndex}/${endIndex}`;
  } else {
    statusDot.className = "status-dot";
    statusText.textContent = customStatus;
    statusText.style.color = customStatus.toLowerCase().includes("error") ? "var(--danger)" : "var(--text-main)";
    indexBadge.textContent = "Ready";
  }

  // Operation Card 1: Switch & Chat
  tracksSwitchStatus.textContent = isSwitchBusy ? "Busy" : "Free";
  tracksSwitchStatus.className = `tab-status-pill ${isSwitchBusy ? "status-busy" : "status-free"}`;
  trackCardSwitch.classList.toggle("busy", isSwitchBusy);
  cancelSwitchBtn.disabled = !isSwitchBusy;
  if (isSwitchBusy) {
    tracksSwitchInfo.textContent = `Processing Channel #${currentIndex} (Range: ${startIndex} → ${endIndex})`;
  } else {
    tracksSwitchInfo.textContent = "Idle - No active channel switching.";
  }

  // Operation Card 2: Channel Creation
  tracksCreateStatus.textContent = isCreateBusy ? "Busy" : "Free";
  tracksCreateStatus.className = `tab-status-pill ${isCreateBusy ? "status-busy" : "status-free"}`;
  trackCardCreate.classList.toggle("busy", isCreateBusy);
  cancelCreateBtn.disabled = !isCreateBusy;
  if (isCreateBusy) {
    const curBatch = state.createBatchCurrent || 0;
    const totBatch = state.createBatchTotal || 1;
    tracksCreateInfo.textContent = `Creating: ${curBatch} / ${totBatch} channels sequentially${state.creationCurrentHandle ? ` (@${state.creationCurrentHandle})` : ""}`;
  } else {
    tracksCreateInfo.textContent = "Idle - No channels currently being created.";
  }

  // Operation Card 3: Brand Accounts Deletion
  tracksDeleteStatus.textContent = isDeleteBusy ? (state.isDeletingPaused ? "Paused" : "Busy") : "Free";
  tracksDeleteStatus.className = `tab-status-pill ${isDeleteBusy ? "status-busy" : "status-free"}`;
  trackCardDelete.classList.toggle("busy", isDeleteBusy);
  cancelDeleteBtn.disabled = !isDeleteBusy;
  if (state.isDeletingPaused) {
    tracksDeleteInfo.textContent = "Paused: Password verification required on tab.";
  } else if (state.isDeleting) {
    tracksDeleteInfo.textContent = "Deleting Brand Account channels sequentially...";
  } else {
    tracksDeleteInfo.textContent = "Idle - No brand accounts being deleted.";
  }

  // Operation Card 4: Channel Subscribing
  if (tracksSubsStatus) {
    tracksSubsStatus.textContent = isSubBusy ? "Busy" : "Free";
    tracksSubsStatus.className = `tab-status-pill ${isSubBusy ? "status-busy" : "status-free"}`;
    trackCardSubs.classList.toggle("busy", isSubBusy);
    cancelSubBtn.disabled = !isSubBusy;
    if (isSubBusy) {
      tracksSubsInfo.textContent = `Subscribing with Channel #${currentIndex} (Range: ${startIndex} → ${endIndex})`;
    } else {
      tracksSubsInfo.textContent = "Idle - No channels being subscribed.";
    }
  }

  // Render Activity Log
  renderLogs(state.activityLogs || []);
}

function renderLogs(logs) {
  if (!activityLogList) return;
  if (!logs || logs.length === 0) {
    activityLogList.innerHTML = '<div class="log-empty">No activity recorded yet.</div>';
    return;
  }

  activityLogList.innerHTML = logs
    .slice(0, 40)
    .map((log) => {
      const typeClass = log.type || "info";
      const timeStr = log.time || "";
      const escapedMsg = escapeHtml(log.message || "");
      return `
        <div class="log-entry">
          <span class="log-time">[${timeStr}]</span>
          <span class="log-msg ${typeClass}">${escapedMsg}</span>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Initial state and active tab verification
checkActiveTab();

// Real-time state synchronization
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local") {
    checkActiveTab();
  }
});

// ==============================================================
// START BUTTON HANDLERS (Tabs only trigger start & switch to Tracks)
// ==============================================================

// Start Switch & Chat automation
startBtn.addEventListener("click", () => {
  const chatUrl = chatUrlInput.value.trim() || DEFAULT_URL;
  const startIndex = startIndexInput.value.trim() !== "" ? parseInt(startIndexInput.value, 10) : 0;
  const endIndex = endIndexInput.value.trim() !== "" ? parseInt(endIndexInput.value, 10) : 19;

  if (endIndex < startIndex) {
    alert("End Index must be greater than or equal to Start Index.");
    return;
  }

  chrome.runtime.sendMessage({
    action: "start_automation",
    chatUrl,
    startIndex,
    endIndex,
  });

  // Switch to Tracks tab to monitor live data
  switchTab("tracksTab");
});

// Start YouTube Channel Creation
createChannelBtn.addEventListener("click", () => {
  const channelName = (channelNameInput.value.trim() || "Messi");
  const username = (channelUsernameInput.value.trim() || "Lion_________________1_Messi");
  const count = Math.max(1, parseInt(createCountInput.value, 10) || 1);

  // Persist exact user values to storage so tabs always read user input
  chrome.storage.local.set({
    channelName,
    channelUsername: username,
    creationBaseChannelName: channelName,
    creationBaseUsername: username,
    creationCurrentChannelName: channelName,
    creationCurrentHandle: username,
  });

  chrome.runtime.sendMessage({
    action: "start_channel_creation",
    channelName,
    username,
    count,
  });

  // Switch to Tracks tab to monitor live data
  switchTab("tracksTab");
});

// Start Brand Accounts Deletion
deleteChannelsBtn.addEventListener("click", () => {
  if (!isOnBrandAccountsPage) {
    alert("This action only works when your active tab is on: https://myaccount.google.com/brandaccounts");
    return;
  }

  const confirmed = confirm(
    "⚠️ WARNING: This will automatically delete your Brand Account channels sequentially on this page.\n\nAre you sure you want to proceed?"
  );

  if (!confirmed) return;

  chrome.storage.local.set({
    isDeleting: true,
    isRunning: false,
    isCreatingChannel: false,
    statusText: "Starting channel deletion loop...",
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { action: "start_deletion_now" }).catch(() => {});
    }
  });

  chrome.runtime.sendMessage({
    action: "start_delete_channels",
  });

  // Switch to Tracks tab to monitor live data
  switchTab("tracksTab");
});

// Start Subscribe Channel
startSubBtn.addEventListener("click", () => {
  const subUrl = subUrlInput.value.trim();
  if (!subUrl) {
    alert("Please enter a valid Channel URL.");
    return;
  }
  const startIndex = subStartIndexInput.value.trim() !== "" ? parseInt(subStartIndexInput.value, 10) : 0;
  const endIndex = subEndIndexInput.value.trim() !== "" ? parseInt(subEndIndexInput.value, 10) : 19;

  if (endIndex < startIndex) {
    alert("End Index must be greater than or equal to Start Index.");
    return;
  }

  chrome.runtime.sendMessage({
    action: "start_subscribing",
    subUrl,
    startIndex,
    endIndex,
  });

  switchTab("tracksTab");
});

// Resume Brand Accounts Deletion if paused
resumeDeleteBtn.addEventListener("click", () => {
  chrome.storage.local.set({
    isDeleting: true,
    isDeletingPaused: false,
    statusText: "Resuming channel deletion...",
  });

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => {
      if (t.id && t.url && (t.url.includes("google.com") || t.url.includes("brandaccounts"))) {
        chrome.tabs.sendMessage(t.id, { action: "resume_deletion_now" }).catch(() => {});
      }
    });
  });

  chrome.runtime.sendMessage({
    action: "resume_delete_channels",
  });

  switchTab("tracksTab");
});

// ==============================================================
// 3 DEDICATED CANCEL BUTTONS IN TRACKS INTERFACE
// ==============================================================

// 1. Cancel Switch & Chat
cancelSwitchBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    action: "stop_automation",
  });

  updateUI({
    isRunning: false,
    currentIndex: 0,
    statusText: "Switch & Chat automation cancelled by user",
  });
});

// 2. Cancel Channel Creation
cancelCreateBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    action: "stop_channel_creation",
  });

  updateUI({
    isCreatingChannel: false,
    statusText: "Channel creation cancelled by user",
  });
});

// 3. Cancel Brand Accounts Deletion
cancelDeleteBtn.addEventListener("click", () => {
  chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: "Brand deletion cancelled by user",
  });

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => {
      if (t.id && t.url && (t.url.includes("google.com") || t.url.includes("brandaccounts"))) {
        chrome.tabs.sendMessage(t.id, { action: "stop_deletion_now" }).catch(() => {});
      }
    });
  });

  chrome.runtime.sendMessage({
    action: "stop_delete_channels",
  });

  updateUI({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: "Brand deletion cancelled by user",
  });
});

// 4. Cancel Subscribing
cancelSubBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    action: "stop_subscribing",
  });

  updateUI({
    isSubscribing: false,
    currentIndex: 0,
    statusText: "Channel subscribing cancelled by user",
  });
});

// Clear activity logs button
clearLogBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clear_activity_logs" });
  chrome.storage.local.set({ activityLogs: [] });
  renderLogs([]);
});
