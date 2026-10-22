/* ==========================================================
   AWAKENED — Persistent focus sessions
   Dependencies: state.js and quests.js
========================================================== */

import {
    getState,
    updateState,
    createId,
    clone,
    nowISO,
    getTrackingDate,
    ensureDay,
    appendActivity
} from "./state.js";

import {
    logQuestProgress,
    isQuestScheduled,
    getQuestPeriod
} from "./quests.js";

const MINUTE = 60 * 1000;

const PRESETS = {
    "25-5": {
        focusMinutes: 25,
        breakMinutes: 5
    },

    "50-10": {
        focusMinutes: 50,
        breakMinutes: 10
    }
};

const AMBIENT_OPTIONS = [
    "off",
    "rain",
    "brown-noise",
    "system-hum"
];

let tickerId = null;

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function integer(value, min, max, label) {
    const parsed = Number(value);

    assert(
        Number.isInteger(parsed) &&
        parsed >= min &&
        parsed <= max,
        `${label} must be between ${min} and ${max}.`
    );

    return parsed;
}

function timestampISO(timestamp) {
    return new Date(timestamp).toISOString();
}

function getRemainingMs(session, timestamp = Date.now()) {
    if (!session) return 0;

    if (session.status !== "running") {
        return Math.max(0, session.remainingMs);
    }

    return Math.max(
        0,
        Date.parse(session.deadlineAt) - timestamp
    );
}

function getElapsedMs(session, timestamp = Date.now()) {
    return Math.max(
        0,
        Math.min(
            session.durationMs,
            session.durationMs - getRemainingMs(session, timestamp)
        )
    );
}

function makeSession({
    phase,
    minutes,
    linkedQuestId = null,
    startRunning = true,
    parentSessionId = null,
    breakMinutes,
    autoBreak
}) {
    const startedAt = nowISO();
    const durationMs = minutes * MINUTE;

    return {
        id: createId("focus"),

        phase,
        status: startRunning ? "running" : "ready",

        durationMs,
        remainingMs: durationMs,

        startedAt,
        deadlineAt: startRunning
            ? timestampISO(Date.parse(startedAt) + durationMs)
            : null,

        pausedAt: null,

        linkedQuestId,
        parentSessionId,

        breakMinutes,
        autoBreak
    };
}

/* -------------------- SETTINGS -------------------- */

export function configureFocus(input = {}) {
    return updateState("focus:configure", draft => {
        const current = draft.focus;

        const preset = input.preset ?? current.preset;

        assert(
            preset === "custom" || Object.hasOwn(PRESETS, preset),
            "Unknown focus preset."
        );

        const durations = preset === "custom"
            ? {
                focusMinutes: integer(
                    input.focusMinutes ?? current.focusMinutes,
                    1,
                    240,
                    "Focus duration"
                ),

                breakMinutes: integer(
                    input.breakMinutes ?? current.breakMinutes,
                    1,
                    60,
                    "Break duration"
                )
            }
            : PRESETS[preset];

        const ambient = input.ambient ?? current.ambient;

        assert(
            AMBIENT_OPTIONS.includes(ambient),
            "Unknown ambient sound."
        );

        current.preset = preset;
        current.focusMinutes = durations.focusMinutes;
        current.breakMinutes = durations.breakMinutes;

        current.ambient = ambient;
        current.volume = integer(
            input.volume ?? current.volume,
            0,
            100,
            "Volume"
        );

        if (input.autoBreak !== undefined) {
            current.autoBreak = Boolean(input.autoBreak);
        }

        /*
          Configuration changes apply to the next session.
          The active session retains its own duration snapshot.
        */
        return clone(current);
    });
}

/* -------------------- START / PAUSE / RESUME -------------------- */

