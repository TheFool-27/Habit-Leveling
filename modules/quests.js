/* ==========================================================
   AWAKENED — Quest engine
   Depends only on ./state.js
========================================================== */

import {
    STAT_KEYS,
    RANK_REWARDS,
    getState,
    updateState,
    createId,
    clone,
    nowISO,
    dateKey,
    isDateKey,
    parseDateKey,
    dayDifference,
    shiftDateKey,
    getTrackingDate,
    getPeriodKey,
    ensureDay,
    appendActivity,
    markActivityReversed
} from "./state.js";

import { getXpMultiplier } from "./shop.js";

const TYPES = ["checkbox", "counter", "timer", "avoidance"];

const FREQUENCIES = [
    "daily",
    "weekdays",
    "selected-days",
    "interval",
    "weekly",
    "monthly",
    "once"
];

const TIME_BLOCKS = [
    "anytime",
    "morning",
    "afternoon",
    "evening",
    "night",
    "custom"
];

const UNSAFE_KEYS = ["__proto__", "prototype", "constructor"];

export const QUEST_TEMPLATES = Object.freeze([
    {
        id: "read",
        category: "study",
        title: "Read 20 pages",
        type: "counter",
        stat: "int",
        rank: "D",
        target: 20,
        unit: "pages",
        icon: "📚"
    },
    {
        id: "deep-work",
        category: "focus",
        title: "Complete a focus session",
        type: "timer",
        stat: "wil",
        rank: "D",
        target: 25,
        unit: "minutes",
        icon: "🎯"
    },
    {
        id: "movement",
        category: "fitness",
        title: "Move for 15 minutes",
        type: "timer",
        stat: "str",
        rank: "E",
        target: 15,
        unit: "minutes",
        icon: "🚶"
    },
    {
        id: "sleep-routine",
        category: "health",
        title: "Complete my bedtime routine",
        type: "checkbox",
        stat: "vit",
        rank: "E",
        target: 1,
        unit: "",
        icon: "🌙"
    },
    {
        id: "create",
        category: "creative",
        title: "Create for 20 minutes",
        type: "timer",
        stat: "cre",
        rank: "D",
        target: 20,
        unit: "minutes",
        icon: "🎨"
    },
    {
        id: "connect",
        category: "social",
        title: "Check in with someone",
        type: "checkbox",
        stat: "cha",
        rank: "E",
        target: 1,
        unit: "",
        icon: "💬"
    },
    {
        id: "phone",
        category: "focus",
        title: "Keep my planned phone-free window",
        type: "avoidance",
        stat: "dis",
        rank: "D",
        target: 1,
        unit: "",
        icon: "📵"
    }
]);

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function text(value, maxLength = 2000) {
    return String(value ?? "").trim().slice(0, maxLength);
}

function number(value, fallback, min, max) {
    const parsed = value === "" || value == null
        ? fallback
        : Number(value);

    assert(
        Number.isFinite(parsed) && parsed >= min && parsed <= max,
        `Enter a number between ${min} and ${max}.`
    );

    return parsed;
}

