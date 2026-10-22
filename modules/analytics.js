/* ==========================================================
   AWAKENED — Analytics selectors and CSV export
   Dependencies: state.js and journal.js

   Read-only: no state updates and no DOM manipulation.
========================================================== */

import {
    getState,
    clone,
    isDateKey,
    parseDateKey,
    shiftDateKey,
    dayDifference,
    getTrackingDate
} from "./state.js";

import {
    getJournalSummary,
    getJournalTrend
} from "./journal.js";

const SUPPORTED_RANGES = ["7", "30", "90", "365", "all"];

const PROTECTED_STATUSES = new Set([
    "rest",
    "frozen",
    "shielded",
    "recovered"
]);

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function round(value, places = 2) {
    const factor = 10 ** places;

    return Math.round(
        (value + Number.EPSILON) * factor
    ) / factor;
}

function percent(numerator, denominator) {
    return denominator > 0
        ? round((numerator / denominator) * 100, 1)
        : null;
}

function sum(items, selector) {
    return items.reduce(
        (total, item) => total + selector(item),
        0
    );
}

function inRange(date, range) {
    return (
        typeof date === "string" &&
        date >= range.from &&
        date <= range.to
    );
}

function today(state = getState()) {
    return getTrackingDate(
        new Date(),
        state.settings.dayStart
    );
}

function firstKnownDate(state, fallback) {
    const dates = [
        getTrackingDate(
            new Date(state.meta.createdAt),
            state.settings.dayStart
        ),

        ...Object.keys(state.days),

        ...state.activity.map(event => event.trackingDate),

        ...state.journal.map(entry => entry.date),

        ...state.focusSessions.map(session => session.trackingDate)
    ].filter(isDateKey);

    return dates.length
        ? dates.sort()[0]
        : fallback;
}

function dateSequence(from, to) {
    assert(
        isDateKey(from) && isDateKey(to),
        "Invalid report dates."
    );

    assert(from <= to, "Report dates are reversed.");

    const length = dayDifference(from, to) + 1;

    assert(
        length <= 36500,
        "This report covers too many days."
    );

    return Array.from(
        { length },
        (_, index) => shiftDateKey(from, index)
    );
}

/* -------------------- REPORT RANGE -------------------- */

export function resolveAnalyticsRange(
    selection = "7",
    endDate = today()
) {
    const state = getState();
    const value = String(selection);

    assert(
        SUPPORTED_RANGES.includes(value),
        "Unknown analytics range."
    );

    assert(isDateKey(endDate), "Invalid report end date.");

    assert(
        endDate <= today(state),
        "Reports cannot end in the future."
    );

    let from;

    if (value === "all") {
        from = firstKnownDate(state, endDate);

        /*
          A historical end date may precede account creation.
          Return that date as an empty one-day reporting window.
        */
        if (from > endDate) from = endDate;
    } else {
        from = shiftDateKey(endDate, -(Number(value) - 1));
    }

    return {
        selection: value,
        from,
        to: endDate,
        days: dayDifference(from, endDate) + 1
    };
}

/* -------------------- ACTIVITY SELECTORS -------------------- */

function activeEvents(state, range) {
    return state.activity.filter(event =>
        !event.reversedBy &&
        inRange(event.trackingDate, range)
    );
}

function completionEvents(state, range) {
    return activeEvents(state, range).filter(
        event => event.type === "quest.completed"
    );
}

function xpFromEvent(event) {
    if (event.type === "quest.completed") {
        return event.payload.reward?.xp || 0;
    }

    if (event.type === "raid.cleared") {
        return event.payload.xp || 0;
    }

    return 0;
}

function goldFromEvent(event) {
    if (event.type === "quest.completed") {
        return event.payload.reward?.currency === "gold"
            ? event.payload.reward.amount || 0
            : 0;
    }

    if (event.type === "raid.cleared") {
        return event.payload.gold || 0;
    }

    return 0;
}

/* -------------------- SCHEDULED OBLIGATIONS -------------------- */

