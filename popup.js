const DEFAULT_URL = "https://www.youtube.com/live_chat?is_popout=1&v=5FW9ZVMR_7M";

// Switch & Chat Elements
const chatUrlInput = document.getElementById("chatUrl");
const startIndexInput = document.getElementById("startIndex");
const endIndexInput = document.getElementById("endIndex");
const delayMsInput = document.getElementById("delayMs");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");

// Create Channel Elements
const channelNameInput = document.getElementById("channelName");
const channelUsernameInput = document.getElementById("channelUsername");
const createCountInput = document.getElementById("createCount");
const createDelayMsInput = document.getElementById("createDelayMs");
const createChannelBtn = document.getElementById("createChannelBtn");
const stopCreateBtn = document.getElementById("stopCreateBtn");

// Common UI Elements
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const indexBadge = document.getElementById("indexBadge");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

// Delete Channels Elements
const deleteChannelsBtn = document.getElementById("deleteChannelsBtn");
const resumeDeleteBtn = document.getElementById("resumeDeleteBtn");
const stopDeleteBtn = document.getElementById("stopDeleteBtn");
const deleteBtnNotice = document.getElementById("deleteBtnNotice");

let isOnBrandAccountsPage = false;
let currentActiveTabName = "switchTab";

// Tab Switching logic
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTab = btn.getAttribute("data-tab");
    if (!targetTab) return;

    tabButtons.forEach((b) => b.classList.remove("active"));
    tabContents.forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    const targetContent = document.getElementById(targetTab);
    if (targetContent) targetContent.classList.add("active");
    currentActiveTabName = targetTab;
    updateBadge();
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
        "currentIndex",
        "startIndex",
        "endIndex",
        "liveChatUrl",
        "statusText",
        "channelName",
        "channelUsername",
        "createCount",
        "createDelayMs",
        "createBatchCurrent",
        "createBatchTotal",
      ],
      (result) => {
        updateUI(result);
      }
    );
  });
}

function updateBadge() {
  if (currentActiveTabName === "switchTab") {
    const start = parseInt(startIndexInput.value, 10) || 0;
    const end = parseInt(endIndexInput.value, 10) || 0;
    const total = Math.max(0, end - start + 1);
    indexBadge.textContent = `Range: ${start} → ${end} (${total} tabs)`;
  } else if (currentActiveTabName === "createTab") {
    const count = parseInt(createCountInput.value, 10) || 1;
    indexBadge.textContent = `Target: ${count} Channel${count > 1 ? "s" : ""}`;
  } else {
    indexBadge.textContent = isOnBrandAccountsPage ? "Ready (Brand Page)" : "Inactive";
  }
}

startIndexInput.addEventListener("input", updateBadge);
endIndexInput.addEventListener("input", updateBadge);
createCountInput.addEventListener("input", updateBadge);

