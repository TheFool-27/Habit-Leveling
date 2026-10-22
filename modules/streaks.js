/* ==========================================================
   AWAKENED — Daily evaluation and streak protection
   Dependencies: state.js and quests.js
========================================================== */

import {
    getState,
    updateState,
    clone,
    nowISO,
    createId,
    isDateKey,
    parseDateKey,
    shiftDateKey,
    dayDifference,
    getTrackingDate,
    getPeriodKey,
    ensureDay,
    appendActivity
} from "./state.js";

import {
    isQuestScheduled,
    getQuestPeriod
} from "./quests.js";

const PROTECTED_STATUSES = new Set([
    "rest",
    "frozen",
    "shielded",
    "recovered"
]);

const REST_REASONS = new Set([
    "planned-rest",
    "illness",
    "travel",
    "exam",
    "forgot",
    "other"
]);

const RECOVERY_WINDOW_DAYS = 7;

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function today(state = getState()) {
    return getTrackingDate(new Date(), state.settings.dayStart);
}

function firstTrackingDate(state) {
    return getTrackingDate(
        new Date(state.meta.createdAt),
        state.settings.dayStart
    );
}

function sortedDayKeys(state) {
    return Object.keys(state.days).sort();
}

function assertOpenDay(day) {
    assert(
        !day.evaluatedAt,
        "This day has already been evaluated."
    );
}

function assertEditableDate(state, key) {
    assert(isDateKey(key), "Choose a valid date.");

    const age = dayDifference(key, today(state));

    assert(age >= 0, "That activity date is in the future.");

    assert(
        age <= state.settings.backfillDays,
        "That date is outside your backfill allowance."
    );
}

/* -------------------- PERIOD DEADLINES -------------------- */

function isPeriodDeadline(quest, key) {
    /*
      An explicitly configured end date also closes
      a weekly or monthly obligation.
    */
    if (quest.endDate === key) return true;

    const date = parseDateKey(key);

    if (quest.frequency === "weekly") {
        return date.getDay() === 0;
    }

    if (quest.frequency === "monthly") {
        return shiftDateKey(key, 1).slice(0, 7) !== key.slice(0, 7);
    }

    return true;
}

function isEvaluationObligation(quest, key, state) {
    if (!isQuestScheduled(quest, key)) return false;

    if (["weekly", "monthly"].includes(quest.frequency)) {
        return isPeriodDeadline(quest, key);
    }

    if (quest.frequency === "once") {
        const period = getQuestPeriod(quest, key, state);

        /*
          A completed one-time goal does not become due again.
          An incomplete one-time goal is evaluated on its deadline,
          or on its start date when no deadline was specified.
        */
        if (period?.completedAt) {
            return period.completedDate === key;
        }

        return key === (quest.endDate || quest.startDate);
    }

    return true;
}

/* -------------------- DAY SNAPSHOTS -------------------- */

/*
  Take a schedule snapshot while the day is open.
  ui.js should refresh today's snapshot after quest edits.

  Evaluated snapshots are immutable.
  Historical schedules cannot be reconstructed perfectly from
  current definitions if the app was not opened for those days.
*/

function snapshotDay(draft, key) {
    const day = ensureDay(draft, key);

    if (day.evaluatedAt) return day;

    const obligations = draft.quests.filter(quest =>
        isEvaluationObligation(quest, key, draft)
    );

    day.obligations = obligations.map(quest => ({
        questId: quest.id,
        title: quest.title,
        mandatory: quest.mandatory,
        periodKey: getPeriodKey(quest.frequency, key)
    }));

    day.scheduledQuestIds = obligations.map(quest => quest.id);

    day.scheduleSnapshotAt = nowISO();

    return day;
}

export function captureTodaySchedule() {
    updateState("streak:snapshot-today", draft => {
        snapshotDay(draft, today(draft));
    });
}

function getObligationStatus(state, day) {
    const obligations = day.obligations || [];

    return obligations.map(item => {
        const period =
            state.questPeriods[item.questId]?.[item.periodKey];

        return {
            ...clone(item),
            completed: Boolean(period?.completedAt),
            skipped: Boolean(day.skips?.[item.questId]?.protected),
            skip: clone(day.skips?.[item.questId] || null)
        };
    });
}

/* -------------------- QUALIFICATION -------------------- */

function qualification(state, day) {
    const obligations = getObligationStatus(state, day);

    const required = obligations.filter(item => !item.skipped);

    const mandatory = required.filter(item => item.mandatory);
    const completed = required.filter(item => item.completed);

    const incompleteMandatory = mandatory.filter(
        item => !item.completed
    );

    const allCompleted =
        required.length > 0 &&
        completed.length === required.length;

    let qualifies = false;

    if (required.length) {
        qualifies = mandatory.length
            ? incompleteMandatory.length === 0
            : completed.length > 0;
    }

    return {
        obligations,
        required,
        completed,
        incompleteMandatory,

        qualifies,
        perfect: qualifies && allCompleted,

        /*
          No due obligations is a neutral day.
          It does not increase or break the streak.
        */
        neutral: required.length === 0
    };
}

