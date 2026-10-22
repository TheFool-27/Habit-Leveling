/* ==========================================================
   AWAKENED — Boss raid engine
   Dependencies: state.js and quests.js

   No DOM rendering or event listeners in this module.
========================================================== */

import {
    getState,
    updateState,
    clone,
    createId,
    nowISO,
    isDateKey,
    getTrackingDate,
    getWeekStart,
    shiftDateKey,
    appendActivity,
    claimOnce
} from "./state.js";

import { xpForLevel } from "./quests.js";

import { getXpMultiplier } from "./shop.js";

const RAID_RANKS = [
    "E",
    "D",
    "C",
    "B",
    "A",
    "S",
    "national"
];

const FAILURE_MODES = [
    "none",
    "recovery",
    "escape"
];

const ACTIVE_STATUS = "active";

const MAX_HP = 10000000;
const MAX_REWARD = 1000000;

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function text(value, max = 2000) {
    return String(value ?? "").trim().slice(0, max);
}

function wholeNumber(value, fallback, min, max) {
    const parsed =
        value === "" || value == null
            ? fallback
            : Number(value);

    assert(
        Number.isSafeInteger(parsed) &&
        parsed >= min &&
        parsed <= max,
        `Enter a whole number between ${min} and ${max}.`
    );

    return parsed;
}

function today(state = getState()) {
    return getTrackingDate(new Date(), state.settings.dayStart);
}

function findRaid(state, id) {
    const raid = state.raids.find(item => item.id === id);

    assert(raid, "Raid not found.");

    return raid;
}

function isActive(raid) {
    return raid.status === ACTIVE_STATUS;
}

function sourceAlreadyProcessed(raid, sourceId) {
    return raid.processedSourceIds.includes(sourceId);
}

function rememberSource(raid, sourceId) {
    if (!sourceAlreadyProcessed(raid, sourceId)) {
        raid.processedSourceIds.push(sourceId);
    }
}

/* -------------------- VALIDATION -------------------- */

function normalizeRaid(input, state, existing = null) {
    const name = text(input.name, 100);
    const rank = input.rank || "E";
    const failureMode = input.failureMode || "none";
    const deadline = input.deadline || "";

    assert(name, "Boss name is required.");
    assert(RAID_RANKS.includes(rank), "Unknown raid difficulty.");
    assert(
        FAILURE_MODES.includes(failureMode),
        "Unknown deadline consequence."
    );

    assert(
        !deadline || isDateKey(deadline),
        "Choose a valid deadline."
    );

    /*
      An unchanged deadline may naturally become historical.
      Setting a new deadline in the past is not allowed.
    */
    if (deadline && deadline !== existing?.deadline) {
        assert(
            deadline >= today(state),
            "Choose today or a future deadline."
        );
    }

    const tasks = Array.isArray(input.tasks)
        ? input.tasks
        : [];

    assert(tasks.length <= 100, "Use no more than 100 attack tasks.");

    const normalizedTasks = tasks.map(task => {
        const title = text(task.title, 160);

        assert(title, "Attack tasks need a title.");

        return {
            id: task.id || createId("attack"),

            title,

            damage: wholeNumber(
                task.damage,
                100,
                1,
                MAX_HP
            ),

            completed: Boolean(task.completed),
            completedAt: task.completedAt || null
        };
    });

    const ids = normalizedTasks.map(task => task.id);

    assert(
        new Set(ids).size === ids.length,
        "Attack task IDs must be unique."
    );

    return {
        name,
        description: text(input.description),
        rank,

        totalHp: wholeNumber(
            input.hp ?? input.totalHp,
            500,
            50,
            MAX_HP
        ),

        deadline,

        goldReward: wholeNumber(
            input.gold ?? input.goldReward,
            200,
            0,
            MAX_REWARD
        ),

        xpReward: wholeNumber(
            input.xp ?? input.xpReward,
            150,
            0,
            MAX_REWARD
        ),

        essenceReward: wholeNumber(
            input.essence ?? input.essenceReward,
            10,
            0,
            10000
        ),

        failureMode,
        counterattacks: Boolean(input.counterattacks),

        tasks: normalizedTasks
    };
}

function makeRaid(data, extra = {}) {
    return {
        id: createId("raid"),

        ...data,

        currentHp: data.totalHp,
        status: ACTIVE_STATUS,

        createdAt: nowISO(),
        updatedAt: nowISO(),
        clearedAt: null,
        failedAt: null,

        processedSourceIds: [],
        damageTaken: 0,

        rewardClaimed: false,
        shadowId: null,

        recoveryOffered: false,

        parentRaidId: null,
        weeklyPeriod: null,

        ...extra
    };
}

