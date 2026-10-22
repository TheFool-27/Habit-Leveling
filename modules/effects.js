/* ==========================================================
   AWAKENED — Visual and audio feedback
   Depends only on ./state.js

   No external libraries, fonts, sounds, or network requests.
========================================================== */

import {
    getState,
    subscribe
} from "./state.js";

/* -------------------- MODULE STATE -------------------- */

let initialized = false;
let unsubscribe = null;

let audioContext = null;
let audioUnlocked = false;
let ambientSource = null;
let ambientGain = null;
let ambientKey = null;
let ambientRequest = 0;

let particleCanvas = null;
let particleContext = null;
let particleFrame = null;
let particles = [];
let particleWidth = 0;
let particleHeight = 0;
let particleLastFrame = 0;

let motionQuery = null;

const cleanupCallbacks = [];
const transientElements = new Set();
const celebrationStops = new Set();

const SOUND_PATTERNS = {
    progress: [
        [520, 0, 0.08, "sine"]
    ],

    complete: [
        [660, 0, 0.12, "sine"],
        [880, 0.1, 0.16, "sine"]
    ],

    purchase: [
        [740, 0, 0.1, "triangle"],
        [980, 0.09, 0.14, "triangle"]
    ],

    level: [
        [440, 0, 0.17, "triangle"],
        [554, 0.12, 0.17, "triangle"],
        [659, 0.24, 0.17, "triangle"],
        [880, 0.36, 0.25, "triangle"]
    ],

    hit: [
        [150, 0, 0.13, "triangle"]
    ],

    warning: [
        [220, 0, 0.15, "triangle"],
        [180, 0.18, 0.2, "triangle"]
    ],

    focus: [
        [620, 0, 0.18, "sine"],
        [820, 0.22, 0.25, "sine"]
    ]
};

const VOICE_LINES = {
    complete: "Quest complete.",
    level: "Level up.",
    raid: "Gate cleared.",
    focus: "Focus session complete.",
    recovery: "Recovery complete."
};

/* -------------------- PREFERENCE HELPERS -------------------- */

export function prefersReducedMotion() {
    return Boolean(
        getState().settings.reducedMotion ||
        motionQuery?.matches
    );
}

function accentColor() {
    return getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#38bdf8";
}

function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);

    cleanupCallbacks.push(() => {
        target.removeEventListener(type, handler, options);
    });
}

function isVisible() {
    return document.visibilityState === "visible";
}

/* -------------------- AUDIO INITIALIZATION -------------------- */

/*
  Call unlockAudio() directly from a click/tap/key event.
  Do not depend on autoplay at application startup.
*/

export async function unlockAudio() {
    const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return false;

    try {
        if (!audioContext || audioContext.state === "closed") {
            audioContext = new AudioContextClass();
        }

        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        audioUnlocked = audioContext.state === "running";

        return audioUnlocked;
    } catch (error) {
        console.warn("Audio could not be enabled:", error);
        return false;
    }
}

function playTone(
    frequency,
    delay,
    duration,
    waveform
) {
    if (
        !audioContext ||
        audioContext.state !== "running"
    ) {
        return;
    }

    const start = audioContext.currentTime + delay;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(
        0.045,
        start + 0.01
    );

    gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
    };

    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
}

export function playSound(name) {
    if (
        !getState().settings.sfx ||
        !audioUnlocked ||
        !isVisible()
    ) {
        return false;
    }

    const pattern = SOUND_PATTERNS[name];

    if (!pattern) return false;

    pattern.forEach(args => playTone(...args));

    return true;
}

/* -------------------- AMBIENT AUDIO -------------------- */

function buildNoiseBuffer(type) {
    const duration = 4;
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * duration;

    const buffer = audioContext.createBuffer(
        1,
        length,
        sampleRate
    );

    const data = buffer.getChannelData(0);

    let lastBrownSample = 0;

    for (let index = 0; index < length; index += 1) {
        const white = Math.random() * 2 - 1;

        if (type === "brown-noise") {
            lastBrownSample =
                (lastBrownSample + white * 0.02) / 1.02;

            data[index] = lastBrownSample * 3.5;
        } else {
            /*
              Synthesized rain-like noise texture.
              This is not a recorded rainfall sound.
            */
            const seconds = index / sampleRate;

            const envelope =
                0.55 +
                Math.sin(seconds * Math.PI * 0.5) * 0.05;

            data[index] = white * envelope;
        }
    }

    return buffer;
}

export function stopAmbient() {
    ambientRequest += 1;

    if (ambientSource) {
        try {
            ambientSource.stop();
        } catch {
            // A source may already have stopped.
        }

        ambientSource.disconnect();
    }

    if (ambientGain) {
        ambientGain.disconnect();
    }

    ambientSource = null;
    ambientGain = null;
    ambientKey = null;
}

