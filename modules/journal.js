/* ==========================================================
   AWAKENED — Hunter's Journal
   Depends only on ./state.js

   One journal entry per tracking date.
   No DOM manipulation and no external requests.
========================================================== */

import {
    getState,
    updateState,
    createId,
    clone,
    nowISO,
    isDateKey,
    getTrackingDate,
    appendActivity
} from "./state.js";

export const MOOD_LABELS = Object.freeze({
    1: "Bad",
    2: "Low",
    3: "Neutral",
    4: "Good",
    5: "Great"
});

export const ENERGY_LABELS = Object.freeze({
    1: "Drained",
    2: "Low",
    3: "Normal",
    4: "High",
    5: "Full"
});

const TEXT_LIMITS = Object.freeze({
    win: 3000,
    blocker: 3000,
    gratitude: 1000,
    nextStep: 1000
});

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function today(state = getState()) {
    return getTrackingDate(
        new Date(),
        state.settings.dayStart
    );
}

function validateText(value, limit, label) {
    const result = String(value ?? "").trim();

    assert(
        result.length <= limit,
        `${label} must be ${limit} characters or fewer.`
    );

    return result;
}

function optionalNumber(
    value,
    { min, max, integer = false, label }
) {
    if (value === "" || value === null || value === undefined) {
        return null;
    }

    const parsed = Number(value);

    assert(
        Number.isFinite(parsed) &&
        parsed >= min &&
        parsed <= max &&
        (!integer || Number.isInteger(parsed)),
        `${label} must be ${integer ? "a whole number " : ""
        }between ${min} and ${max}.`
    );

    return parsed;
}

function average(values) {
    if (!values.length) return null;

    const sum = values.reduce(
        (total, value) => total + value,
        0
    );

    return Math.round((sum / values.length) * 100) / 100;
}

function findEntry(state, id) {
    const entry = state.journal.find(
        item => item.id === id
    );

    assert(entry, "Journal entry not found.");

    return entry;
}

function validateRange({ from, to } = {}) {
    assert(
        !from || isDateKey(from),
        "Invalid journal range start."
    );

    assert(
        !to || isDateKey(to),
        "Invalid journal range end."
    );

    assert(
        !from || !to || from <= to,
        "The range end must not precede its start."
    );
}

/* -------------------- INPUT VALIDATION -------------------- */

function normalizeEntry(input, state) {
    const date = input.date || today(state);

    assert(isDateKey(date), "Choose a valid journal date.");

    assert(
        date <= today(state),
        "Future journal entries are not supported."
    );

    const entry = {
        date,

        mood: optionalNumber(input.mood, {
            min: 1,
            max: 5,
            integer: true,
            label: "Mood"
        }),

        energy: optionalNumber(input.energy, {
            min: 1,
            max: 5,
            integer: true,
            label: "Energy"
        }),

        sleep: optionalNumber(input.sleep, {
            min: 0,
            max: 24,
            label: "Sleep hours"
        }),

        win: validateText(
            input.win,
            TEXT_LIMITS.win,
            "Your win"
        ),

        blocker: validateText(
            input.blocker,
            TEXT_LIMITS.blocker,
            "Your blocker"
        ),

        gratitude: validateText(
            input.gratitude,
            TEXT_LIMITS.gratitude,
            "Your gratitude note"
        ),

        nextStep: validateText(
            input.nextStep,
            TEXT_LIMITS.nextStep,
            "Your next step"
        )
    };

    const containsMetric = [
        entry.mood,
        entry.energy,
        entry.sleep
    ].some(value => value !== null);

    const containsText = [
        entry.win,
        entry.blocker,
        entry.gratitude,
        entry.nextStep
    ].some(Boolean);

    assert(
        containsMetric || containsText,
        "Record at least one reflection or check-in value."
    );

    return entry;
}

/* -------------------- CREATE / UPDATE -------------------- */

/*
  Without an ID:
    - Creates an entry for a new date.
    - Updates the existing entry when that date already exists.

  With an ID:
    - Updates that entry.
    - Rejects moving it onto another entry's date.

  This is a full-form save, not a partial patch:
  omitted optional fields are cleared.
*/

export function saveJournalEntry(input) {
    assert(
        input && typeof input === "object",
        "Journal input is required."
    );

    return updateState("journal:save", draft => {
        const data = normalizeEntry(input, draft);

        const requestedId =
            typeof input.id === "string"
                ? input.id.trim()
                : "";

        const existingForDate = draft.journal.find(
            entry => entry.date === data.date
        );

        let existing = null;

        if (requestedId) {
            existing = findEntry(draft, requestedId);

            assert(
                !existingForDate ||
                existingForDate.id === existing.id,
                "Another entry already exists for that date."
            );
        } else {
            existing = existingForDate || null;
        }

        const previousDate = existing?.date || null;
        const timestamp = nowISO();

        if (existing) {
            Object.assign(existing, data, {
                updatedAt: timestamp
            });

            appendActivity(draft, {
                type: "journal.updated",
                entityId: existing.id,
                trackingDate: data.date,

                payload: {
                    date: data.date,
                    previousDate
                }
            });

            return {
                id: existing.id,
                date: existing.date,
                created: false
            };
        }

        const entry = {
            id: createId("journal"),

            ...data,

            createdAt: timestamp,
            updatedAt: timestamp
        };

        draft.journal.push(entry);

        appendActivity(draft, {
            type: "journal.created",
            entityId: entry.id,
            trackingDate: entry.date,

            payload: {
                date: entry.date
            }
        });

        return {
            id: entry.id,
            date: entry.date,
            created: true
        };
    });
}

