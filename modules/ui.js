/* ==========================================================
   AWAKENED — Application UI
   Rendering, forms, routing, dialogs, and user interactions.

   Domain rules remain in their engine modules.
========================================================== */

import {
    getState,
    updateState,
    subscribe,
    subscribePersistence,
    clone,
    STAT_INFO,
    getTrackingDate,
    serializeBackup,
    validateBackup,
    restoreBackup,
    resetStore,
    reloadFromStorage
} from "./state.js";

import {
    createQuest,
    editQuest,
    deleteQuest,
    setQuestPaused,
    setQuestArchived,
    setQuestPriority,
    moveQuest,
    logQuestProgress,
    completeQuest,
    undoLastQuestLog,
    setChecklistStep,
    selectQuests,
    getTodayQuestSummary,
    getQuestTemplates,
    createQuestFromTemplate,
    createBonusQuest,
    suggestRank,
    xpForLevel
} from "./quests.js";

import {
    captureTodaySchedule,
    getDayReview,
    evaluateToday,
    reconcileElapsedDays,
    recordRest,
    getRecoveryOptions,
    getStreakSummary,
    reserveProtection,
    cancelProtection,
    startRecovery,
    setRecoveryStep,
    completeRecovery,
    cancelRecovery
} from "./streaks.js";

import {
    createRaid,
    editRaid,
    deleteRaid,
    attackRaidTask,
    createRaidRematch,
    selectRaids,
    getWeeklyGate,
    getShadowArmy,
    getRaidSummary,
    syncRaidEvents
} from "./raids.js";

import {
    createCurrency,
    getCurrencies,
    createReward,
    editReward,
    deleteReward,
    purchaseItem,
    useConsumable,
    redeemReward,
    equipItem,
    unequipSlot,
    getEquipmentOptions,
    getActiveBuffs,
    selectShopItems,
    selectInventory,
    getPurchaseHistory
} from "./shop.js";

import {
    configureFocus,
    startFocus,
    pauseFocus,
    resumeFocus,
    resetFocus,
    skipBreak,
    reconcileFocus,
    processPendingFocusCredits,
    retryFocusCredit,
    getFocusView,
    getFocusHistory,
    getFocusSummary,
    getLinkableFocusQuests
} from "./focus.js";

import {
    saveJournalEntry,
    deleteJournalEntry,
    getJournalEntry,
    getJournalEntryForDate,
    selectJournalEntries
} from "./journal.js";

import {
    getAnalyticsReport,
    getConsistencyCalendar,
    createAnalyticsCsv
} from "./analytics.js";

import {
    unlockAudio,
    playSound,
    startAmbient,
    stopAmbient,
    flashCompletion,
    showQuestRewards,
    showDamage,
    shakeBoss,
    celebrate,
    haptic,
    speakSystem
} from "./effects.js";

/* -------------------- UI STATE -------------------- */

const ROUTES = new Set([
    "dashboard",
    "quests",
    "raids",
    "character",
    "shop",
    "inventory",
    "focus",
    "journal",
    "analytics",
    "achievements",
    "connections"
]);

let initialized = false;
let controller = null;
let unsubscribeStore = null;
let unsubscribePersistence = null;
let renderFrame = null;

let currentRoute = "dashboard";
let pendingInstallPrompt = null;
let confirmationResolver = null;

const $ = id => document.getElementById(id);

/* -------------------- SAFE DOM HELPERS -------------------- */

function element(tag, text = "", className = "") {
    const node = document.createElement(tag);

    if (text !== "") node.textContent = String(text);
    if (className) node.className = className;

    return node;
}

function replace(id, children = []) {
    const parent = $(id);

    if (parent) {
        parent.replaceChildren(...children.filter(Boolean));
    }
}

function setText(id, value) {
    const node = $(id);

    if (node) node.textContent = String(value ?? "");
}

function show(id, visible = true) {
    const node = $(id);

    if (node) node.hidden = !visible;
}

function slot(root, name, value) {
    const node = root.querySelector(`[data-slot="${name}"]`);

    if (node && value !== undefined) {
        node.textContent = String(value ?? "");
    }

    return node;
}

function template(id) {
    const source = $(id);

    if (!source?.content?.firstElementChild) {
        throw new Error(`Missing HTML template: ${id}`);
    }

    return source.content.firstElementChild.cloneNode(true);
}

function actionButton(label, action, id = "", className = "button button-ghost") {
    const button = element("button", label, className);

    button.type = "button";
    button.dataset.action = action;

    if (id) button.dataset.id = id;

    return button;
}

function badge(text, className = "") {
    return element("span", text, `badge ${className}`.trim());
}

function number(value) {
    return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2
    }).format(value || 0);
}

function trackingDate() {
    return getTrackingDate();
}

function readableDate(key) {
    if (!key) return "—";

    const parsed = new Date(
        `${key}T12:00:00`
    );

    if (!Number.isFinite(parsed.getTime())) return key;

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium"
    }).format(parsed);
}

function setMeter(id, value, max) {
    const meter = $(id);

    if (!meter) return;

    meter.max = Math.max(1, max);
    meter.value = Math.max(0, value);
    meter.textContent = `${Math.round(
        (Math.max(0, value) / Math.max(1, max)) * 100
    )}%`;
}

function fillOptions(select, options, selected = "") {
    if (!select) return;

    select.replaceChildren(
        ...options.map(item => {
            const option = element("option", item.name);

            option.value = String(item.value ?? "");
            return option;
        })
    );

    select.value = String(selected ?? "");
}

function formObject(form) {
    return Object.fromEntries(new FormData(form).entries());
}

function disableAction(root, action, disabled, label) {
    const button = root.querySelector(`[data-action="${action}"]`);

    if (!button) return;

    button.disabled = Boolean(disabled);

    if (label) button.textContent = label;
}

/* -------------------- TOASTS -------------------- */

export function toast(message, {
    type = "",
    undo = null
} = {}) {
    const region = $("toastRegion");

    if (!region) return;

    const node = template("toastTemplate");

    if (type) node.classList.add(`is-${type}`);

    slot(node, "message", message);

    const undoButton = node.querySelector(
        '[data-action="toast-undo"]'
    );

    const dismissButton = node.querySelector(
        '[data-action="dismiss-toast"]'
    );

    undoButton.hidden = typeof undo !== "function";

    undoButton.addEventListener("click", async event => {
        event.stopPropagation();
        undoButton.disabled = true;

        try {
            await undo();
            node.remove();
        } catch (error) {
            undoButton.disabled = false;
            toast(error.message, { type: "danger" });
        }
    });

    dismissButton.addEventListener("click", event => {
        event.stopPropagation();
        node.remove();
    });

    region.appendChild(node);

    while (region.children.length > 5) {
        region.firstElementChild.remove();
    }

    /*
      Undo notifications stay longer than ordinary notifications.
    */
    setTimeout(() => node.remove(), undo ? 12000 : 6000);
}

/* -------------------- DIALOGS -------------------- */

export function openDialog(id) {
    const dialog = $(id);

    if (!(dialog instanceof HTMLDialogElement)) {
        throw new Error(`Dialog not found: ${id}`);
    }

    prepareDialog(id);

    if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
    if (dialog instanceof HTMLDialogElement && dialog.open) {
        dialog.close();
    }
}

function closeAllDialogs() {
    document.querySelectorAll("dialog[open]").forEach(closeDialog);
}

function confirmAction({
    title = "Confirm action",
    message,
    details = "",
    typed = null,
    submitLabel = "Confirm"
}) {
    if (confirmationResolver) {
        throw new Error("Another confirmation is already open.");
    }

    setText("confirmHeading", title);
    setText("confirmMessage", message);
    setText("confirmDetails", details);
    setText("confirmSubmitButton", submitLabel);

    $("confirmText").value = "";
    $("confirmText").placeholder = typed || "";

    $("confirmText").dataset.expected = typed || "";

    show("confirmTextField", Boolean(typed));
    show("confirmError", false);

    $("confirmDialog").showModal();

    return new Promise(resolve => {
        confirmationResolver = resolve;
    });
}

function settleConfirmation(result) {
    const resolve = confirmationResolver;

    confirmationResolver = null;
    closeDialog($("confirmDialog"));

    resolve?.(result);
}

function celebrateDialog({
    title,
    message,
    rewards = [],
    symbol = "✦"
}) {
    /*
      Avoid stacking celebrations above an editor.
      The durable activity feed still records the outcome.
    */
    if (
        document.querySelector(
            "dialog[open]:not(#celebrationDialog)"
        )
    ) {
        toast(`${title}: ${message}`, { type: "success" });
        return;
    }

    setText("celebrationHeading", title);
    setText("celebrationMessage", message);
    setText("celebrationSymbol", symbol);

    replace(
        "celebrationRewards",
        rewards.map(item => element("li", item))
    );

    openDialog("celebrationDialog");

    celebrate({ host: $("celebrationDialog") });
}

/* -------------------- ROUTING -------------------- */

