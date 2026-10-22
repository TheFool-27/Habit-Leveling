/* ==========================================================
   AWAKENED — Shared state and persistence

   All state changes go through updateState().
   Feature modules must not write directly to localStorage.
========================================================== */

export const SCHEMA_VERSION = 1;

export const STORAGE_KEY = "awakened:state:v1";
export const LEGACY_STORAGE_KEY = "awakened_system_v1";

export const STAT_KEYS = Object.freeze([
    "str",
    "int",
    "agi",
    "wil",
    "vit",
    "cha",
    "cre",
    "dis",
    "lck"
]);

export const STAT_INFO = deepFreeze({
    str: { name: "STR", label: "Fitness", icon: "💪" },
    int: { name: "INT", label: "Study", icon: "📚" },
    agi: { name: "AGI", label: "Speed", icon: "⚡" },
    wil: { name: "WIL", label: "Focus", icon: "👁" },
    vit: { name: "VIT", label: "Health", icon: "🛡" },
    cha: { name: "CHA", label: "Social", icon: "💬" },
    cre: { name: "CRE", label: "Creativity", icon: "🎨" },
    dis: { name: "DIS", label: "Discipline", icon: "🎯" },
    lck: { name: "LCK", label: "Fortune", icon: "🍀" }
});

export const RANK_REWARDS = deepFreeze({
    E: { xp: 20, gold: 10 },
    D: { xp: 40, gold: 18 },
    C: { xp: 70, gold: 30 },
    B: { xp: 110, gold: 50 },
    A: { xp: 160, gold: 80 },
    S: { xp: 250, gold: 130 }
});

const COLLECTION_KEYS = [
    "quests",
    "raids",
    "activity",
    "journal",
    "focusSessions",
    "challenges",
    "achievements",
    "shadows"
];

const subscribers = new Set();
const statusSubscribers = new Set();

let currentState = deepFreeze(createDefaultState());
let initialized = false;
let updating = false;
let storageListenerAttached = false;

/*
  The serialized value this tab expects to find in storage.
  A mismatch blocks writes until the conflict is resolved.
*/
let expectedStoredValue = null;

let persistenceStatus = Object.freeze({
    mode: "initializing",
    message: "Storage initializing."
});

/* -------------------- GENERAL UTILITIES -------------------- */

export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }

    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

export function createId(prefix = "id") {
    const randomId = globalThis.crypto?.randomUUID?.();

    if (randomId) {
        return `${prefix}_${randomId}`;
    }

    return [
        prefix,
        Date.now().toString(36),
        Math.random().toString(36).slice(2),
        Math.random().toString(36).slice(2)
    ].join("_");
}

export function nowISO() {
    return new Date().toISOString();
}

export function isRecord(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertNumber(value, path, options = {}) {
    const { min = 0, integer = false } = options;

    assert(
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        (!integer || Number.isInteger(value)),
        `Invalid number at ${path}.`
    );
}

function notify(listeners, ...args) {
    for (const listener of [...listeners]) {
        try {
            listener(...args);
        } catch (error) {
            console.error("AWAKENED subscriber failed:", error);
        }
    }
}

function setPersistenceStatus(mode, message) {
    persistenceStatus = Object.freeze({ mode, message });
    notify(statusSubscribers, persistenceStatus);
}

/* -------------------- LOCAL CALENDAR HELPERS -------------------- */

export function dateKey(value = new Date()) {
    const date = new Date(value);

    assert(
        Number.isFinite(date.getTime()),
        "Cannot create a date key from an invalid date."
    );

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

export function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day, 12);

    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    );
}

export function parseDateKey(key) {
    assert(isDateKey(key), `Invalid calendar date: ${key}`);

    const [year, month, day] = key.split("-").map(Number);

    // Local noon avoids most midnight daylight-saving transitions.
    return new Date(year, month - 1, day, 12);
}

