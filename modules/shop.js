/* ==========================================================
   AWAKENED — Shop, wallet, inventory, and consumables
   Depends only on ./state.js
========================================================== */

import {
    getState,
    updateState,
    createId,
    clone,
    nowISO,
    getTrackingDate,
    getWeekStart,
    appendActivity
} from "./state.js";

const MAX_PRICE = 1000000;
const MAX_COOLDOWN = 8760;

const CATALOG = [
    {
        id: "system-freeze",
        name: "Streak Freeze",
        description: "Adds one freeze to your recovery resources.",
        icon: "❄",
        category: "consumable",
        currency: "gold",
        price: 120,
        cooldown: 0,
        effect: "freeze"
    },
    {
        id: "system-shield",
        name: "Penalty Shield",
        description: "Adds one shield for manually protecting a tracking day.",
        icon: "🛡",
        category: "consumable",
        currency: "gold",
        price: 180,
        cooldown: 0,
        effect: "shield"
    },
    {
        id: "system-xp-elixir",
        name: "XP Elixir",
        description: "Grants +20% base XP for 24 hours. Does not stack.",
        icon: "🧪",
        category: "consumable",
        currency: "gold",
        price: 250,
        cooldown: 0,
        effect: "xp-boost"
    },
    {
        id: "title-iron-will",
        name: "Iron Will",
        description: "An equippable title. Cosmetic only.",
        icon: "✦",
        category: "cosmetic",
        slot: "title",
        equipValue: "iron-will",
        currency: "essence",
        price: 30,
        cooldown: 0
    },
    {
        id: "frame-shadow",
        name: "Shadow Frame",
        description: "A shadow-themed profile frame. Cosmetic only.",
        icon: "◈",
        category: "cosmetic",
        slot: "frame",
        equipValue: "shadow",
        currency: "essence",
        price: 25,
        cooldown: 0
    },
    {
        id: "avatar-shadow",
        name: "Shadow Avatar",
        description: "Unlocks the shadow avatar.",
        icon: "♜",
        category: "cosmetic",
        slot: "avatar",
        equipValue: "shadow",
        currency: "crystals",
        price: 10,
        cooldown: 0
    },
    {
        id: "theme-purple",
        name: "Shadow Purple Theme",
        description: "Equip the Shadow Purple appearance.",
        icon: "◇",
        category: "cosmetic",
        slot: "theme",
        equipValue: "shadow-purple",
        currency: "gold",
        price: 200,
        cooldown: 0
    }
];

const DEFAULT_EQUIPMENT = {
    title: {
        value: "awakened",
        name: "The Awakened One"
    },
    frame: {
        value: "default",
        name: "System default"
    },
    avatar: {
        value: "initials",
        name: "Name initials"
    },
    theme: {
        value: null,
        name: "Use settings theme"
    }
};

/* -------------------- UTILITIES -------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function text(value, max) {
    return String(value ?? "").trim().slice(0, max);
}

function integer(value, fallback, min, max) {
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

function requireCurrency(state, currency) {
    assert(
        typeof currency === "string" &&
        Object.hasOwn(state.wallet, currency),
        "Currency not found."
    );
}

function currentWeek(state) {
    return getWeekStart(
        getTrackingDate(new Date(), state.settings.dayStart)
    );
}

function findProduct(state, productId) {
    const product =
        CATALOG.find(item => item.id === productId) ||
        state.shop.customRewards.find(item => item.id === productId);

    assert(product, "This shop item no longer exists.");

    return product;
}

function findInventoryItem(state, inventoryId) {
    const item = state.inventory.items.find(
        entry => entry.id === inventoryId
    );

    assert(item, "Inventory item not found.");

    return item;
}

function ownsProduct(state, productId) {
    return state.inventory.items.some(item =>
        item.productId === productId &&
        item.category === "cosmetic" &&
        item.quantity > 0
    );
}

/* -------------------- CUSTOM CURRENCIES -------------------- */

export function createCurrency({ name, symbol }) {
    const cleanName = text(name, 40);
    const cleanSymbol = text(symbol, 16);

    assert(cleanName, "Currency name is required.");
    assert(cleanSymbol, "Currency symbol is required.");

    return updateState("currency:create", draft => {
        assert(
            !draft.customCurrencies.some(currency =>
                currency.name.toLowerCase() === cleanName.toLowerCase()
            ),
            "A currency with that name already exists."
        );

        const id = createId("currency");

        draft.customCurrencies.push({
            id,
            name: cleanName,
            symbol: cleanSymbol,
            createdAt: nowISO()
        });

        draft.wallet[id] = 0;

        appendActivity(draft, {
            type: "currency.created",
            entityId: id,
            payload: {
                title: cleanName,
                symbol: cleanSymbol
            }
        });

        return id;
    });
}