export function navigate(route, { updateHash = true } = {}) {
    currentRoute = ROUTES.has(route) ? route : "dashboard";

    document.querySelectorAll("[data-page]").forEach(page => {
        page.hidden = page.dataset.page !== currentRoute;
    });

    document.querySelectorAll("[data-route]").forEach(link => {
        if (link.dataset.route === currentRoute) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    });

    closeDialog($("navigationDialog"));

    if (currentRoute !== "focus") {
        document.body.classList.remove("deep-work");
        stopAmbient();
    }

    if (updateHash && location.hash !== `#${currentRoute}`) {
        location.hash = currentRoute;
    }

    renderCurrentPage();
}

function routeFromHash() {
    return location.hash.slice(1) || "dashboard";
}

/* -------------------- APPEARANCE -------------------- */

function applyAppearance() {
    const state = getState();
    const settings = state.settings;
    const root = document.documentElement;

    root.dataset.theme =
        state.inventory.equipped.theme || settings.theme;

    root.dataset.density = settings.density;
    root.dataset.font = settings.font;
    root.dataset.cardStyle = settings.cardStyle;

    /*
      The custom accent currently applies to System Blue only.
      Named themes retain their own accent tokens.
    */
    if (root.dataset.theme === "system-blue") {
        const hex = settings.accent;

        root.style.setProperty("--accent", hex);

        const channels = [
            hex.slice(1, 3),
            hex.slice(3, 5),
            hex.slice(5, 7)
        ].map(value => parseInt(value, 16));

        root.style.setProperty(
            "--accent-rgb",
            channels.join(", ")
        );
    } else {
        root.style.removeProperty("--accent");
        root.style.removeProperty("--accent-rgb");
    }

    const soundButton = document.querySelector(
        '[data-action="toggle-sound"]'
    );

    soundButton?.setAttribute(
        "aria-pressed",
        String(settings.sfx)
    );
}

/* -------------------- GLOBAL HEADER -------------------- */

function renderHeader() {
    const state = getState();

    setText("headerGold", number(state.wallet.gold));
    setText("headerCrystals", number(state.wallet.crystals));
    setText("headerStreak", state.streaks.current);

    setText("sidebarPlayerName", state.profile.name);

    setText(
        "sidebarPlayerRank",
        `Level ${state.profile.level} · ${state.profile.classId || "Unassigned"}`
    );

    setText("sidebarAvatar", initials(state.profile.name));

    const summary = getTodayQuestSummary();

    setText(
        "questNavCount",
        summary.total - summary.completed
    );

    setText("connectionStatus", "Local mode");
}

function initials(name) {
    return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part[0] || "")
        .join("")
        .toUpperCase();
}

/* -------------------- DASHBOARD -------------------- */

function renderDashboard() {
    const state = getState();

    const summary = getTodayQuestSummary();
    const streak = getStreakSummary();
    const raids = getRaidSummary();
    const focus = getFocusSummary();

    const date = trackingDate();

    setText("todayDate", readableDate(date));

    setText(
        "dashboardHeading",
        `Welcome back, ${state.profile.name}.`
    );

    setText(
        "mandatorySummary",
        summary.mandatoryRemaining
            ? `${summary.mandatoryRemaining} mandatory objective(s) remain.`
            : "No mandatory objectives remain."
    );

    setText(
        "dailyCompletionText",
        `${summary.completed} of ${summary.total} quests completed`
    );

    setMeter(
        "dailyCompletionProgress",
        summary.completed,
        Math.max(1, summary.total)
    );

    const xpToday = state.activity
        .filter(event =>
            !event.reversedBy &&
            event.trackingDate === date
        )
        .reduce((total, event) => {
            if (event.type === "quest.completed") {
                return total + (event.payload.reward?.xp || 0);
            }

            if (event.type === "raid.cleared") {
                return total + (event.payload.xp || 0);
            }

            return total;
        }, 0);

    setText("dashboardXp", number(xpToday));
    setText("dashboardCombo", "Base rewards active");

    setText("dashboardStreak", `${streak.current} days`);
    setText("dashboardBestStreak", `Best: ${streak.best} days`);

    setText("dashboardFocus", `${focus.minutes} min`);
    setText("dashboardFocusSessions", `${focus.sessions} sessions`);

    setText("dashboardRaids", raids.active);

    setText(
        "dashboardNextDeadline",
        raids.nextDeadline
            ? `Next: ${readableDate(raids.nextDeadline)}`
            : "No upcoming deadline"
    );

    setText(
        "freezeBalance",
        `${streak.freezes} freezes · ${streak.shields} shields`
    );

    setText(
        "recoverySummary",
        streak.activeRecovery
            ? `Recovery in progress for ${readableDate(
                streak.activeRecovery.targetDate
            )}.`
            : `${streak.recoverableDays} missed day(s) available for recovery.`
    );

    replace(
        "priorityQuestList",
        summary.priorities.map(renderQuestCard)
    );

    show("priorityEmpty", summary.priorities.length === 0);

    const recent = [...state.activity]
        .reverse()
        .slice(0, 8);

    replace("recentActivityList", recent.map(event => {
        const item = element("li");

        item.append(
            element("span", event.type.replaceAll(".", " · ")),
            element("time", readableDate(event.trackingDate))
        );

        return item;
    }));

    show("recentActivityEmpty", recent.length === 0);

    const weekly = getWeeklyGate();

    replace(
        "weeklyBossCard",
        weekly
            ? [renderRaidCard(weekly)]
            : [element("p", "Weekly gate will appear after initialization.", "empty-message")]
    );
}

/* -------------------- QUEST CARDS -------------------- */

function renderQuestCard(quest) {
    const card = template("questCardTemplate");

    card.dataset.id = quest.id;
    card.dataset.status = quest.completed ? "completed" : "pending";

    card.classList.toggle("is-mandatory", quest.mandatory);
    card.classList.toggle("is-paused", quest.paused);
    card.classList.toggle("is-archived", quest.archived);

    slot(card, "icon", quest.icon);
    slot(card, "title", quest.title);
    slot(card, "description", quest.description);
    slot(card, "cue", quest.cue);

    const badges = [
        badge(`${quest.rank}-Rank`),
        badge(STAT_INFO[quest.stat]?.name || quest.stat),
        badge(quest.frequency),
        badge(quest.timeBlock)
    ];

    if (quest.mandatory) {
        badges.push(badge("Mandatory", "badge-danger"));
    }

    if (quest.completed) {
        badges.push(badge("Completed", "badge-success"));
    }

    slot(card, "badges").replaceChildren(...badges);

    const priority = card.querySelector(
        '[data-action="toggle-priority"]'
    );

    priority.setAttribute(
        "aria-pressed",
        String(quest.priority)
    );

    priority.textContent = quest.priority ? "★" : "☆";

    const checklist = slot(card, "checklist");

    checklist.replaceChildren(
        ...quest.checklist.map(step => {
            const label = element("label");
            const input = element("input");

            input.type = "checkbox";
            input.checked = quest.checklistDone.includes(step.id);
            input.disabled = quest.completed;

            input.dataset.action = "checklist-step";
            input.dataset.stepId = step.id;

            label.append(input, element("span", step.title));

            return label;
        })
    );

    slot(
        card,
        "progressText",
        `${number(quest.progress)} / ${number(quest.target)} ${quest.unit}`
    );

    const progress = slot(card, "progress");

    progress.max = quest.target;
    progress.value = quest.progress;

    slot(
        card,
        "rewards",
        `${quest.rewardPreview.xp} base XP · ` +
        `${quest.rewardPreview.gold} ${quest.rewardPreview.currency}`
    );

    const blocked =
        quest.completed ||
        quest.archived ||
        quest.paused ||
        !quest.scheduled;

    disableAction(
        card,
        "complete-quest",
        blocked,
        quest.completed ? "Completed" : "Complete"
    );

    disableAction(card, "log-progress", blocked);

    const focusButton = card.querySelector(
        '[data-action="start-quest-focus"]'
    );

    focusButton.hidden = quest.type !== "timer";
    focusButton.disabled = blocked;

    const pause = card.querySelector('[data-action="pause-quest"]');
    const archive = card.querySelector('[data-action="archive-quest"]');

    pause.textContent = quest.paused ? "Resume" : "Pause";
    archive.textContent = quest.archived ? "Restore" : "Archive";

    return card;
}

function renderQuests() {
    const quests = selectQuests({
        search: $("questSearch").value,
        status: $("questStatusFilter").value,
        stat: $("questStatFilter").value,
        rank: $("questRankFilter").value,
        sort: $("questSort").value
    });

    replace("questList", quests.map(renderQuestCard));

    setText("questResultsCount", `${quests.length} quests`);
    show("questsEmpty", quests.length === 0);
}

/* -------------------- RAID CARDS -------------------- */