function round(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function today(state = getState()) {
    return getTrackingDate(new Date(), state.settings.dayStart);
}

function findQuest(state, id) {
    const quest = state.quests.find(item => item.id === id);
    assert(quest, "Quest not found.");
    return quest;
}

function assertQuestId(id) {
    assert(
        typeof id === "string" &&
        id.length > 0 &&
        !UNSAFE_KEYS.includes(id),
        "Invalid quest ID."
    );
}

function periodSnapshot(quest) {
    return {
        title: quest.title,
        type: quest.type,
        target: quest.target,
        unit: quest.unit,
        stat: quest.stat,
        rank: quest.rank,
        currency: quest.currency,
        checklist: clone(quest.checklist)
    };
}

export function xpForLevel(level) {
    let requirement = 100;

    for (let current = 1; current < level; current += 1) {
        requirement = Math.round(requirement * 1.25);
    }

    return requirement;
}

/* -------------------- VALIDATION -------------------- */

function normalizeQuest(input, state) {
    const type = input.type || "checkbox";
    const frequency = input.frequency || "daily";
    const stat = input.stat || "dis";
    const rank = input.rank || "E";
    const timeBlock = input.timeBlock || "anytime";

    assert(TYPES.includes(type), "Unknown quest tracking type.");
    assert(FREQUENCIES.includes(frequency), "Unknown quest schedule.");
    assert(STAT_KEYS.includes(stat), "Unknown linked stat.");
    assert(Object.hasOwn(RANK_REWARDS, rank), "Unknown difficulty rank.");
    assert(TIME_BLOCKS.includes(timeBlock), "Unknown time block.");

    const title = text(input.title, 100);
    assert(title.length > 0, "Quest title is required.");

    const startDate = input.startDate || today(state);
    const endDate = input.endDate || "";

    assert(isDateKey(startDate), "Choose a valid start date.");
    assert(!endDate || isDateKey(endDate), "Choose a valid end date.");
    assert(!endDate || endDate >= startDate, "End date precedes start date.");

    const weekdays = [...new Set(
        (input.weekdays || []).map(Number)
    )];

    assert(
        weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6),
        "Invalid weekday selection."
    );

    if (frequency === "selected-days") {
        assert(weekdays.length > 0, "Select at least one weekday.");
    }

    const interval = number(input.interval, 2, 1, 365);
    assert(Number.isInteger(interval), "Repeat interval must be a whole number.");

    const currency = text(input.currency || "gold", 200);

    assert(
        Object.hasOwn(state.wallet, currency),
        "Choose an existing reward currency."
    );

    const reminder = input.reminder || "";

    assert(
        !reminder || /^([01]\d|2[0-3]):[0-5]\d$/.test(reminder),
        "Invalid reminder time."
    );

    const tags = (
        Array.isArray(input.tags)
            ? input.tags
            : String(input.tags || "").split(",")
    )
        .map(tag => text(tag, 30))
        .filter(Boolean);

    const checklistInput = Array.isArray(input.checklist)
        ? input.checklist
        : String(input.checklist || "").split("\n");

    const checklist = checklistInput
        .map(item => text(
            typeof item === "object" ? item.title : item,
            160
        ))
        .filter(Boolean)
        .slice(0, 30)
        .map((title, index) => ({
            id: `step_${index + 1}`,
            title
        }));

    const dependency = input.dependency || null;
    const raidId = input.raidId || null;

    if (dependency) {
        assertQuestId(dependency);
        findQuest(state, dependency);
    }

    if (raidId) {
        assert(
            state.raids.some(raid => raid.id === raidId),
            "Linked raid does not exist."
        );
    }

    return {
        title,
        description: text(input.description),
        type,
        stat,
        rank,

        target: ["checkbox", "avoidance"].includes(type)
            ? 1
            : number(input.target, 1, 1, 1000000),

        unit: type === "timer"
            ? "minutes"
            : text(input.unit, 30),

        effort: input.effort
            ? number(input.effort, 1, 1, 1440)
            : null,

        frequency,
        startDate,
        endDate,
        weekdays,
        interval,

        timeBlock,
        customBlock: text(input.customBlock, 40),

        tags: [...new Set(tags)].slice(0, 15),
        icon: text(input.icon, 16) || "☑",
        reminder,

        cue: text(input.cue, 150),
        dependency,
        raidId,
        raidDamage: number(input.raidDamage, 25, 1, 1000000),

        currency,
        checklist,

        mandatory: Boolean(input.mandatory),
        priority: Boolean(input.priority)
    };
}

function assertNoDependencyCycle(state, questId, dependencyId) {
    const visited = new Set([questId]);
    let nextId = dependencyId;

    while (nextId) {
        assert(!visited.has(nextId), "Quest dependencies cannot form a cycle.");

        visited.add(nextId);
        nextId = findQuest(state, nextId).dependency;
    }
}