/* -------------------- CREATE / EDIT / DELETE -------------------- */

export function createRaid(input) {
    return updateState("raid:create", draft => {
        const data = normalizeRaid(input, draft);
        const raid = makeRaid(data);

        draft.raids.push(raid);

        appendActivity(draft, {
            type: "raid.created",
            entityId: raid.id,

            payload: {
                title: raid.name,
                rank: raid.rank,
                totalHp: raid.totalHp
            }
        });

        return raid.id;
    });
}

export function editRaid(id, input) {
    updateState("raid:edit", draft => {
        const raid = findRaid(draft, id);

        assert(isActive(raid), "Only an active raid can be edited.");

        const data = normalizeRaid(
            {
                ...raid,
                ...input,
                tasks: input.tasks || raid.tasks
            },
            draft,
            raid
        );

        /*
          Once damage has happened, changing HP, rewards, or tasks
          could create inconsistent attack and payout histories.
        */
        if (raid.damageTaken > 0) {
            assert(
                data.totalHp === raid.totalHp,
                "Boss HP is locked after its first hit."
            );

            assert(
                data.goldReward === raid.goldReward &&
                data.xpReward === raid.xpReward &&
                data.essenceReward === raid.essenceReward,
                "Rewards are locked after the first hit."
            );

            const originalTasks = raid.tasks.map(task => ({
                id: task.id,
                title: task.title,
                damage: task.damage
            }));

            const incomingTasks = data.tasks.map(task => ({
                id: task.id,
                title: task.title,
                damage: task.damage
            }));

            assert(
                JSON.stringify(originalTasks) === JSON.stringify(incomingTasks),
                "Attack tasks are locked after the first hit."
            );

            data.tasks = raid.tasks;
        } else {
            /*
              The editor cannot manufacture completed attack tasks.
            */
            data.tasks = data.tasks.map(task => ({
                ...task,
                completed: false,
                completedAt: null
            }));

            raid.currentHp = data.totalHp;
        }

        Object.assign(raid, data, {
            updatedAt: nowISO()
        });

        appendActivity(draft, {
            type: "raid.edited",
            entityId: raid.id,
            payload: { title: raid.name }
        });
    });
}

export function deleteRaid(id) {
    updateState("raid:delete", draft => {
        const raid = findRaid(draft, id);

        draft.quests.forEach(quest => {
            if (quest.raidId === id) {
                quest.raidId = null;
            }
        });

        /*
          Purchases, activity, and recruited shadows remain.
          Deleting a definition does not undo earned history.
        */
        draft.raids = draft.raids.filter(item => item.id !== id);

        appendActivity(draft, {
            type: "raid.deleted",
            entityId: id,
            payload: { title: raid.name }
        });
    });
}

/* -------------------- PHASES / LORE -------------------- */

export function getRaidPhase(raid) {
    if (raid.status === "cleared") {
        return {
            id: "cleared",
            label: "Gate cleared",
            percent: 0
        };
    }

    const percent =
        Math.max(0, raid.currentHp / raid.totalHp) * 100;

    if (percent > 75) {
        return { id: "opening", label: "Phase I", percent };
    }

    if (percent > 50) {
        return { id: "pressure", label: "Phase II", percent };
    }

    if (percent > 25) {
        return { id: "enraged", label: "Phase III", percent };
    }

    return {
        id: "final",
        label: "Final phase",
        percent
    };
}

export function getRaidLore(raid) {
    if (raid.status === "cleared") {
        return "The gate falls silent. Your effort remains.";
    }

    if (raid.status === "escaped") {
        return "The boss escaped. A rematch is available.";
    }

    if (raid.status === "failed") {
        return "The gate closed. Review the plan and return prepared.";
    }

    const phase = getRaidPhase(raid).id;

    const messages = {
        opening: "The boss awaits your first decisive action.",
        pressure: "The gate trembles. Your consistency is working.",
        enraged: "The boss is weakening. Keep your next action small and clear.",
        final: "The final phase begins. Finish the work—not just the animation."
    };

    return messages[phase];
}

/* -------------------- REWARDS -------------------- */

function grantRaidXp(draft, amount) {
    draft.profile.xp += amount;
    draft.totals.xpEarned += amount;

    let levelsGained = 0;

    while (draft.profile.xp >= xpForLevel(draft.profile.level)) {
        draft.profile.xp -= xpForLevel(draft.profile.level);
        draft.profile.level += 1;
        draft.profile.statPoints += 5;

        levelsGained += 1;
    }

    return levelsGained;
}