function renderRaidCard(raid) {
    const card = template("raidCardTemplate");

    card.dataset.id = raid.id;
    card.classList.toggle("is-cleared", raid.status === "cleared");
    card.classList.toggle(
        "is-failed",
        ["failed", "escaped"].includes(raid.status)
    );

    slot(card, "rank", `${raid.rank}-Rank`);
    slot(card, "name", raid.name);
    slot(card, "phase", raid.phase.label);
    slot(card, "description", raid.description);

    slot(
        card,
        "deadline",
        raid.deadline
            ? `Deadline: ${readableDate(raid.deadline)}`
            : "No deadline"
    );

    slot(
        card,
        "hpText",
        `${number(raid.currentHp)} / ${number(raid.totalHp)} HP`
    );

    const hp = slot(card, "hp");

    hp.max = raid.totalHp;
    hp.value = raid.currentHp;

    const tasks = raid.tasks.map(task => {
        const row = element("div", "", "raid-task");

        row.classList.toggle("is-completed", task.completed);

        const button = actionButton(
            task.completed ? "Done" : `Attack · ${task.damage}`,
            "attack-raid-task",
            raid.id,
            "button button-secondary"
        );

        button.dataset.taskId = task.id;
        button.disabled = task.completed || !raid.active;

        row.append(element("span", task.title), button);

        return row;
    });

    slot(card, "tasks").replaceChildren(...tasks);

    slot(
        card,
        "rewards",
        `${raid.xpReward} base XP · ${raid.goldReward} Gold · ` +
        `${raid.essenceReward} Essence`
    );

    slot(card, "lore", raid.lore);

    disableAction(card, "edit-raid", !raid.active);

    const rematch = card.querySelector(
        '[data-action="rematch-raid"]'
    );

    rematch.hidden = !["failed", "escaped"].includes(raid.status);

    return card;
}

function renderRaids() {
    const raids = selectRaids({
        status: $("raidStatusFilter").value
    });

    replace("raidList", raids.map(renderRaidCard));
    show("raidsEmpty", raids.length === 0);

    const shadows = getShadowArmy();

    setText("shadowArmyCount", `${shadows.length} shadows`);

    replace("shadowArmyList", shadows.map(shadow => {
        const card = element("article", "", "inventory-card");

        card.append(
            element("span", "♜", "item-icon"),
            element("h3", shadow.name),
            badge(`${shadow.rank}-Rank`)
        );

        return card;
    }));

    show("shadowArmyEmpty", shadows.length === 0);
}

/* -------------------- CHARACTER -------------------- */

function renderCharacter() {
    const state = getState();
    const profile = state.profile;

    setText("characterName", profile.name);

    const title = getEquipmentOptions("title").find(
        option => option.value === profile.title
    );

    setText("characterTitle", title?.name || profile.title);
    setText("characterClass", `Class: ${profile.classId || "Unassigned"}`);

    setText("characterLevel", `Level ${profile.level}`);
    setText("characterPrestige", `Awakening ${profile.prestige}`);
    setText("characterRank", rankForLevel(profile.level));

    setText(
        "characterAvatar",
        profile.avatar === "shadow"
            ? "♜"
            : profile.avatar === "mage"
                ? "✦"
                : profile.avatar === "hunter"
                    ? "⚔"
                    : initials(profile.name)
    );

    $("characterAvatar").dataset.frame = profile.frame;

    const requiredXp = xpForLevel(profile.level);

    setText("characterHpText", `${profile.hp} / ${profile.maxHp}`);
    setText("characterEnergyText", `${profile.energy} / ${profile.maxEnergy}`);
    setText("characterXpText", `${profile.xp} / ${requiredXp}`);

    setMeter("characterHp", profile.hp, profile.maxHp);
    setMeter("characterEnergy", profile.energy, profile.maxEnergy);
    setMeter("characterXp", profile.xp, requiredXp);

    setText("availableStatPoints", profile.statPoints);
    setText("availableSkillPoints", profile.skillPoints);

    replace("statList", Object.entries(profile.stats).map(
        ([key, value]) => {
            const row = element("div", "", "stat-row");

            const identity = element("div", "", "stat-identity");
            const copy = element("div");

            copy.append(
                element("span", STAT_INFO[key].name, "stat-name"),
                element("span", STAT_INFO[key].label, "stat-label")
            );

            identity.append(
                element("span", STAT_INFO[key].icon),
                copy
            );

            const controls = element("div", "", "stat-controls");

            const button = actionButton(
                "+",
                "allocate-stat",
                key,
                "icon-button"
            );

            button.setAttribute(
                "aria-label",
                `Increase ${STAT_INFO[key].name}`
            );

            button.disabled = profile.statPoints <= 0;

            controls.append(
                element("span", number(value), "stat-value"),
                button
            );

            row.append(identity, controls);

            return row;
        }
    ));

    drawBars(
        $("statRadar"),
        Object.entries(profile.stats).map(([label, value]) => ({
            label: label.toUpperCase(),
            value
        }))
    );

    setText(
        "statRadarSummary",
        "Current stat comparison. Radar visualization can replace these bars later."
    );

    replace("skillTree", [
        element(
            "p",
            "Skill unlock rules are not connected yet. Unspent skill points remain preserved.",
            "helper-text"
        )
    ]);
}

function rankForLevel(level) {
    if (level >= 60) return "Monarch";
    if (level >= 50) return "S-Rank";
    if (level >= 40) return "A-Rank";
    if (level >= 30) return "B-Rank";
    if (level >= 20) return "C-Rank";
    if (level >= 10) return "D-Rank";
    if (level >= 5) return "E-Rank";

    return "Novice";
}

/* -------------------- SHOP / INVENTORY -------------------- */

function renderShop() {
    replace("currencyBalances", getCurrencies().map(currency => {
        const card = element("article", "", "wallet-card");

        card.append(
            element("strong", `${currency.symbol} ${number(currency.balance)}`),
            element("span", currency.name)
        );

        return card;
    }));

    const products = selectShopItems({
        category: $("shopTypeFilter").value,
        affordableOnly: $("shopAffordableOnly").checked
    });

    replace("shopList", products.map(product => {
        const card = template("shopCardTemplate");

        card.dataset.id = product.id;

        slot(card, "icon", product.icon);
        slot(card, "category", product.weekly ? "Weekly offer" : product.category);
        slot(card, "name", product.name);
        slot(card, "description", product.description);
        slot(card, "price", `${product.price} ${product.currency}`);

        slot(
            card,
            "availability",
            product.reason || "Available"
        );

        disableAction(
            card,
            "purchase-item",
            !product.available,
            product.owned ? "Owned" : "Buy"
        );

        const custom = product.category === "real-life";

        card.querySelector('[data-action="edit-reward"]').hidden = !custom;
        card.querySelector('[data-action="delete-reward"]').hidden = !custom;

        return card;
    }));

    const history = getPurchaseHistory().slice(0, 30);

    replace("purchaseHistoryList", history.map(purchase => {
        const item = element("li");

        item.textContent =
            `${purchase.product.name} · ` +
            `${purchase.price} ${purchase.currency}`;

        return item;
    }));

    show("purchaseHistoryEmpty", history.length === 0);
}

function renderInventory() {
    const buffs = getActiveBuffs();

    replace("activeBuffList", buffs.map(buff => {
        const card = element("article", "", "buff-card");

        card.append(
            element("strong", buff.name),
            element(
                "time",
                `Expires ${new Date(buff.expiresAt).toLocaleString()}`
            )
        );

        return card;
    }));

    show("activeBuffsEmpty", buffs.length === 0);

    const items = selectInventory({
        category: $("inventoryTypeFilter").value
    });

    replace("inventoryList", items.map(item => {
        const card = template("inventoryCardTemplate");

        card.dataset.id = item.id;
        card.classList.toggle("is-equipped", item.equipped);

        slot(card, "icon", item.icon);
        slot(card, "name", item.name);
        slot(card, "description", item.description);
        slot(card, "quantity", `Owned: ${item.quantity}`);

        const button = card.querySelector('[data-action="use-item"]');

        button.textContent =
            item.category === "real-life"
                ? "Redeem"
                : item.category === "cosmetic"
                    ? item.equipped ? "Unequip" : "Equip"
                    : "Use";

        return card;
    }));

    show("inventoryEmpty", items.length === 0);
}

/* -------------------- FOCUS -------------------- */

export function renderFocusTimer(view = getFocusView()) {
    setText("focusTimer", view.display);

    $("focusTimer").setAttribute(
        "aria-label",
        `${view.display} remaining`
    );

    setText(
        "focusPhase",
        view.status === "idle"
            ? "Ready to focus"
            : `${view.phase} · ${view.status}`
    );

    const root = $("page-focus");

    const start = root.querySelector('[data-action="focus-start"]');
    const pause = root.querySelector('[data-action="focus-pause"]');
    const skip = root.querySelector('[data-action="focus-skip-break"]');

    start.textContent = view.canResume ? "Resume" : "Start";
    start.disabled = !(view.canStart || view.canResume);

    pause.disabled = !view.canPause;
    skip.hidden = !view.canSkipBreak;

    root.querySelector(".focus-panel")
        .classList.toggle("is-break", view.phase === "break");
}