export function startFocus({ linkedQuestId = null } = {}) {
    return updateState("focus:start", draft => {
        assert(
            !draft.focus.activeSession,
            "Finish or reset the current timer first."
        );

        if (linkedQuestId) {
            const quest = draft.quests.find(
                item => item.id === linkedQuestId
            );

            assert(quest, "Linked quest not found.");

            assert(
                quest.type === "timer",
                "Only timed quests can receive focus minutes."
            );

            const key = getTrackingDate(
                new Date(),
                draft.settings.dayStart
            );

            assert(
                isQuestScheduled(quest, key),
                "The linked quest is not scheduled today."
            );

            assert(
                !draft.days[key]?.evaluatedAt,
                "Today's tracking day is already evaluated."
            );

            const period = getQuestPeriod(quest, key, draft);

            assert(
                !period?.completedAt,
                "The linked quest is already completed for this period."
            );
        }

        const session = makeSession({
            phase: "focus",
            minutes: draft.focus.focusMinutes,
            linkedQuestId,
            breakMinutes: draft.focus.breakMinutes,
            autoBreak: draft.focus.autoBreak
        });

        draft.focus.activeSession = session;

        appendActivity(draft, {
            type: "focus.started",
            entityId: session.id,

            payload: {
                durationMinutes: session.durationMs / MINUTE,
                linkedQuestId
            }
        });

        return session.id;
    });
}

export function pauseFocus() {
    /*
      Finalize an expired timer before attempting to pause it.
    */
    reconcileFocus();

    updateState("focus:pause", draft => {
        const session = draft.focus.activeSession;

        assert(session, "No timer is active.");

        assert(
            session.status === "running",
            "This timer is not running."
        );

        session.remainingMs = getRemainingMs(session);
        session.status = "paused";
        session.pausedAt = nowISO();
        session.deadlineAt = null;
    });
}

export function resumeFocus() {
    updateState("focus:resume", draft => {
        const session = draft.focus.activeSession;

        assert(session, "No timer is active.");

        assert(
            ["paused", "ready"].includes(session.status),
            "This timer cannot be resumed."
        );

        session.deadlineAt = timestampISO(
            Date.now() + session.remainingMs
        );

        session.status = "running";
        session.pausedAt = null;
    });
}

/* -------------------- SESSION HISTORY -------------------- */

function createHistoryRecord(
    session,
    {
        status,
        finishedAt,
        elapsedMs,
        trackingDate
    }
) {
    return {
        id: session.id,

        status,
        phase: session.phase,

        startedAt: session.startedAt,
        finishedAt,
        trackingDate,

        plannedMinutes: session.durationMs / MINUTE,
        elapsedMinutes: Math.round(elapsedMs / 600) / 100,

        linkedQuestId: session.linkedQuestId,

        questCredit: {
            status:
                status === "completed" && session.linkedQuestId
                    ? "pending"
                    : "not-applicable",

            sourceId: `focus-credit:${session.id}`,

            eventId: null,
            message: null
        }
    };
}

/* -------------------- COMPLETE / RECONCILE -------------------- */

/*
  Call at startup, on visibility changes, and from the ticker.

  Only one phase is finalized at a time.
  Refreshing after several hours does not fabricate a chain
  of focus sessions or automatically finished breaks.
*/

export function reconcileFocus() {
    const state = getState();
    const session = state.focus.activeSession;

    if (
        !session ||
        session.status !== "running" ||
        getRemainingMs(session) > 0
    ) {
        return null;
    }

    return updateState("focus:phase-complete", draft => {
        const active = draft.focus.activeSession;

        if (
            !active ||
            active.status !== "running" ||
            getRemainingMs(active) > 0
        ) {
            return null;
        }

        if (active.phase === "break") {
            draft.focus.activeSession = null;

            appendActivity(draft, {
                type: "focus.break-completed",
                entityId: active.id,

                payload: {
                    parentSessionId: active.parentSessionId
                }
            });

            return { phase: "break", completed: true };
        }

        /*
          Use the scheduled finish time for the activity date.
          A late refresh should not move yesterday's session
          into today's totals.
        */
        const finishedAt = active.deadlineAt;

        const trackingDate = getTrackingDate(
            new Date(finishedAt),
            draft.settings.dayStart
        );

        const existing = draft.focusSessions.find(
            item => item.id === active.id
        );

        assert(!existing, "This session has already been recorded.");

        const record = createHistoryRecord(active, {
            status: "completed",
            finishedAt,
            elapsedMs: active.durationMs,
            trackingDate
        });

        draft.focusSessions.push(record);

        const minutes = active.durationMs / MINUTE;

        draft.totals.focusMinutes += minutes;

        const day = ensureDay(draft, trackingDate);
        day.focusMinutes += minutes;

        appendActivity(draft, {
            type: "focus.completed",
            entityId: active.id,
            trackingDate,

            payload: {
                minutes,
                linkedQuestId: active.linkedQuestId,
                scheduledFinishAt: finishedAt
            }
        });

        /*
          A break starts when completion is processed.
          We do not backdate its start and silently finish it.
        */
        draft.focus.activeSession = makeSession({
            phase: "break",
            minutes: active.breakMinutes,

            startRunning: active.autoBreak,
            parentSessionId: active.id,

            breakMinutes: active.breakMinutes,
            autoBreak: false
        });

        return {
            phase: "focus",
            completed: true,
            sessionId: record.id,
            minutes,
            linkedQuestId: record.linkedQuestId
        };
    });
}