export function shiftDateKey(key, amount) {
    assert(Number.isInteger(amount), "Day offset must be an integer.");

    const date = parseDateKey(key);
    date.setDate(date.getDate() + amount);

    return dateKey(date);
}

export function dayDifference(first, second) {
    assert(isDateKey(first) && isDateKey(second), "Invalid date comparison.");

    const [aYear, aMonth, aDay] = first.split("-").map(Number);
    const [bYear, bMonth, bDay] = second.split("-").map(Number);

    const a = Date.UTC(aYear, aMonth - 1, aDay);
    const b = Date.UTC(bYear, bMonth - 1, bDay);

    return Math.round((b - a) / 86400000);
}

export function isTime(value) {
    return (
        typeof value === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    );
}

/*
  Tracking days are local calendar days with a configured boundary.

  At 02:00 with a 04:00 boundary, the tracking date is yesterday.
  We compare local clock time instead of subtracting fixed hours.
*/
export function getTrackingDate(
    value = new Date(),
    dayStart = currentState.settings.dayStart
) {
    const date = new Date(value);

    assert(Number.isFinite(date.getTime()), "Invalid tracking timestamp.");
    assert(isTime(dayStart), "Invalid tracking-day boundary.");

    const [hours, minutes] = dayStart.split(":").map(Number);

    const clockMinutes = date.getHours() * 60 + date.getMinutes();
    const boundaryMinutes = hours * 60 + minutes;

    if (clockMinutes < boundaryMinutes) {
        date.setDate(date.getDate() - 1);
    }

    return dateKey(date);
}

export function getWeekStart(key) {
    const date = parseDateKey(key);
    const offset = (date.getDay() + 6) % 7;

    return shiftDateKey(key, -offset);
}

export function getMonthStart(key) {
    assert(isDateKey(key), "Invalid month date.");
    return `${key.slice(0, 7)}-01`;
}

export function getPeriodKey(
    frequency,
    key = getTrackingDate()
) {
    assert(isDateKey(key), "Invalid period date.");

    if (frequency === "weekly") {
        return `week:${getWeekStart(key)}`;
    }

    if (frequency === "monthly") {
        return `month:${key.slice(0, 7)}`;
    }

    if (frequency === "once") {
        return "once";
    }

    return `day:${key}`;
}

/* -------------------- DEFAULT STATE -------------------- */

export function createDefaultState() {
    const timestamp = nowISO();

    return {
        schemaVersion: SCHEMA_VERSION,

        meta: {
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastAction: "created",
            onboardingComplete: false
        },

        profile: {
            name: "Shadow Hunter",
            avatar: "initials",
            title: "awakened",
            frame: "default",
            classId: null,
            mainGoal: "discipline",

            level: 1,
            xp: 0,
            prestige: 0,

            hp: 100,
            maxHp: 100,

            energy: 100,
            maxEnergy: 100,

            statPoints: 0,
            skillPoints: 0,

            stats: Object.fromEntries(
                STAT_KEYS.map(key => [key, 10])
            ),

            unlockedSkills: []
        },

        wallet: {
            gold: 0,
            crystals: 0,
            essence: 0
        },

        customCurrencies: [],

        /*
          Quest definitions live here.
          Individual tracking periods live in questPeriods.
    
          Feature modules will define each entity's full shape.
        */
        quests: [],
        questPeriods: {},

        raids: [],

        shop: {
            customRewards: [],
            purchases: [],
            rotation: {
                period: null,
                itemIds: []
            }
        },

        inventory: {
            items: [],
            buffs: [],
            equipped: {
                title: "awakened",
                frame: "default",
                avatar: "initials",
                theme: null
            }
        },

        streaks: {
            current: 0,
            best: 0,
            lastQualifiedDate: null,
            lastProcessedDate: null,

            freezes: 1,
            shields: 0,

            protectedDates: [],
            recoveries: []
        },

        /*
          Day records hold evaluation outcomes, rest decisions,
          snapshots, and idempotency markers.
    
          Activity is the historical event ledger.
        */
        days: {},
        activity: [],

        focus: {
            activeSession: null,
            preset: "25-5",
            focusMinutes: 25,
            breakMinutes: 5,
            ambient: "off",
            volume: 25,
            autoBreak: false
        },

        focusSessions: [],
        journal: [],
        challenges: [],
        achievements: [],
        shadows: [],

        /*
          Claim keys prevent the same milestone, evaluation,
          or reward period from being awarded more than once.
        */
        claims: {},

        totals: {
            questsCompleted: 0,
            xpEarned: 0,
            goldEarned: 0,
            raidsCleared: 0,
            focusMinutes: 0,
            perfectDays: 0
        },

        settings: {
            theme: "system-blue",
            accent: "#38bdf8",
            density: "comfortable",
            font: "system",
            cardStyle: "glass",

            particles: true,
            scanlines: false,
            reducedMotion: false,

            sfx: false,
            voice: false,
            haptics: false,
            confetti: true,

            dayStart: "04:00",
            backfillDays: 1,
            difficulty: "normal",

            autoFreeze: true,
            penalties: false,

            inAppReminders: true,
            eveningReview: true,
            weeklySummary: true,

            quietStart: "22:00",
            quietEnd: "07:00"
        }
    };
}