/*
  Only evaluated days provide the denominator.

  Pending days are not treated as failures.
  Protected full days are excluded from the obligation rate.
  Quest-specific protected skips are also excluded.

  Completion is read from the final period record, so a
  later completed target can be recognized where applicable.
*/

function evaluatedObligations(state, range) {
    const rows = [];

    for (const [date, day] of Object.entries(state.days)) {
        if (!inRange(date, range) || !day.evaluatedAt) continue;

        if (PROTECTED_STATUSES.has(day.status)) continue;

        for (const obligation of day.obligations || []) {
            if (day.skips?.[obligation.questId]?.protected) {
                continue;
            }

            const period =
                state.questPeriods[obligation.questId]?.[
                obligation.periodKey
                ];

            const definition = state.quests.find(
                quest => quest.id === obligation.questId
            );

            const completed =
                Boolean(period?.completedAt) &&
                Boolean(period?.completedDate) &&
                period.completedDate <= date;

            rows.push({
                date,

                questId: obligation.questId,
                title: obligation.title,

                stat:
                    period?.snapshot.stat ||
                    definition?.stat ||
                    null,

                mandatory: obligation.mandatory,
                periodKey: obligation.periodKey,

                completed,

                scheduleReconstructed:
                    Boolean(day.scheduleReconstructed)
            });
        }
    }

    return rows;
}

/* -------------------- OVERVIEW METRICS -------------------- */

export function getAnalyticsMetrics(selection = "7") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const events = activeEvents(state, range);
    const completions = events.filter(
        event => event.type === "quest.completed"
    );

    const obligations = evaluatedObligations(state, range);

    const completedSessions = state.focusSessions.filter(
        session =>
            session.status === "completed" &&
            inRange(session.trackingDate, range)
    );

    const evaluatedDays = Object.values(state.days).filter(
        day =>
            day.evaluatedAt &&
            inRange(day.date, range)
    );

    return {
        range,

        questCompletions: completions.length,

        scheduledObligations: obligations.length,

        completedObligations: obligations.filter(
            item => item.completed
        ).length,

        obligationCompletionRate: percent(
            obligations.filter(item => item.completed).length,
            obligations.length
        ),

        xpEarned: sum(events, xpFromEvent),
        goldEarned: sum(events, goldFromEvent),

        raidsCleared: events.filter(
            event => event.type === "raid.cleared"
        ).length,

        focusSessions: completedSessions.length,

        focusMinutes: sum(
            completedSessions,
            session => session.plannedMinutes
        ),

        perfectDays: evaluatedDays.filter(
            day => day.evaluation?.perfect
        ).length,

        missedDays: evaluatedDays.filter(
            day => day.status === "missed"
        ).length,

        protectedDays: evaluatedDays.filter(
            day => PROTECTED_STATUSES.has(day.status)
        ).length,

        evaluatedDays: evaluatedDays.length,

        /*
          Current and best streak are overall values,
          not streaks recalculated only inside the selected range.
        */
        currentStreak: state.streaks.current,
        lifetimeBestStreak: state.streaks.best,

        reconstructedScheduleDays: evaluatedDays.filter(
            day => day.scheduleReconstructed
        ).length
    };
}

/* -------------------- DAILY CHART SERIES -------------------- */

export function getDailyAnalytics(selection = "30") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const rows = new Map(
        dateSequence(range.from, range.to).map(date => [
            date,
            {
                date,
                questCompletions: 0,
                xp: 0,
                gold: 0,
                focusMinutes: 0,
                focusSessions: 0,
                raidsCleared: 0,
                status: state.days[date]?.status || "unrecorded"
            }
        ])
    );

    for (const event of activeEvents(state, range)) {
        const row = rows.get(event.trackingDate);

        if (!row) continue;

        row.xp += xpFromEvent(event);
        row.gold += goldFromEvent(event);

        if (event.type === "quest.completed") {
            row.questCompletions += 1;
        }

        if (event.type === "raid.cleared") {
            row.raidsCleared += 1;
        }
    }

    for (const session of state.focusSessions) {
        if (
            session.status !== "completed" ||
            !inRange(session.trackingDate, range)
        ) {
            continue;
        }

        const row = rows.get(session.trackingDate);

        row.focusMinutes += session.plannedMinutes;
        row.focusSessions += 1;
    }

    return [...rows.values()];
}