/* -------------------- LINKED QUEST CREDIT -------------------- */

/*
  Quest credit is a separate recoverable operation.

  The sourceId added to quests.js makes retrying idempotent.
  Session completion remains saved even if the quest was
  deleted, evaluated, completed elsewhere, or out of backfill range.
*/

export function processPendingFocusCredits() {
    const pendingIds = getState().focusSessions
        .filter(record =>
            record.status === "completed" &&
            record.questCredit?.status === "pending"
        )
        .map(record => record.id);

    const results = [];

    for (const sessionId of pendingIds) {
        const record = getState().focusSessions.find(
            item => item.id === sessionId
        );

        try {
            const result = logQuestProgress(
                record.linkedQuestId,
                record.plannedMinutes,
                {
                    date: record.trackingDate,
                    note: "Completed focus session",
                    sourceId: record.questCredit.sourceId
                }
            );

            updateState("focus:quest-credit-recorded", draft => {
                const saved = draft.focusSessions.find(
                    item => item.id === sessionId
                );

                saved.questCredit.status = "applied";
                saved.questCredit.eventId = result.eventId;
                saved.questCredit.message = null;
            });

            results.push({
                sessionId,
                applied: true,
                eventId: result.eventId
            });
        } catch (error) {
            /*
              If storage is unavailable/conflicted, leave the credit
              pending rather than attempting another failed write.
            */
            try {
                updateState("focus:quest-credit-blocked", draft => {
                    const saved = draft.focusSessions.find(
                        item => item.id === sessionId
                    );

                    saved.questCredit.status = "blocked";
                    saved.questCredit.message = String(
                        error.message || "Quest credit could not be applied."
                    ).slice(0, 300);
                });
            } catch {
                // The durable pending record remains available to retry.
            }

            results.push({
                sessionId,
                applied: false,
                message: error.message
            });
        }
    }

    return results;
}

export function retryFocusCredit(sessionId) {
    updateState("focus:retry-quest-credit", draft => {
        const record = draft.focusSessions.find(
            item => item.id === sessionId
        );

        assert(record, "Focus session not found.");

        assert(
            record.questCredit?.status === "blocked",
            "This session has no blocked quest credit."
        );

        record.questCredit.status = "pending";
        record.questCredit.message = null;
    });

    return processPendingFocusCredits();
}

/* -------------------- RESET / SKIP BREAK -------------------- */