/* -------------------- VALIDATION -------------------- */

/*
  Store validation protects the shared structure.
  Feature modules still validate their entity-specific fields.
*/

function assertUniqueIds(items, path) {
    const seen = new Set();

    for (const item of items) {
        assert(isRecord(item), `Invalid record in ${path}.`);

        assert(
            typeof item.id === "string" &&
            item.id.length > 0 &&
            item.id.length <= 200,
            `Missing or invalid ID in ${path}.`
        );

        assert(!seen.has(item.id), `Duplicate ID in ${path}: ${item.id}`);
        seen.add(item.id);
    }
}

export function validateState(candidate) {
    assert(isRecord(candidate), "State must be an object.");

    assert(
        candidate.schemaVersion === SCHEMA_VERSION,
        "Unsupported state schema."
    );

    for (const key of [
        "meta",
        "profile",
        "wallet",
        "questPeriods",
        "shop",
        "inventory",
        "streaks",
        "days",
        "focus",
        "claims",
        "totals",
        "settings"
    ]) {
        assert(isRecord(candidate[key]), `Missing state section: ${key}`);
    }

    for (const key of COLLECTION_KEYS) {
        assert(Array.isArray(candidate[key]), `${key} must be an array.`);
        assertUniqueIds(candidate[key], key);
    }

    assert(
        Array.isArray(candidate.customCurrencies),
        "customCurrencies must be an array."
    );
    assertUniqueIds(candidate.customCurrencies, "customCurrencies");

    const profile = candidate.profile;

    assert(
        typeof profile.name === "string" &&
        profile.name.trim().length > 0 &&
        profile.name.length <= 40,
        "Hunter name must contain 1–40 characters."
    );

    assert(isRecord(profile.stats), "Missing character stats.");

    for (const stat of STAT_KEYS) {
        assertNumber(profile.stats[stat], `profile.stats.${stat}`);
    }

    for (const key of [
        "level",
        "prestige",
        "statPoints",
        "skillPoints"
    ]) {
        assertNumber(profile[key], `profile.${key}`, {
            min: key === "level" ? 1 : 0,
            integer: true
        });
    }

    for (const key of [
        "xp",
        "hp",
        "maxHp",
        "energy",
        "maxEnergy"
    ]) {
        assertNumber(profile[key], `profile.${key}`);
    }

    assert(profile.maxHp > 0, "Maximum HP must be positive.");
    assert(profile.maxEnergy > 0, "Maximum energy must be positive.");
    assert(profile.hp <= profile.maxHp, "HP exceeds maximum HP.");
    assert(
        profile.energy <= profile.maxEnergy,
        "Energy exceeds maximum energy."
    );

    assert(
        Array.isArray(profile.unlockedSkills),
        "unlockedSkills must be an array."
    );

    for (const amount of Object.values(candidate.wallet)) {
        assertNumber(amount, "wallet balance");
    }

    for (const key of ["gold", "crystals", "essence"]) {
        assertNumber(candidate.wallet[key], `wallet.${key}`);
    }

    for (const [key, amount] of Object.entries(candidate.totals)) {
        assertNumber(amount, `totals.${key}`);
    }

    assertNumber(candidate.meta.revision, "meta.revision", {
        integer: true
    });

    assert(
        Array.isArray(candidate.shop.customRewards) &&
        Array.isArray(candidate.shop.purchases),
        "Invalid shop collections."
    );

    assertUniqueIds(candidate.shop.customRewards, "shop.customRewards");
    assertUniqueIds(candidate.shop.purchases, "shop.purchases");

    assert(
        Array.isArray(candidate.inventory.items) &&
        Array.isArray(candidate.inventory.buffs),
        "Invalid inventory collections."
    );

    assertUniqueIds(candidate.inventory.items, "inventory.items");
    assertUniqueIds(candidate.inventory.buffs, "inventory.buffs");

    assert(
        isRecord(candidate.inventory.equipped),
        "Invalid equipped items."
    );

    for (const key of ["current", "best", "freezes", "shields"]) {
        assertNumber(candidate.streaks[key], `streaks.${key}`, {
            integer: true
        });
    }

    assert(
        Array.isArray(candidate.streaks.protectedDates) &&
        Array.isArray(candidate.streaks.recoveries),
        "Invalid streak history."
    );

    for (const key of Object.keys(candidate.days)) {
        assert(isDateKey(key), `Invalid day record key: ${key}`);
        assert(isRecord(candidate.days[key]), "Invalid day record.");
    }

    assert(isTime(candidate.settings.dayStart), "Invalid day-start time.");
    assert(isTime(candidate.settings.quietStart), "Invalid quiet start.");
    assert(isTime(candidate.settings.quietEnd), "Invalid quiet end.");

    assert(
        [0, 1, 3, 7].includes(candidate.settings.backfillDays),
        "Unsupported backfill allowance."
    );

    assert(
        /^#[0-9a-f]{6}$/i.test(candidate.settings.accent),
        "Invalid accent color."
    );

    for (const key of [
        "particles",
        "scanlines",
        "reducedMotion",
        "sfx",
        "voice",
        "haptics",
        "confetti",
        "autoFreeze",
        "penalties",
        "inAppReminders",
        "eveningReview",
        "weeklySummary"
    ]) {
        assert(
            typeof candidate.settings[key] === "boolean",
            `Invalid settings flag: ${key}`
        );
    }

    return true;
}