export function getCurrencies() {
    const state = getState();

    const definitions = [
        { id: "gold", name: "Gold", symbol: "◈" },
        { id: "crystals", name: "Mana Crystals", symbol: "◇" },
        { id: "essence", name: "Shadow Essence", symbol: "✦" },
        ...state.customCurrencies
    ];

    return definitions.map(currency => ({
        ...clone(currency),
        balance: state.wallet[currency.id] || 0
    }));
}

/* -------------------- REAL-LIFE REWARDS -------------------- */

function normalizeReward(input, state) {
    const name = text(input.name, 100);
    const currency = input.currency || "gold";

    assert(name, "Reward name is required.");
    requireCurrency(state, currency);

    return {
        name,
        description: text(input.description, 1000),
        icon: text(input.icon, 16) || "🎁",

        category: "real-life",
        currency,

        price: integer(input.price, 100, 1, MAX_PRICE),
        cooldown: integer(input.cooldown, 0, 0, MAX_COOLDOWN)
    };
}

export function createReward(input) {
    return updateState("shop:create-reward", draft => {
        const reward = {
            id: createId("reward"),
            ...normalizeReward(input, draft),

            createdAt: nowISO(),
            updatedAt: nowISO()
        };

        draft.shop.customRewards.push(reward);

        return reward.id;
    });
}

export function editReward(id, input) {
    updateState("shop:edit-reward", draft => {
        const reward = draft.shop.customRewards.find(
            item => item.id === id
        );

        assert(reward, "Custom reward not found.");

        Object.assign(
            reward,
            normalizeReward({ ...reward, ...input }, draft),
            { updatedAt: nowISO() }
        );

        /*
          Purchased vouchers retain their original product snapshot.
        */
    });
}

export function deleteReward(id) {
    updateState("shop:delete-reward", draft => {
        const reward = draft.shop.customRewards.find(
            item => item.id === id
        );

        assert(reward, "Custom reward not found.");

        draft.shop.customRewards =
            draft.shop.customRewards.filter(item => item.id !== id);

        appendActivity(draft, {
            type: "shop.reward-deleted",
            entityId: id,
            payload: { title: reward.name }
        });
    });
}

/* -------------------- WEEKLY OFFERS -------------------- */

/*
  Deterministic local rotation—not a server-wide live shop.
  All catalog items remain available; selected items get 20% off.
*/

function weeklyOfferIds(state) {
    const period = currentWeek(state);

    const hash = [...period].reduce(
        (sum, character) => sum + character.charCodeAt(0),
        0
    );

    const start = hash % CATALOG.length;

    return [
        CATALOG[start].id,
        CATALOG[(start + 3) % CATALOG.length].id
    ];
}

export function refreshShopRotation() {
    const state = getState();
    const period = currentWeek(state);

    if (state.shop.rotation.period === period) return;

    updateState("shop:refresh-rotation", draft => {
        draft.shop.rotation = {
            period,
            itemIds: weeklyOfferIds(draft)
        };
    });
}

function productPrice(state, product) {
    const weekly = weeklyOfferIds(state).includes(product.id);

    return {
        weekly,
        originalPrice: product.price,
        price: weekly
            ? Math.max(1, Math.floor(product.price * 0.8))
            : product.price
    };
}

/* -------------------- PURCHASE AVAILABILITY -------------------- */

function availability(state, product, at = Date.now()) {
    const pricing = productPrice(state, product);
    const balance = state.wallet[product.currency] || 0;

    const purchases = state.shop.purchases
        .filter(purchase => purchase.productId === product.id)
        .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));

    const latest = purchases[0];

    const nextPurchaseAt = latest && product.cooldown > 0
        ? Date.parse(latest.purchasedAt) +
        product.cooldown * 60 * 60 * 1000
        : null;

    const owned =
        product.category === "cosmetic" &&
        ownsProduct(state, product.id);

    let reason = null;

    if (owned) {
        reason = "Already owned.";
    } else if (nextPurchaseAt && nextPurchaseAt > at) {
        reason = "Reward cooldown is active.";
    } else if (balance < pricing.price) {
        reason = "Not enough currency.";
    }

    return {
        ...pricing,

        balance,
        owned,

        nextPurchaseAt:
            nextPurchaseAt && nextPurchaseAt > at
                ? new Date(nextPurchaseAt).toISOString()
                : null,

        available: reason === null,
        reason
    };
}

/* -------------------- PURCHASING -------------------- */