/* -------------------- STREAK REBUILD -------------------- */

function rebuildStreaks(draft) {
    let current = 0;
    let best = 0;
    let lastQualifiedDate = null;
    let lastProcessedDate = null;

    for (const key of sortedDayKeys(draft)) {
        const day = draft.days[key];

        if (!day.evaluatedAt) continue;

        lastProcessedDate = key;

        if (day.status === "complete") {
            current += 1;
            best = Math.max(best, current);
            lastQualifiedDate = key;
            continue;
        }

        if (
            day.status === "neutral" ||
            PROTECTED_STATUSES.has(day.status)
        ) {
            continue;
        }

        if (day.status === "missed") {
            current = 0;
        }
    }

    draft.streaks.current = current;

    /*
      Preserve the historical best even if a later correction
      changes the currently reconstructed streak.
    */
    draft.streaks.best = Math.max(draft.streaks.best, best);

    draft.streaks.lastQualifiedDate = lastQualifiedDate;
    draft.streaks.lastProcessedDate = lastProcessedDate;

    draft.streaks.protectedDates = sortedDayKeys(draft).filter(
        key => PROTECTED_STATUSES.has(draft.days[key].status)
    );
}

/* -------------------- EVALUATION -------------------- */

function evaluateInDraft(draft, key) {
    const existing = ensureDay(draft, key);

    if (existing.evaluatedAt) {
        return clone(existing);
    }

    /*
      Preserve an existing captured schedule.
      If none exists, use current definitions as a fallback.
    */
    if (!Array.isArray(existing.obligations)) {
        snapshotDay(draft, key);
        existing.scheduleReconstructed = true;
    }

    const day = draft.days[key];
    const result = qualification(draft, day);

    let status;

    if (day.rest?.protected) {
        status = "rest";
    } else if (result.neutral) {
        status = "neutral";
    } else if (result.qualifies) {
        status = "complete";
    } else if (day.protection?.type === "shield") {
        status = "shielded";
    } else if (day.protection?.type === "freeze") {
        status = "frozen";
    } else if (
        draft.settings.autoFreeze &&
        draft.streaks.freezes > 0
    ) {
        draft.streaks.freezes -= 1;

        day.protection = {
            type: "freeze",
            source: "automatic",
            appliedAt: nowISO()
        };

        status = "frozen";
    } else {
        status = "missed";
    }

    day.status = status;
    day.evaluatedAt = nowISO();

    day.completedQuestIds = result.completed.map(
        item => item.questId
    );

    day.evaluation = {
        scheduled: result.required.length,
        completed: result.completed.length,

        incompleteMandatoryIds: result.incompleteMandatory.map(
            item => item.questId
        ),

        perfect: status === "complete" && result.perfect
    };

    /*
      Perfect-day reward bonuses are not awarded here yet.
      A later progression layer can claim them once.
    */
    if (
        day.evaluation.perfect &&
        !day.perfectDayClaimed
    ) {
        draft.totals.perfectDays += 1;
        day.perfectDayClaimed = true;
    }

    appendActivity(draft, {
        type: "day.evaluated",
        trackingDate: key,
        payload: {
            status,
            scheduled: result.required.length,
            completed: result.completed.length,
            perfect: day.evaluation.perfect
        }
    });

    if (status === "missed" && draft.settings.penalties) {
        const damage = Math.min(10, draft.profile.hp);

        draft.profile.hp -= damage;

        day.evaluation.hpDamage = damage;

        appendActivity(draft, {
            type: "day.hp-consequence",
            trackingDate: key,
            payload: { damage }
        });
    }

    return clone(day);
}

/*
  Close elapsed tracking days up to, but not including, today.

  This should run at startup and when the app returns to the
  foreground. It intentionally does not finalize the current day.
*/

function reconcileInDraft(draft, throughDate) {
    const first = firstTrackingDate(draft);

    let key = first;
    let processed = 0;

    while (key < throughDate) {
        evaluateInDraft(draft, key);
        key = shiftDateKey(key, 1);
        processed += 1;

        assert(
            processed <= 36500,
            "Tracking history is too large to reconcile safely."
        );
    }

    rebuildStreaks(draft);
}

export function reconcileElapsedDays() {
    return updateState("streak:reconcile", draft => {
        const key = today(draft);

        reconcileInDraft(draft, key);
        snapshotDay(draft, key);

        return {
            current: draft.streaks.current,
            best: draft.streaks.best
        };
    });
}