export function setAmbientVolume(volume) {
    if (!ambientGain || !audioContext) return;

    const normalized = Math.max(
        0,
        Math.min(100, Number(volume) || 0)
    ) / 100;

    ambientGain.gain.setTargetAtTime(
        normalized * 0.12,
        audioContext.currentTime,
        0.08
    );
}

export async function startAmbient(
    type = getState().focus.ambient,
    volume = getState().focus.volume
) {
    const supported = [
        "off",
        "rain",
        "brown-noise",
        "system-hum"
    ];

    if (!supported.includes(type)) {
        throw new Error("Unknown ambient sound.");
    }

    if (type === "off") {
        stopAmbient();
        return false;
    }

    if (!isVisible()) return false;

    if (
        ambientKey === type &&
        ambientSource &&
        audioContext?.state === "running"
    ) {
        setAmbientVolume(volume);
        return true;
    }

    stopAmbient();

    const request = ambientRequest;

    const enabled = await unlockAudio();

    if (
        !enabled ||
        request !== ambientRequest ||
        !isVisible()
    ) {
        return false;
    }

    ambientGain = audioContext.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(audioContext.destination);

    if (type === "system-hum") {
        const oscillator = audioContext.createOscillator();

        oscillator.type = "sine";
        oscillator.frequency.value = 90;

        ambientSource = oscillator;
    } else {
        const source = audioContext.createBufferSource();

        source.buffer = buildNoiseBuffer(type);
        source.loop = true;

        ambientSource = source;
    }

    ambientSource.connect(ambientGain);
    ambientSource.start();

    ambientKey = type;

    setAmbientVolume(volume);

    return true;
}

/* -------------------- BACKGROUND PARTICLES -------------------- */

function stopParticles() {
    if (particleFrame !== null) {
        cancelAnimationFrame(particleFrame);
        particleFrame = null;
    }

    particleLastFrame = 0;

    particleContext?.clearRect(
        0,
        0,
        particleWidth,
        particleHeight
    );
}

function resizeParticles() {
    if (!particleCanvas || !particleContext) return;

    particleWidth = window.innerWidth;
    particleHeight = window.innerHeight;

    const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        2
    );

    particleCanvas.width = Math.round(
        particleWidth * pixelRatio
    );

    particleCanvas.height = Math.round(
        particleHeight * pixelRatio
    );

    particleContext.setTransform(
        pixelRatio,
        0,
        0,
        pixelRatio,
        0,
        0
    );

    const count = Math.min(
        45,
        Math.max(
            12,
            Math.floor(
                particleWidth * particleHeight / 35000
            )
        )
    );

    particles = Array.from({ length: count }, () => ({
        x: Math.random() * particleWidth,
        y: Math.random() * particleHeight,

        radius: 0.6 + Math.random() * 1.2,
        speed: 4 + Math.random() * 10,
        opacity: 0.1 + Math.random() * 0.25
    }));
}

function shouldAnimateParticles() {
    return Boolean(
        particleContext &&
        getState().settings.particles &&
        !prefersReducedMotion() &&
        isVisible()
    );
}

function drawParticles(timestamp) {
    particleFrame = null;

    if (!shouldAnimateParticles()) return;

    /*
      Cap drawing at approximately 30 FPS.
    */
    if (
        particleLastFrame &&
        timestamp - particleLastFrame < 32
    ) {
        particleFrame = requestAnimationFrame(drawParticles);
        return;
    }

    const delta = particleLastFrame
        ? Math.min((timestamp - particleLastFrame) / 1000, 0.1)
        : 1 / 30;

    particleLastFrame = timestamp;

    particleContext.clearRect(
        0,
        0,
        particleWidth,
        particleHeight
    );

    particleContext.fillStyle = accentColor();

    for (const particle of particles) {
        particle.y -= particle.speed * delta;

        if (particle.y < -5) {
            particle.y = particleHeight + 5;
            particle.x = Math.random() * particleWidth;
        }

        particleContext.globalAlpha = particle.opacity;

        particleContext.beginPath();

        particleContext.arc(
            particle.x,
            particle.y,
            particle.radius,
            0,
            Math.PI * 2
        );

        particleContext.fill();
    }

    particleContext.globalAlpha = 1;

    particleFrame = requestAnimationFrame(drawParticles);
}

function syncParticles() {
    if (!shouldAnimateParticles()) {
        stopParticles();
        return;
    }

    if (particleFrame === null) {
        particleLastFrame = 0;
        particleFrame = requestAnimationFrame(drawParticles);
    }
}