export function purchaseItem(productId) {
    return updateState("shop:purchase", draft => {
        const product = findProduct(draft, productId);

        requireCurrency(draft, product.currency);

        const status = availability(draft, product);

        assert(status.available, status.reason || "Item unavailable.");

        draft.wallet[product.currency] -= status.price;

        const purchase = {
            id: createId("purchase"),
            productId: product.id,
            purchasedAt: nowISO(),

            price: status.price,
            currency: product.currency,

            /*
              A snapshot preserves meaning after later reward edits.
            */
            product: clone(product)
        };

        draft.shop.purchases.push(purchase);

        let inventoryItem;

        /*
          Consumables stack by product.
          Real-life rewards get one voucher per purchase.
          Cosmetics are permanent single purchases.
        */
        if (product.category === "consumable") {
            inventoryItem = draft.inventory.items.find(item =>
                item.productId === product.id &&
                item.category === "consumable"
            );
        }

        if (inventoryItem) {
            inventoryItem.quantity += 1;
        } else {
            inventoryItem = {
                id: createId("inventory"),

                productId: product.id,
                purchaseId: purchase.id,

                category: product.category,
                name: product.name,
                description: product.description,
                icon: product.icon,

                effect: product.effect || null,
                slot: product.slot || null,
                equipValue: product.equipValue ?? null,

                quantity: 1,
                acquiredAt: nowISO(),

                redeemedAt: null
            };

            draft.inventory.items.push(inventoryItem);
        }

        appendActivity(draft, {
            type: "shop.purchased",
            entityId: product.id,

            payload: {
                title: product.name,
                purchaseId: purchase.id,
                inventoryId: inventoryItem.id,

                price: status.price,
                currency: product.currency
            }
        });

        return {
            purchaseId: purchase.id,
            inventoryId: inventoryItem.id,

            productId: product.id,
            name: product.name,

            price: status.price,
            currency: product.currency
        };
    });
}

/* -------------------- CONSUMABLES -------------------- */

function activeXpBuff(state, timestamp = Date.now()) {
    return state.inventory.buffs.find(buff =>
        buff.type === "xp-boost" &&
        Date.parse(buff.startsAt) <= timestamp &&
        Date.parse(buff.expiresAt) > timestamp
    );
}

/*
  Accept a draft as well as the current frozen state.
  This lets reward engines calculate modifiers atomically.
*/

export function getXpMultiplier(
    state = getState(),
    timestamp = Date.now()
) {
    return activeXpBuff(state, timestamp)?.multiplier || 1;
}

export function useConsumable(inventoryId) {
    return updateState("inventory:consume", draft => {
        const item = findInventoryItem(draft, inventoryId);

        assert(
            item.category === "consumable",
            "This item is not consumable."
        );

        assert(item.quantity > 0, "No quantity remains.");

        let result;

        if (item.effect === "freeze") {
            assert(
                draft.streaks.freezes < 3,
                "You can hold up to three ready-to-use freezes."
            );

            draft.streaks.freezes += 1;

            result = {
                effect: "freeze",
                balance: draft.streaks.freezes
            };
        } else if (item.effect === "shield") {
            draft.streaks.shields += 1;

            result = {
                effect: "shield",
                balance: draft.streaks.shields
            };
        } else if (item.effect === "xp-boost") {
            assert(
                !activeXpBuff(draft),
                "An XP Elixir is already active."
            );

            const startsAt = nowISO();

            const buff = {
                id: createId("buff"),
                type: "xp-boost",
                name: "XP Elixir",

                sourceInventoryId: item.id,
                multiplier: 1.2,

                startsAt,
                expiresAt: new Date(
                    Date.parse(startsAt) + 24 * 60 * 60 * 1000
                ).toISOString()
            };

            draft.inventory.buffs.push(buff);

            result = {
                effect: "xp-boost",
                buff: clone(buff)
            };
        } else {
            throw new Error("This consumable has no supported effect.");
        }

        item.quantity -= 1;

        appendActivity(draft, {
            type: "inventory.consumed",
            entityId: item.id,

            payload: {
                title: item.name,
                effect: item.effect
            }
        });

        return result;
    });
}

export function getActiveBuffs() {
    const now = Date.now();

    return getState().inventory.buffs
        .filter(buff =>
            Date.parse(buff.startsAt) <= now &&
            Date.parse(buff.expiresAt) > now
        )
        .map(buff => ({
            ...clone(buff),

            remainingMs: Math.max(
                0,
                Date.parse(buff.expiresAt) - now
            )
        }));
}

/* -------------------- REAL-LIFE REDEMPTION -------------------- */