/*
  Closing the current day requires explicit user confirmation.
  The UI must explain that further progress logging is locked.
*/

export function evaluateToday({ confirmed = false } = {}) {
    assert(
        confirmed,
        "Confirm that you want to finish and lock today's evaluation."
    );

    return updateState("streak:evaluate-today", draft => {
        const key = today(draft);

        reconcileInDraft(draft, key);

        /*
          Refresh the current snapshot before final evaluation.
        */
        snapshotDay(draft, key);

        const result = evaluateInDraft(draft, key);

        rebuildStreaks(draft);

        return result;
    });
}

export function getDayReview(key = today()) {
    const state = getState();

    assert(isDateKey(key), "Invalid review date.");

    /*
      Work on a copy: opening a review is not a state mutation.
    */
    const preview = clone(state);

    if (!preview.days[key]?.evaluatedAt) {
        snapshotDay(preview, key);
    }

    const day = ensureDay(preview, key);
    const result = qualification(preview, day);

    return {
        date: key,
        evaluated: Boolean(day.evaluatedAt),
        status: day.status,

        ...result,

        protection: clone(day.protection || null),
        rest: clone(day.rest || null),

        autoFreezeAvailable:
            preview.settings.autoFreeze &&
            preview.streaks.freezes > 0
    };
}

/* -------------------- REST / SKIPS -------------------- */

export function recordRest({
    date = today(),
    questId = "all",
    reason = "planned-rest",
    note = ""
} = {}) {
    assert(REST_REASONS.has(reason), "Unknown rest reason.");

    return updateState("streak:record-rest", draft => {
        assert(isDateKey(date), "Invalid rest date.");

        const current = today(draft);
        const age = dayDifference(date, current);

        /*
          Rest can be planned up to 30 calendar days ahead.
          Past edits remain limited by the backfill allowance.
        */
        assert(age >= -30, "Plan rest no more than 30 days ahead.");

        if (age >= 0) {
            assertEditableDate(draft, date);
        }

        const day = ensureDay(draft, date);
        assertOpenDay(day);

        const details = {
            reason,
            note: String(note).trim().slice(0, 1000),
            recordedAt: nowISO()
        };

        /*
          Planned rest, illness, and travel can protect a day.
          Other reasons are recorded without automatic protection.
        */
        const protects = [
            "planned-rest",
            "illness",
            "travel"
        ].includes(reason);

        if (questId === "all") {
            day.rest = {
                ...details,
                protected: protects
            };
        } else {
            assert(
                draft.quests.some(quest => quest.id === questId),
                "Quest not found."
            );

            if (!day.skips) day.skips = {};

            day.skips[questId] = {
                ...details,
                protected: protects
            };

            /*
              Only protected skips remove an obligation.
              Non-protected reasons remain an incomplete obligation.
            */
            if (!protects) {
                day.skips[questId].reasonOnly = true;
            }
        }

        appendActivity(draft, {
            type: "day.rest-recorded",
            entityId: questId === "all" ? null : questId,
            trackingDate: date,
            payload: {
                ...details,
                scope: questId,
                protected: protects
            }
        });

        return clone(details);
    });
}

export function clearRest(date = today(), questId = "all") {
    updateState("streak:clear-rest", draft => {
        assertEditableDate(draft, date);

        const day = ensureDay(draft, date);
        assertOpenDay(day);

        if (questId === "all") {
            day.rest = null;
        } else if (day.skips) {
            delete day.skips[questId];
        }
    });
}

/* -------------------- MANUAL PROTECTION -------------------- */

export function reserveProtection(
    type,
    date = today()
) {
    assert(
        type === "freeze" || type === "shield",
        "Choose a freeze or shield."
    );

    updateState("streak:reserve-protection", draft => {
        assertEditableDate(draft, date);

        const day = ensureDay(draft, date);
        assertOpenDay(day);

        assert(!day.protection, "This day already has protection.");

        const resource = type === "freeze" ? "freezes" : "shields";

        assert(
            draft.streaks[resource] > 0,
            `No ${type} is available.`
        );

        draft.streaks[resource] -= 1;

        day.protection = {
            type,
            source: "manual",
            appliedAt: nowISO()
        };

        appendActivity(draft, {
            type: "day.protection-reserved",
            trackingDate: date,
            payload: { type }
        });
    });
}

export function cancelProtection(date = today()) {
    updateState("streak:cancel-protection", draft => {
        assertEditableDate(draft, date);

        const day = ensureDay(draft, date);
        assertOpenDay(day);

        assert(day.protection, "No protection is reserved.");

        const resource =
            day.protection.type === "freeze"
                ? "freezes"
                : "shields";

        draft.streaks[resource] += 1;
        day.protection = null;
    });
}