function assertPriorityLimit(state, questId, wantsPriority) {
    if (!wantsPriority) return;

    const pinned = state.quests.filter(quest =>
        quest.id !== questId &&
        quest.priority &&
        !quest.archived &&
        !quest.paused
    );

    assert(pinned.length < 3, "Only three active quests can be pinned.");
}

/* -------------------- DEFINITIONS -------------------- */

export function createQuest(input) {
    return updateState("quest:create", draft => {
        const data = normalizeQuest(input, draft);
        const id = createId("quest");

        assertPriorityLimit(draft, id, data.priority);

        const quest = {
            id,
            ...data,
            order: draft.quests.length,
            paused: false,
            archived: false,
            createdAt: nowISO(),
            updatedAt: nowISO()
        };

        draft.quests.push(quest);

        appendActivity(draft, {
            type: "quest.created",
            entityId: id,
            payload: { title: quest.title }
        });

        return id;
    });
}

export function editQuest(id, input) {
    return updateState("quest:edit", draft => {
        const quest = findQuest(draft, id);
        const data = normalizeQuest({ ...quest, ...input }, draft);

        assertNoDependencyCycle(draft, id, data.dependency);
        assertPriorityLimit(draft, id, data.priority);

        /*
          Existing periods keep their original target and reward rules.
          Editing a definition must not retroactively change earned progress.
        */
        Object.assign(quest, data, { updatedAt: nowISO() });

        appendActivity(draft, {
            type: "quest.edited",
            entityId: id,
            payload: { title: quest.title }
        });
    });
}

export function setQuestPaused(id, paused) {
    updateState("quest:pause", draft => {
        const quest = findQuest(draft, id);

        quest.paused = Boolean(paused);
        if (quest.paused) quest.priority = false;

        quest.updatedAt = nowISO();
    });
}

export function setQuestArchived(id, archived) {
    updateState("quest:archive", draft => {
        const quest = findQuest(draft, id);

        quest.archived = Boolean(archived);
        if (quest.archived) quest.priority = false;

        quest.updatedAt = nowISO();
    });
}

export function setQuestPriority(id, priority) {
    updateState("quest:priority", draft => {
        const quest = findQuest(draft, id);

        assert(!quest.archived && !quest.paused, "Activate the quest before pinning it.");
        assertPriorityLimit(draft, id, priority);

        quest.priority = Boolean(priority);
    });
}

export function deleteQuest(id) {
    updateState("quest:delete", draft => {
        const quest = findQuest(draft, id);

        /*
          Definitions may be removed; periods and activity remain.
          Clear live dependencies rather than leaving broken references.
        */
        draft.quests.forEach(item => {
            if (item.dependency === id) item.dependency = null;
        });

        draft.quests = draft.quests.filter(item => item.id !== id);

        appendActivity(draft, {
            type: "quest.deleted",
            entityId: id,
            payload: { title: quest.title }
        });
    });
}

export function moveQuest(id, direction) {
    assert(
        direction === "up" || direction === "down",
        "Choose up or down."
    );

    updateState("quest:reorder", draft => {
        const ordered = [...draft.quests].sort((a, b) => a.order - b.order);
        const index = ordered.findIndex(quest => quest.id === id);

        assert(index >= 0, "Quest not found.");

        const next = index + (direction === "up" ? -1 : 1);
        if (next < 0 || next >= ordered.length) return;

        [ordered[index], ordered[next]] = [ordered[next], ordered[index]];

        ordered.forEach((quest, order) => {
            quest.order = order;
        });
    });
}

/* -------------------- SCHEDULES -------------------- */

