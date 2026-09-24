// The GJS module stubs the GNOME tests load real extension files under:
// a module hook that answers gi://, resource:/// and 'gettext' with
// scriptable stubs. Importing this file registers the hook for the whole
// test process; each test installs the few GObject members it exercises in
// `stub.overrides` and puts them back afterwards.
import {registerHooks} from 'node:module';
import {URL} from 'node:url';

export const EXT = new URL('../claude-usage-panel@fschmutz.github.io/', import.meta.url);

// ── GJS stubs ───────────────────────────────────────────────────────────────
// A namespace member nobody overrode is a class that constructs, can be
// extended, called, and read any property of - enough for a widget tree to
// build. What a test cares about it sets in `stub.overrides`.
// Never a thenable: `await widget` must not wait forever on a stub `then`.
const opaque = prop => typeof prop !== 'string' || prop === 'then';

function anything(name) {
    const cache = new Map();
    class Widget {
        constructor(...args) {
            const self = new Proxy(this, {
                get: (target, prop, receiver) => {
                    if (!(prop in target) && !opaque(prop))
                        target[prop] = anything(`${name}().${prop}`);
                    return Reflect.get(target, prop, receiver);
                },
            });
            self._init(...args);
            return self;
        }

        _init(props = {}) {
            Object.assign(this, props);
        }

        destroy() {}

        // GObject out-parameters come back as arrays: [x, y] = get_position().
        * [Symbol.iterator]() {
            yield* [0, 0, 0];
        }
    }
    return new Proxy(Widget, {
        get: (target, prop, receiver) => {
            if (prop in target)
                return Reflect.get(target, prop, receiver);
            if (opaque(prop))
                return undefined;
            if (!cache.has(prop))
                cache.set(prop, anything(`${name}.${prop}`));
            return cache.get(prop);
        },
        apply: () => new Widget(),
    });
}

// Always true, whatever a test overrides: registerClass hands the class back.
const BASE = {
    'gi://GObject': {registerClass: (meta, klass) => klass ?? meta},
};

export const stub = {
    overrides: {},
    gettext: s => s,
    ngettext: (one, many, n) => (n === 1 ? one : many),
    namespace(module) {
        const fallback = anything(module);
        return new Proxy({}, {
            get: (_t, prop) => stub.overrides[module]?.[prop] ?? BASE[module]?.[prop] ?? fallback[prop],
        });
    },
};
globalThis.gjsStub = stub;

// GJS adds String.prototype.format (printf-style); the files under test use it.
if (!String.prototype.format) {
    Object.defineProperty(String.prototype, 'format', {
        value(...args) {
            let i = 0;
            return this.replace(/%(%|[sd])/g, (_m, c) => (c === '%' ? '%' : String(args[i++])));
        },
    });
}

const NAMED = {
    'resource:///org/gnome/shell/ui/popupMenu.js': ['PopupBaseMenuItem', 'PopupMenu', 'PopupMenuItem'],
    'resource:///org/gnome/shell/ui/main.js': ['notify', 'layoutManager', 'panel'],
    'resource:///org/gnome/shell/ui/panelMenu.js': ['Button'],
};

const SPECIFIERS = [];
stub.specifiers = SPECIFIERS;

function stubSource(specifier) {
    if (specifier === 'gettext') {
        return `export default {domain: d => (globalThis.gjsStub.domain = d, {
            gettext: s => globalThis.gjsStub.gettext(s),
            ngettext: (a, b, n) => globalThis.gjsStub.ngettext(a, b, n),
        })};`;
    }
    if (specifier.endsWith('/extensions/extension.js')) {
        return `export const gettext = s => globalThis.gjsStub.gettext(s);
            export const ngettext = (a, b, n) => globalThis.gjsStub.ngettext(a, b, n);
            export const Extension = class {};`;
    }
    // The generated source names the namespace by an index into SPECIFIERS,
    // never by the specifier text: no import string ever becomes code.
    let idx = SPECIFIERS.indexOf(specifier);
    if (idx < 0) idx = SPECIFIERS.push(specifier) - 1;
    const ns = `globalThis.gjsStub.namespace(globalThis.gjsStub.specifiers[${idx}])`;
    // Functions forward at call time, so a test can swap Main.notify after load.
    const named = (NAMED[specifier] ?? []).map(n => (n === 'notify'
        ? `export const notify = (...a) => ${ns}.notify(...a);`
        : `export const ${n} = ${ns}.${n};`)).join('\n');
    return `export default ${ns};\n${named}`;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'gettext' || specifier.startsWith('gi://') || specifier.startsWith('resource:///'))
            return {url: `gjs-stub:${encodeURIComponent(specifier)}`, shortCircuit: true};
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url.startsWith('gjs-stub:')) {
            const specifier = decodeURIComponent(url.slice('gjs-stub:'.length));
            return {format: 'module', source: stubSource(specifier), shortCircuit: true};
        }
        return nextLoad(url, context);
    },
});

/** Import an extension file (path relative to the extension dir) through the stubs. */
export const load = rel => import(new URL(rel, EXT).href);