/* -------------------- FLOATING NUMBERS -------------------- */

function resolveElement(target) {
    if (typeof target === "string") {
        return document.querySelector(target);
    }

    return target instanceof Element ? target : null;
}

function effectHost(target) {
    /*
      A native dialog lives in the browser's top layer.
      Attach its effects inside that dialog so they remain visible.
    */
    const dialog = target?.closest("dialog[open]");

    return dialog || document.getElementById("effectsLayer");
}

export function floatText(
    message,
    target,
    {
        damage = false,
        critical = false
    } = {}
) {
    if (prefersReducedMotion() || !isVisible()) {
        return false;
    }

    const element = resolveElement(target);

    if (!element) return false;

    const host = effectHost(element);

    if (!host) return false;

    const rect = element.getBoundingClientRect();
    const node = document.createElement("span");

    node.className = damage
        ? "damage-number"
        : "floating-reward";

    if (critical) {
        node.classList.add("is-critical");
    }

    node.textContent = String(message);

    /*
      Viewport coordinates are shared with getBoundingClientRect().
    */
    node.style.position = "fixed";
    node.style.left = `${Math.max(
        8,
        Math.min(window.innerWidth - 100, rect.left + rect.width / 2)
    )}px`;

    node.style.top = `${Math.max(12, rect.top + 12)}px`;
    node.style.pointerEvents = "none";
    node.style.zIndex = "10";

    host.appendChild(node);
    transientElements.add(node);

    const remove = () => {
        node.remove();
        transientElements.delete(node);
    };

    node.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, 1400);

    return true;
}

export function showQuestRewards(
    target,
    { xp = 0, amount = 0, currency = "gold" } = {}
) {
    const parts = [];

    if (xp > 0) parts.push(`+${xp} XP`);

    if (amount > 0) {
        parts.push(`+${amount} ${currency}`);
    }

    if (!parts.length) return false;

    return floatText(parts.join(" · "), target);
}

export function showDamage(
    target,
    amount,
    { critical = false } = {}
) {
    return floatText(
        `${critical ? "CRITICAL " : ""}−${amount} HP`,
        target,
        { damage: true, critical }
    );
}

/* -------------------- CARD ANIMATIONS -------------------- */

function animateClass(target, className) {
    if (prefersReducedMotion() || !isVisible()) {
        return false;
    }

    const element = resolveElement(target);

    if (!element) return false;

    element.classList.remove(className);

    // Restart the CSS animation after repeated actions.
    void element.offsetWidth;

    element.classList.add(className);

    const clear = () => {
        element.classList.remove(className);
    };

    element.addEventListener("animationend", clear, { once: true });
    setTimeout(clear, 1000);

    return true;
}

export function flashCompletion(target) {
    return animateClass(target, "is-completion-flash");
}

export function shakeBoss(target) {
    return animateClass(target, "is-hit");
}

/* -------------------- CANVAS CELEBRATION -------------------- */

export function celebrate({
    host = null,
    duration = 1500
} = {}) {
    if (
        !getState().settings.confetti ||
        prefersReducedMotion() ||
        !isVisible()
    ) {
        return false;
    }

    const parent =
        resolveElement(host) ||
        document.querySelector("dialog[open]") ||
        document.getElementById("effectsLayer");

    if (!parent) return false;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) return false;

    const width = window.innerWidth;
    const height = window.innerHeight;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    Object.assign(canvas.style, {
        position: "fixed",
        inset: "0",
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
        zIndex: "20"
    });

    canvas.setAttribute("aria-hidden", "true");

    context.scale(ratio, ratio);
    parent.appendChild(canvas);

    const colors = [
        accentColor(),
        "#f4ce63",
        "#c4a1ff",
        "#65dfa4"
    ];

    const pieces = Array.from({ length: 65 }, () => ({
        x: width / 2,
        y: height * 0.4,

        vx: (Math.random() - 0.5) * 650,
        vy: -150 - Math.random() * 300,

        size: 3 + Math.random() * 4,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 8,

        color: colors[Math.floor(Math.random() * colors.length)]
    }));

    let frame = null;
    let start = null;
    let previous = null;
    let stopped = false;

    const lifespan = Math.max(
        300,
        Math.min(3000, Number(duration) || 1500)
    );

    const stop = () => {
        if (stopped) return;

        stopped = true;

        if (frame !== null) {
            cancelAnimationFrame(frame);
        }

        canvas.remove();
        celebrationStops.delete(stop);
    };

    celebrationStops.add(stop);

    const draw = timestamp => {
        if (stopped) return;

        if (!isVisible() || prefersReducedMotion()) {
            stop();
            return;
        }

        start ??= timestamp;
        previous ??= timestamp;

        const elapsed = timestamp - start;
        const delta = Math.min(
            (timestamp - previous) / 1000,
            0.05
        );

        previous = timestamp;

        if (elapsed >= lifespan) {
            stop();
            return;
        }

        context.clearRect(0, 0, width, height);

        context.globalAlpha = Math.min(
            1,
            (lifespan - elapsed) / 400
        );

        for (const piece of pieces) {
            piece.x += piece.vx * delta;
            piece.y += piece.vy * delta;
            piece.vy += 500 * delta;
            piece.rotation += piece.spin * delta;

            context.save();

            context.translate(piece.x, piece.y);
            context.rotate(piece.rotation);

            context.fillStyle = piece.color;

            context.fillRect(
                -piece.size / 2,
                -piece.size / 2,
                piece.size,
                piece.size * 1.5
            );

            context.restore();
        }

        frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return stop;
}