/* -------------------- DELETE -------------------- */

/*
  The UI must confirm before calling this.
  Reflection text is removed; the deletion event stores no text.
*/

export function deleteJournalEntry(id) {
    return updateState("journal:delete", draft => {
        const entry = findEntry(draft, id);

        draft.journal = draft.journal.filter(
            item => item.id !== id
        );

        appendActivity(draft, {
            type: "journal.deleted",
            entityId: id,
            trackingDate: entry.date,

            payload: {
                date: entry.date
            }
        });

        return {
            id,
            date: entry.date
        };
    });
}

/* -------------------- SINGLE-ENTRY SELECTORS -------------------- */

export function getJournalEntry(id) {
    const entry = getState().journal.find(
        item => item.id === id
    );

    return entry ? clone(entry) : null;
}

export function getJournalEntryForDate(
    date = today()
) {
    assert(isDateKey(date), "Invalid journal date.");

    const entry = getState().journal.find(
        item => item.date === date
    );

    return entry ? clone(entry) : null;
}

/* -------------------- SEARCH / FILTERS -------------------- */

export function selectJournalEntries({
    search = "",
    month = "",
    from,
    to,
    order = "newest"
} = {}) {
    validateRange({ from, to });

    if (month) {
        assert(
            /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
            "Choose a valid journal month."
        );
    }

    assert(
        order === "newest" || order === "oldest",
        "Unknown journal ordering."
    );

    const query = String(search).trim().toLowerCase();

    return getState().journal
        .filter(entry => {
            if (month && entry.date.slice(0, 7) !== month) {
                return false;
            }

            if (from && entry.date < from) return false;
            if (to && entry.date > to) return false;

            if (!query) return true;

            const searchable = [
                entry.date,
                entry.win,
                entry.blocker,
                entry.gratitude,
                entry.nextStep,

                MOOD_LABELS[entry.mood] || "",
                ENERGY_LABELS[entry.energy] || ""
            ]
                .join(" ")
                .toLowerCase();

            return searchable.includes(query);
        })
        .sort((a, b) =>
            order === "oldest"
                ? a.date.localeCompare(b.date)
                : b.date.localeCompare(a.date)
        )
        .map(entry => ({
            ...clone(entry),

            moodLabel:
                MOOD_LABELS[entry.mood] || "Not recorded",

            energyLabel:
                ENERGY_LABELS[entry.energy] || "Not recorded"
        }));
}

/* -------------------- ANALYTICS DATA -------------------- */

/*
  Missing metrics stay null.
  They must not become zero in charts or averages.
*/

export function getJournalTrend({
    from,
    to
} = {}) {
    return selectJournalEntries({
        from,
        to,
        order: "oldest"
    }).map(entry => ({
        date: entry.date,

        mood: entry.mood,
        energy: entry.energy,
        sleep: entry.sleep
    }));
}

export function getJournalSummary({
    from,
    to
} = {}) {
    const entries = selectJournalEntries({
        from,
        to,
        order: "oldest"
    });

    const moods = entries
        .map(entry => entry.mood)
        .filter(value => value !== null);

    const energies = entries
        .map(entry => entry.energy)
        .filter(value => value !== null);

    const sleepHours = entries
        .map(entry => entry.sleep)
        .filter(value => value !== null);

    const moodDistribution = {
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0
    };

    moods.forEach(value => {
        moodDistribution[value] += 1;
    });

    return {
        entries: entries.length,

        firstDate: entries[0]?.date || null,
        lastDate: entries.at(-1)?.date || null,

        mood: {
            average: average(moods),
            recordedDays: moods.length,
            distribution: moodDistribution
        },

        energy: {
            average: average(energies),
            recordedDays: energies.length
        },

        sleep: {
            averageHours: average(sleepHours),
            recordedDays: sleepHours.length
        },

        reflections: {
            wins: entries.filter(entry => entry.win).length,

            blockers: entries.filter(
                entry => entry.blocker
            ).length,

            gratitude: entries.filter(
                entry => entry.gratitude
            ).length,

            nextSteps: entries.filter(
                entry => entry.nextStep
            ).length
        }
    };
}

/* -------------------- NON-AI REFLECTION PROMPTS -------------------- */

export function getReflectionPrompts() {
    return [
        {
            field: "win",
            prompt: "What is one thing you followed through on today?"
        },
        {
            field: "blocker",
            prompt: "What made your next action harder than it needed to be?"
        },
        {
            field: "gratitude",
            prompt: "What is one ordinary thing you appreciated?"
        },
        {
            field: "nextStep",
            prompt: "What is the smallest useful action you can take next?"
        }
    ];
}