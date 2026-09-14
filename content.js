(async function init() {
  // ⚠️ Capture the URL hash SYNCHRONOUSLY right now — before any await.
  // YouTube's SPA router strips custom hash params during page hydration.
  // By the time any async code runs, window.location.hash may already be empty.
  const _rawHash = window.location.hash || "";
  const _savedHash = _rawHash.startsWith("#") ? _rawHash.substring(1) : _rawHash;
  const INITIAL_HASH_PARAMS = new URLSearchParams(_savedHash);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Deep recursive query selector across Shadow DOM and accessible iframe boundaries
  const querySelectorDeep = (selector, root = document) => {
    const matching = [];
    const traverse = (currentRoot) => {
      if (!currentRoot) return;
      try {
        const elements = currentRoot.querySelectorAll(selector);
        elements.forEach((el) => matching.push(el));
      } catch (e) {}

      try {
        const allElements = currentRoot.querySelectorAll("*");
        allElements.forEach((el) => {
          if (el.shadowRoot) {
            traverse(el.shadowRoot);
          }
          if (el.tagName === "IFRAME") {
            try {
              const iframeDoc = el.contentDocument || el.contentWindow?.document;
              if (iframeDoc) {
                traverse(iframeDoc);
              }
            } catch (e) {} // Cross-origin protection
          }
        });
      } catch (e) {}
    };
    traverse(root);
    return matching;
  };

  // Clean, single click without duplicate events
  const smartClick = async (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "instant", block: "center" });
    el.focus();
    await sleep(80);

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };

    el.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
    el.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    el.dispatchEvent(new PointerEvent("pointerup", eventOptions));
    el.dispatchEvent(new MouseEvent("mouseup", eventOptions));
    el.click();
  };

  // Wait for dynamic element condition
  const waitForDeep = async (predicate, timeoutMs = 20000, pollIntervalMs = 300) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = predicate();
        if (result && (!Array.isArray(result) || result.length > 0)) {
          return result;
        }
      } catch (e) {}
      await sleep(pollIntervalMs);
    }
    throw new Error("Timed out waiting for element.");
  };

  const waitForPageReady = async () => {
    if (document.readyState === "complete") return;
    return new Promise((resolve) => {
      window.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 2000);
    });
  };
  // ==============================================================
  // STEP 1A: AUTOMATED CHANNEL CREATION FLOW
  // ==============================================================
  function incrementIdentifier(template, batchIdx) {
    if (batchIdx <= 1 || !template) return template;
    const offset = batchIdx - 1;

    if (/\{[in]\}/i.test(template)) {
      return template.replace(/\{[in]\}/gi, () => String(batchIdx));
    }

    const numberRegex = /(\d+)/;
    const match = template.match(numberRegex);
    if (match) {
      const originalNumStr = match[1];
      const originalNum = parseInt(originalNumStr, 10);
      const newNum = originalNum + offset;
      const formattedNum = String(newNum).padStart(originalNumStr.length, "0");
      return template.replace(numberRegex, formattedNum);
    }

    const separator = template.includes("_") ? "_" : " ";
    return `${template}${separator}${batchIdx}`;
  }

  let isExecutingCreation = false;
  async function checkAndRunCreationFlow() {
    if (isExecutingCreation) return;
    if (window !== window.top) return;

    const currentUrl = window.location.href;

    // Handle signin_prompt without infinite redirect loop
    if (currentUrl.includes("youtube.com/signin_prompt")) {
      console.warn("[YT Creator] signin_prompt page detected. User may need to sign in to YouTube.");
      return;
    }

    if (!currentUrl.includes("youtube.com/channel_switcher") && !currentUrl.includes("youtube.com/account")) {
      return;
    }

    // Read state from chrome.storage.local first (clean URL approach)
    let storage = {};
    try {
      storage = await new Promise((resolve) =>
        chrome.storage.local.get(
          [
            "isCreatingChannel",
            "isRunning",
            "creationBaseChannelName",
            "creationBaseUsername",
            "creationCurrentChannelName",
            "creationCurrentHandle",
            "channelName",
            "channelUsername",
            "createBatchCurrent",
            "createBatchTotal",
          ],
          resolve
        )
      );
    } catch (e) {}

    // Use the hash params captured synchronously at script start.
    // DO NOT re-read window.location.hash here — YouTube may have already cleared it.
    const hashParams = INITIAL_HASH_PARAMS;
    const searchParams = new URLSearchParams(window.location.search);

    const isCreateChannel =
      hashParams.get("auto_create") === "true" ||
      hashParams.get("create_channel") === "true" ||
      searchParams.get("create_channel") === "true" ||
      (storage?.isCreatingChannel === true && storage?.isRunning !== true);

    if (!isCreateChannel) {
      return;
    }

    // Wait until the tab actually becomes active/visible before processing
    // This perfectly matches the requested sequential "focus-cycling" strategy.
    const waitForFocus = async () => {
      if (!document.hidden) return;
      return new Promise((resolve) => {
        const onVisibilityChange = () => {
          if (!document.hidden) {
            document.removeEventListener("visibilitychange", onVisibilityChange);
            resolve();
          }
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
      });
    };

    let channelName =
      hashParams.get("channel_name") ||
      searchParams.get("channel_name") ||
      storage?.creationBaseChannelName ||
      storage?.creationCurrentChannelName ||
      storage?.channelName ||
      "";

    let channelUsername =
      hashParams.get("channel_username") ||
      searchParams.get("channel_username") ||
      "";

    let batchIdx =
      parseInt(hashParams.get("batch_idx") || searchParams.get("batch_idx"), 10) ||
      parseInt(storage?.createBatchCurrent, 10) ||
      1;

    let batchTotal =
      parseInt(hashParams.get("batch_total") || searchParams.get("batch_total"), 10) ||
      parseInt(storage?.createBatchTotal, 10) ||
      1;

    // If channelUsername not found in URL (e.g. YouTube stripped parameters), ask background worker for assigned job
    if (!channelUsername) {
      try {
        const bgData = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: "get_creation_tab_params" }, resolve)
        );
        if (bgData?.job?.handle) {
          channelUsername = bgData.job.handle;
          if (bgData.job.name) channelName = bgData.job.name;
          if (bgData.job.batchIdx) batchIdx = bgData.job.batchIdx;
        } else if (bgData?.baseUsername) {
          channelUsername = incrementIdentifier(bgData.baseUsername, batchIdx);
        }
      } catch (e) {}
    }

    if (!channelUsername) {
      const baseHandle =
        storage?.creationBaseUsername ||
        storage?.creationCurrentHandle ||
        storage?.channelUsername ||
        "";
      channelUsername = incrementIdentifier(baseHandle, batchIdx);
    }

    isExecutingCreation = true;

    const logCreationStatus = (msg) => {
      console.log(`[YT Creator] ${msg}`);
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({
            action: "channel_creation_status",
            statusText: msg,
            batchIdx,
            batchTotal,
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      } catch (e) {}
    };

    logCreationStatus(`Waiting for focus to initialize channel creation (${batchIdx}/${batchTotal}): "${channelName}" (@${channelUsername})...`);
    await waitForFocus();
    
    logCreationStatus(`Tab active! Initializing channel creation (${batchIdx}/${batchTotal}): "${channelName}" (@${channelUsername})...`);
    await waitForPageReady();
    await sleep(1000);

    try {
      logCreationStatus(`[1/5] Locating "Create a channel" button...`);

      // 1. Click "Create a channel"
      const createChannelLink = await waitForDeep(() => {
        const links = querySelectorDeep(
          'a[aria-label="Create a channel"], a[href*="create_channel"], a[href*="channel_creation"], ytd-button-renderer a, yt-button-shape a, yt-button-shape button'
        );
        return links.find((el) => {
          const label = (el.getAttribute("aria-label") || "").toLowerCase();
          const text = (el.textContent || "").trim().toLowerCase();
          return (
            label === "create a channel" ||
            text === "create a channel" ||
            text.includes("create a channel") ||
            el.href?.includes("channel_creation") ||
            el.href?.includes("create_channel")
          );
        });
      }, 25000);

      if (!createChannelLink) {
        throw new Error('Could not find "Create a channel" button on channel switcher page.');
      }

      logCreationStatus(`[2/5] Clicking "Create a channel" button...`);
      await smartClick(createChannelLink);
      await sleep(2500);

      // Helper for reliable input typing across Polymer / Lit / React
      const typeIntoInput = async (inputEl, text) => {
        if (!inputEl) return;
        inputEl.scrollIntoView({ behavior: "instant", block: "center" });
        inputEl.focus();
        await sleep(150);

        // Clear previous text
        inputEl.value = "";
        inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

        if (typeof inputEl.select === "function") inputEl.select();
        try {
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        } catch (e) {}

        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, text);
        } catch (e) {}

        if (!inserted || inputEl.value !== text) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) {
            nativeSetter.call(inputEl, text);
          } else {
            inputEl.value = text;
          }
        }

        try {
          inputEl.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              composed: true,
              cancelable: true,
              data: text,
              inputType: "insertText",
            })
          );
        } catch (e) {}

        inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Enter" }));
        inputEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Enter" }));

        const parentPaper = inputEl.closest("tp-yt-paper-input, paper-input");
        if (parentPaper) {
          try {
            parentPaper.value = text;
            parentPaper.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            parentPaper.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          } catch (e) {}
        }
      };

      // 4. Locate Channel Name & Handle input fields distinctly
      logCreationStatus(`[3/5] Locating Name and Handle input fields in creation dialog...`);
      const { nameInput, usernameInput } = await waitForDeep(() => {
        // In background (inactive) tabs, offsetParent and getBoundingClientRect return zero.
        // Instead of layout checks, we check DOM attributes for explicit hidden state.
        const isUsable = (i) => {
          if (!i || i.type === "file" || i.type === "hidden" || i.type === "submit") return false;
          // Reject elements explicitly hidden in the DOM
          if (i.closest("[hidden]") || i.closest('[style*="display: none"]')) return false;
          return true;
        };

        // Find the creation dialog (don't gate on visibility — background tabs always return 0)
        const dialogs = querySelectorDeep(
          'ytd-channel-creation-dialog-renderer, tp-yt-paper-dialog, [role="dialog"], #dialog'
        );
        const activeDialog = dialogs[0] || document;

        // Collect all usable inputs in the dialog
        const allInputs = querySelectorDeep(
          'tp-yt-paper-input input, paper-input input, input#input, input[type="text"]',
          activeDialog
        ).filter(isUsable);

        // Fallback: search whole document if dialog empty
        const docInputs = allInputs.length > 0 ? allInputs : querySelectorDeep(
          'tp-yt-paper-input input, paper-input input, input#input, input[type="text"]'
        ).filter(isUsable);

        // Helper to get text associated with an input
        const getInputLabelText = (inp) => {
          let text = (inp.getAttribute("aria-label") || "").toLowerCase();
          const labelId = inp.getAttribute("aria-labelledby");
          if (labelId) {
            const root = inp.getRootNode && inp.getRootNode() !== document ? inp.getRootNode() : document;
            const labelEl = root.getElementById(labelId) || document.getElementById(labelId);
            if (labelEl) text += " " + (labelEl.textContent || "").toLowerCase();
          }
          // Also check parent wrappers
          const parentPaper = inp.closest("tp-yt-paper-input, paper-input");
          if (parentPaper) {
            text += " " + (parentPaper.getAttribute("aria-label") || "").toLowerCase();
            const labelNode = parentPaper.querySelector("label");
            if (labelNode) text += " " + (labelNode.textContent || "").toLowerCase();
          }
          return text;
        };

        // Score inputs
        let bestName = null, nameScore = -1;
        let bestHandle = null, handleScore = -1;

        docInputs.forEach((inp) => {
          const text = getInputLabelText(inp);
          let nScore = 0, hScore = 0;

          if (text.includes("name")) nScore += 10;
          if (text.includes("channel name")) nScore += 10;
          if (inp.id && inp.id.toLowerCase().includes("name")) nScore += 5;

          if (text.includes("handle")) hScore += 10;
          if (text.includes("@")) hScore += 10;
          if (inp.id && inp.id.toLowerCase().includes("handle")) hScore += 5;

          // If no strong label, rely on index as fallback
          if (nScore === 0 && hScore === 0) {
            const idx = docInputs.indexOf(inp);
            if (idx === 0) nScore += 1;
            if (idx === 1) hScore += 1;
          }

          if (nScore > nameScore) { nameScore = nScore; bestName = inp; }
          if (hScore > handleScore) { handleScore = hScore; bestHandle = inp; }
        });

        // Ensure they aren't the same input if both are found
        if (bestName && bestHandle && bestName === bestHandle) {
          if (docInputs.length >= 2) {
            bestName = docInputs[0];
            bestHandle = docInputs[1];
          }
        }

        if (bestName) return { nameInput: bestName, usernameInput: bestHandle };
        return null;
      }, 25000);

      if (!nameInput) {
        throw new Error("Could not locate Channel Name input field.");
      }

      // Fill Name field (no increment)
      logCreationStatus(`[Step 4/5] Writing channel name: "${channelName}" into Name field...`);
      await typeIntoInput(nameInput, channelName);
      await sleep(800);

      // Fill Handle field (with increment)
      if (usernameInput && usernameInput !== nameInput) {
        const cleanHandle = channelUsername.replace(/^@+/, "");
        logCreationStatus(`[Step 4/5] Writing handle: "@${cleanHandle}" into Handle field...`);
        await typeIntoInput(usernameInput, cleanHandle);
        await sleep(800);
      }

      logCreationStatus(`Validating handle and waiting for create button to activate...`);
      // Wait for handle validation & debounce to finish so the button enables (aria-disabled="false")
      await sleep(2500);

      // 5. Click final "Create channel" button
      logCreationStatus(`[Step 5/5] Locating and clicking final "Create channel" button...`);
      const finalCreateButton = await waitForDeep(() => {
        const buttons = querySelectorDeep(
          'button.ytSpecButtonShapeNextHost[aria-label*="Create channel" i], button[aria-label*="Create channel" i], button[aria-label*="Create a channel" i], ytd-channel-creation-dialog-renderer button, button'
        );
        return buttons.find((btn) => {
          const label = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
          const text = (btn.textContent || "").trim().toLowerCase();
          const isMatch =
            label.includes("create channel") ||
            label.includes("create a channel") ||
            text.includes("create channel") ||
            text.includes("create a channel");
          // Don't gate on visibility — background tabs return 0 for all layout metrics
          const isEnabled =
            btn.getAttribute("aria-disabled") !== "true" &&
            !btn.hasAttribute("disabled");
          return isMatch && isEnabled;
        });
      }, 20000);

      if (!finalCreateButton) {
        throw new Error('Final "Create channel" submit button was not enabled or found.');
      }

      // Notify background that the form is being submitted so it can monitor for post-submit navigation
      try {
        chrome.runtime.sendMessage({
          action: "channel_creation_submitted",
          batchIdx,
        });
      } catch (e) {}

      // Get live spatial coordinates to avoid scale(Infinity) animation errors
      const rect = finalCreateButton.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      const eventOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
        pointerId: 1,
        width: 1,
        height: 1,
        pressure: 0.5,
        isPrimary: true,
      };

      finalCreateButton.focus();

      // Trigger events on inner text container and outer button
      const innerTarget =
        finalCreateButton.querySelector(
          ".ytSpecButtonShapeNextButtonTextContent, span"
        ) || finalCreateButton;

      innerTarget.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
      innerTarget.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      innerTarget.dispatchEvent(new PointerEvent("pointerup", eventOptions));
      innerTarget.dispatchEvent(new MouseEvent("mouseup", eventOptions));
      innerTarget.dispatchEvent(new MouseEvent("click", eventOptions));

      finalCreateButton.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
      finalCreateButton.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      finalCreateButton.dispatchEvent(new PointerEvent("pointerup", eventOptions));
      finalCreateButton.dispatchEvent(new MouseEvent("mouseup", eventOptions));
      finalCreateButton.dispatchEvent(new MouseEvent("click", eventOptions));

      if (typeof finalCreateButton.click === "function") {
        finalCreateButton.click();
      }

      console.log("✅ 'Create channel' button clicked successfully!");
      logCreationStatus(`Processing YouTube backend channel creation (waiting 7s)...`);

      // Monitor for 7 seconds to let YouTube's backend request complete, while checking for any server errors
      const monitorSeconds = 7;
      for (let s = 1; s <= monitorSeconds; s++) {
        await sleep(1000);

        // Check if an error banner appeared inside the dialog
        const dialogs = querySelectorDeep(
          'ytd-channel-creation-dialog-renderer, tp-yt-paper-dialog, [role="dialog"]'
        );
        const activeDialog = dialogs[0]; // don't gate on visibility — background tabs return 0

        if (activeDialog) {
          const errorEl = activeDialog.querySelector(
            '#error, .error, [role="alert"], #error-message, ytd-alert-renderer, .yt-spec-form-error, [has-error]'
          );
          if (errorEl) {
            const errText = (errorEl.textContent || "").trim();
            if (errText && !errText.toLowerCase().includes("uploading")) {
              throw new Error(`YouTube server error: ${errText}`);
            }
          }
        }
      }

      logCreationStatus(`✅ Channel "${channelName}" (@${channelUsername}) created successfully!`);
      await sleep(1000);

      chrome.runtime.sendMessage({
        action: "channel_creation_success",
        channelName,
        channelUsername,
        batchIdx,
        batchTotal,
      });
    } catch (err) {
      console.error("[YT Creator] Channel creation failed:", err);
      logCreationStatus(`❌ Creation error: ${err.message}`);
      chrome.runtime.sendMessage({
        action: "channel_creation_error",
        error: err.message || "Failed to create channel",
        batchIdx,
        batchTotal,
      });
    } finally {
      isExecutingCreation = false;
    }
  }

  // Initial execution & periodic / event listeners for seamless tab transitions
  checkAndRunCreationFlow();
  window.addEventListener("hashchange", () => {
    setTimeout(checkAndRunCreationFlow, 300);
  });
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(checkAndRunCreationFlow, 300);
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "run_channel_creation") {
      checkAndRunCreationFlow();
      sendResponse({ status: "running" });
    }
  });
  // Active interval loop to ensure creation starts as soon as YouTube finishes rendering
  setInterval(() => {
    if (!chrome.runtime?.id) return;
    if (!isExecutingCreation) {
      checkAndRunCreationFlow().catch(e => console.debug("Ignored creation flow error", e));
    }
  }, 2000);

  const currentUrl = window.location.href;
  if (currentUrl.includes("youtube.com/channel_switcher") || currentUrl.includes("youtube.com/account")) {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.substring(1)
      : window.location.hash;

    const hashParams = new URLSearchParams(hash);
    const searchParams = new URLSearchParams(window.location.search);

    // -------------------------------------------------------------
    // 1B. SWITCH CHANNEL AUTOMATION FLOW
    // -------------------------------------------------------------
    // Extract target index from URL hash or query params
    const hashIndex = hashParams.get("target_index") || searchParams.get("target_index");

    // STRICT CHECK: If no target_index is specified, this is a manual user visit. DO NOT automate.
    if (hashIndex === null || hashIndex === undefined || hashIndex.trim() === "") {
      console.log("[YT Switcher] Manual channel switcher tab detected (no target_index param). Skipping automation.");
      return;
    }

    const targetIndex = parseInt(hashIndex, 10);
    if (isNaN(targetIndex) || targetIndex < 0) {
      console.warn("[YT Switcher] Invalid target_index provided:", hashIndex);
      return;
    }

    // Prevent duplicate triggers on the same tab
    const sessionKey = `yt_switcher_handled_${targetIndex}`;
    if (sessionStorage.getItem(sessionKey)) {
      console.log(`[YT Switcher] Channel #${targetIndex} already processed on this tab session.`);
      return;
    }
    sessionStorage.setItem(sessionKey, "true");

    console.log(`[YT Switcher] Automation active for Channel Index: ${targetIndex}. Waiting for page ready...`);
    await waitForPageReady();

    try {
      // Find all account items
      const channelItems = await waitForDeep(() => {
        const items = querySelectorDeep("ytd-account-item-renderer");
        return items.length > 0 ? items : null;
      }, 15000);

      const totalChannels = channelItems.length;
      console.log(`[YT Switcher] Found ${totalChannels} channels available.`);

      if (targetIndex >= totalChannels) {
        console.warn(`[YT Switcher] Index ${targetIndex} exceeds available channels (${totalChannels}).`);
        chrome.runtime.sendMessage({
          action: "channel_out_of_bounds",
          index: targetIndex,
          totalChannels,
        });
        return;
      }

      const targetItem = channelItems[targetIndex];
      console.log(`[YT Switcher] Clicking Channel Index #${targetIndex} (Channel ${targetIndex + 1}/${totalChannels})...`);

      // Target innermost clickable element
      const clickable =
        targetItem.querySelector("tp-yt-paper-icon-item") ||
        targetItem.querySelector("paper-icon-item") ||
        targetItem.querySelector("a#channel-handle") ||
        targetItem.querySelector("a") ||
        targetItem.querySelector("#channel-title") ||
        targetItem;

      clickable.scrollIntoView({ behavior: "instant", block: "center" });
      await sleep(200);

      // Dispatch simulated click events
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((evt) => {
        clickable.dispatchEvent(
          new MouseEvent(evt, {
            bubbles: true,
            cancelable: true,
            view: window,
          })
        );
      });

      if (typeof clickable.click === "function") {
        clickable.click();
      }

      console.log(`[YT Switcher] Channel #${targetIndex} clicked successfully. Notifying background orchestrator.`);

      // Notify background script that click was performed
      chrome.runtime.sendMessage({
        action: "channel_clicked",
        index: targetIndex,
        totalChannels,
      });
    } catch (err) {
      console.error("[YT Switcher] Error during channel selection:", err);
      // Crucial: notify background so the batch doesn't hang!
      chrome.runtime.sendMessage({
        action: "channel_error",
        index: targetIndex,
        error: err.message || "Failed to find or click channel",
      });
    }
  }

  // ==============================================================
  // STEP 2: REDIRECTED TARGET / LIVE CHAT PAGE LOGIC
  // ==============================================================
  else if (
    currentUrl.includes("live_chat") ||
    currentUrl.includes("watch") ||
    currentUrl.includes("youtube.com")
  ) {
    if (!currentUrl.includes("channel_switcher")) {
      console.log("[YT Switcher] Target page loaded. Checking automation mode...");
      await waitForPageReady();

      const storageState = await new Promise((resolve) => {
        chrome.storage.local.get(['automationMode'], resolve);
      });
      const automationMode = storageState.automationMode || "chat";

      if (automationMode === "subscribe") {
        console.log("[YT Switcher] Automation Mode: Subscribe. Looking for Subscribe button...");
        try {
          const subscribeTarget = await waitForDeep(() => {
            const buttons = querySelectorDeep('button');
            const target = buttons.find(btn => {
              const ariaLabel = btn.getAttribute('aria-label');
              const textContent = btn.textContent || "";
              return (ariaLabel && ariaLabel.toLowerCase().includes('subscribe to')) || 
                     (textContent.trim().toLowerCase() === 'subscribe');
            });
            if (target) {
              const rect = target.getBoundingClientRect();
              if (target.offsetParent !== null || (rect.width > 0 && rect.height > 0)) {
                return target;
              }
            }
            return null;
          }, 15000);

          if (subscribeTarget) {
            console.log("[YT Switcher] Found Subscribe button. Clicking...", subscribeTarget);
            await smartClick(subscribeTarget);
            console.log("✅ [YT Switcher] Subscribe button clicked successfully!");
          }
        } catch (err) {
          console.log("[YT Switcher] Subscribe button not found on this page.");
        }
      } else {
        console.log("[YT Switcher] Automation Mode: Chat. Searching for chat/text input to focus...");
        try {
          const inputSelectors = [
            'div#input[contenteditable="true"]',
            'yt-live-chat-text-input-field-renderer #input',
            'yt-live-chat-message-input-renderer #input',
            '#input.yt-live-chat-text-input-field-renderer',
            '#input[contenteditable="true"]',
            '#contenteditable-root',
            'tp-yt-paper-input-container input',
            'textarea',
            'input[type="text"]',
            'input:not([type="hidden"])',
            '[contenteditable="true"]',
          ];

          const focusTarget = await waitForDeep(() => {
            for (const selector of inputSelectors) {
              const matched = querySelectorDeep(selector);
              const visible = matched.find((el) => {
                const rect = el.getBoundingClientRect();
                return el.offsetParent !== null || (rect.width > 0 && rect.height > 0);
              });
              if (visible) return visible;
            }
            return null;
          }, 15000);

          if (focusTarget) {
            console.log("[YT Switcher] Found target input. Activating focus...", focusTarget);
            focusTarget.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(200);

            focusTarget.focus();
            focusTarget.dispatchEvent(new Event("focus", { bubbles: true }));
            focusTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            focusTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            focusTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

            if (typeof focusTarget.click === "function") {
              focusTarget.click();
            }

            try {
              if (focusTarget.isContentEditable) {
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(focusTarget);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              } else if (typeof focusTarget.setSelectionRange === "function") {
                const len = focusTarget.value?.length || 0;
                focusTarget.setSelectionRange(len, len);
              }
            } catch (e) {}

            console.log("✅ [YT Switcher] Element focused successfully!");
          }
        } catch (err) {
          console.log("[YT Switcher] No chat input found on this page.");
        }
      }
    }
  }

  // ==============================================================
  // STEP 3: GOOGLE BRAND ACCOUNT / CHANNEL DELETION (STATE MACHINE)
  // ==============================================================
  else if (
    (window.location.hostname.includes("google.com") ||
    window.location.hostname.includes("myaccount.google.com")) &&
    !window.location.href.includes("profile/picture") &&
    !window.location.href.includes("photos.google.com") &&
    !window.location.href.includes("picker")
  ) {
    let isDeletingActive = false;
    let isExecutingCycle = false;
    let isWaitingForBatch = false;
    let unrecognizedAttempts = 0;

    const logStatus = (step, msg) => {
      console.log(`[DeleteChannel] [Step ${step}] ${msg}`);
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage({
            action: "delete_channel_status",
            statusText: `[Step ${step}] ${msg}`,
          }, () => {
            if (chrome.runtime.lastError) {} // Suppress closed port warning
          });
        }
      } catch (e) {}
    };

    // Helper: Dead / Processed account skip registry in sessionStorage
    const getSkippedAccounts = () => {
      try {
        const raw = sessionStorage.getItem("skipped_brand_accounts") || "[]";
        return new Set(JSON.parse(raw));
      } catch (e) {
        return new Set();
      }
    };

    const markAccountSkipped = (accountId) => {
      if (!accountId) return;
      const set = getSkippedAccounts();
      set.add(accountId);
      sessionStorage.setItem("skipped_brand_accounts", JSON.stringify(Array.from(set)));
      console.log(`[DeleteChannel] Marked account as skipped/dead: ${accountId}`);
    };

    const extractAccountId = (urlOrHref) => {
      if (!urlOrHref) return null;
      const match = urlOrHref.match(/brandaccounts\/([0-9]+)/);
      return match ? match[1] : null;
    };

    // Helper: Find all unique, unprocessed Brand Account items on list page
    const getBrandAccountItems = () => {
      const skippedSet = getSkippedAccounts();
      const items = [];
      const seenAccountIds = new Set();

      // Look for distinct <li> containers
      const candidateLis = Array.from(
        document.querySelectorAll("li.K6ZZTd, ul[role='list'] > li, li")
      );

      for (const li of candidateLis) {
        const link = li.querySelector("a[href*='brandaccounts/'][href*='/view'], a[href*='brandaccounts/'], a[href*='/view']");
        if (!link) continue;

        const href = link.getAttribute("href") || "";
        const accountId = extractAccountId(href);
        if (!accountId || seenAccountIds.has(accountId) || skippedSet.has(accountId)) continue;

        seenAccountIds.add(accountId);
        items.push({
          li,
          link,
          accountId,
          href,
        });
      }

      // Fallback: If <li> structure didn't yield items, deduplicate <a> tags directly
      if (items.length === 0) {
        const allLinks = Array.from(
          document.querySelectorAll("a[href*='brandaccounts/'][href*='/view'], a[href*='brandaccounts/']")
        );
        for (const a of allLinks) {
          const href = a.getAttribute("href") || "";
          const accountId = extractAccountId(href);
          if (accountId && !seenAccountIds.has(accountId) && !skippedSet.has(accountId)) {
            seenAccountIds.add(accountId);
            items.push({
              li: a.closest("li") || a,
              link: a,
              accountId,
              href,
            });
          }
        }
      }

      return items;
    };

    const isAuthChallengePage = () => {
      const url = window.location.href.toLowerCase();
      const hasPasswordInput = Boolean(
        document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"], div#password, input#password')
      );
      const isSignInUrl =
        url.includes("accounts.google.com/signin") ||
        url.includes("accounts.google.com/v3/signin") ||
        url.includes("/challenge/") ||
        url.includes("signin/challenge") ||
        url.includes("rejectedchallenge");

      return hasPasswordInput || isSignInUrl;
    };

    const is404OrErrorPage = () => {
      const title = (document.title || "").toLowerCase();
      const bodyText = (document.body?.innerText || "").toLowerCase();
      return (
        title.includes("404") ||
        title.includes("error") ||
        title.includes("not found") ||
        bodyText.includes("404. that’s an error") ||
        bodyText.includes("404. that's an error") ||
        bodyText.includes("the requested url was not found") ||
        bodyText.includes("there was a problem loading this account") ||
        bodyText.includes("page not found")
      );
    };

    const smartClick = async (el, name = "element") => {
      if (!el) throw new Error(`Target ${name} not found`);
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      await sleep(350);
      if (typeof el.focus === "function") el.focus();

      const evt = { bubbles: true, cancelable: true, composed: true, view: window };
      el.dispatchEvent(new PointerEvent("pointerdown", evt));
      el.dispatchEvent(new MouseEvent("mousedown", evt));
      el.dispatchEvent(new PointerEvent("pointerup", evt));
      el.dispatchEvent(new MouseEvent("mouseup", evt));
      el.dispatchEvent(new MouseEvent("click", evt));
      if (typeof el.click === "function") {
        el.click();
      }
    };

    const ensureCheckbox = async (selector, desc) => {
      let cb = document.querySelector(selector);
      if (!cb) {
        const cleanId = selector.replace("#", "");
        cb = document.querySelector(`input[id="${cleanId}"], [role="checkbox"][id="${cleanId}"]`);
      }

      if (!cb) {
        const allInputs = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"));
        if (allInputs.length > 0) {
          cb = selector.includes("7") ? allInputs[0] : allInputs[allInputs.length - 1];
        }
      }

      if (!cb) throw new Error(`Checkbox ${selector} (${desc}) not found in DOM`);

      const isChecked = cb.checked === true || cb.getAttribute("aria-checked") === "true";
      if (!isChecked) {
        logStatus(desc, `Checking checkbox ${selector}...`);
        await smartClick(cb, `Checkbox ${selector}`);
        if (!cb.checked) {
          cb.checked = true;
          cb.setAttribute("aria-checked", "true");
          cb.dispatchEvent(new Event("input", { bubbles: true }));
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        logStatus(desc, `Checkbox ${selector} already checked.`);
      }
    };

    async function checkDeletionState() {
      return new Promise((resolve) => {
        try {
          if (!chrome.runtime?.id || !chrome.storage?.local) {
            const sessionActive = sessionStorage.getItem("auto_delete_active") === "true";
            return resolve(sessionActive);
          }

          chrome.storage.local.get(["isDeleting", "isDeletingPaused"], (res) => {
            if (chrome.runtime?.lastError) {
              const sessionActive = sessionStorage.getItem("auto_delete_active") === "true";
              return resolve(sessionActive);
            }

            if (res?.isDeleting === false) {
              sessionStorage.removeItem("auto_delete_active");
              if (window.location.hash.includes("auto_delete=true")) {
                try {
                  history.replaceState(null, "", window.location.pathname + window.location.search);
                } catch (e) {
                  window.location.hash = "";
                }
              }
              return resolve(false);
            }

            if (res?.isDeletingPaused === true) {
              return resolve(false);
            }

            const hashActive = window.location.hash.includes("auto_delete=true");
            const sessionActive = sessionStorage.getItem("auto_delete_active") === "true";
            const storageActive = Boolean(res?.isDeleting);
            const active = storageActive || (hashActive && storageActive) || (sessionActive && storageActive);
            if (active) {
              sessionStorage.setItem("auto_delete_active", "true");
            }
            resolve(active);
          });
        } catch (err) {
          const sessionActive = sessionStorage.getItem("auto_delete_active") === "true";
          resolve(sessionActive);
        }
      });
    }

    async function runCycle() {
      if (isExecutingCycle || isWaitingForBatch) return;

      if (sessionStorage.getItem("deletion_submitted") === "true") {
        sessionStorage.removeItem("deletion_submitted");
        logStatus("Finished", "Detected successful deletion. Closing tab...");
        try { chrome.runtime.sendMessage({ action: "deletion_tab_completed" }); } catch (e) {}
        return;
      }

      isDeletingActive = await checkDeletionState();
      if (!isDeletingActive) return;

      isExecutingCycle = true;
      const url = window.location.href;

      try {
        // -------------------------------------------------------------
        // PRE-CHECK 1: GOOGLE PASSWORD / 2FA AUTHENTICATION CHALLENGE
        // -------------------------------------------------------------
        if (isAuthChallengePage()) {
          logStatus("Auth", "🔑 Password / Verification required. Please authenticate and click Resume in popup.");
          chrome.storage.local.set({
            isDeleting: true,
            isDeletingPaused: true,
            statusText: "🔑 Password required: Verify & click Resume",
          });
          isExecutingCycle = false;
          return;
        }

        // -------------------------------------------------------------
        // PRE-CHECK 2: 404 OR DEAD ERROR PAGE
        // -------------------------------------------------------------
        if (is404OrErrorPage()) {
          const deadId = extractAccountId(url);
          if (deadId) markAccountSkipped(deadId);
          logStatus("Recovery", `Detected 404/Error page for account [${deadId || "unknown"}]. Notifying background...`);
          await sleep(1500);
          if (url.endsWith("brandaccounts") || url.endsWith("brandaccounts/") || url.includes("brandaccounts#auto_delete=true")) {
            window.location.href = "https://myaccount.google.com/brandaccounts#auto_delete=true";
          } else {
            try { chrome.runtime.sendMessage({ action: "deletion_tab_error", error: "404 Error page" }); } catch(e) {}
          }
          isExecutingCycle = false;
          return;
        }

        // -------------------------------------------------------------
        // STATE A: CONFIRMATION PAGE (Checkboxes #i7, #i9 & Submit button)
        // -------------------------------------------------------------
        const hasCheckboxes = document.querySelector("#i7, #i9, input[type='checkbox'], [role='checkbox']");
        const hasSubmitBtn = document.querySelector("button[type='submit'], input[type='submit']");
        const isDeleteUrl = url.includes("/delete") || url.includes("deleteaccount") || url.includes("delete");

        if (hasCheckboxes || (isDeleteUrl && hasSubmitBtn)) {
          unrecognizedAttempts = 0;
          const accountId = extractAccountId(url);
          if (accountId) markAccountSkipped(accountId);

          logStatus("5-6", "Confirmation UI detected. Checking checkbox #i7...");
          await ensureCheckbox("#i7", "Checkbox 1 (#i7)");
          await sleep(800);

          logStatus("7-8", "Checking checkbox #i9...");
          await ensureCheckbox("#i9", "Checkbox 2 (#i9)");
          await sleep(1000);

          logStatus("9", "Looking for final 'Delete Account' submit button...");
          const submitBtn = await waitForDeep(() => {
            const btns = Array.from(
              document.querySelectorAll("button[type='submit'], input[type='submit'], button, div[role='button']")
            );
            return btns.find((b) => {
              const text = (b.textContent || b.value || "").trim().toLowerCase();
              const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
              const isMatch = text === "delete account" || aria === "delete account" || text.includes("delete account");
              const isEnabled = !b.disabled && b.getAttribute("aria-disabled") !== "true";
              return isMatch && isEnabled;
            });
          }, 15000).catch(() => null);

          if (submitBtn) {
            logStatus("10", "Clicking final 'Delete Account' submit button...");
            sessionStorage.setItem("deletion_submitted", "true");
            await smartClick(submitBtn, "Final Delete Account Button");
            logStatus("10", "Deletion submitted! Waiting for Google to process...");

            // Wait up to 15s for the submit button to disappear or the page to unload
            let waitTime = 0;
            while(document.contains(submitBtn) && waitTime < 15000) {
              await sleep(500);
              waitTime += 500;
            }
            
            // Add a safety buffer in case the DOM updated but network is slow
            await sleep(2500);
            
            if (sessionStorage.getItem("deletion_submitted") === "true") {
              sessionStorage.removeItem("deletion_submitted");
              try { chrome.runtime.sendMessage({ action: "deletion_tab_completed" }); } catch (e) {}
            }
          } else {
            logStatus("Recovery", "Final submit button not found after 15s. Notifying background to close tab...");
            try { chrome.runtime.sendMessage({ action: "deletion_tab_error", error: "Missing submit button" }); } catch (e) {}
          }
          isExecutingCycle = false;
          return;
        }

        // -------------------------------------------------------------
        // STATE B: BRAND ACCOUNT VIEW PAGE (/view or "Delete account" button)
        // -------------------------------------------------------------
        if (url.includes("/view")) {
          unrecognizedAttempts = 0;
          logStatus("3-4", "Brand account view page. Finding 'Delete account' button...");
          await sleep(1200);

          const deleteBtn = await waitForDeep(() => {
            const candidates = Array.from(
              document.querySelectorAll("button, a, div[role='button'], span[role='button'], [data-id]")
            );
            return candidates.find((el) => {
              const text = (el.textContent || "").trim().toLowerCase();
              const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
              const href = (el.getAttribute("href") || "").toLowerCase();
              return (
                text === "delete account" ||
                text.includes("delete account") ||
                aria === "delete account" ||
                aria.includes("delete account") ||
                href.includes("/delete") ||
                href.includes("deleteaccount")
              );
            });
          }, 20000).catch(() => null);

          if (deleteBtn) {
            logStatus("4", "Found 'Delete account' button. Clicking...");
            const href = deleteBtn.getAttribute("href");
            const accountId = extractAccountId(url) || extractAccountId(href);
            if (accountId) markAccountSkipped(accountId);

            await smartClick(deleteBtn, "'Delete account' button");

            // Fallback: If SPA route didn't change after 2s and href is available, navigate
            await sleep(2000);
            if (window.location.href.includes("/view") && href) {
              window.location.href = href;
            }
          } else {
            // Element not found on view page after 20s
            const accountId = extractAccountId(url);
            if (accountId) markAccountSkipped(accountId);
            logStatus("Recovery", "Could not find 'Delete account' button after 20s. Notifying background to close tab...");
            try { chrome.runtime.sendMessage({ action: "deletion_tab_error", error: "Missing button" }); } catch (e) {}
          }
          isExecutingCycle = false;
          return;
        }

        // -------------------------------------------------------------
        // STATE C: BRAND ACCOUNTS LIST PAGE (/brandaccounts)
        // -------------------------------------------------------------
        if (url.includes("brandaccounts") && !url.includes("/view") && !url.includes("/delete")) {
          unrecognizedAttempts = 0;
          logStatus("1", "Scanning brand account <li> items on list page...");
          await sleep(1500);

          const availableItems = getBrandAccountItems();
          console.log(`[DeleteChannel] Found ${availableItems.length} unprocessed unique brand account(s).`);

          // Report count to background script so Scout Tab can dynamically open remaining tabs
          try {
            chrome.runtime.sendMessage({
              action: "report_channel_count",
              count: availableItems.length,
            });
          } catch (e) {}

          if (availableItems.length === 0) {
            // Check if items are still rendering
            await sleep(2000);
            const retryItems = getBrandAccountItems();
            if (retryItems.length === 0) {
              logStatus("Finished", "🎉 All Brand Account channels have been successfully deleted!");
              sessionStorage.removeItem("auto_delete_active");
              sessionStorage.removeItem("skipped_brand_accounts");
              sessionStorage.removeItem("auto_delete_reloaded");
              await chrome.storage.local.set({
                isDeleting: false,
                statusText: "All channels deleted successfully!",
              });
              try { chrome.runtime.sendMessage({ action: "delete_channels_completed" }); } catch (e) {}
              isExecutingCycle = false;
              return;
            }
          }

          // Fetch assigned targetIdx from background script
          let deleteIdx = 0;
          try {
            const response = await new Promise((res) => {
              chrome.runtime.sendMessage({ action: "get_deletion_tab_params" }, (r) => {
                if (chrome.runtime.lastError) res(null);
                else res(r);
              });
            });
            if (response && typeof response.targetIdx === "number") {
              deleteIdx = response.targetIdx;
            } else {
              deleteIdx = parseInt(INITIAL_HASH_PARAMS.get("delete_idx"), 10) || 0;
            }
          } catch (e) {
            deleteIdx = parseInt(INITIAL_HASH_PARAMS.get("delete_idx"), 10) || 0;
          }

          console.log(`[DeleteChannel] Tab assigned index ${deleteIdx} (li ${deleteIdx + 1}). Available items: ${availableItems.length}`);

          if (deleteIdx >= availableItems.length) {
            logStatus("Finished", `Tab assigned index ${deleteIdx} but only ${availableItems.length} items remain. Reporting out of bounds.`);
            try { chrome.runtime.sendMessage({ action: "deletion_out_of_bounds" }); } catch (e) {}
            isExecutingCycle = false;
            return;
          }

          const targetItem = availableItems[deleteIdx];
          if (targetItem) {
            logStatus("1-2", `[Tab -> li ${deleteIdx + 1}] Targeting brand account [${targetItem.accountId}]: ${targetItem.href}`);
            // Mark account skipped in this tab so subsequent cycles don't re-target it
            markAccountSkipped(targetItem.accountId);

            await smartClick(targetItem.link, `Brand Account li ${deleteIdx + 1} link`);

            // Fallback if SPA doesn't trigger URL transition
            await sleep(2000);
            if (
              window.location.href.includes("brandaccounts") &&
              !window.location.href.includes("/view") &&
              !window.location.href.includes("/delete")
            ) {
              if (targetItem.href) {
                window.location.href = targetItem.href;
              }
            }
          }
          isExecutingCycle = false;
          return;
        }

        // -------------------------------------------------------------
        // STATE D: UNRECOGNIZED / TRANSITIONAL PAGE STATE
        // -------------------------------------------------------------
        unrecognizedAttempts++;
        if (unrecognizedAttempts < 10) {
          logStatus("Wait", `Page is transitioning/loading (${unrecognizedAttempts}/10). Waiting...`);
          await sleep(1500);
          isExecutingCycle = false;
          return;
        }

        // Only after 10 failed attempts (15+ seconds) treat as stuck
        logStatus("Recovery", "Page state unrecognized after 10 attempts. Notifying background...");
        unrecognizedAttempts = 0;
        if (url.includes("brandaccounts")) {
          window.location.href = "https://myaccount.google.com/brandaccounts#auto_delete=true";
        } else {
          try { chrome.runtime.sendMessage({ action: "deletion_tab_error", error: "Unrecognized page state" }); } catch (e) {}
        }
      } catch (err) {
        console.error("[DeleteChannel] Cycle error:", err);
        logStatus("Error", `${err.message}. Notifying background...`);
        await sleep(1500);
        if (window.location.href.includes("brandaccounts")) {
          window.location.href = "https://myaccount.google.com/brandaccounts#auto_delete=true";
        } else {
          try { chrome.runtime.sendMessage({ action: "deletion_tab_error", error: err.message }); } catch(e) {}
        }
      } finally {
        isExecutingCycle = false;
      }
    }

    // Listen for direct trigger from popup or background
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "start_deletion_now") {
        sessionStorage.setItem("auto_delete_active", "true");
        chrome.storage.local.set({ isDeleting: true, isDeletingPaused: false });
        isExecutingCycle = false;
        runCycle();
        sendResponse({ status: "started" });
      } else if (msg.action === "resume_deletion_now") {
        sessionStorage.setItem("auto_delete_active", "true");
        chrome.storage.local.set({ isDeleting: true, isDeletingPaused: false });
        isExecutingCycle = false;
        logStatus("Resume", "Resuming deletion process...");
        runCycle();
        sendResponse({ status: "resumed" });
      } else if (msg.action === "stop_deletion_now") {
        isDeletingActive = false;
        isExecutingCycle = false;
        sessionStorage.removeItem("auto_delete_active");
        sessionStorage.removeItem("skipped_brand_accounts");
        sessionStorage.removeItem("auto_delete_reloaded");
        if (window.location.hash.includes("auto_delete=true")) {
          try {
            history.replaceState(null, "", window.location.pathname + window.location.search);
          } catch (e) {
            window.location.hash = "";
          }
        }
        chrome.storage.local.set({ isDeleting: false, isDeletingPaused: false, statusText: "Channel deletion stopped" });
        logStatus("Stopped", "Channel deletion stopped by user.");
        sendResponse({ status: "stopped" });
      }
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.isDeleting?.newValue === true && changes.isDeletingPaused?.newValue !== true) {
        sessionStorage.setItem("auto_delete_active", "true");
        isExecutingCycle = false;
        runCycle();
      } else if (changes.isDeletingPaused?.newValue === false && changes.isDeleting?.newValue !== false) {
        sessionStorage.setItem("auto_delete_active", "true");
        isExecutingCycle = false;
        runCycle();
      } else if (changes.isDeleting?.newValue === false) {
        isDeletingActive = false;
        sessionStorage.removeItem("auto_delete_active");
        sessionStorage.removeItem("skipped_brand_accounts");
        sessionStorage.removeItem("auto_delete_reloaded");
        if (window.location.hash.includes("auto_delete=true")) {
          try {
            history.replaceState(null, "", window.location.pathname + window.location.search);
          } catch (e) {
            window.location.hash = "";
          }
        }
      }
    });

    // Start polling cycle loop to handle SPA transitions & dynamic renders
    setInterval(runCycle, 1500);
    runCycle();
  }
})();