/* -------------------- VOICE / HAPTICS -------------------- */

export function speakSystem(lineId) {
    if (
        !getState().settings.voice ||
        !isVisible() ||
        !("speechSynthesis" in window)
    ) {
        return false;
    }

    const message = VOICE_LINES[lineId];

    if (!message) return false;

    /*
      Fixed system messages only.
      Journal text is never passed to speech synthesis here.
    */
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(message);

    utterance.rate = 0.95;
    utterance.volume = 0.65;

    window.speechSynthesis.speak(utterance);

    return true;
}

export function haptic(kind = "success") {
    if (
        !getState().settings.haptics ||
        !isVisible() ||
        typeof navigator.vibrate !== "function"
    ) {
        return false;
    }

    const patterns = {
        tap: 12,
        success: [15, 40, 15],
        milestone: [20, 50, 20, 50, 35]
    };

    return navigator.vibrate(
        patterns[kind] || patterns.tap
    );
}

/* -------------------- SETTINGS / VISIBILITY -------------------- */

export function refreshEffects() {
    const settings = getState().settings;

    /*
      Match the CSS hooks already defined in style.css.
      Full appearance/theme rendering remains ui.js's job.
    */
    document.documentElement.dataset.particles =
        String(settings.particles);

    document.documentElement.dataset.scanlines =
        String(settings.scanlines);

    document.documentElement.dataset.reducedMotion =
        String(prefersReducedMotion());

    syncParticles();

    if (!settings.voice && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }

    if (ambientSource) {
        if (
            getState().focus.ambient === "off" ||
            getState().focus.ambient !== ambientKey
        ) {
            stopAmbient();
        } else {
            setAmbientVolume(getState().focus.volume);
        }
    }
}

function handleVisibilityChange() {
    syncParticles();

    if (!isVisible()) {
        /*
          No surprise audio when the user switches away.
          Ambient can be restarted through an explicit UI action.
        */
        stopAmbient();

        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
        }

        for (const stop of [...celebrationStops]) {
            stop();
        }
    }
}

/* -------------------- INITIALIZE / CLEAN UP -------------------- */

export function initEffects() {
    if (initialized) return destroyEffects;

    initialized = true;

    motionQuery = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
    );

    particleCanvas = document.getElementById("particleCanvas");
    particleContext = particleCanvas?.getContext("2d") || null;

    resizeParticles();

    listen(window, "resize", resizeParticles);

    listen(
        document,
        "visibilitychange",
        handleVisibilityChange
    );

    const motionChanged = () => {
        refreshEffects();

        if (prefersReducedMotion()) {
            for (const stop of [...celebrationStops]) {
                stop();
            }

            for (const element of transientElements) {
                element.remove();
            }

            transientElements.clear();
        }
    };

    if (motionQuery.addEventListener) {
        listen(motionQuery, "change", motionChanged);
    } else {
        motionQuery.addListener(motionChanged);

        cleanupCallbacks.push(() => {
            motionQuery.removeListener(motionChanged);
        });
    }

    unsubscribe = subscribe(refreshEffects);

    refreshEffects();

    return destroyEffects;
}

export function destroyEffects() {
    initialized = false;

    unsubscribe?.();
    unsubscribe = null;

    while (cleanupCallbacks.length) {
        cleanupCallbacks.pop()();
    }

    stopParticles();
    stopAmbient();

    for (const stop of [...celebrationStops]) {
        stop();
    }

    for (const element of transientElements) {
        element.remove();
    }

    transientElements.clear();

    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }

    if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => { });
    }

    audioContext = null;
    audioUnlocked = false;

    particleCanvas = null;
    particleContext = null;
    particles = [];
}