/* Reject non-JSON values and prototype-related keys in imports. */

function assertSafeJson(value, depth = 0) {
    assert(depth <= 60, "Backup nesting is too deep.");

    if (value === null) return;

    if (typeof value === "number") {
        assert(Number.isFinite(value), "Non-finite number in data.");
        return;
    }

    if (typeof value === "string" || typeof value === "boolean") {
        return;
    }

    if (Array.isArray(value)) {
        value.forEach(item => assertSafeJson(item, depth + 1));
        return;
    }

    assert(isRecord(value), "Data contains a non-JSON value.");

    for (const [key, child] of Object.entries(value)) {
        assert(
            !["__proto__", "prototype", "constructor"].includes(key),
            "Unsafe property in data."
        );

        assertSafeJson(child, depth + 1);
    }
}

/* -------------------- SCHEMA MIGRATIONS -------------------- */

function migrateState(raw) {
    assertSafeJson(raw);

    assert(
        Number.isInteger(raw?.schemaVersion),
        "Backup is missing its schema version."
    );

    if (raw.schemaVersion > SCHEMA_VERSION) {
        throw new Error(
            "This data was created by a newer application version."
        );
    }

    /*
      Future migrations go here:
  
      if (raw.schemaVersion === 1) {
        raw = migrateV1ToV2(raw);
      }
  
      The previous prototype used a different, incompatible schema.
      We do not silently reinterpret its totals or reward history.
    */

    assert(
        raw.schemaVersion === SCHEMA_VERSION,
        "No migration exists for this data version."
    );

    validateState(raw);
    return clone(raw);
}