function clearRaid(draft, raid, sourceEventId = null) {
    const claimed = claimOnce(
        draft,
        `raid-clear:${raid.id}`,
        { raidId: raid.id }
    );

    assert(claimed, "This raid reward has already been claimed.");

    raid.currentHp = 0;
    raid.status = "cleared";
    raid.clearedAt = nowISO();
    raid.updatedAt = nowISO();
    raid.rewardClaimed = true;

    draft.wallet.gold += raid.goldReward;
    draft.wallet.essence += raid.essenceReward;

    draft.totals.goldEarned += raid.goldReward;
    draft.totals.raidsCleared += 1;

    const awardedXp = Math.round(
        raid.xpReward * getXpMultiplier(draft)
    );

    const levelsGained = grantRaidXp(draft, awardedXp);

    const shadow = {
        id: createId("shadow"),
        raidId: raid.id,

        name: raid.name,
        rank: raid.rank,

        recruitedAt: nowISO()
    };

    draft.shadows.push(shadow);
    raid.shadowId = shadow.id;

    appendActivity(draft, {
        type: "raid.cleared",
        entityId: raid.id,

        payload: {
            title: raid.name,

            sourceEventId,

            xp: awardedXp,
            gold: raid.goldReward,
            essence: raid.essenceReward,

            levelsGained,
            shadowId: shadow.id
        }
    });

    return {
        xp: raid.xpReward,
        gold: raid.goldReward,
        essence: raid.essenceReward,

        levelsGained,
        shadowId: shadow.id
    };
}

/* -------------------- DAMAGE -------------------- */

function applyDamage(
    draft,
    raid,
    requestedDamage,
    {
        sourceEventId = null,
        taskId = null,
        critical = false
    } = {}
) {
    assert(isActive(raid), "This raid is not active.");

    const actualDamage = Math.min(
        raid.currentHp,
        requestedDamage
    );

    assert(actualDamage > 0, "No damage can be applied.");

    const previousPhase = getRaidPhase(raid).id;

    raid.currentHp -= actualDamage;
    raid.damageTaken += actualDamage;
    raid.updatedAt = nowISO();

    const attack = appendActivity(draft, {
        type: "raid.damaged",
        entityId: raid.id,

        payload: {
            title: raid.name,

            sourceEventId,
            taskId,

            damage: actualDamage,
            critical,
            remainingHp: raid.currentHp
        }
    });

    let rewards = null;

    if (raid.currentHp === 0) {
        rewards = clearRaid(draft, raid, sourceEventId);
    }

    return {
        eventId: attack.id,
        raidId: raid.id,

        damage: actualDamage,
        remainingHp: raid.currentHp,
        critical,

        phaseChanged: previousPhase !== getRaidPhase(raid).id,
        phase: getRaidPhase(raid),

        cleared: raid.status === "cleared",
        rewards
    };
}

/*
  Critical hits are off by default.
  If enabled by the caller, the chance is fixed at 10%.
  Future skill/perk rules can replace this policy.
*/

function rollDamage(baseDamage, allowCritical) {
    const critical = allowCritical && Math.random() < 0.1;

    return {
        damage: critical ? baseDamage * 2 : baseDamage,
        critical
    };
}

export function attackRaidTask(
    raidId,
    taskId,
    { allowCritical = false } = {}
) {
    return updateState("raid:task-attack", draft => {
        const raid = findRaid(draft, raidId);

        assert(isActive(raid), "This raid is not active.");

        assert(
            !raid.deadline || today(draft) <= raid.deadline,
            "This raid's deadline has passed."
        );

        const task = raid.tasks.find(item => item.id === taskId);

        assert(task, "Attack task not found.");
        assert(!task.completed, "This attack task is already completed.");

        task.completed = true;
        task.completedAt = nowISO();

        const hit = rollDamage(task.damage, allowCritical);

        return applyDamage(draft, raid, hit.damage, {
            taskId: task.id,
            critical: hit.critical
        });
    });
}

/* -------------------- QUEST-LINKED DAMAGE -------------------- */

function processQuestCompletion(draft, event) {
    const raidId = event.payload.raidId;

    if (!raidId) return null;

    const raid = draft.raids.find(
        item => item.id === raidId
    );

    if (!raid || !isActive(raid)) return null;
    if (sourceAlreadyProcessed(raid, event.id)) return null;
    if (event.occurredAt < raid.createdAt) return null;

    if (raid.deadline && event.trackingDate > raid.deadline) {
        return null;
    }

    const damage = wholeNumber(
        event.payload.raidDamage,
        25,
        1,
        MAX_HP
    );

    rememberSource(raid, event.id);

    return applyDamage(draft, raid, damage, {
        sourceEventId: event.id
    });
}