export function resetFocus({ confirmed = false } = {}) {
    const current = getState().focus.activeSession;

    if (!current) return;

    /*
      Process completed work before resetting.
    */
    reconcileFocus();

    const active = getState().focus.activeSession;

    if (!active) return;

    if (
        active.phase === "focus" &&
        getElapsedMs(active) > 0
    ) {
        assert(
            confirmed,
            "Confirm cancellation of the unfinished focus session."
        );
    }

    updateState("focus:reset", draft => {
        const session = draft.focus.activeSession;

        if (!session) return;

        if (session.phase === "focus") {
            const finishedAt = nowISO();

            const trackingDate = getTrackingDate(
                new Date(finishedAt),
                draft.settings.dayStart
            );

            const record = createHistoryRecord(session, {
                status: "cancelled",
                finishedAt,
                elapsedMs: getElapsedMs(session),
                trackingDate
            });

            draft.focusSessions.push(record);

            appendActivity(draft, {
                type: "focus.cancelled",
                entityId: session.id,
                trackingDate,

                payload: {
                    elapsedMinutes: record.elapsedMinutes,
                    plannedMinutes: record.plannedMinutes
                }
            });
        }

        /*
          Cancelled minutes are visible in history but do not
          receive completion credit or increase focus totals.
        */
        draft.focus.activeSession = null;
    });
}

export function skipBreak() {
    updateState("focus:skip-break", draft => {
        const session = draft.focus.activeSession;

        assert(
            session?.phase === "break",
            "No break is active."
        );

        draft.focus.activeSession = null;

        appendActivity(draft, {
            type: "focus.break-skipped",
            entityId: session.id,

            payload: {
                parentSessionId: session.parentSessionId
            }
        });
    });
}

/* -------------------- DISPLAY SELECTORS -------------------- */

export function getFocusView(timestamp = Date.now()) {
    const state = getState();
    const session = state.focus.activeSession;

    const remainingMs = session
        ? getRemainingMs(session, timestamp)
        : state.focus.focusMinutes * MINUTE;

    const seconds = Math.ceil(remainingMs / 1000);
    const minutesPart = Math.floor(seconds / 60);
    const secondsPart = seconds % 60;

    return {
        session: session ? clone(session) : null,

        phase: session?.phase || "focus",
        status: session?.status || "idle",

        remainingMs,

        display: [
            String(minutesPart).padStart(2, "0"),
            String(secondsPart).padStart(2, "0")
        ].join(":"),

        canStart: !session,
        canPause: session?.status === "running",

        canResume:
            session?.status === "paused" ||
            session?.status === "ready",

        canSkipBreak: session?.phase === "break",

        settings: {
            preset: state.focus.preset,
            focusMinutes: state.focus.focusMinutes,
            breakMinutes: state.focus.breakMinutes,

            ambient: state.focus.ambient,
            volume: state.focus.volume,
            autoBreak: state.focus.autoBreak
        }
    };
}

export function getFocusHistory() {
    return clone(getState().focusSessions)
        .sort((a, b) =>
            b.finishedAt.localeCompare(a.finishedAt)
        );
}

export function getFocusSummary(
    date = getTrackingDate()
) {
    const records = getState().focusSessions.filter(
        record =>
            record.status === "completed" &&
            record.trackingDate === date
    );

    return {
        date,
        sessions: records.length,

        minutes: records.reduce(
            (sum, record) => sum + record.plannedMinutes,
            0
        )
    };
}

export function getLinkableFocusQuests() {
    const state = getState();

    const key = getTrackingDate(
        new Date(),
        state.settings.dayStart
    );

    return state.quests
        .filter(quest =>
            quest.type === "timer" &&
            isQuestScheduled(quest, key) &&
            !getQuestPeriod(quest, key, state)?.completedAt
        )
        .map(quest => ({
            id: quest.id,
            title: quest.title
        }));
}

/* -------------------- OPTIONAL UI TICKER -------------------- */

/*
  This timer only drives display refresh and phase reconciliation.
  It does not save state every second.

  Final script.js will start it once and pass a UI callback.
*/

export function startFocusTicker(onTick, onError = console.error) {
    assert(
        typeof onTick === "function",
        "A timer-render callback is required."
    );

    stopFocusTicker();

    const tick = () => {
        try {
            reconcileFocus();
            onTick(getFocusView());
        } catch (error) {
            onError(error);
        }
    };

    tick();

    tickerId = setInterval(tick, 1000);

    return stopFocusTicker;
}

export function stopFocusTicker() {
    if (tickerId !== null) {
        clearInterval(tickerId);
        tickerId = null;
    }
}