/* -------------------- STORAGE INITIALIZATION -------------------- */

export function initStore() {
    if (initialized) {
        return getPersistenceStatus();
    }

    initialized = true;

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        expectedStoredValue = raw;

        if (raw !== null) {
            const loaded = migrateState(JSON.parse(raw));
            currentState = deepFreeze(loaded);

            setPersistenceStatus("saved", "Local progress loaded.");
        } else {
            const legacyExists =
                localStorage.getItem(LEGACY_STORAGE_KEY) !== null;

            setPersistenceStatus(
                "ready",
                legacyExists
                    ? "New store ready. Previous prototype data is preserved separately."
                    : "New local store ready."
            );
        }
    } catch (error) {
        /*
          Do not overwrite unreadable data with an empty state.
          Updates stay blocked until an explicit recovery action.
        */
        setPersistenceStatus(
            "blocked",
            `Local data could not be loaded: ${error.message}`
        );
    }

    if (!storageListenerAttached && typeof window !== "undefined") {
        window.addEventListener("storage", handleStorageEvent);
        storageListenerAttached = true;
    }

    return getPersistenceStatus();
}

export function getState() {
    return currentState;
}

export function getPersistenceStatus() {
    return persistenceStatus;
}

export function subscribe(listener, { immediate = false } = {}) {
    assert(typeof listener === "function", "Subscriber must be a function.");

    subscribers.add(listener);

    if (immediate) {
        listener(currentState, {
            label: "initial",
            persisted: persistenceStatus.mode === "saved"
        });
    }

    return () => subscribers.delete(listener);
}

export function subscribePersistence(
    listener,
    { immediate = false } = {}
) {
    assert(typeof listener === "function", "Subscriber must be a function.");

    statusSubscribers.add(listener);

    if (immediate) {
        listener(persistenceStatus);
    }

    return () => statusSubscribers.delete(listener);
}

/* -------------------- TRANSACTIONAL UPDATES -------------------- */

/*
  Mutate only the draft supplied to this callback.

  Example:
    updateState("profile:rename", draft => {
      draft.profile.name = "New Name";
    });

  Updates are synchronous. Async callbacks are rejected.
  Failed validation or persistence leaves currentState unchanged.
*/

export function updateState(label, updater) {
    assert(initialized, "Call initStore() before updating state.");
    assert(!updating, "Nested state transactions are not supported.");
    assert(typeof updater === "function", "Updater must be a function.");

    assert(
        !["blocked", "conflict"].includes(persistenceStatus.mode),
        "Resolve the storage problem before changing progress."
    );

    updating = true;

    try {
        const draft = clone(currentState);
        const result = updater(draft);

        assert(
            !result || typeof result.then !== "function",
            "State updaters must be synchronous."
        );

        draft.schemaVersion = SCHEMA_VERSION;
        draft.meta.revision = currentState.meta.revision + 1;
        draft.meta.updatedAt = nowISO();
        draft.meta.lastAction = String(label || "update").slice(0, 160);

        assertSafeJson(draft);
        validateState(draft);

        const serialized = JSON.stringify(draft);

        persistSerialized(serialized);

        currentState = deepFreeze(draft);

        /*
          Release the transaction before notifying subscribers.
          Rendering subscribers should normally remain read-only.
        */
        updating = false;

        notify(subscribers, currentState, {
            label: draft.meta.lastAction,
            persisted: true
        });

        return result;
    } finally {
        updating = false;
    }
}