export function isQuestScheduled(quest, key = today()) {
    assert(isDateKey(key), "Invalid schedule date.");

    if (quest.archived || quest.paused) return false;
    if (key < quest.startDate) return false;
    if (quest.endDate && key > quest.endDate) return false;

    const weekday = parseDateKey(key).getDay();

    switch (quest.frequency) {
        case "weekdays":
            return weekday >= 1 && weekday <= 5;

        case "selected-days":
            return quest.weekdays.includes(weekday);

        case "interval":
            return dayDifference(quest.startDate, key) % quest.interval === 0;

        /*
          Weekly/monthly targets can be progressed on any day
          within the active period.
        */
        default:
            return true;
    }
}

export function getQuestPeriod(
    quest,
    key = today(),
    state = getState()
) {
    const periodKey = getPeriodKey(quest.frequency, key);

    return state.questPeriods[quest.id]?.[periodKey] || null;
}

function ensureQuestPeriod(draft, quest, key) {
    assertQuestId(quest.id);

    const periodKey = getPeriodKey(quest.frequency, key);

    if (!Object.hasOwn(draft.questPeriods, quest.id)) {
        draft.questPeriods[quest.id] = {};
    }

    if (!draft.questPeriods[quest.id][periodKey]) {
        draft.questPeriods[quest.id][periodKey] = {
            id: `${quest.id}:${periodKey}`,
            periodKey,
            snapshot: periodSnapshot(quest),

            progress: 0,
            completedAt: null,
            completedDate: null,
            reward: null,

            checklistDone: [],
            createdAt: nowISO()
        };
    }

    return draft.questPeriods[quest.id][periodKey];
}

function assertLoggingAllowed(state, quest, key) {
    assert(isDateKey(key), "Choose a valid activity date.");
    assert(isQuestScheduled(quest, key), "This quest is not scheduled on that date.");

    const currentDate = today(state);
    const age = dayDifference(key, currentDate);

    assert(age >= 0, "Future progress cannot be logged.");
    assert(
        age <= state.settings.backfillDays,
        "That date is outside your backfill allowance."
    );

    assert(
        !state.days[key]?.evaluatedAt,
        "This day has been evaluated. Reopening evaluated days is not implemented yet."
    );

    if (quest.dependency) {
        const prerequisite = findQuest(state, quest.dependency);
        const prerequisitePeriod = getQuestPeriod(prerequisite, key, state);

        assert(
            Boolean(prerequisitePeriod?.completedAt),
            "Complete the prerequisite quest first."
        );
    }
}

/* -------------------- REWARD CALCULATIONS -------------------- */

function grantCompletionReward(draft, quest, period, key) {
    const rules = period.snapshot;
    const base = RANK_REWARDS[rules.rank];

    assert(
        Object.hasOwn(draft.wallet, rules.currency),
        "The reward currency no longer exists."
    );

    const reward = {
        xp: Math.round(base.xp * getXpMultiplier(draft)),
        amount: base.gold,
        currency: rules.currency,
        stat: rules.stat,
        statGain: 0.2,
        levelsGained: 0,
        statPointsGranted: 0
    };

    draft.profile.xp += reward.xp;

    while (draft.profile.xp >= xpForLevel(draft.profile.level)) {
        draft.profile.xp -= xpForLevel(draft.profile.level);
        draft.profile.level += 1;
        draft.profile.statPoints += 5;

        reward.levelsGained += 1;
        reward.statPointsGranted += 5;
    }

    draft.wallet[reward.currency] += reward.amount;

    draft.profile.stats[reward.stat] = round(
        draft.profile.stats[reward.stat] + reward.statGain
    );

    draft.totals.questsCompleted += 1;
    draft.totals.xpEarned += reward.xp;

    if (reward.currency === "gold") {
        draft.totals.goldEarned += reward.amount;
    }

    const day = ensureDay(draft, key);

    day.xpEarned += reward.xp;

    if (reward.currency === "gold") {
        day.goldEarned += reward.amount;
    }

    if (!day.completedQuestIds.includes(quest.id)) {
        day.completedQuestIds.push(quest.id);
    }

    period.completedAt = nowISO();
    period.completedDate = key;
    period.reward = reward;

    return reward;
}

/* -------------------- PROGRESS -------------------- */

