// A minimal browser page for running game.js in Node: elements by id
// (only the ids that really exist in public/index.html), window and
// document events, requestAnimationFrame driven by the test, storage
// and location.

import { readFileSync } from "node:fs";

class FakeElement {
    constructor(tag = "div", id = "", classes = [], hidden = false) {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.textContent = "";
        this.innerHTML = "";
        this.style = {};
        this.dataset = {};
        this.hidden = hidden;
        this.children = [];
        this.listeners = {};
        this.offsetWidth = 0;
        this.value = "";

        const set = new Set(classes);

        this.classList = {
            add: (...c) => c.forEach((x) => set.add(x)),
            remove: (...c) => c.forEach((x) => set.delete(x)),
            toggle: (c, on) => {
                const want = on === undefined ? !set.has(c) : Boolean(on);
                if (want) set.add(c); else set.delete(c);
                return want;
            },
            contains: (c) => set.has(c)
        };
    }

    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}

    dispatch(type, event = {}) {
        for (const fn of this.listeners[type] ?? []) {
            fn({ type, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }

    appendChild(child) { this.children.push(child); return child; }
    focus() { this.focused = true; }
    blur() { this.focused = false; }
    select() {}
    querySelector() { return new FakeElement(); }
    closest() { return null; }
    getContext() { return null; }

    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    releasePointerCapture() {}
}

function makeStorage() {
    const data = new Map();

    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k)
    };
}

export function installDom(indexHtmlPath) {
    const html = readFileSync(indexHtmlPath, "utf8");
    const elements = new Map();

    // Every element with an id in the real page.
    for (const match of html.matchAll(/<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
        const [, tag, before, id, after] = match;
        const attrs = before + " " + after;
        const classes = (attrs.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
        const hidden = /\shidden(\s|$|=)/.test(" " + attrs);

        elements.set(id, new FakeElement(tag, id, classes, hidden));
    }

    const rafQueue = [];
    const windowListeners = {};
    const documentListeners = {};

    const document = {
        hidden: false,
        body: new FakeElement("body"),
        head: new FakeElement("head"),
        getElementById: (id) => elements.get(id) ?? null,
        createElement: (tag) => new FakeElement(tag),
        addEventListener: (type, fn) => (documentListeners[type] ??= []).push(fn)
    };

    const window = globalThis;

    Object.assign(globalThis, {
        document,
        innerWidth: 1280,
        innerHeight: 720,
        devicePixelRatio: 1,
        localStorage: makeStorage(),
        sessionStorage: makeStorage(),
        location: { protocol: "http:", host: "game.test", search: "" },
        matchMedia: () => ({ matches: false }),
        getSelection: () => null,
        requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
        addEventListener: (type, fn) => (windowListeners[type] ??= []).push(fn)
    });

    window.window = window;

    return {
        elements,
        el: (id) => elements.get(id),

        // Run one animation frame.
        frame() {
            const callbacks = rafQueue.splice(0);
            for (const cb of callbacks) cb(performance.now());
        },

        key(type, code, target = null) {
            for (const fn of windowListeners[type] ?? []) {
                fn({ type, code, target, repeat: false, preventDefault() {} });
            }
        }
    };
}