function renderFocus() {
    renderFocusTimer();

    const linkedSelect = $("focusLinkedQuest");

    fillOptions(
        linkedSelect,
        [
            { value: "", name: "No linked quest" },
            ...getLinkableFocusQuests().map(quest => ({
                value: quest.id,
                name: quest.title
            }))
        ],
        linkedSelect.value
    );

    const history = getFocusHistory().slice(0, 30);

    replace("focusHistoryList", history.map(session => {
        const row = element("li");

        row.append(
            element(
                "span",
                `${session.status} · ${session.elapsedMinutes} min · ` +
                readableDate(session.trackingDate)
            )
        );

        if (session.questCredit?.status === "blocked") {
            row.append(
                element(
                    "p",
                    session.questCredit.message,
                    "helper-text"
                ),
                actionButton(
                    "Retry quest credit",
                    "retry-focus-credit",
                    session.id
                )
            );
        }

        return row;
    }));

    show("focusHistoryEmpty", history.length === 0);
}

/* -------------------- JOURNAL -------------------- */

function renderJournal() {
    const entries = selectJournalEntries({
        search: $("journalSearch").value,
        month: $("journalMonth").value
    });

    replace("journalList", entries.map(entry => {
        const card = template("journalCardTemplate");

        card.dataset.id = entry.id;

        const date = slot(card, "date", readableDate(entry.date));
        date.dateTime = entry.date;

        slot(
            card,
            "mood",
            `${entry.moodLabel} · Energy: ${entry.energy ?? "—"}/5`
        );

        const reflections = slot(card, "reflection");

        const fields = [
            ["Sleep", entry.sleep === null ? "" : `${entry.sleep} hours`],
            ["Win", entry.win],
            ["Blocker", entry.blocker],
            ["Gratitude", entry.gratitude],
            ["Next step", entry.nextStep]
        ];

        for (const [label, value] of fields) {
            if (!value) continue;

            const group = element("div");

            group.append(
                element("dt", label),
                element("dd", value)
            );

            reflections.appendChild(group);
        }

        return card;
    }));

    show("journalEmpty", entries.length === 0);
}

/* -------------------- ANALYTICS / SVG CHARTS -------------------- */

function metric(label, value, detail = "") {
    const card = element("article", "", "metric-card");

    card.append(
        element("p", label),
        element("h2", value),
        element("span", detail)
    );

    return card;
}

function svgNode(tag, attributes = {}) {
    const node = document.createElementNS(
        "http://www.w3.org/2000/svg",
        tag
    );

    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, String(value));
    }

    return node;
}

function drawBars(container, values) {
    if (!container) return;

    container.replaceChildren();

    if (!values.length) return;

    const width = 520;
    const rowHeight = 32;
    const height = values.length * rowHeight + 12;

    const max = Math.max(
        1,
        ...values.map(item => Number(item.value) || 0)
    );

    const svg = svgNode("svg", {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": values.map(
            item => `${item.label}: ${item.value}`
        ).join("; ")
    });

    values.forEach((item, index) => {
        const y = index * rowHeight + 8;

        const label = svgNode("text", {
            x: 0,
            y: y + 13,
            class: "chart-axis-label"
        });

        label.textContent = item.label;

        const bar = svgNode("rect", {
            x: 90,
            y,
            width: Math.max(0, (item.value / max) * 340),
            height: 17,
            rx: 4,
            class: "chart-bar"
        });

        const amount = svgNode("text", {
            x: 442,
            y: y + 13,
            class: "chart-axis-label"
        });

        amount.textContent = number(item.value);

        svg.append(label, bar, amount);
    });

    container.appendChild(svg);
}

function renderAnalytics() {
    const selection = $("analyticsRange").value;
    const report = getAnalyticsReport(selection);
    const data = report.metrics;

    replace("analyticsMetrics", [
        metric("Quest completions", data.questCompletions),
        metric("XP earned", number(data.xpEarned)),
        metric("Focus", `${number(data.focusMinutes)} min`),
        metric(
            "Obligation rate",
            data.obligationCompletionRate === null
                ? "—"
                : `${data.obligationCompletionRate}%`,
            `${data.completedObligations}/${data.scheduledObligations} evaluated`
        ),
        metric("Gold earned", number(data.goldEarned)),
        metric("Raids cleared", data.raidsCleared),
        metric("Perfect days", data.perfectDays),
        metric("Best streak", data.lifetimeBestStreak, "Lifetime")
    ]);

    const calendar = getConsistencyCalendar();

    replace("heatmap", calendar.cells.map(cell => {
        const node = element("span", "", "heat-cell");

        if (cell.placeholder) {
            node.classList.add("is-placeholder");
            node.setAttribute("aria-hidden", "true");
            return node;
        }

        node.classList.add(`level-${cell.level}`);

        const statusClasses = {
            rest: "is-rest",
            frozen: "is-frozen",
            shielded: "is-frozen",
            recovered: "is-rest",
            missed: "is-missed"
        };

        if (statusClasses[cell.status]) {
            node.classList.add(statusClasses[cell.status]);
        }

        const label =
            `${cell.date}: ${cell.completed} completion(s), ${cell.status}`;

        node.title = label;
        node.setAttribute("aria-label", label);
        node.setAttribute("role", "img");

        if (cell.isToday) node.setAttribute("aria-current", "date");

        return node;
    }));

    setText(
        "heatmapSummary",
        `${calendar.activeDays} days with recorded quest completions.`
    );

    /*
      Aggregate daily XP into at most 12 chart buckets.
      The full-resolution data remains in CSV.
    */
    const bucketSize = Math.max(
        1,
        Math.ceil(report.daily.length / 12)
    );

    const xpBuckets = [];

    for (let index = 0; index < report.daily.length; index += bucketSize) {
        const rows = report.daily.slice(index, index + bucketSize);

        xpBuckets.push({
            label: rows[0].date.slice(5),
            value: rows.reduce((sum, row) => sum + row.xp, 0)
        });
    }

    drawBars($("xpTrendChart"), xpBuckets);

    setText(
        "xpTrendSummary",
        `${number(data.xpEarned)} XP earned in the selected period.`
    );

    drawBars(
        $("statGrowthChart"),
        report.statGains.map(item => ({
            label: item.stat.toUpperCase(),
            value: item.gain
        }))
    );

    setText(
        "statGrowthHeading",
        "Recorded quest stat gains"
    );

    setText(
        "statGrowthSummary",
        "Includes quest-awarded stat gains, not a full history of manual allocations."
    );

    replace("habitPerformanceBody", report.quests.map(quest => {
        const row = element("tr");

        row.append(
            element("td", quest.title),
            element("td", quest.completed),
            element("td", quest.scheduled),
            element("td", `${quest.completionRate}%`)
        );

        return row;
    }));

    replace(
        "insightList",
        report.insights.map(insight =>
            element("li", insight.message)
        )
    );

    show("insightsEmpty", report.insights.length === 0);
}

/* -------------------- ACHIEVEMENTS STATUS -------------------- */

function renderAchievements() {
    const state = getState();

    setText(
        "achievementCount",
        `${state.achievements.length} recorded`
    );

    replace("achievementList", state.achievements.map(item => {
        const card = element("article", "", "achievement-card");

        card.append(
            element("h3", item.name || item.id),
            element("p", item.description || "")
        );

        return card;
    }));

    if (!state.achievements.length) {
        replace("achievementList", [
            element(
                "p",
                "Achievement unlock and reward rules are not connected yet.",
                "empty-message"
            )
        ]);
    }

    replace("challengeList", state.challenges.map(challenge => {
        const card = element("article", "", "panel");

        card.append(
            element("h3", challenge.name),
            element("p", `${challenge.duration} days · ${challenge.status || "planned"}`)
        );

        return card;
    }));

    show("challengesEmpty", state.challenges.length === 0);

    /*
      Do not let users start challenges that have no evaluator yet.
    */
    const challengeButton = document.querySelector(
        '[data-open-dialog="challengeDialog"]'
    );

    challengeButton.disabled = true;
    challengeButton.title = "Challenge evaluation will be added with progression rules.";
}

/* -------------------- DIALOG PREPARATION -------------------- */

function prepareDialog(id) {
    if (id === "settingsDialog") fillSettings();
    if (id === "profileDialog") fillProfile();
    if (id === "templatesDialog") renderTemplates();
    if (id === "recoveryDialog") renderRecovery();
    if (id === "dayReviewDialog") renderDayReview();

    if (id === "restDialog") {
        $("restDate").value = trackingDate();

        fillOptions(
            $("restQuestId"),
            [
                { value: "all", name: "All scheduled quests" },
                ...getState().quests.map(quest => ({
                    value: quest.id,
                    name: quest.title
                }))
            ],
            "all"
        );
    }

    if (id === "currencyDialog") {
        replace(
            "customCurrencyList",
            getCurrencies().map(currency =>
                element(
                    "p",
                    `${currency.symbol} ${currency.name}: ${number(currency.balance)}`
                )
            )
        );
    }

    if (id === "classDialog") {
        setText(
            "classBonusPreview",
            "Class bonuses are not implemented yet. Choosing a class is disabled until its rules are connected."
        );

        $("classForm").querySelector('[type="submit"]').disabled = true;
    }

    if (id === "prestigeDialog") {
        setText(
            "prestigeEligibility",
            "Re-awakening is not implemented yet. No character data will be reset."
        );
    }
}