export function logQuestProgress(
    id,
    amount = 1,
    { date, note = "", sourceId = null } = {}
) {
    return updateState("quest:progress", draft => {
        if (sourceId) {
            assert(
                typeof sourceId === "string" && sourceId.length <= 200,
                "Invalid progress source."
            );

            const existing = draft.activity.find(event =>
                event.payload?.progressSourceId === sourceId &&
                ["quest.progress", "quest.completed"].includes(event.type)
            );

            if (existing) {
                return {
                    eventId: existing.id,
                    questId: existing.entityId,
                    duplicate: true,
                    completed: existing.type === "quest.completed"
                };
            }
        }
        const quest = findQuest(draft, id);
        const key = date || today(draft);

        assertLoggingAllowed(draft, quest, key);

        const period = ensureQuestPeriod(draft, quest, key);

        assert(!period.completedAt, "This quest period is already completed.");

        const increment = number(amount, 1, 0.01, 1000000);

        const before = period.progress;
        const after = Math.min(
            period.snapshot.target,
            round(before + increment)
        );

        const delta = round(after - before);

        assert(delta > 0, "No progress remains to log.");

        if (period.snapshot.checklist.length) {
            assert(
                period.snapshot.checklist.every(step =>
                    period.checklistDone.includes(step.id)
                ),
                "Finish the checklist before logging completion progress."
            );
        }

        period.progress = after;

        const completed = after >= period.snapshot.target;
        const reward = completed
            ? grantCompletionReward(draft, quest, period, key)
            : null;

        const day = ensureDay(draft, key);

        if (!day.scheduledQuestIds.includes(id)) {
            day.scheduledQuestIds.push(id);
        }

        const event = appendActivity(draft, {
            type: completed ? "quest.completed" : "quest.progress",
            entityId: id,
            trackingDate: key,
            periodKey: period.periodKey,
            progressSourceId: sourceId,
            payload: {
                title: period.snapshot.title,
                amount: delta,
                unit: period.snapshot.unit,
                previousProgress: before,
                nextProgress: after,
                note: text(note, 1000),
                raidId: quest.raidId,
                raidDamage: quest.raidDamage,
                reward: reward ? clone(reward) : null
            }
        });

        return {
            eventId: event.id,
            questId: id,
            completed,
            progress: after,
            target: period.snapshot.target,
            reward: reward ? clone(reward) : null
        };
    });
}

export function completeQuest(id, options = {}) {
    const state = getState();
    const quest = findQuest(state, id);
    const key = options.date || today(state);
    const period = getQuestPeriod(quest, key, state);

    const remaining =
        (period?.snapshot.target ?? quest.target) -
        (period?.progress ?? 0);

    assert(remaining > 0, "This quest period is already completed.");

    return logQuestProgress(id, remaining, options);
}

export function setChecklistStep(
    id,
    stepId,
    checked,
    key = today()
) {
    updateState("quest:checklist", draft => {
        const quest = findQuest(draft, id);

        assertLoggingAllowed(draft, quest, key);

        const period = ensureQuestPeriod(draft, quest, key);

        assert(!period.completedAt, "Undo completion before changing its checklist.");

        assert(
            period.snapshot.checklist.some(step => step.id === stepId),
            "Checklist step not found."
        );

        period.checklistDone = period.checklistDone.filter(id => id !== stepId);

        if (checked) {
            period.checklistDone.push(stepId);
        }
    });
}

/* -------------------- UNDO -------------------- */

/*
  Undo reverses the latest unreversed progress event for a quest.

  Safeguards:
  - Spent reward currency is not silently made negative.
  - Level reductions cannot remove already-spent stat points.
  - Evaluated days remain locked.
  - Downstream reward effects are blocked until a future
    coordinating undo engine can reverse them atomically.
*/