function persistSerialized(serialized) {
    try {
        const actualStoredValue = localStorage.getItem(STORAGE_KEY);

        if (actualStoredValue !== expectedStoredValue) {
            setPersistenceStatus(
                "conflict",
                "Progress changed in another tab. Reload stored progress before continuing."
            );

            throw new Error("Storage conflict detected.");
        }

        localStorage.setItem(STORAGE_KEY, serialized);
        expectedStoredValue = serialized;

        setPersistenceStatus("saved", "Progress saved on this device.");
    } catch (error) {
        if (persistenceStatus.mode !== "conflict") {
            setPersistenceStatus(
                "error",
                "Save failed. The requested change was not applied."
            );
        }

        throw error;
    }
}

/*
  Browser localStorage is not a database transaction across tabs.
  This detects common conflicts, but simultaneous writes can still race.
  Use a single active editing tab for this local version.
*/

function handleStorageEvent(event) {
    if (
        event.storageArea !== localStorage ||
        (event.key !== STORAGE_KEY && event.key !== null)
    ) {
        return;
    }

    if (event.newValue === expectedStoredValue && event.key !== null) {
        return;
    }

    setPersistenceStatus(
        "conflict",
        "Another tab changed or removed local progress. Reload before editing."
    );
}

export function reloadFromStorage() {
    assert(!updating, "Cannot reload during a transaction.");

    try {
        const raw = localStorage.getItem(STORAGE_KEY);

        assert(
            raw !== null,
            "No saved state exists. Import a backup or explicitly reset."
        );

        const loaded = migrateState(JSON.parse(raw));

        currentState = deepFreeze(loaded);
        expectedStoredValue = raw;

        setPersistenceStatus("saved", "Latest local progress loaded.");

        notify(subscribers, currentState, {
            label: "storage:reload",
            persisted: true
        });

        return currentState;
    } catch (error) {
        setPersistenceStatus(
            "blocked",
            `Reload failed: ${error.message}`
        );

        throw error;
    }
}

/* -------------------- DAY RECORDS -------------------- */

export function ensureDay(draft, key = getTrackingDate()) {
    assert(isDateKey(key), "Invalid tracking day.");

    if (!draft.days[key]) {
        draft.days[key] = {
            date: key,
            status: "open",

            evaluatedAt: null,
            scheduledQuestIds: [],
            completedQuestIds: [],

            rest: null,
            protection: null,

            xpEarned: 0,
            goldEarned: 0,
            focusMinutes: 0,

            perfectDayClaimed: false
        };
    }

    return draft.days[key];
}

/* -------------------- ACTIVITY LEDGER -------------------- */

/*
  Event example:

  {
    type: "quest.completed",
    entityId: quest.id,
    trackingDate: "2026-10-17",
    periodKey: "day:2026-10-17",
    payload: {
      title: "Read 20 pages",
      xp: 40,
      gold: 18
    }
  }

  Store a title snapshot so later quest edits/deletion do not
  erase the meaning of historical records.
*/

export function appendActivity(draft, event) {
    assert(isRecord(event), "Activity must be an object.");

    assert(
        typeof event.type === "string" && event.type.length > 0,
        "Activity requires a type."
    );

    const trackingDate =
        event.trackingDate ||
        getTrackingDate(new Date(), draft.settings.dayStart);

    assert(isDateKey(trackingDate), "Invalid activity date.");

    const record = {
        id: createId("event"),
        type: event.type,
        entityId: event.entityId ?? null,
        trackingDate,
        periodKey: event.periodKey ?? null,
        occurredAt: nowISO(),
        payload: clone(event.payload ?? {}),
        reversedBy: null
    };

    draft.activity.push(record);

    return record;
}

/*
  Reversal records preserve history.

  Feature modules must reverse the matching XP, wallet, progress,
  and claim effects inside the same updateState transaction.
  This helper only links the historical records.
*/