/* -------------------- PER-QUEST PERFORMANCE -------------------- */

export function getQuestPerformance(selection = "30") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const groups = new Map();

    for (const item of evaluatedObligations(state, range)) {
        if (!groups.has(item.questId)) {
            groups.set(item.questId, {
                questId: item.questId,
                title: item.title,

                completed: 0,
                scheduled: 0,
                reconstructed: 0
            });
        }

        const group = groups.get(item.questId);

        group.scheduled += 1;

        if (item.completed) group.completed += 1;
        if (item.scheduleReconstructed) group.reconstructed += 1;
    }

    return [...groups.values()]
        .map(group => ({
            ...group,

            completionRate: percent(
                group.completed,
                group.scheduled
            )
        }))
        .sort((a, b) =>
            a.completionRate - b.completionRate ||
            a.title.localeCompare(b.title)
        );
}

/* -------------------- STAT DATA -------------------- */

/*
  This returns recorded stat gains from quest rewards.

  It is not a complete historical character-stat chart:
  manual stat allocations were not recorded with deltas
  in the modules written so far.
*/

export function getRecordedStatGains(selection = "30") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const totals = Object.fromEntries(
        Object.keys(state.profile.stats).map(stat => [stat, 0])
    );

    for (const event of completionEvents(state, range)) {
        const reward = event.payload.reward;

        if (
            reward?.stat &&
            Object.hasOwn(totals, reward.stat)
        ) {
            totals[reward.stat] += reward.statGain || 0;
        }
    }

    return Object.entries(totals).map(([stat, gain]) => ({
        stat,
        gain: round(gain),
        currentValue: state.profile.stats[stat]
    }));
}

export function getStatConsistency(selection = "30") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const grouped = new Map();

    for (const item of evaluatedObligations(state, range)) {
        if (!item.stat) continue;

        if (!grouped.has(item.stat)) {
            grouped.set(item.stat, {
                stat: item.stat,
                scheduled: 0,
                completed: 0
            });
        }

        const group = grouped.get(item.stat);

        group.scheduled += 1;

        if (item.completed) group.completed += 1;
    }

    return [...grouped.values()].map(group => ({
        ...group,

        completionRate: percent(
            group.completed,
            group.scheduled
        )
    }));
}

/* -------------------- CONSISTENCY CALENDAR -------------------- */

export function getConsistencyCalendar({
    endDate = today(),
    days = 365
} = {}) {
    const state = getState();

    assert(isDateKey(endDate), "Invalid calendar end date.");

    assert(
        Number.isInteger(days) && days >= 1 && days <= 366,
        "Calendar length must be between 1 and 366 days."
    );

    const from = shiftDateKey(endDate, -(days - 1));
    const counts = new Map();

    for (const event of state.activity) {
        if (
            event.type !== "quest.completed" ||
            event.reversedBy ||
            event.trackingDate < from ||
            event.trackingDate > endDate
        ) {
            continue;
        }

        counts.set(
            event.trackingDate,
            (counts.get(event.trackingDate) || 0) + 1
        );
    }

    const dates = dateSequence(from, endDate);

    /*
      Monday-first grid: leading placeholders align weekdays.
      CSS lays out seven rows per week.
    */
    const weekday = parseDateKey(from).getDay();
    const leadingBlanks = (weekday + 6) % 7;

    const cells = Array.from(
        { length: leadingBlanks },
        () => ({
            placeholder: true
        })
    );

    for (const date of dates) {
        const day = state.days[date];
        const count = counts.get(date) || 0;

        let level = 0;

        if (count >= 5) level = 4;
        else if (count >= 3) level = 3;
        else if (count >= 2) level = 2;
        else if (count >= 1) level = 1;

        cells.push({
            placeholder: false,

            date,
            completed: count,
            level,

            status: day?.status || "unrecorded",
            evaluated: Boolean(day?.evaluatedAt),

            isToday: date === today(state)
        });
    }

    return {
        from,
        to: endDate,
        days,
        cells,

        activeDays: dates.filter(
            date => (counts.get(date) || 0) > 0
        ).length
    };
}