export function undoLastQuestLog(id) {
    return updateState("quest:undo", draft => {
        findQuest(draft, id);

        const event = [...draft.activity].reverse().find(item =>
            item.entityId === id &&
            ["quest.progress", "quest.completed"].includes(item.type) &&
            !item.reversedBy
        );

        assert(event, "No progress log is available to undo.");

        assert(
            !draft.days[event.trackingDate]?.evaluatedAt,
            "Evaluated days cannot be changed yet."
        );

        const period = draft.questPeriods[id]?.[event.periodKey];

        assert(period, "Progress period not found.");

        assert(
            period.progress === event.payload.nextProgress,
            "Later progress changed this period. Undo the latest log first."
        );

        /*
          Future modules must record sourceEventId for derived effects.
          Refuse a partial reversal if dependent effects remain active.
        */
        const dependentEffect = draft.activity.some(item =>
            item.payload?.sourceEventId === event.id &&
            !item.reversedBy
        );

        assert(
            !dependentEffect,
            "This log has linked effects that must be reversed together."
        );

        const reward = event.payload.reward;

        if (reward) {
            assert(
                draft.wallet[reward.currency] >= reward.amount,
                "This reward has been spent. Restore the currency before undoing."
            );

            let newXp = draft.profile.xp - reward.xp;
            let newLevel = draft.profile.level;
            let levelsRemoved = 0;

            while (newXp < 0 && newLevel > 1) {
                newLevel -= 1;
                newXp += xpForLevel(newLevel);
                levelsRemoved += 1;
            }

            assert(newXp >= 0, "XP cannot be reversed safely.");

            const pointsToRemove = levelsRemoved * 5;

            assert(
                draft.profile.statPoints >= pointsToRemove,
                "Undo would remove levels whose stat points have already been spent."
            );

            draft.profile.level = newLevel;
            draft.profile.xp = newXp;
            draft.profile.statPoints -= pointsToRemove;

            draft.wallet[reward.currency] -= reward.amount;

            draft.profile.stats[reward.stat] = round(
                draft.profile.stats[reward.stat] - reward.statGain
            );

            draft.totals.questsCompleted -= 1;
            draft.totals.xpEarned -= reward.xp;

            if (reward.currency === "gold") {
                draft.totals.goldEarned -= reward.amount;
            }

            const day = ensureDay(draft, event.trackingDate);

            day.xpEarned -= reward.xp;

            if (reward.currency === "gold") {
                day.goldEarned -= reward.amount;
            }

            day.completedQuestIds = day.completedQuestIds.filter(
                questId => questId !== id
            );

            period.completedAt = null;
            period.completedDate = null;
            period.reward = null;
        }

        period.progress = event.payload.previousProgress;

        const reversal = appendActivity(draft, {
            type: "quest.log-reversed",
            entityId: id,
            trackingDate: event.trackingDate,
            periodKey: event.periodKey,
            payload: {
                title: event.payload.title,
                originalEventId: event.id,
                amount: event.payload.amount
            }
        });

        markActivityReversed(draft, event.id, reversal.id);

        return {
            originalEventId: event.id,
            reversalEventId: reversal.id
        };
    });
}

/* -------------------- SELECTORS -------------------- */

export function getQuestView(
    quest,
    key = today(),
    state = getState()
) {
    const period = getQuestPeriod(quest, key, state);
    const snapshot = period?.snapshot || periodSnapshot(quest);

    return {
        ...clone(quest),

        periodKey: getPeriodKey(quest.frequency, key),
        progress: period?.progress || 0,
        target: snapshot.target,
        unit: snapshot.unit,

        completed: Boolean(period?.completedAt),
        completedAt: period?.completedAt || null,

        scheduled: isQuestScheduled(quest, key),
        checklist: clone(snapshot.checklist),
        checklistDone: [...(period?.checklistDone || [])],

        rewardPreview: {
            ...RANK_REWARDS[snapshot.rank],
            currency: snapshot.currency
        }
    };
}

