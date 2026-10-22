/* ==========================================================
   AWAKENED — Application entry point

   Keep domain rules inside modules.
   This file coordinates initialization and lifecycle.
========================================================== */

import {
    initStore,
    getState,
    getPersistenceStatus,
    subscribePersistence,
    getTrackingDate
} from "./modules/state.js";

import {
    reconcileElapsedDays
} from "./modules/streaks.js";

import {
    syncRaidEvents,
    ensureWeeklyGate
} from "./modules/raids.js";

import {
    refreshShopRotation
} from "./modules/shop.js";

import {
    reconcileFocus,
    processPendingFocusCredits,
    startFocusTicker,
    stopFocusTicker
} from "./modules/focus.js";

import {
    initEffects,
    stopAmbient,
    playSound,
    speakSystem
} from "./modules/effects.js";

import {
    initUI,
    renderApp,
    renderFocusTimer,
    toast
} from "./modules/ui.js";

/* -------------------- APPLICATION STATE -------------------- */

let started = false;
let reconciling = false;
let lifecycleController = null;
let unsubscribePersistence = null;

let lastTrackingDate = null;
let knownCompletedSessionIds = new Set();

let storageWarningShown = false;

/* -------------------- HELPERS -------------------- */

function currentTrackingDate() {
    const state = getState();

    return getTrackingDate(
        new Date(),
        state.settings.dayStart
    );
}

function storageIsBlocked() {
    return ["blocked", "conflict"].includes(
        getPersistenceStatus().mode
    );
}

function completedFocusSessions() {
    return getState().focusSessions.filter(
        session => session.status === "completed"
    );
}

function rememberCompletedSessions() {
    knownCompletedSessionIds = new Set(
        completedFocusSessions().map(session => session.id)
    );
}

function reportError(error, context = "Application") {
    console.error(`[AWAKENED: ${context}]`, error);

    toast(
        error?.message || "An unexpected error occurred.",
        { type: "danger" }
    );
}

/* -------------------- ENGINE COORDINATION -------------------- */

/*
  Important ordering:

  1. Finish an elapsed focus session.
  2. Try its pending quest credit.
  3. Evaluate elapsed tracking days.
  4. Apply linked raid effects and expire overdue raids.
  5. Initialize this week's gate and shop rotation.

  These are separate durable transactions, not one
  cross-module database transaction.
*/

function reconcileApplication() {
    if (reconciling || storageIsBlocked()) return false;

    reconciling = true;

    try {
        reconcileFocus();
        processPendingFocusCredits();

        reconcileElapsedDays();
        syncRaidEvents();

        ensureWeeklyGate();
        refreshShopRotation();

        lastTrackingDate = currentTrackingDate();

        return true;
    } finally {
        reconciling = false;
    }
}

/* -------------------- FOCUS COMPLETION FEEDBACK -------------------- */

function announceNewFocusSessions() {
    const sessions = completedFocusSessions();

    const newlyCompleted = sessions.filter(
        session => !knownCompletedSessionIds.has(session.id)
    );

    rememberCompletedSessions();

    if (!newlyCompleted.length) return;

    if (document.visibilityState !== "visible") return;

    const minutes = newlyCompleted.reduce(
        (sum, session) => sum + session.plannedMinutes,
        0
    );

    playSound("focus");
    speakSystem("focus");

    toast(
        newlyCompleted.length === 1
            ? `Focus session complete: ${minutes} minutes.`
            : `${newlyCompleted.length} focus sessions recorded: ${minutes} minutes.`,
        { type: "success" }
    );

    /*
      Completion does not guarantee quest credit:
      the quest may have been completed elsewhere, deleted,
      or locked by an evaluated day.
    */
    for (const session of newlyCompleted) {
        if (session.questCredit?.status === "blocked") {
            toast(
                `Focus time was saved, but quest credit needs attention: ` +
                session.questCredit.message,
                { type: "danger" }
            );
        }
    }

    stopAmbient();
}

/* -------------------- TIMER DISPLAY LOOP -------------------- */

/*
  focus.js reconciles elapsed timers before invoking onTick.

  We only run the larger reconciliation pipeline when:
  - the tracking date changed, or
  - a new completed focus session appeared.

  Normal timer ticks do not save the full state every second.
*/

function handleTimerTick(view) {
    if (storageIsBlocked()) {
        stopFocusTicker();
        return;
    }

    renderFocusTimer(view);

    const dayChanged =
        currentTrackingDate() !== lastTrackingDate;

    const hasNewFocusCompletion = completedFocusSessions().some(
        session => !knownCompletedSessionIds.has(session.id)
    );

    if (!dayChanged && !hasNewFocusCompletion) return;

    try {
        reconcileApplication();

        announceNewFocusSessions();

        /*
          Reconciliation may have changed the phase or quest data.
        */
        renderApp();

        if (dayChanged) {
            toast("A new tracking day has started.");
        }
    } catch (error) {
        reportError(error, "Timer reconciliation");

        /*
          Prevent repeated errors on every subsequent tick.
          Foreground reconciliation can retry later.
        */
        stopFocusTicker();
    }
}