function openQuestEditor(id = null) {
    const quest = id
        ? getState().quests.find(item => item.id === id)
        : null;

    if (id && !quest) throw new Error("Quest not found.");

    $("questForm").reset();

    const values = quest || {
        id: "",
        title: "",
        description: "",
        type: "checkbox",
        stat: "dis",
        rank: "E",
        target: 1,
        unit: "",
        frequency: "daily",
        startDate: trackingDate(),
        endDate: "",
        interval: 2,
        timeBlock: "anytime",
        customBlock: "",
        tags: [],
        icon: "☑",
        reminder: "",
        cue: "",
        raidDamage: 25,
        checklist: [],
        mandatory: false,
        priority: false
    };

    const mappings = {
        questId: "id",
        questTitle: "title",
        questDescription: "description",
        questType: "type",
        questStat: "stat",
        questRank: "rank",
        questTarget: "target",
        questUnit: "unit",
        questEffort: "effort",
        questFrequency: "frequency",
        questStartDate: "startDate",
        questEndDate: "endDate",
        questInterval: "interval",
        questTimeBlock: "timeBlock",
        questCustomBlock: "customBlock",
        questIcon: "icon",
        questReminder: "reminder",
        questHabitCue: "cue",
        questRaidDamage: "raidDamage"
    };

    for (const [inputId, key] of Object.entries(mappings)) {
        $(inputId).value = values[key] ?? "";
    }

    $("questTags").value = values.tags.join(", ");

    $("questChecklist").value =
        values.checklist.map(step => step.title).join("\n");

    $("questMandatory").checked = values.mandatory;
    $("questPriority").checked = values.priority;

    $("questForm").querySelectorAll('[name="weekdays"]').forEach(input => {
        input.checked = (values.weekdays || []).includes(Number(input.value));
    });

    fillOptions(
        $("questDependency"),
        [
            { value: "", name: "No prerequisite quest" },
            ...getState().quests
                .filter(item => item.id !== id)
                .map(item => ({ value: item.id, name: item.title }))
        ],
        values.dependency
    );

    fillOptions(
        $("questLinkedRaid"),
        [
            { value: "", name: "No linked raid" },
            ...getState().raids
                .filter(item => item.status === "active")
                .map(item => ({ value: item.id, name: item.name }))
        ],
        values.raidId
    );

    fillCurrencySelect($("questRewardCurrency"), values.currency || "gold");

    setText("questDialogHeading", id ? "Edit quest" : "Create quest");
    show("questFormError", false);

    openDialog("questDialog");
}

function fillCurrencySelect(select, selected = "gold") {
    fillOptions(
        select,
        getCurrencies().map(currency => ({
            value: currency.id,
            name: currency.name
        })),
        selected
    );
}

function addRaidTaskRow(task = {}) {
    const row = template("raidTaskEditorTemplate");

    if (task.id) row.dataset.id = task.id;

    row.querySelector('[name="taskTitle"]').value = task.title || "";
    row.querySelector('[name="taskDamage"]').value = task.damage || 100;

    $("raidTaskEditor").appendChild(row);
}

function openRaidEditor(id = null) {
    const raid = id
        ? getState().raids.find(item => item.id === id)
        : null;

    $("raidForm").reset();

    $("raidId").value = id || "";
    $("raidName").value = raid?.name || "";
    $("raidDescription").value = raid?.description || "";
    $("raidRank").value = raid?.rank || "E";
    $("raidHp").value = raid?.totalHp || 500;
    $("raidDeadline").value = raid?.deadline || "";
    $("raidGoldReward").value = raid?.goldReward ?? 200;
    $("raidXpReward").value = raid?.xpReward ?? 150;
    $("raidEssenceReward").value = raid?.essenceReward ?? 10;
    $("raidFailureMode").value = raid?.failureMode || "none";
    $("raidCounterattacks").checked = raid?.counterattacks || false;

    replace("raidTaskEditor");

    if (raid) {
        raid.tasks.forEach(addRaidTaskRow);
    } else {
        addRaidTaskRow();
    }

    setText("raidDialogHeading", id ? "Edit raid" : "Summon boss raid");

    openDialog("raidDialog");
}

function openRewardEditor(id = null) {
    const reward = id
        ? getState().shop.customRewards.find(item => item.id === id)
        : null;

    $("rewardForm").reset();

    $("rewardId").value = id || "";
    $("rewardName").value = reward?.name || "";
    $("rewardDescription").value = reward?.description || "";
    $("rewardIcon").value = reward?.icon || "🎁";
    $("rewardPrice").value = reward?.price || 100;
    $("rewardCooldown").value = reward?.cooldown || 0;

    fillCurrencySelect($("rewardCurrency"), reward?.currency || "gold");

    openDialog("rewardDialog");
}

function openJournalEditor(id = null) {
    const entry = id
        ? getJournalEntry(id)
        : getJournalEntryForDate();

    $("journalForm").reset();

    const mapping = {
        journalId: "id",
        journalDate: "date",
        journalMood: "mood",
        journalEnergy: "energy",
        journalSleep: "sleep",
        journalWin: "win",
        journalBlocker: "blocker",
        journalGratitude: "gratitude",
        journalNextStep: "nextStep"
    };

    for (const [inputId, key] of Object.entries(mapping)) {
        $(inputId).value = entry?.[key] ?? "";
    }

    $("journalDate").value = entry?.date || trackingDate();

    openDialog("journalDialog");
}

function fillProfile() {
    const profile = getState().profile;

    $("profileName").value = profile.name;

    fillOptions(
        $("profileTitle"),
        getEquipmentOptions("title").map(item => ({
            value: item.value,
            name: item.name
        })),
        profile.title
    );

    fillOptions(
        $("profileFrame"),
        getEquipmentOptions("frame").map(item => ({
            value: item.value,
            name: item.name
        })),
        profile.frame
    );

    fillOptions(
        $("profileAvatar"),
        [
            { value: "initials", name: "Name initials" },
            { value: "hunter", name: "Hunter" },
            { value: "mage", name: "Mage" },
            ...getEquipmentOptions("avatar")
                .filter(item => item.value !== "initials")
                .map(item => ({
                    value: item.value,
                    name: item.name
                }))
        ],
        profile.avatar
    );
}

function fillSettings() {
    const settings = getState().settings;
    const form = $("settingsForm");

    for (const [key, value] of Object.entries(settings)) {
        const input = form.elements.namedItem(key);

        if (!input || !("value" in input)) continue;

        if (input.type === "checkbox") {
            input.checked = value;
        } else {
            input.value = value;
        }
    }

    setText(
        "storageDetails",
        `${new Blob([JSON.stringify(getState())]).size.toLocaleString()} bytes of serialized progress. Backups include journal text.`
    );
}

function renderTemplates() {
    const templates = getQuestTemplates($("templateCategory").value);

    replace("templateList", templates.map(item => {
        const card = element("article", "", "panel");

        card.append(
            element("h3", `${item.icon} ${item.title}`),
            element("p", `${item.rank}-Rank · ${item.category}`, "helper-text"),
            actionButton(
                "Add quest",
                "add-template",
                item.id,
                "button button-secondary"
            )
        );

        return card;
    }));
}

function renderRecovery() {
    const summary = getStreakSummary();

    setText(
        "recoveryDetails",
        `${summary.freezes} freezes · ${summary.shields} shields`
    );

    const options = getRecoveryOptions().map(option => {
        const row = element("article", "", "panel");

        row.append(
            element("p", `Missed day: ${readableDate(option.date)}`),
            actionButton(
                "Start recovery",
                "start-recovery",
                option.date,
                "button button-secondary"
            )
        );

        return row;
    });

    const protection = element("div", "", "button-group");

    protection.append(
        actionButton("Reserve freeze", "reserve-freeze"),
        actionButton("Reserve shield", "reserve-shield"),
        actionButton("Cancel today's protection", "cancel-protection")
    );

    replace("recoveryOptions", [protection, ...options]);

    const recovery = summary.activeRecovery;

    if (!recovery) {
        replace("activeRecoveryQuest");
        return;
    }

    const card = element("section", "", "panel");

    card.append(
        element("h3", `Recover ${readableDate(recovery.targetDate)}`)
    );

    recovery.steps.forEach(step => {
        const label = element("label", "", "checkbox-field");
        const input = element("input");

        input.type = "checkbox";
        input.checked = step.completed;

        input.dataset.action = "recovery-step";
        input.dataset.id = recovery.id;
        input.dataset.stepId = step.id;

        label.append(input, element("span", step.title));
        card.appendChild(label);
    });

    card.append(
        actionButton(
            "Finish recovery",
            "complete-recovery",
            recovery.id,
            "button button-primary"
        ),
        actionButton(
            "Cancel recovery",
            "cancel-recovery",
            recovery.id
        )
    );

    replace("activeRecoveryQuest", [card]);
}

function renderDayReview() {
    const review = getDayReview();

    setText(
        "dayReviewSummary",
        `${review.completed.length}/${review.required.length} due obligations completed.`
    );

    replace(
        "dayReviewIncompleteList",
        review.incompleteMandatory.map(item =>
            element("li", item.title)
        )
    );

    setText(
        "dayReviewOutcome",
        review.evaluated
            ? `Today is already evaluated: ${review.status}.`
            : "Evaluation locks further logging for today. Optional daily HP consequences and enabled raid counterattacks can both apply."
    );

    const button = document.querySelector(
        '[data-action="evaluate-day"]'
    );

    button.disabled = review.evaluated;
}