/* -------------------- RECOVERY QUESTS -------------------- */

export function getRecoveryOptions() {
    const state = getState();
    const current = today(state);

    return sortedDayKeys(state)
        .filter(key => {
            const age = dayDifference(key, current);

            return (
                state.days[key].status === "missed" &&
                age >= 0 &&
                age <= RECOVERY_WINDOW_DAYS
            );
        })
        .map(key => ({
            date: key,
            daysAgo: dayDifference(key, current),

            activeRecovery: clone(
                state.streaks.recoveries.find(recovery =>
                    recovery.targetDate === key &&
                    recovery.status === "active"
                ) || null
            )
        }));
}

export function startRecovery(targetDate) {
    return updateState("streak:recovery-start", draft => {
        assert(isDateKey(targetDate), "Invalid recovery date.");

        const age = dayDifference(targetDate, today(draft));

        assert(
            age >= 0 && age <= RECOVERY_WINDOW_DAYS,
            "That missed day is outside the recovery window."
        );

        assert(
            draft.days[targetDate]?.status === "missed",
            "Only a missed day can be recovered."
        );

        assert(
            !draft.streaks.recoveries.some(item =>
                item.status === "active"
            ),
            "Finish or cancel your active recovery first."
        );

        const recovery = {
            id: createId("recovery"),
            targetDate,
            status: "active",
            createdAt: nowISO(),
            completedAt: null,

            steps: [
                {
                    id: "reflect",
                    title: "Write one sentence about what got in the way.",
                    completed: false
                },
                {
                    id: "restart",
                    title: "Choose and complete one small useful action.",
                    completed: false
                },
                {
                    id: "plan",
                    title: "Choose your next scheduled action.",
                    completed: false
                }
            ]
        };

        draft.streaks.recoveries.push(recovery);

        appendActivity(draft, {
            type: "recovery.started",
            entityId: recovery.id,
            payload: { targetDate }
        });

        return recovery.id;
    });
}

export function setRecoveryStep(recoveryId, stepId, completed) {
    updateState("streak:recovery-step", draft => {
        const recovery = draft.streaks.recoveries.find(
            item => item.id === recoveryId
        );

        assert(recovery?.status === "active", "No active recovery found.");

        const step = recovery.steps.find(item => item.id === stepId);

        assert(step, "Recovery step not found.");

        step.completed = Boolean(completed);
    });
}

export function completeRecovery(recoveryId) {
    return updateState("streak:recovery-complete", draft => {
        const recovery = draft.streaks.recoveries.find(
            item => item.id === recoveryId
        );

        assert(recovery?.status === "active", "No active recovery found.");

        assert(
            recovery.steps.every(step => step.completed),
            "Complete the recovery steps first."
        );

        const age = dayDifference(recovery.targetDate, today(draft));

        assert(
            age <= RECOVERY_WINDOW_DAYS,
            "This recovery has expired."
        );

        const day = draft.days[recovery.targetDate];

        assert(day?.status === "missed", "This day no longer needs recovery.");

        recovery.status = "completed";
        recovery.completedAt = nowISO();

        day.status = "recovered";
        day.recoveryId = recovery.id;

        /*
          Do not change the original completion counts,
          earned XP, or perfect-day result.
        */
        rebuildStreaks(draft);

        appendActivity(draft, {
            type: "recovery.completed",
            entityId: recovery.id,
            payload: {
                targetDate: recovery.targetDate,
                currentStreak: draft.streaks.current
            }
        });

        return {
            current: draft.streaks.current,
            best: draft.streaks.best
        };
    });
}

export function cancelRecovery(recoveryId) {
    updateState("streak:recovery-cancel", draft => {
        const recovery = draft.streaks.recoveries.find(
            item => item.id === recoveryId
        );

        assert(recovery?.status === "active", "No active recovery found.");

        recovery.status = "cancelled";
    });
}

/* -------------------- SELECTORS -------------------- */

export function getStreakSummary() {
    const state = getState();

    return {
        current: state.streaks.current,
        best: state.streaks.best,
        freezes: state.streaks.freezes,
        shields: state.streaks.shields,

        lastQualifiedDate: state.streaks.lastQualifiedDate,

        activeRecovery: clone(
            state.streaks.recoveries.find(
                item => item.status === "active"
            ) || null
        ),

        recoverableDays: getRecoveryOptions().length
    };
}

export function getCalendarDays() {
    const state = getState();

    return sortedDayKeys(state).map(key => ({
        date: key,
        status: state.days[key].status,
        completed: state.days[key].completedQuestIds.length,
        evaluated: Boolean(state.days[key].evaluatedAt)
    }));
}