/* -------------------- TIME-OF-DAY DISTRIBUTION -------------------- */

/*
  Based on the local clock interpretation of recorded timestamps.
  These are logging times, not verified times the work occurred.
*/

export function getLoggingTimeDistribution(selection = "30") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const buckets = [
        { id: "night", label: "00:00–05:59", count: 0 },
        { id: "morning", label: "06:00–11:59", count: 0 },
        { id: "afternoon", label: "12:00–17:59", count: 0 },
        { id: "evening", label: "18:00–23:59", count: 0 }
    ];

    const events = completionEvents(state, range);

    for (const event of events) {
        const hour = new Date(event.occurredAt).getHours();

        if (!Number.isFinite(hour)) continue;

        buckets[Math.floor(hour / 6)].count += 1;
    }

    const count = sum(buckets, bucket => bucket.count);

    return {
        recordedCompletions: count,

        buckets: buckets.map(bucket => ({
            ...bucket,
            percentage: percent(bucket.count, count)
        }))
    };
}

/* -------------------- COMEBACK METRICS -------------------- */

/*
  Observed return delay:
  days from the first evaluated miss in a consecutive missed
  run to the next recorded quest completion.

  Recovery-protocol completion is a separate metric.
*/

export function getComebackMetrics(selection = "90") {
    const state = getState();
    const range = resolveAnalyticsRange(selection);

    const completionDates = [
        ...new Set(
            state.activity
                .filter(event =>
                    event.type === "quest.completed" &&
                    !event.reversedBy
                )
                .map(event => event.trackingDate)
        )
    ].sort();

    const missedDates = Object.entries(state.days)
        .filter(([, day]) =>
            day.evaluatedAt &&
            (
                day.status === "missed" ||
                day.status === "recovered"
            )
        )
        .map(([date]) => date)
        .sort();

    const runStarts = missedDates.filter((date, index) =>
        index === 0 ||
        dayDifference(missedDates[index - 1], date) > 1
    );

    const returns = runStarts
        .filter(date => inRange(date, range))
        .map(missedDate => {
            const returnedDate = completionDates.find(
                date => date > missedDate
            );

            return {
                missedDate,
                returnedDate: returnedDate || null,

                daysToReturn: returnedDate
                    ? dayDifference(missedDate, returnedDate)
                    : null
            };
        });

    const observed = returns.filter(
        item => item.daysToReturn !== null
    );

    const recoveredProtocols = state.streaks.recoveries.filter(
        recovery =>
            recovery.status === "completed" &&
            inRange(recovery.targetDate, range)
    );

    return {
        missedRuns: returns.length,
        observedReturns: observed.length,
        unresolvedRuns: returns.length - observed.length,

        averageDaysToReturn: observed.length
            ? round(
                sum(observed, item => item.daysToReturn) /
                observed.length
            )
            : null,

        recoveryProtocolsCompleted: recoveredProtocols.length,

        returns
    };
}

/* -------------------- SOURCE-SUPPORTED LOCAL INSIGHTS -------------------- */

/*
  These are transparent rule-based summaries, not AI.
  Thresholds suppress claims based on tiny samples.
*/