export function redeemReward(inventoryId) {
    return updateState("inventory:redeem", draft => {
        const item = findInventoryItem(draft, inventoryId);

        assert(
            item.category === "real-life",
            "This item is not a real-life reward."
        );

        assert(
            item.quantity > 0 && !item.redeemedAt,
            "This voucher has already been redeemed."
        );

        item.quantity = 0;
        item.redeemedAt = nowISO();

        appendActivity(draft, {
            type: "inventory.reward-redeemed",
            entityId: item.id,

            payload: {
                title: item.name,
                purchaseId: item.purchaseId
            }
        });

        return {
            name: item.name,
            redeemedAt: item.redeemedAt
        };
    });
}

/* -------------------- EQUIPMENT -------------------- */

function applyEquipment(draft, slot, value) {
    draft.inventory.equipped[slot] = value;

    if (slot === "title") draft.profile.title = value;
    if (slot === "frame") draft.profile.frame = value;
    if (slot === "avatar") draft.profile.avatar = value;

    /*
      Equipped themes override settings visually in ui.js.
      Unequipping returns to settings.theme.
    */
}

export function equipItem(inventoryId) {
    updateState("inventory:equip", draft => {
        const item = findInventoryItem(draft, inventoryId);

        assert(
            item.category === "cosmetic" && item.quantity > 0,
            "This cosmetic is not owned."
        );

        assert(
            Object.hasOwn(DEFAULT_EQUIPMENT, item.slot),
            "Unknown equipment slot."
        );

        applyEquipment(draft, item.slot, item.equipValue);

        appendActivity(draft, {
            type: "inventory.equipped",
            entityId: item.id,

            payload: {
                title: item.name,
                slot: item.slot,
                value: item.equipValue
            }
        });
    });
}

export function unequipSlot(slot) {
    assert(
        Object.hasOwn(DEFAULT_EQUIPMENT, slot),
        "Unknown equipment slot."
    );

    updateState("inventory:unequip", draft => {
        applyEquipment(
            draft,
            slot,
            DEFAULT_EQUIPMENT[slot].value
        );
    });
}

export function getEquipmentOptions(slot) {
    assert(
        Object.hasOwn(DEFAULT_EQUIPMENT, slot),
        "Unknown equipment slot."
    );

    const state = getState();

    return [
        {
            inventoryId: null,
            value: DEFAULT_EQUIPMENT[slot].value,
            name: DEFAULT_EQUIPMENT[slot].name
        },

        ...state.inventory.items
            .filter(item =>
                item.category === "cosmetic" &&
                item.slot === slot &&
                item.quantity > 0
            )
            .map(item => ({
                inventoryId: item.id,
                value: item.equipValue,
                name: item.name
            }))
    ];
}

/* -------------------- SELECTORS -------------------- */

export function selectShopItems({
    category = "all",
    affordableOnly = false
} = {}) {
    const state = getState();

    return [
        ...CATALOG,
        ...state.shop.customRewards
    ]
        .map(product => ({
            ...clone(product),
            ...availability(state, product)
        }))
        .filter(product => {
            if (category === "weekly") return product.weekly;

            return (
                category === "all" ||
                product.category === category
            );
        })
        .filter(product =>
            !affordableOnly || product.balance >= product.price
        );
}

export function selectInventory({
    category = "all"
} = {}) {
    const state = getState();

    return state.inventory.items
        .filter(item => item.quantity > 0)
        .filter(item => {
            if (category === "all") return true;

            if (category === "reward") {
                return item.category === "real-life";
            }

            if (
                ["title", "frame", "avatar", "theme"].includes(category)
            ) {
                return (
                    item.category === "cosmetic" &&
                    item.slot === category
                );
            }

            return item.category === category;
        })
        .map(item => ({
            ...clone(item),

            equipped:
                item.category === "cosmetic" &&
                state.inventory.equipped[item.slot] === item.equipValue
        }));
}

export function getPurchaseHistory() {
    return clone(getState().shop.purchases)
        .sort((a, b) =>
            b.purchasedAt.localeCompare(a.purchasedAt)
        );
}

export function getShopSummary() {
    const state = getState();

    return {
        purchases: state.shop.purchases.length,

        availableVouchers: state.inventory.items
            .filter(item =>
                item.category === "real-life" &&
                item.quantity > 0
            )
            .reduce((sum, item) => sum + item.quantity, 0),

        consumables: state.inventory.items
            .filter(item => item.category === "consumable")
            .reduce((sum, item) => sum + item.quantity, 0),

        cosmetics: state.inventory.items.filter(item =>
            item.category === "cosmetic" &&
            item.quantity > 0
        ).length,

        activeBuffs: getActiveBuffs().length
    };
}