export function markActivityReversed(draft, eventId, reversalId) {
    const event = draft.activity.find(item => item.id === eventId);

    assert(event, "Original activity was not found.");
    assert(!event.reversedBy, "This activity has already been reversed.");

    assert(
        draft.activity.some(item => item.id === reversalId),
        "Reversal activity was not found."
    );

    event.reversedBy = reversalId;
}

export function selectActivity({
    type,
    entityId,
    from,
    to,
    includeReversed = false
} = {}) {
    return currentState.activity.filter(event => {
        if (!includeReversed && event.reversedBy) return false;
        if (type && event.type !== type) return false;
        if (entityId && event.entityId !== entityId) return false;
        if (from && event.trackingDate < from) return false;
        if (to && event.trackingDate > to) return false;

        return true;
    });
}

/* -------------------- IDEMPOTENT CLAIMS -------------------- */

export function hasClaim(draft, key) {
    return Object.hasOwn(draft.claims, key);
}

export function claimOnce(draft, key, details = {}) {
    assert(
        typeof key === "string" && key.length > 0,
        "Claim key is required."
    );

    assert(
        !["__proto__", "prototype", "constructor"].includes(key),
        "Invalid claim key."
    );

    if (hasClaim(draft, key)) {
        return false;
    }

    draft.claims[key] = {
        claimedAt: nowISO(),
        details: clone(details)
    };

    return true;
}

/* -------------------- BACKUP / RESTORE -------------------- */

export function createBackup() {
    return {
        app: "AWAKENED",
        format: 1,
        exportedAt: nowISO(),
        state: clone(currentState)
    };
}

export function serializeBackup() {
    return JSON.stringify(createBackup(), null, 2);
}

export function validateBackup(input) {
    let parsed;

    if (typeof input === "string") {
        assert(
            input.length <= 20_000_000,
            "Backup is too large for this importer."
        );

        parsed = JSON.parse(input);
    } else {
        parsed = input;
    }

    assertSafeJson(parsed);

    assert(
        parsed?.app === "AWAKENED" && parsed?.format === 1,
        "This is not a supported AWAKENED backup."
    );

    return migrateState(parsed.state);
}

/*
  Call only after the UI shows an import preview and the
  user explicitly confirms replacing current progress.
*/

export function restoreBackup(input) {
    assert(initialized, "Initialize the store before importing.");
    assert(!updating, "Cannot import during a transaction.");

    const restored = validateBackup(input);

    /*
      Preserve imported history; start a new local revision.
    */
    restored.meta.revision = currentState.meta.revision + 1;
    restored.meta.updatedAt = nowISO();
    restored.meta.lastAction = "backup:restore";

    const serialized = JSON.stringify(restored);

    /*
      Explicit restoration may recover a blocked/corrupt store.
      Conflicting live tabs still require a deliberate reload first.
    */
    assert(
        persistenceStatus.mode !== "conflict",
        "Resolve the tab conflict before importing."
    );

    persistSerialized(serialized);

    currentState = deepFreeze(restored);

    notify(subscribers, currentState, {
        label: "backup:restore",
        persisted: true
    });

    return currentState;
}

/*
  Call only after typed confirmation in the UI.
  This resets the new store, not the separately preserved prototype.
*/

export function resetStore(confirmation) {
    assert(
        confirmation === "RESET AWAKENED",
        "Type RESET AWAKENED to confirm the reset."
    );

    assert(initialized, "Initialize the store before resetting.");
    assert(!updating, "Cannot reset during a transaction.");

    assert(
        persistenceStatus.mode !== "conflict",
        "Resolve the tab conflict before resetting."
    );

    const fresh = createDefaultState();
    const serialized = JSON.stringify(fresh);

    persistSerialized(serialized);

    currentState = deepFreeze(fresh);

    notify(subscribers, currentState, {
        label: "store:reset",
        persisted: true
    });

    return currentState;
}