export function getAnalyticsInsights(selection = "30") {
    const metrics = getAnalyticsMetrics(selection);
    const insights = [];

    if (metrics.scheduledObligations >= 5) {
        insights.push({
            id: "completion-rate",

            message:
                `You completed ${metrics.completedObligations} of ` +
                `${metrics.scheduledObligations} evaluated obligations ` +
                `(${metrics.obligationCompletionRate}%).`,

            sampleSize: metrics.scheduledObligations
        });
    }

    const comparableStats = getStatConsistency(selection)
        .filter(item => item.scheduled >= 5)
        .sort((a, b) =>
            a.completionRate - b.completionRate
        );

    if (comparableStats.length >= 2) {
        const weakest = comparableStats[0];

        insights.push({
            id: "lowest-consistency-stat",

            message:
                `${weakest.stat.toUpperCase()} has your lowest ` +
                `observed completion rate among stats with at least ` +
                `five evaluated obligations: ` +
                `${weakest.completed}/${weakest.scheduled}.`,

            sampleSize: weakest.scheduled
        });
    }

    const logging = getLoggingTimeDistribution(selection);

    if (logging.recordedCompletions >= 10) {
        const peak = [...logging.buckets]
            .sort((a, b) => b.count - a.count)[0];

        insights.push({
            id: "logging-window",

            message:
                `Your busiest completion-logging window was ` +
                `${peak.label}: ${peak.count} of ` +
                `${logging.recordedCompletions} logged completions.`,

            sampleSize: logging.recordedCompletions
        });
    }

    if (metrics.focusSessions >= 3) {
        insights.push({
            id: "focus-time",

            message:
                `You finished ${metrics.focusSessions} focus sessions ` +
                `for ${metrics.focusMinutes} planned minutes.`,

            sampleSize: metrics.focusSessions
        });
    }

    if (metrics.reconstructedScheduleDays > 0) {
        insights.push({
            id: "schedule-caveat",

            message:
                `${metrics.reconstructedScheduleDays} evaluated day(s) ` +
                `used reconstructed schedules. Historical completion ` +
                `rates may be less precise for those dates.`,

            sampleSize: metrics.reconstructedScheduleDays
        });
    }

    return insights;
}

/* -------------------- COMBINED REPORT -------------------- */

export function getAnalyticsReport(selection = "30") {
    const range = resolveAnalyticsRange(selection);

    return {
        generatedAt: new Date().toISOString(),

        range,

        metrics: getAnalyticsMetrics(selection),
        daily: getDailyAnalytics(selection),

        quests: getQuestPerformance(selection),

        statGains: getRecordedStatGains(selection),
        statConsistency: getStatConsistency(selection),

        loggingTimes: getLoggingTimeDistribution(selection),
        comeback: getComebackMetrics(selection),

        journal: getJournalSummary({
            from: range.from,
            to: range.to
        }),

        journalTrend: getJournalTrend({
            from: range.from,
            to: range.to
        }),

        insights: getAnalyticsInsights(selection)
    };
}

/* -------------------- CSV EXPORT -------------------- */

/*
  Export daily operational metrics.
  Private journal text is deliberately not included.

  The download action itself belongs in ui.js.
*/

function csvCell(value) {
    if (value === null || value === undefined) return "";

    let result = String(value);

    /*
      Prevent text fields from being interpreted as spreadsheet
      formulas when the exported file is opened.
    */
    if (
        typeof value === "string" &&
        /^\s*[=+\-@\t\r]/.test(result)
    ) {
        result = `'${result}`;
    }

    return `"${result.replaceAll('"', '""')}"`;
}

export function createAnalyticsCsv(selection = "365") {
    const rows = getDailyAnalytics(selection);

    const headers = [
        "date",
        "quest_completions",
        "xp_earned",
        "gold_earned",
        "focus_minutes",
        "focus_sessions",
        "raids_cleared",
        "day_status"
    ];

    const data = rows.map(row => [
        row.date,
        row.questCompletions,
        row.xp,
        row.gold,
        row.focusMinutes,
        row.focusSessions,
        row.raidsCleared,
        row.status
    ]);

    return [
        headers.map(csvCell).join(","),
        ...data.map(row => row.map(csvCell).join(","))
    ].join("\r\n");
}