function updateUI(state) {
  const isRunning = Boolean(state.isRunning);
  const isDeleting = Boolean(state.isDeleting);
  const isDeletingPaused = Boolean(state.isDeletingPaused);
  const isCreating = Boolean(state.isCreatingChannel);
  const currentIndex = state.currentIndex ?? 0;
  const startIndex = state.startIndex ?? (parseInt(startIndexInput.value, 10) || 0);
  const endIndex = state.endIndex ?? (parseInt(endIndexInput.value, 10) || 19);
  const liveChatUrl = state.liveChatUrl || DEFAULT_URL;
  const customStatus = state.statusText;

  if (state.channelName && document.activeElement !== channelNameInput) {
    channelNameInput.value = state.channelName;
  }
  if (state.channelUsername && document.activeElement !== channelUsernameInput) {
    channelUsernameInput.value = state.channelUsername;
  }
  if (state.createCount && document.activeElement !== createCountInput) {
    createCountInput.value = state.createCount;
  }
  if (state.createDelayMs && document.activeElement !== createDelayMsInput) {
    createDelayMsInput.value = state.createDelayMs;
  }

  if (chatUrlInput.value !== liveChatUrl && document.activeElement !== chatUrlInput) {
    chatUrlInput.value = liveChatUrl;
  }

  // Reset dot classes
  statusDot.className = "status-dot";

  if (isCreating) {
    statusDot.classList.add("active-create");
    statusText.textContent = customStatus || "Creating Channel...";
    statusText.style.color = "var(--create-accent)";
    createChannelBtn.textContent = "Creating...";
    createChannelBtn.disabled = true;
    startBtn.disabled = true;
    deleteChannelsBtn.disabled = true;
    deleteChannelsBtn.style.display = "inline-flex";
    resumeDeleteBtn.style.display = "none";

    const currentBatch = state.createBatchCurrent || 1;
    const totalBatch = state.createBatchTotal || 1;
    indexBadge.textContent = `Creating: ${currentBatch} / ${totalBatch}`;
  } else if (isDeletingPaused) {
    statusDot.classList.add("active-paused");
    statusText.textContent = customStatus || "Paused (Password Required)";
    statusText.style.color = "var(--warning)";
    deleteChannelsBtn.style.display = "none";
    resumeDeleteBtn.style.display = "inline-flex";
    resumeDeleteBtn.disabled = false;
    stopDeleteBtn.disabled = false;
    startBtn.disabled = true;
    createChannelBtn.disabled = true;
    indexBadge.textContent = "Paused";
    if (deleteBtnNotice) {
      deleteBtnNotice.textContent = "🔑 Complete password verification in tab & click Resume";
      deleteBtnNotice.style.color = "#ffb300";
      deleteBtnNotice.style.display = "block";
    }
  } else if (isDeleting) {
    statusDot.classList.add("active-delete");
    statusText.textContent = customStatus || "Deleting Channels...";
    statusText.style.color = "#ff5252";
    deleteChannelsBtn.style.display = "inline-flex";
    deleteChannelsBtn.textContent = "Deleting in progress...";
    deleteChannelsBtn.disabled = true;
    resumeDeleteBtn.style.display = "none";
    stopDeleteBtn.disabled = false;
    startBtn.disabled = true;
    createChannelBtn.disabled = true;
    indexBadge.textContent = "Deleting...";
    if (deleteBtnNotice) deleteBtnNotice.style.display = "none";
  } else if (isRunning) {
    statusDot.classList.add("active");
    statusText.textContent = customStatus || "Running";
    statusText.style.color = "var(--success)";
    startBtn.textContent = "Running...";
    startBtn.disabled = true;
    createChannelBtn.disabled = true;
    deleteChannelsBtn.disabled = true;
    deleteChannelsBtn.style.display = "inline-flex";
    resumeDeleteBtn.style.display = "none";
    indexBadge.textContent = `Channel: ${currentIndex} / ${endIndex}`;
    if (deleteBtnNotice) deleteBtnNotice.style.display = "none";
  } else {
    statusDot.classList.remove("active", "active-create", "active-delete", "active-paused");
    statusText.textContent = customStatus || "Idle";
    statusText.style.color = "var(--text-main)";
    startBtn.textContent = "Start Automation";
    startBtn.disabled = false;
    resumeDeleteBtn.style.display = "none";
    deleteChannelsBtn.style.display = "inline-flex";
    createChannelBtn.innerHTML = `
      <svg style="width:15px;height:15px;fill:currentColor;" viewBox="0 0 24 24">
        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
      </svg>
      Create Channel
    `;
    createChannelBtn.disabled = false;

    // Strict URL check for delete button
    if (isOnBrandAccountsPage) {
      deleteChannelsBtn.disabled = false;
      deleteChannelsBtn.innerHTML = `
        <svg style="width:16px;height:16px;fill:currentColor;" viewBox="0 0 24 24">
          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
        </svg>
        Delete Brand Accounts
      `;
      if (deleteBtnNotice) {
        deleteBtnNotice.textContent = "✅ Active on Google Brand Accounts";
        deleteBtnNotice.style.color = "#00e676";
        deleteBtnNotice.style.display = "block";
      }
    } else {
      deleteChannelsBtn.disabled = true;
      deleteChannelsBtn.innerHTML = `
        <svg style="width:16px;height:16px;fill:currentColor;" viewBox="0 0 24 24">
          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
        </svg>
        Delete Brand Accounts (Inactive)
      `;
      if (deleteBtnNotice) {
        deleteBtnNotice.textContent = "⚠️ Active only on https://myaccount.google.com/brandaccounts";
        deleteBtnNotice.style.color = "#8d96a7";
        deleteBtnNotice.style.display = "block";
      }
    }
    updateBadge();
  }
}