/* -------------------- COUNTERATTACKS -------------------- */

function processDayEvaluation(draft, event) {
    if (!draft.settings.penalties) return [];

    const day = draft.days[event.trackingDate];
    const missedMandatory =
        day?.evaluation?.incompleteMandatoryIds || [];

    /*
      Protected/rest/recovered days do not trigger attacks.
    */
    if (day?.status !== "missed") return [];

    const results = [];

    for (const raid of draft.raids) {
        if (!isActive(raid) || !raid.counterattacks) continue;
        if (sourceAlreadyProcessed(raid, event.id)) continue;
        if (event.occurredAt < raid.createdAt) continue;

        if (
            raid.deadline &&
            event.trackingDate > raid.deadline
        ) {
            continue;
        }

        const linkedMisses = draft.quests.filter(quest =>
            quest.raidId === raid.id &&
            missedMandatory.includes(quest.id)
        );

        if (!linkedMisses.length) continue;

        rememberSource(raid, event.id);

        const requestedDamage = Math.min(
            15,
            linkedMisses.length * 5
        );

        const damage = Math.min(
            draft.profile.hp,
            requestedDamage
        );

        draft.profile.hp -= damage;

        appendActivity(draft, {
            type: "raid.counterattack",
            entityId: raid.id,

            trackingDate: event.trackingDate,

            payload: {
                title: raid.name,

                sourceEventId: event.id,

                damage,
                missedQuestIds: linkedMisses.map(quest => quest.id)
            }
        });

        results.push({
            raidId: raid.id,
            damage
        });
    }

    return results;
}

/* -------------------- DEADLINES -------------------- */

function expireRaids(draft) {
    const currentDate = today(draft);
    const expired = [];

    for (const raid of draft.raids) {
        if (!isActive(raid)) continue;
        if (!raid.deadline || raid.deadline >= currentDate) continue;

        raid.status =
            raid.failureMode === "escape"
                ? "escaped"
                : "failed";

        raid.failedAt = nowISO();
        raid.updatedAt = nowISO();

        /*
          This is an offer flag—not an automatically completed
          streak recovery and not an invented recovery reward.
        */
        raid.recoveryOffered =
            raid.failureMode === "recovery";

        appendActivity(draft, {
            type: "raid.expired",
            entityId: raid.id,

            payload: {
                title: raid.name,
                deadline: raid.deadline,
                status: raid.status,
                recoveryOffered: raid.recoveryOffered
            }
        });

        expired.push(raid.id);
    }

    return expired;
}

/* -------------------- EVENT SYNCHRONIZATION -------------------- */

/*
  Call after quest updates and day evaluation.

  This function does not subscribe to the store itself.
  That avoids hidden nested transactions and render loops.

  Process source events before deadline expiration so an
  already-recorded on-time completion can still count.
*/

export function syncRaidEvents() {
    return updateState("raid:sync-events", draft => {
        const sourceEvents = draft.activity
            .filter(event =>
                !event.reversedBy &&
                ["quest.completed", "day.evaluated"].includes(event.type)
            )
            .slice()
            .sort((a, b) =>
                a.occurredAt.localeCompare(b.occurredAt)
            );

        const attacks = [];
        const counterattacks = [];

        for (const event of sourceEvents) {
            if (event.type === "quest.completed") {
                const result = processQuestCompletion(draft, event);

                if (result) attacks.push(result);
            }

            if (event.type === "day.evaluated") {
                counterattacks.push(
                    ...processDayEvaluation(draft, event)
                );
            }
        }

        const expiredRaidIds = expireRaids(draft);

        return {
            attacks,
            counterattacks,
            expiredRaidIds
        };
    });
}

/* -------------------- REMATCHES -------------------- */

