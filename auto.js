async function createYouTubeChannel(channelName, username) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Deep recursive query selector across Shadow DOM and iframe boundaries
    const querySelectorDeep = (selector, root = document) => {
        const matching = [];

        const traverse = (currentRoot) => {
            if (!currentRoot) return;

            // Search normal children
            try {
                const elements = currentRoot.querySelectorAll(selector);
                elements.forEach((el) => matching.push(el));
            } catch (e) {}

            // Search all children for shadow roots and iframes
            try {
                const allElements = currentRoot.querySelectorAll("*");
                allElements.forEach((el) => {
                    if (el.shadowRoot) {
                        traverse(el.shadowRoot);
                    }
                    if (el.tagName === "IFRAME") {
                        try {
                            const iframeDoc = el.contentDocument || el.contentWindow?.document;
                            if (iframeDoc) traverse(iframeDoc);
                        } catch (e) {}
                    }
                });
            } catch (e) {}
        };

        traverse(root);
        return matching;
    };

    const smartClick = async (el) => {
        if (!el) return;
        el.scrollIntoView({ behavior: "instant", block: "center" });
        el.focus();
        await wait(80);

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

    // Wait for an element even if deeply hidden inside custom elements / Shadow DOM
    const waitForDeep = async (predicate, timeout = 20000) => {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            const result = predicate();
            if (result && (!Array.isArray(result) || result.length > 0)) {
                return Array.isArray(result) ? result[0] : result;
            }
            await wait(300);
        }

        throw new Error("Timed out waiting for deep DOM element.");
    };

    console.log(`[1/11] Finding "Create a channel" button...`);
    // 1. Click "Create a channel"
    const createChannelLink = await waitForDeep(() => {
        const links = querySelectorDeep(
            'a[aria-label="Create a channel"], a[href*="create_channel"], a[href*="channel_creation"], ytd-button-renderer a'
        );
        return links.find((el) => {
            const label = (el.getAttribute("aria-label") || "").toLowerCase();
            const text = (el.textContent || "").trim().toLowerCase();
            return (
                label === "create a channel" ||
                text.includes("create a channel") ||
                el.href?.includes("channel_creation")
            );
        });
    });

    await smartClick(createChannelLink);
    await wait(2000);

    const typeIntoInput = async (inputEl, text) => {
        if (!inputEl) return;
        inputEl.scrollIntoView({ behavior: "instant", block: "center" });
        inputEl.focus();
        await wait(150);

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
    };

    console.log(`[4/5] Locating Name and Handle input fields in creation dialog...`);
    const { nameInput, usernameInput } = await waitForDeep(() => {
        const dialogs = querySelectorDeep(
            'ytd-channel-creation-dialog-renderer, tp-yt-paper-dialog, [role="dialog"], #dialog'
        );
        const activeDialog = dialogs.find(
            (d) => d.offsetParent !== null || d.getBoundingClientRect().width > 0
        ) || document;

        const allInputs = querySelectorDeep(
            'tp-yt-paper-input input, paper-input input, input#input, input[type="text"], input.tp-yt-paper-input',
            activeDialog
        ).filter((inp) => {
            const isVisible = inp.offsetParent !== null || inp.getBoundingClientRect().width > 0;
            const isFileInput = inp.type === "file";
            const isHidden = inp.type === "hidden";
            return isVisible && !isFileInput && !isHidden;
        });

        let nInput = querySelectorDeep(
            '#name-input input, tp-yt-paper-input#name-input input, [id*="name" i] input, tp-yt-paper-input[aria-label*="name" i] input',
            activeDialog
        ).find((i) => i.offsetParent !== null || i.getBoundingClientRect().width > 0);

        let uInput = querySelectorDeep(
            '#handle-input input, tp-yt-paper-input#handle-input input, [id*="handle" i] input, tp-yt-paper-input[aria-label*="handle" i] input',
            activeDialog
        ).find((i) => i.offsetParent !== null || i.getBoundingClientRect().width > 0);

        if (!nInput || !uInput || nInput === uInput) {
            if (allInputs.length >= 2) {
                nInput = allInputs[0];
                uInput = allInputs[1];
            } else if (allInputs.length === 1) {
                nInput = allInputs[0];
            }
        }

        if (nInput) {
            return { nameInput: nInput, usernameInput: uInput };
        }
        return null;
    }, 20000);

    if (!nameInput) {
        throw new Error("Could not locate Channel Name input field.");
    }

    console.log(`[4/5] Entering channel name: "${channelName}" into Name field...`);
    await typeIntoInput(nameInput, channelName);
    await wait(800);

    if (usernameInput && usernameInput !== nameInput) {
        const cleanHandle = username.replace(/^@+/, "");
        console.log(`[4/5] Entering handle: "@${cleanHandle}" into Handle field...`);
        await typeIntoInput(usernameInput, cleanHandle);
        await wait(800);
    }

    console.log(`[5/5] Validating handle and clicking final "Create channel" button...`);
    // Wait for handle validation & debounce to finish so the button enables (aria-disabled="false")
    await wait(2500);

    // 11. Click final "Create channel" button
    const finalCreateButton = await waitForDeep(() => {
        const buttons = querySelectorDeep(
            'button.ytSpecButtonShapeNextHost[aria-label="Create channel"], button[aria-label="Create channel"], ytd-channel-creation-dialog-renderer button, button'
        );
        return buttons.find((btn) => {
            const label = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
            const text = (btn.textContent || "").trim().toLowerCase();
            const isMatch =
                label === "create channel" ||
                text === "create channel" ||
                text.includes("create channel");

            const isVisible =
                btn.offsetParent !== null ||
                btn.getBoundingClientRect().width > 0;

            const isEnabled =
                btn.getAttribute("aria-disabled") !== "true" &&
                !btn.hasAttribute("disabled");

            return isMatch && isVisible && isEnabled;
        });
    }, 20000);

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

    console.log("✅ 'Create channel' button clicked! Processing YouTube backend creation (waiting 7s)...");

    for (let s = 1; s <= 7; s++) {
        await wait(1000);

        const dialogs = querySelectorDeep(
            'ytd-channel-creation-dialog-renderer, tp-yt-paper-dialog, [role="dialog"]'
        );
        const activeDialog = dialogs.find(
            (d) => d.offsetParent !== null && d.getBoundingClientRect().width > 0
        );

        if (activeDialog) {
            const errorEl = activeDialog.querySelector(
                '#error, .error, [role="alert"], #error-message, ytd-alert-renderer, .yt-spec-form-error, [has-error]'
            );
            if (errorEl) {
                const errText = (errorEl.textContent || "").trim();
                if (errText && !errText.toLowerCase().includes("uploading")) {
                    throw new Error(`YouTube creation error: ${errText}`);
                }
            }
        }
    }

    console.log(`✅ Channel "${channelName}" created and confirmed!`);
}