// Initial state and active tab verification
checkActiveTab();

// Real-time state synchronization
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local") {
    checkActiveTab();
  }
});

// Start Switch & Chat button click handler
startBtn.addEventListener("click", async () => {
  const chatUrl = chatUrlInput.value.trim() || DEFAULT_URL;
  const startIndex = parseInt(startIndexInput.value, 10) || 0;
  const endIndex = parseInt(endIndexInput.value, 10) || 0;
  const delayMs = parseInt(delayMsInput.value, 10) || 1000;

  if (endIndex < startIndex) {
    alert("End Index must be greater than or equal to Start Index.");
    return;
  }

  chrome.runtime.sendMessage({
    action: "start_automation",
    chatUrl,
    startIndex,
    endIndex,
    delayMs,
  });

  window.close();
});

// Create YouTube Channel button click handler
createChannelBtn.addEventListener("click", async () => {
  const channelName = channelNameInput.value.trim();
  const username = channelUsernameInput.value.trim();
  const count = Math.max(1, parseInt(createCountInput.value, 10) || 1);
  const delayMs = Math.max(1000, parseInt(createDelayMsInput.value, 10) || 2500);

  if (!channelName) {
    alert("Please enter a channel name.");
    return;
  }

  if (!username) {
    alert("Please enter a handle / username.");
    return;
  }

  // Persist values in storage
  chrome.storage.local.set({
    channelName,
    channelUsername,
    createCount: count,
    createDelayMs: delayMs,
  });

  chrome.runtime.sendMessage({
    action: "start_channel_creation",
    channelName,
    username,
    count,
    delayMs,
  });

  window.close();
});

// Stop Channel Creation button
stopCreateBtn.addEventListener("click", async () => {
  chrome.runtime.sendMessage({
    action: "stop_channel_creation",
  });

  updateUI({
    isCreatingChannel: false,
    statusText: "Channel creation stopped",
  });
});

// Delete Channels button click handler (Strictly works on brandaccounts)
deleteChannelsBtn.addEventListener("click", async () => {
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

  window.close();
});

// Resume Delete Channels button handler
resumeDeleteBtn.addEventListener("click", async () => {
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

  updateUI({
    isDeleting: true,
    isDeletingPaused: false,
    statusText: "Resuming channel deletion...",
  });

  window.close();
});

// Stop Delete Channels button handler
stopDeleteBtn.addEventListener("click", async () => {
  chrome.storage.local.set({
    isDeleting: false,
    isDeletingPaused: false,
    statusText: "Channel deletion stopped",
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
    statusText: "Channel deletion stopped",
  });
});

// Stop Switch & Chat button click handler
resetBtn.addEventListener("click", async () => {
  chrome.runtime.sendMessage({
    action: "stop_automation",
  });

  updateUI({
    isRunning: false,
    isDeleting: false,
    isCreatingChannel: false,
    currentIndex: 0,
    statusText: "Stopped",
    liveChatUrl: chatUrlInput.value.trim() || DEFAULT_URL,
  });
});