/* -------------------- POST-ACTION ENGINE SYNC -------------------- */

/*
  This is an explicit action pipeline, not a store subscriber.
  Subscribers only schedule rendering.
*/

export function synchronizeAfterAction() {
    processPendingFocusCredits();

    const result = syncRaidEvents();

    for (const attack of result.attacks) {
        if (attack.cleared) {
            toast("Linked quest cleared a raid.", { type: "success" });
        }
    }

    captureTodaySchedule();

    return result;
}

/* -------------------- FORM HANDLERS -------------------- */

async function handleFormSubmit(event) {
    const form = event.target;

    if (!(form instanceof HTMLFormElement)) return;

    const knownForms = new Set([
        "questForm",
        "progressForm",
        "raidForm",
        "rewardForm",
        "currencyForm",
        "journalForm",
        "profileForm",
        "settingsForm",
        "restForm",
        "onboardingForm",
        "confirmForm"
    ]);

    if (!knownForms.has(form.getAttribute("id"))) return;

    event.preventDefault();

    try {
        if (form.getAttribute("id") === "confirmForm") {
            const expected = $("confirmText").dataset.expected;

            if (expected && $("confirmText").value !== expected) {
                setText("confirmError", `Type ${expected} exactly.`);
                show("confirmError");
                return;
            }

            settleConfirmation(true);
            return;
        }

        const data = formObject(form);

        if (form.getAttribute("id") === "questForm") {
            show("questFormError", false);

            data.weekdays = new FormData(form).getAll("weekdays");
            data.mandatory = $("questMandatory").checked;
            data.priority = $("questPriority").checked;

            const editing = Boolean(data.id);

            let savedId;

            if (editing) {
                editQuest(data.id, data);
                savedId = data.id;
            } else {
                savedId = createQuest(data);
            }

            const savedQuest = getState().quests.find(
                quest => quest.id === savedId
            );

            if (!savedQuest) {
                throw new Error(
                    "The save finished without returning a stored quest."
                );
            }

            try {
                captureTodaySchedule();
            } catch (error) {
                console.error(
                    "[AWAKENED] Quest saved, but schedule refresh failed:",
                    error
                );

                toast(
                    "Quest saved, but today's schedule could not refresh.",
                    { type: "danger" }
                );
            }

            closeDialog($("questDialog"));

            $("questSearch").value = "";
            $("questStatusFilter").value = "all";
            $("questStatFilter").value = "all";
            $("questRankFilter").value = "all";
            $("questSort").value = "manual";

            navigate("quests");
            renderQuests();

            toast(
                `${editing ? "Updated" : "Created"}: ${savedQuest.title}`,
                { type: "success" }
            );
        }

        if (form.getAttribute("id") === "progressForm") {
            const result = logQuestProgress(
                data.questId,
                Number(data.amount),
                { date: data.date, note: data.note }
            );

            closeDialog($("progressDialog"));
            handleQuestResult(result, null);
        }

        if (form.getAttribute("id") === "raidForm") {
            data.counterattacks = $("raidCounterattacks").checked;

            data.tasks = [...$("raidTaskEditor").children].map(row => ({
                id: row.dataset.id || undefined,
                title: row.querySelector('[name="taskTitle"]').value,
                damage: Number(row.querySelector('[name="taskDamage"]').value)
            }));

            if (data.id) editRaid(data.id, data);
            else createRaid(data);

            closeDialog($("raidDialog"));
            toast("Raid saved.", { type: "success" });
        }

        if (form.getAttribute("id") === "rewardForm") {
            if (data.id) editReward(data.id, data);
            else createReward(data);

            closeDialog($("rewardDialog"));
            toast("Reward saved.");
        }

        if (form.getAttribute("id") === "currencyForm") {
            createCurrency(data);
            form.reset();
            prepareDialog("currencyDialog");
            toast("Currency created.");
        }

        if (form.getAttribute("id") === "journalForm") {
            saveJournalEntry(data);
            closeDialog($("journalDialog"));
            toast("Reflection saved.", { type: "success" });
        }

        if (form.getAttribute("id") === "profileForm") {
            const allowedTitles = getEquipmentOptions("title")
                .map(item => item.value);

            const allowedFrames = getEquipmentOptions("frame")
                .map(item => item.value);

            const allowedAvatars = [
                "initials",
                "hunter",
                "mage",
                ...getEquipmentOptions("avatar").map(item => item.value)
            ];

            if (
                !allowedTitles.includes(data.title) ||
                !allowedFrames.includes(data.frame) ||
                !allowedAvatars.includes(data.avatar)
            ) {
                throw new Error("Choose owned profile equipment.");
            }

            updateState("profile:update", draft => {
                draft.profile.name = data.name.trim();
                draft.profile.title = data.title;
                draft.profile.frame = data.frame;
                draft.profile.avatar = data.avatar;

                draft.inventory.equipped.title = data.title;
                draft.inventory.equipped.frame = data.frame;
                draft.inventory.equipped.avatar = data.avatar;
            });

            closeDialog($("profileDialog"));
            toast("Identity updated.");
        }

        if (form.getAttribute("id") === "settingsForm") {
            const changes = {};

            for (const [key, current] of Object.entries(getState().settings)) {
                const input = form.elements.namedItem(key);

                if (!input || !("value" in input)) continue;

                changes[key] =
                    typeof current === "boolean"
                        ? input.checked
                        : typeof current === "number"
                            ? Number(input.value)
                            : input.value;
            }

            /*
              A boundary change needs a migration policy.
              Do not allow an unsafe live change yet.
            */
            if (changes.dayStart !== getState().settings.dayStart) {
                throw new Error(
                    "Changing the tracking-day boundary is not enabled yet; it needs period migration."
                );
            }

            updateState("settings:update", draft => {
                Object.assign(draft.settings, changes);
            });

            closeDialog($("settingsDialog"));
            toast("Settings saved.");
        }

        if (form.getAttribute("id") === "restForm") {
            recordRest(data);
            closeDialog($("restDialog"));
            toast("Rest / skip recorded.");
        }

        if (form.getAttribute("id") === "onboardingForm") {
            const selected = new FormData(form).getAll("starter");

            if (selected.length > 3) {
                throw new Error("Choose no more than three starter habits.");
            }

            /*
              Save the identity first. If a later template save fails,
              onboarding remains open and the error is visible.
            */
            updateState("onboarding:identity", draft => {
                draft.profile.name = data.name.trim();
                draft.profile.mainGoal = data.goal;

                draft.settings.difficulty = data.difficulty;
                draft.settings.inAppReminders =
                    $("onboardingReminders").checked;
            });

            for (const templateId of selected) {
                const source = getQuestTemplates().find(
                    item => item.id === templateId
                );

                const alreadyExists = getState().quests.some(
                    quest => quest.title === source?.title
                );

                if (!alreadyExists) createQuestFromTemplate(templateId);
            }

            updateState("onboarding:complete", draft => {
                draft.meta.onboardingComplete = true;
            });

            captureTodaySchedule();

            closeDialog($("onboardingDialog"));
            toast("System initialized. Your first action is ready.", {
                type: "success"
            });
        }

        scheduleRender();
    } catch (error) {
        console.error(
            `[AWAKENED] Form submission failed: ${form.getAttribute("id")}`,
            error
        );

        const errorIds = {
            questForm: "questFormError",
            progressForm: "progressFormError",
            raidForm: "raidFormError",
            settingsForm: "settingsFormError",
            onboardingForm: "onboardingError"
        };

        const errorId = errorIds[form.getAttribute("id")];

        if (errorId) {
            setText(errorId, error.message);
            show(errorId);
        }

        toast(error.message, { type: "danger" });
    }
}

/* -------------------- QUEST RESULT FEEDBACK -------------------- */

function handleQuestResult(result, card) {
    if (result.completed) {
        playSound("complete");
        haptic("success");
        speakSystem("complete");

        if (card) {
            flashCompletion(card);
            showQuestRewards(card, result.reward);
        }

        toast("Quest completed.", {
            type: "success",

            undo: () => {
                undoLastQuestLog(result.questId);
                synchronizeAfterAction();
            }
        });

        if (result.reward?.levelsGained > 0) {
            celebrateDialog({
                title: "Level up",
                message: `You reached level ${getState().profile.level}.`,

                rewards: [
                    `+${result.reward.statPointsGranted} stat points`
                ]
            });

            playSound("level");
        }
    } else {
        playSound("progress");
        toast("Progress recorded.");
    }

    synchronizeAfterAction();
}

/* -------------------- ACTION HANDLERS -------------------- */