export function createRaidRematch(
    raidId,
    { deadline = "" } = {}
) {
    return updateState("raid:rematch", draft => {
        const original = findRaid(draft, raidId);

        assert(
            ["failed", "escaped"].includes(original.status),
            "Only a failed or escaped raid can be rematched."
        );

        const existingRematch = draft.raids.find(raid =>
            raid.parentRaidId === original.id &&
            isActive(raid)
        );

        assert(
            !existingRematch,
            "This boss already has an active rematch."
        );

        const data = normalizeRaid({
            name: `${original.name} — Rematch`,
            description: original.description,
            rank: original.rank,

            hp: original.totalHp,
            deadline,

            gold: original.goldReward,
            xp: original.xpReward,
            essence: original.essenceReward,

            failureMode: original.failureMode,
            counterattacks: original.counterattacks,

            tasks: original.tasks.map(task => ({
                id: createId("attack"),
                title: task.title,
                damage: task.damage
            }))
        }, draft);

        const rematch = makeRaid(data, {
            parentRaidId: original.id
        });

        draft.raids.push(rematch);

        appendActivity(draft, {
            type: "raid.rematch-created",
            entityId: rematch.id,

            payload: {
                title: rematch.name,
                originalRaidId: original.id
            }
        });

        return rematch.id;
    });
}

/* -------------------- LOCAL WEEKLY GATE -------------------- */

/*
  This is a solo weekly challenge.
  It is not shared multiplayer or a global world boss.
*/

export function ensureWeeklyGate() {
    const state = getState();
    const period = getWeekStart(today(state));

    const existing = state.raids.find(
        raid => raid.weeklyPeriod === period
    );

    if (existing) return existing.id;

    return updateState("raid:weekly-gate", draft => {
        /*
          Repeat the check inside the transaction.
        */
        const found = draft.raids.find(
            raid => raid.weeklyPeriod === period
        );

        if (found) return found.id;

        const tasks = [
            {
                id: createId("attack"),
                title: "Complete one meaningful focus session",
                damage: 100,
                completed: false,
                completedAt: null
            },
            {
                id: createId("attack"),
                title: "Finish one task you have been avoiding",
                damage: 100,
                completed: false,
                completedAt: null
            },
            {
                id: createId("attack"),
                title: "Review the week and choose the next priority",
                damage: 100,
                completed: false,
                completedAt: null
            }
        ];

        const raid = makeRaid({
            name: "The Weekly Gate",
            description: "Three deliberate actions. One gate cleared.",
            rank: "D",

            totalHp: 300,
            deadline: shiftDateKey(period, 6),

            goldReward: 75,
            xpReward: 100,
            essenceReward: 5,

            failureMode: "none",
            counterattacks: false,

            tasks
        }, {
            weeklyPeriod: period
        });

        draft.raids.push(raid);

        appendActivity(draft, {
            type: "raid.weekly-created",
            entityId: raid.id,

            payload: {
                title: raid.name,
                period
            }
        });

        return raid.id;
    });
}

/* -------------------- SELECTORS -------------------- */

export function getRaidView(raid) {
    return {
        ...clone(raid),

        phase: getRaidPhase(raid),
        lore: getRaidLore(raid),

        completedTasks: raid.tasks.filter(
            task => task.completed
        ).length,

        totalTasks: raid.tasks.length,

        remainingTaskDamage: raid.tasks
            .filter(task => !task.completed)
            .reduce((sum, task) => sum + task.damage, 0),

        active: isActive(raid)
    };
}

export function selectRaids({
    status = "active",
    search = ""
} = {}) {
    const query = search.trim().toLowerCase();

    return getState().raids
        .filter(raid => {
            if (status === "all") return true;

            if (status === "failed") {
                return ["failed", "escaped"].includes(raid.status);
            }

            return raid.status === status;
        })
        .filter(raid =>
            !query ||
            `${raid.name} ${raid.description}`
                .toLowerCase()
                .includes(query)
        )
        .map(getRaidView)
        .sort((a, b) => {
            if (a.deadline && b.deadline) {
                return a.deadline.localeCompare(b.deadline);
            }

            if (a.deadline) return -1;
            if (b.deadline) return 1;

            return b.createdAt.localeCompare(a.createdAt);
        });
}

export function getWeeklyGate() {
    const state = getState();
    const period = getWeekStart(today(state));

    const raid = state.raids.find(
        item => item.weeklyPeriod === period
    );

    return raid ? getRaidView(raid) : null;
}

export function getShadowArmy() {
    return clone(getState().shadows)
        .sort((a, b) =>
            b.recruitedAt.localeCompare(a.recruitedAt)
        );
}

export function getRaidSummary() {
    const raids = getState().raids;

    const active = raids.filter(isActive);

    const deadlines = active
        .map(raid => raid.deadline)
        .filter(Boolean)
        .sort();

    return {
        active: active.length,

        cleared: raids.filter(
            raid => raid.status === "cleared"
        ).length,

        failed: raids.filter(
            raid => ["failed", "escaped"].includes(raid.status)
        ).length,

        nextDeadline: deadlines[0] || null,

        shadows: getState().shadows.length
    };
}