export function selectQuests({
    search = "",
    status = "today",
    stat = "all",
    rank = "all",
    sort = "manual",
    date = today()
} = {}) {
    const state = getState();
    const query = search.trim().toLowerCase();

    let results = state.quests.map(quest =>
        getQuestView(quest, date, state)
    );

    results = results.filter(quest => {
        if (status === "archived") return quest.archived;
        if (status === "paused") return quest.paused && !quest.archived;

        if (quest.archived || quest.paused) return false;

        if (status === "today" && !quest.scheduled) return false;

        if (status === "pending" && (!quest.scheduled || quest.completed)) {
            return false;
        }

        if (status === "completed" && !quest.completed) return false;

        return true;
    });

    results = results.filter(quest => {
        if (stat !== "all" && quest.stat !== stat) return false;
        if (rank !== "all" && quest.rank !== rank) return false;

        if (!query) return true;

        return [
            quest.title,
            quest.description,
            quest.cue,
            ...quest.tags
        ].join(" ").toLowerCase().includes(query);
    });

    const ranks = ["E", "D", "C", "B", "A", "S"];

    results.sort((a, b) => {
        if (sort === "name") {
            return a.title.localeCompare(b.title);
        }

        if (sort === "rank") {
            return ranks.indexOf(b.rank) - ranks.indexOf(a.rank);
        }

        if (sort === "priority") {
            return Number(b.priority) - Number(a.priority) || a.order - b.order;
        }

        if (sort === "time") {
            return (
                TIME_BLOCKS.indexOf(a.timeBlock) -
                TIME_BLOCKS.indexOf(b.timeBlock)
            ) || a.order - b.order;
        }

        return a.order - b.order;
    });

    return results;
}

export function getTodayQuestSummary() {
    const quests = selectQuests({ status: "today" });

    return {
        total: quests.length,
        completed: quests.filter(quest => quest.completed).length,
        mandatoryRemaining: quests.filter(
            quest => quest.mandatory && !quest.completed
        ).length,
        priorities: quests.filter(quest => quest.priority).slice(0, 3)
    };
}

/* -------------------- TEMPLATES / SUGGESTIONS -------------------- */

export function getQuestTemplates(category = "all") {
    return QUEST_TEMPLATES
        .filter(template =>
            category === "all" || template.category === category
        )
        .map(clone);
}

export function createQuestFromTemplate(templateId) {
    const template = QUEST_TEMPLATES.find(
        item => item.id === templateId
    );

    assert(template, "Template not found.");

    return createQuest({
        ...template,
        frequency: "daily",
        startDate: today()
    });
}

export function suggestRank(effortMinutes) {
    const minutes = number(effortMinutes, 1, 1, 1440);

    if (minutes <= 10) return "E";
    if (minutes <= 30) return "D";
    if (minutes <= 60) return "C";
    if (minutes <= 90) return "B";
    if (minutes <= 150) return "A";

    return "S";
}

/*
  A transparent effort heuristic, not an AI recommendation.
  Different activities are not directly comparable by minutes.
*/

export function createBonusQuest() {
    const state = getState();
    const key = today(state);

    const existing = state.quests.find(quest =>
        quest.bonusDate === key && !quest.archived
    );

    assert(!existing, "Today's side quest has already been generated.");

    const options = [
        { title: "Clear one small workspace", stat: "dis", icon: "🧹" },
        { title: "Write down tomorrow's first action", stat: "wil", icon: "✍" },
        { title: "Send someone a thoughtful message", stat: "cha", icon: "💬" }
    ];

    const option = options[Math.floor(Math.random() * options.length)];

    return updateState("quest:bonus-create", draft => {
        const data = normalizeQuest({
            ...option,
            type: "checkbox",
            rank: "E",
            frequency: "once",
            startDate: key,
            endDate: key,
            target: 1
        }, draft);

        const id = createId("quest");

        draft.quests.push({
            id,
            ...data,
            bonusDate: key,
            order: draft.quests.length,
            paused: false,
            archived: false,
            createdAt: nowISO(),
            updatedAt: nowISO()
        });

        return id;
    });
}