function handleTimerError(error) {
    stopFocusTicker();
    reportError(error, "Focus timer");
}

function startTimerLoop() {
    if (
        document.visibilityState !== "visible" ||
        storageIsBlocked()
    ) {
        return;
    }

    startFocusTicker(
        handleTimerTick,
        handleTimerError
    );
}

/* -------------------- FOREGROUND / BACKGROUND -------------------- */

function returnToForeground() {
    if (
        !started ||
        document.visibilityState !== "visible" ||
        storageIsBlocked()
    ) {
        return;
    }

    stopFocusTicker();

    try {
        reconcileApplication();
        announceNewFocusSessions();

        renderApp();
        startTimerLoop();
    } catch (error) {
        reportError(error, "Foreground reconciliation");
    }
}

function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
        stopFocusTicker();
        stopAmbient();
        return;
    }

    returnToForeground();
}

/* -------------------- STORAGE STATUS -------------------- */

function handlePersistenceStatus(status) {
    if (["blocked", "conflict"].includes(status.mode)) {
        stopFocusTicker();
        stopAmbient();

        if (!storageWarningShown) {
            storageWarningShown = true;

            /*
              ui.js also shows the persistence message.
              This warning explains the lifecycle consequence.
            */
            toast(
                "Background processing is paused. Resolve the storage problem before editing.",
                { type: "danger" }
            );
        }

        return;
    }

    storageWarningShown = false;
}

/* -------------------- STARTUP FAILURE SCREEN -------------------- */

/*
  If saved data cannot be read, do not initialize onboarding
  against an empty replacement state.

  Preserve the stored data and show recovery guidance.
*/

function showStartupFailure(message) {
    const main = document.getElementById("mainContent");

    if (!main) return;

    const panel = document.createElement("section");
    panel.className = "panel";

    const heading = document.createElement("h1");
    heading.textContent = "Your saved progress needs attention.";

    const description = document.createElement("p");
    description.textContent = message;

    const guidance = document.createElement("p");
    guidance.className = "helper-text";

    guidance.textContent =
        "Your stored data has not been overwritten. " +
        "Do not clear browser storage. Export the raw saved data " +
        "before attempting repair.";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "button button-secondary";
    exportButton.textContent = "Export raw stored data";

    exportButton.addEventListener("click", async () => {
        try {
            const { STORAGE_KEY } = await import("./modules/state.js");

            const raw = localStorage.getItem(STORAGE_KEY);

            if (raw === null) {
                guidance.textContent = "No saved value was found under the current storage key.";
                return;
            }

            const blob = new Blob([raw], {
                type: "text/plain;charset=utf-8"
            });

            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");

            link.href = url;
            link.download = "awakened-raw-recovery.txt";

            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            guidance.textContent =
                `The browser could not read the stored value: ${error.message}`;
        }
    });

    panel.append(
        heading,
        description,
        guidance,
        exportButton
    );

    main.replaceChildren(panel);

    document.querySelector(".mobile-nav")?.setAttribute(
        "hidden",
        ""
    );

    document.querySelector(".app-sidebar")?.setAttribute(
        "hidden",
        ""
    );

    /*
      Prevent unrelated controls from suggesting the app is ready.
    */
    document.querySelectorAll(
        ".header-actions button"
    ).forEach(button => {
        button.disabled = true;
    });
}

/* -------------------- LIFECYCLE LISTENERS -------------------- */

function bindLifecycle() {
    lifecycleController = new AbortController();

    const options = {
        signal: lifecycleController.signal
    };

    document.addEventListener(
        "visibilitychange",
        handleVisibilityChange,
        options
    );

    /*
      pagehide/pageshow also cover browser back-forward caching.
      Do not tear down the entire UI on pagehide.
    */
    window.addEventListener("pagehide", () => {
        stopFocusTicker();
        stopAmbient();
    }, options);

    window.addEventListener("pageshow", event => {
        if (event.persisted) {
            returnToForeground();
        }
    }, options);
}

/* -------------------- BOOTSTRAP -------------------- */

function bootstrap() {
    if (started) return;

    const status = initStore();

    if (status.mode === "blocked") {
        showStartupFailure(status.message);
        return;
    }

    /*
      Existing historical sessions should not produce a flood
      of "session complete" notifications on every reload.
    */
    rememberCompletedSessions();

    let startupError = null;

    try {
        reconcileApplication();
    } catch (error) {
        startupError = error;
        console.error("[AWAKENED: startup reconciliation]", error);
    }

    /*
      Still initialize the UI after a recoverable save error,
      so export and diagnostics remain available.
    */
    initEffects();
    initUI();

    started = true;

    bindLifecycle();

    unsubscribePersistence = subscribePersistence(
        handlePersistenceStatus,
        { immediate: true }
    );

    lastTrackingDate = currentTrackingDate();

    announceNewFocusSessions();

    if (startupError) {
        toast(
            `Startup processing could not finish: ${startupError.message}`,
            { type: "danger" }
        );
    } else {
        startTimerLoop();
    }
}

/* -------------------- START -------------------- */

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        bootstrap,
        { once: true }
    );
} else {
    bootstrap();
}