/**
 * Automates deleting all Google Brand Accounts / Channels from Chrome Console
 */
async function deleteAllGoogleBrandAccounts() {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const smartClick = async (element, name = "element") => {
        if (!element) throw new Error(`Target ${name} not found`);
        element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        await wait(350);

        if (typeof element.focus === "function") element.focus();

        const evt = { bubbles: true, cancelable: true, composed: true, view: window };
        element.dispatchEvent(new PointerEvent("pointerdown", evt));
        element.dispatchEvent(new MouseEvent("mousedown", evt));
        element.dispatchEvent(new PointerEvent("pointerup", evt));
        element.dispatchEvent(new MouseEvent("mouseup", evt));
        element.dispatchEvent(new MouseEvent("click", evt));
        if (typeof element.click === "function") element.click();
    };

    const waitFor = async (predicate, timeout = 20000, interval = 250) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = typeof predicate === "function" ? predicate() : document.querySelector(predicate);
            if (el) {
                const rect = el.getBoundingClientRect();
                if (el.offsetParent !== null || rect.width > 0 || rect.height > 0) return el;
            }
            await wait(interval);
        }
        throw new Error("Timed out waiting for element");
    };

    const ensureChecked = async (selector, desc) => {
        const cb = await waitFor(() => {
            const el = document.querySelector(selector);
            if (el) return el;
            const cleanId = selector.replace("#", "");
            return document.querySelector(`input[id="${cleanId}"], [role="checkbox"][id="${cleanId}"]`);
        });

        const isChecked = cb.checked === true || cb.getAttribute("aria-checked") === "true";
        if (!isChecked) {
            console.log(`Checking checkbox ${selector} (${desc})...`);
            await smartClick(cb, `Checkbox ${selector}`);
            if (!cb.checked) {
                cb.checked = true;
                cb.setAttribute("aria-checked", "true");
                cb.dispatchEvent(new Event("input", { bubbles: true }));
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }
    };

    console.log("🚀 Starting Google Brand Accounts Deletion...");

    // 1. Find target <li> / <a>
    const link = await waitFor(() => {
        const specificLi = document.querySelector("li.K6ZZTd.iUwXVd.bs2km.t7ce4c a[href*='brandaccounts/']");
        if (specificLi) return specificLi;
        const anyBrand = document.querySelector("a[href*='brandaccounts/'][href*='/view']");
        if (anyBrand) return anyBrand;
        return document.querySelector("li a[href*='brandaccounts/']");
    });

    console.log("[Step 1-2] Clicking Brand Account link:", link.getAttribute("href"));
    await smartClick(link, "Brand Account link");

    // 3. Wait for view page
    console.log("[Step 3] Waiting for view UI...");
    await wait(2000);

    // 4. Find & Click "Delete account" button
    console.log("[Step 4] Finding 'Delete account' button...");
    const deleteBtn = await waitFor(() => {
        const candidates = Array.from(document.querySelectorAll("button, a, div[role='button'], span[role='button']"));
        return candidates.find((el) => {
            const text = (el.textContent || "").trim().toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
            return text === "delete account" || aria === "delete account";
        });
    });
    await smartClick(deleteBtn, "Delete account button");

    // 5. Wait for confirmation UI
    console.log("[Step 5] Waiting for confirmation UI...");
    await wait(2500);

    // 6. Check #i7
    console.log("[Step 6] Checking #i7...");
    await ensureChecked("#i7", "Confirmation Checkbox 1");
    await wait(800);

    // 8. Check #i9
    console.log("[Step 8] Checking #i9...");
    await ensureChecked("#i9", "Confirmation Checkbox 2");

    // 9-10. Click final submit button
    console.log("[Step 9-10] Finding and clicking final submit button...");
    const submitBtn = await waitFor(() => {
        const buttons = Array.from(document.querySelectorAll("button[type='submit'], input[type='submit'], button, div[role='button']"));
        return buttons.find((btn) => {
            const text = (btn.textContent || btn.value || "").trim().toLowerCase();
            const isSubmit = btn.getAttribute("type") === "submit" || btn.tagName === "BUTTON";
            const isEnabled = !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
            return text === "delete account" && isSubmit && isEnabled;
        });
    });
    await smartClick(submitBtn, "Final Delete Account Button");
    console.log("✅ Deletion submitted successfully! Redirecting back to Brand Accounts list...");
    await wait(2500);
    window.location.href = "https://myaccount.google.com/brandaccounts";
}