async function handleAction(event) {
    const opener = event.target.closest("[data-open-dialog]");

    if (opener) {
        event.preventDefault();

        try {
            openDialog(opener.dataset.openDialog);
        } catch (error) {
            toast(error.message, { type: "danger" });
        }

        return;
    }

    const closer = event.target.closest("[data-close-dialog]");

    if (closer) {
        closeDialog(closer.closest("dialog"));
        return;
    }

    const routeLink = event.target.closest("a[data-route]");

    if (routeLink) {
        event.preventDefault();
        navigate(routeLink.dataset.route);
        return;
    }

    const button = event.target.closest("[data-action]");

    if (!button || button.disabled) return;

    const action = button.dataset.action;

    if ([
        "checklist-step",
        "recovery-step",
        "toast-undo",
        "dismiss-toast"
    ].includes(action)) {
        return;
    }

    const owner = button.closest("[data-id]");
    const id = button.dataset.id || owner?.dataset.id;

    try {
        /*
          Do not delay the business action while waiting for audio.
        */
        void unlockAudio();

        switch (action) {
            case "new-quest":
                openQuestEditor();
                break;

            case "edit-quest":
                openQuestEditor(id);
                break;

            case "complete-quest": {
                const result = completeQuest(id);
                handleQuestResult(result, button.closest(".quest-card"));
                break;
            }

            case "log-progress":
                $("progressForm").reset();
                $("progressQuestId").value = id;
                $("progressDate").value = trackingDate();

                setText(
                    "progressQuestTitle",
                    getState().quests.find(item => item.id === id)?.title
                );

                show("progressFormError", false);
                openDialog("progressDialog");
                break;

            case "undo-quest":
                undoLastQuestLog(id);
                synchronizeAfterAction();
                toast("Last quest log reversed.");
                break;

            case "toggle-priority": {
                const quest = getState().quests.find(item => item.id === id);
                setQuestPriority(id, !quest.priority);
                break;
            }

            case "pause-quest": {
                const quest = getState().quests.find(item => item.id === id);
                setQuestPaused(id, !quest.paused);
                captureTodaySchedule();
                break;
            }

            case "archive-quest": {
                const quest = getState().quests.find(item => item.id === id);
                setQuestArchived(id, !quest.archived);
                captureTodaySchedule();
                break;
            }

            case "delete-quest":
                if (await confirmAction({
                    title: "Delete quest?",
                    message: "Remove this quest definition? Historical activity remains.",
                    submitLabel: "Delete quest"
                })) {
                    deleteQuest(id);
                    captureTodaySchedule();
                }
                break;

            case "move-quest-up":
                moveQuest(id, "up");
                break;

            case "move-quest-down":
                moveQuest(id, "down");
                break;

            case "skip-quest":
                openDialog("restDialog");
                $("restQuestId").value = id;
                break;

            case "generate-bonus-quest":
                createBonusQuest();
                captureTodaySchedule();
                toast("Side quest created.");
                break;

            case "suggest-rank":
                $("questRank").value = suggestRank($("questEffort").value);
                toast("Rank suggested from estimated effort.");
                break;

            case "add-template":
                createQuestFromTemplate(id);
                captureTodaySchedule();
                toast("Template added.");
                break;

            case "new-raid":
                openRaidEditor();
                break;

            case "edit-raid":
                openRaidEditor(id);
                break;

            case "add-raid-task":
                addRaidTaskRow();
                break;

            case "remove-raid-task":
                button.closest(".raid-task-editor").remove();
                break;

            case "attack-raid-task": {
                const result = attackRaidTask(
                    id,
                    button.dataset.taskId
                );

                const card = button.closest(".raid-card");

                playSound("hit");
                shakeBoss(card);

                showDamage(card, result.damage, {
                    critical: result.critical
                });

                if (result.cleared) {
                    celebrateDialog({
                        title: "Gate cleared",
                        message: "Your effort defeated the boss.",

                        rewards: [
                            `${result.rewards.xp} XP`,
                            `${result.rewards.gold} Gold`,
                            `${result.rewards.essence} Shadow Essence`,
                            "A shadow joined your army."
                        ]
                    });

                    speakSystem("raid");
                }
                break;
            }

            case "delete-raid":
                if (await confirmAction({
                    title: "Delete raid?",
                    message: "Remove this raid? Earned rewards and shadows remain.",
                    submitLabel: "Delete raid"
                })) {
                    deleteRaid(id);
                }
                break;

            case "rematch-raid":
                createRaidRematch(id);
                toast("Rematch created. Edit it to set a new deadline.");
                break;

            case "new-reward":
                openRewardEditor();
                break;

            case "edit-reward":
                openRewardEditor(id);
                break;

            case "delete-reward":
                if (await confirmAction({
                    title: "Delete reward?",
                    message: "Existing purchased vouchers will remain usable.",
                    submitLabel: "Delete reward"
                })) {
                    deleteReward(id);
                }
                break;

            case "purchase-item": {
                const product = selectShopItems().find(
                    item => item.id === id
                );

                if (await confirmAction({
                    title: "Purchase reward?",
                    message: `Buy ${product.name} for ${product.price} ${product.currency}?`,
                    submitLabel: "Buy"
                })) {
                    const result = purchaseItem(id);
                    playSound("purchase");
                    toast(`Purchased: ${result.name}`, { type: "success" });
                }
                break;
            }

            case "use-item": {
                const item = getState().inventory.items.find(
                    entry => entry.id === id
                );

                if (item.category === "cosmetic") {
                    const equipped =
                        getState().inventory.equipped[item.slot] === item.equipValue;

                    if (equipped) unequipSlot(item.slot);
                    else equipItem(id);
                } else if (await confirmAction({
                    title: item.category === "real-life" ? "Redeem reward?" : "Use item?",
                    message: `${item.name}: this consumes one owned item.`,
                    submitLabel: "Confirm"
                })) {
                    if (item.category === "real-life") redeemReward(id);
                    else useConsumable(id);

                    toast("Item used.", { type: "success" });
                }
                break;
            }

            case "allocate-stat":
                updateState("profile:allocate-stat", draft => {
                    if (draft.profile.statPoints <= 0) {
                        throw new Error("No stat points available.");
                    }

                    if (!Object.hasOwn(draft.profile.stats, id)) {
                        throw new Error("Unknown stat.");
                    }

                    draft.profile.stats[id] += 1;
                    draft.profile.statPoints -= 1;
                });
                break;

            case "new-journal-entry":
                openJournalEditor();
                break;

            case "edit-journal-entry":
                openJournalEditor(id);
                break;

            case "delete-journal-entry":
                if (await confirmAction({
                    title: "Delete reflection?",
                    message: "This removes the journal entry from this application.",
                    submitLabel: "Delete entry"
                })) {
                    deleteJournalEntry(id);
                }
                break;

            case "start-quest-focus":
                navigate("focus");
                startFocus({ linkedQuestId: id });
                break;

            case "focus-start": {
                const view = getFocusView();

                if (view.canResume) {
                    resumeFocus();
                } else {
                    saveFocusControls();
                    startFocus({
                        linkedQuestId: $("focusLinkedQuest").value || null
                    });
                }

                if (getState().focus.ambient !== "off") {
                    await startAmbient();
                }
                break;
            }

            case "focus-pause":
                pauseFocus();
                stopAmbient();
                break;

            case "focus-reset":
                if (await confirmAction({
                    title: "Reset timer?",
                    message: "Unfinished focus time is recorded as cancelled and receives no completion credit.",
                    submitLabel: "Reset"
                })) {
                    resetFocus({ confirmed: true });
                    processPendingFocusCredits();
                    stopAmbient();
                }
                break;

            case "focus-skip-break":
                skipBreak();
                stopAmbient();
                break;

            case "retry-focus-credit":
                retryFocusCredit(id);
                synchronizeAfterAction();
                break;

            case "toggle-deep-work": {
                const enabled = document.body.classList.toggle("deep-work");

                button.setAttribute("aria-pressed", String(enabled));
                button.textContent = enabled ? "Exit deep work" : "Deep work view";
                break;
            }

            case "start-recovery":
                startRecovery(id);
                renderRecovery();
                break;

            case "complete-recovery":
                completeRecovery(id);
                renderRecovery();
                toast("Recovery complete. Continuity restored.", {
                    type: "success"
                });
                break;

            case "cancel-recovery":
                cancelRecovery(id);
                renderRecovery();
                break;

            case "reserve-freeze":
                reserveProtection("freeze");
                renderRecovery();
                break;

            case "reserve-shield":
                reserveProtection("shield");
                renderRecovery();
                break;

            case "cancel-protection":
                cancelProtection();
                renderRecovery();
                break;

            case "evaluate-day":
                if (await confirmAction({
                    title: "Finish and lock today?",
                    message: "Further quest logging for this tracking day will be locked.",
                    details: "Enabled daily HP consequences and raid counterattacks may both apply.",
                    submitLabel: "Evaluate"
                })) {
                    reconcileFocus();
                    processPendingFocusCredits();

                    const result = evaluateToday({ confirmed: true });

                    syncRaidEvents();
                    renderDayReview();

                    toast(`Day evaluated: ${result.status}.`);
                }
                break;

            case "toggle-sound":
                updateState("settings:toggle-sound", draft => {
                    draft.settings.sfx = !draft.settings.sfx;
                });
                playSound("progress");
                break;

            case "export-json":
                download(
                    serializeBackup(),
                    `awakened-backup-${trackingDate()}.json`,
                    "application/json"
                );
                break;

            case "export-csv":
                download(
                    "\uFEFF" + createAnalyticsCsv("365"),
                    `awakened-report-${trackingDate()}.csv`,
                    "text/csv;charset=utf-8"
                );
                break;

            case "choose-import":
                $("backupFileInput").click();
                break;

            case "request-reset":
                if (await confirmAction({
                    title: "Delete local progress?",
                    message: "This resets the application. Export a backup first.",
                    typed: "RESET AWAKENED",
                    submitLabel: "Reset local data"
                })) {
                    resetStore("RESET AWAKENED");
                    closeAllDialogs();
                    showOnboarding();
                }
                break;

            case "reload-stored-state":
                reloadFromStorage();
                toast("Latest stored progress loaded.");
                break;

            case "request-notifications":
                await checkNotifications();
                break;

            case "install-app":
                if (pendingInstallPrompt) {
                    await pendingInstallPrompt.prompt();
                    pendingInstallPrompt = null;
                    show("installAppButton", false);
                }
                break;

            default:
                return;
        }

        scheduleRender();
    } catch (error) {
        toast(error.message, { type: "danger" });
    }
}

/* -------------------- CHANGE HANDLERS -------------------- */

function saveFocusControls() {
    configureFocus({
        preset: $("focusPreset").value,
        focusMinutes: $("focusMinutes").value,
        breakMinutes: $("breakMinutes").value,
        ambient: $("focusAmbient").value,
        volume: $("ambientVolume").value,
        autoBreak: $("focusAutoBreak").checked
    });
}

function handleChange(event) {
    const input = event.target;

    try {
        if (input.dataset.action === "checklist-step") {
            const questId = input.closest("[data-id]").dataset.id;

            setChecklistStep(
                questId,
                input.dataset.stepId,
                input.checked
            );
        }

        if (input.dataset.action === "recovery-step") {
            setRecoveryStep(
                input.dataset.id,
                input.dataset.stepId,
                input.checked
            );
        }

        if ([
            "questStatusFilter",
            "questStatFilter",
            "questRankFilter",
            "questSort"
        ].includes(input.id)) {
            renderQuests();
        }

        if (input.id === "raidStatusFilter") renderRaids();

        if ([
            "shopTypeFilter",
            "shopAffordableOnly"
        ].includes(input.id)) {
            renderShop();
        }

        if (input.id === "inventoryTypeFilter") renderInventory();
        if (input.id === "journalMonth") renderJournal();
        if (input.id === "analyticsRange") renderAnalytics();
        if (input.id === "templateCategory") renderTemplates();

        if ([
            "focusPreset",
            "focusMinutes",
            "breakMinutes",
            "focusAmbient",
            "ambientVolume",
            "focusAutoBreak"
        ].includes(input.id)) {
            show(
                "customFocusFields",
                $("focusPreset").value === "custom"
            );

            saveFocusControls();

            if (input.id === "focusAmbient") {
                stopAmbient();
            }
        }
    } catch (error) {
        toast(error.message, { type: "danger" });
    }
}

/* -------------------- FILES / INSTALL / NOTIFICATIONS -------------------- */

function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = element("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFile(event) {
    const file = event.target.files?.[0];

    event.target.value = "";

    if (!file) return;

    try {
        if (file.size > 20000000) {
            throw new Error("Backup is too large for this importer.");
        }

        const content = await file.text();
        const preview = validateBackup(content);

        if (await confirmAction({
            title: "Replace current progress?",
            message:
                `Import ${preview.profile.name}'s backup: ` +
                `${preview.quests.length} quests, ` +
                `${preview.raids.length} raids, ` +
                `${preview.journal.length} journal entries.`,

            details: "Existing local state will be replaced. Export it first if needed.",
            submitLabel: "Import backup"
        })) {
            restoreBackup(content);
            closeAllDialogs();
            toast("Backup imported.", { type: "success" });
        }
    } catch (error) {
        toast(error.message, { type: "danger" });
    }
}

async function checkNotifications() {
    if (!("Notification" in window)) {
        setText(
            "notificationSupportStatus",
            "Browser notifications are unavailable in this environment."
        );
        return;
    }

    const permission = await Notification.requestPermission();

    setText(
        "notificationSupportStatus",
        `Permission: ${permission}. Scheduled and closed-app delivery are not configured yet.`
    );
}

/* -------------------- ONBOARDING -------------------- */

function showOnboarding() {
    $("onboardingForm").reset();

    $("onboardingName").value = getState().profile.name;

    replace(
        "onboardingTemplates",
        getQuestTemplates().map(item => {
            const label = element("label", "", "choice-card");
            const input = element("input");

            input.type = "checkbox";
            input.name = "starter";
            input.value = item.id;

            label.append(
                input,
                element("span", `${item.icon} ${item.title}`)
            );

            return label;
        })
    );

    show("onboardingError", false);
    openDialog("onboardingDialog");
}

/* -------------------- RENDER PIPELINE -------------------- */

function renderCurrentPage() {
    switch (currentRoute) {
        case "dashboard": renderDashboard(); break;
        case "quests": renderQuests(); break;
        case "raids": renderRaids(); break;
        case "character": renderCharacter(); break;
        case "shop": renderShop(); break;
        case "inventory": renderInventory(); break;
        case "focus": renderFocus(); break;
        case "journal": renderJournal(); break;
        case "analytics": renderAnalytics(); break;
        case "achievements": renderAchievements(); break;
    }
}

export function renderApp() {
    applyAppearance();
    renderHeader();
    renderCurrentPage();
}

function scheduleRender() {
    if (renderFrame !== null) return;

    renderFrame = requestAnimationFrame(() => {
        renderFrame = null;
        renderApp();
    });
}

/* -------------------- INITIALIZATION -------------------- */

export function initUI() {
    if (initialized) return destroyUI;

    initialized = true;
    controller = new AbortController();

    const options = { signal: controller.signal };
    $("questForm").addEventListener(
        "invalid",
        event => {
            const input = event.target;

            const label =
                input.labels?.[0]?.textContent?.trim() ||
                input.name ||
                "Quest field";

            setText(
                "questFormError",
                `${label}: ${input.validationMessage}`
            );

            show("questFormError", true);
        },
        {
            capture: true,
            signal: controller.signal
        }
    );

    document.addEventListener("click", handleAction, options);
    document.addEventListener("submit", handleFormSubmit, options);
    document.addEventListener("change", handleChange, options);

    $("backupFileInput").addEventListener("change", importFile, options);

    $("questSearch").addEventListener("input", renderQuests, options);
    $("journalSearch").addEventListener("input", renderJournal, options);

    $("questFilters").addEventListener("reset", () => {
        setTimeout(renderQuests, 0);
    }, options);

    window.addEventListener("hashchange", () => {
        navigate(routeFromHash(), { updateHash: false });
    }, options);

    $("confirmDialog").addEventListener("cancel", event => {
        event.preventDefault();
        settleConfirmation(false);
    }, options);

    $("confirmDialog").addEventListener("close", () => {
        if (confirmationResolver) settleConfirmation(false);
    }, options);

    document.addEventListener("keydown", event => {
        const target = event.target;

        const typing =
            target instanceof Element &&
            (
                target.matches("input, textarea, select") ||
                target.isContentEditable
            );

        if (
            typing ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            document.querySelector("dialog[open]")
        ) {
            return;
        }

        if (event.key.toLowerCase() === "n") {
            event.preventDefault();
            openQuestEditor();
        }

        if (event.key === "/") {
            event.preventDefault();
            navigate("quests");
            $("questSearch").focus();
        }
    }, options);

    window.addEventListener("beforeinstallprompt", event => {
        event.preventDefault();
        pendingInstallPrompt = event;
        show("installAppButton");
    }, options);

    window.addEventListener("appinstalled", () => {
        pendingInstallPrompt = null;
        show("installAppButton", false);

        setText("installStatus", "Application installed.");
    }, options);

    unsubscribeStore = subscribe(scheduleRender);

    unsubscribePersistence = subscribePersistence(status => {
        setText("saveStatus", status.message);

        if (status.mode === "conflict") {
            toast(
                `${status.message} Reload this page before editing.`,
                { type: "danger" }
            );
        }
    }, { immediate: true });

    const focus = getState().focus;

    $("focusPreset").value = focus.preset;
    $("focusMinutes").value = focus.focusMinutes;
    $("breakMinutes").value = focus.breakMinutes;
    $("focusAmbient").value = focus.ambient;
    $("ambientVolume").value = focus.volume;
    $("focusAutoBreak").checked = focus.autoBreak;

    show("customFocusFields", focus.preset === "custom");

    navigate(routeFromHash(), { updateHash: false });
    renderApp();

    if (!getState().meta.onboardingComplete) {
        showOnboarding();
    }

    return destroyUI;
}

export function destroyUI() {
    controller?.abort();
    controller = null;

    unsubscribeStore?.();
    unsubscribePersistence?.();

    unsubscribeStore = null;
    unsubscribePersistence = null;

    if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
    }

    if (confirmationResolver) {
        settleConfirmation(false);
    }

    stopAmbient();

    initialized = false;
}