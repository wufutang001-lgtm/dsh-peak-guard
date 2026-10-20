/**
 * Offline smoke test for the peak-guard Web half.
 *
 * Loads the real client bundle against a fake module loader, a tiny hooks
 * runtime, and a fake host that speaks the plugin's own HTTP routes. Then it
 * drives the panel and the dock through every visual state.
 *   node tests/client.mjs
 */
import assert from 'node:assert/strict';

/* ------------------------------ host stand-in ------------------------------ */

const hostState = {
	ok: true,
	now: 1_000_000,
	local: '2026-10-20 13:13',
	timezone: 'UTC+8',
	peak: false,
	weekend: false,
	holiday: false,
	window: '',
	peakEndsAt: 0,
	peakEndsAtLabel: '',
	nextPeakAt: 2_000_000,
	nextPeakAtLabel: '10-20 14:00',
	enabled: true,
	autoResume: true,
	overrideUntil: 0,
	overrideLabel: '',
	windows: ['09:00–12:00', '14:00–18:00'],
	windowSpec: [[9, 12], [14, 18]],
	defaultWindowSpec: [[9, 12], [14, 18]],
	holidays: [],
	frozen: [],
	frozenMessages: 0,
	pauses: 0,
	statePath: 'C:\\Users\\you\\.dsh\\profiles\\desktop\\peak-guard\\state.json',
};

const label = (value) => {
	const hour = Math.floor(value);
	const minute = Math.round((value - hour) * 60);
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const fetchCalls = [];

/** The fake host implements exactly the actions the panel is allowed to send. */
const hostFetch = async (url, init = {}) => {
	fetchCalls.push({ url, init });
	if ((init.method ?? 'GET') === 'POST') {
		const body = JSON.parse(init.body);
		switch (body.action) {
			case 'set-enabled':
				hostState.enabled = body.enabled === true;
				break;
			case 'set-windows':
				hostState.windowSpec = body.windows;
				hostState.windows = body.windows.map(([from, to]) => `${label(from)}–${label(to)}`);
				break;
			case 'resume':
				hostState.overrideUntil = hostState.now + 60_000;
				hostState.overrideLabel = '10-20 18:00';
				break;
			case 'clear-override':
				hostState.overrideUntil = 0;
				hostState.overrideLabel = '';
				break;
			default:
				throw new Error(`unexpected action ${body.action}`);
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, message: '', state: { ...hostState } }) };
	}
	return { ok: true, status: 200, json: async () => ({ ...hostState }) };
};
globalThis.fetch = hostFetch;

/* ------------------------------ browser-ish globals ------------------------------ */

const styles = [];
const listeners = new Map();
let timers = 0;
globalThis.setInterval = () => {
	timers += 1;
	return timers;
};
globalThis.clearInterval = () => {
	timers -= 1;
};
globalThis.document = {
	visibilityState: 'visible',
	head: { append: (node) => styles.push(node) },
	createElement: (tag) => {
		const node = { tag, attributes: {}, textContent: '', setAttribute: (k, v) => (node.attributes[k] = v), remove: () => (node.removed = true) };
		return node;
	},
	addEventListener: (type, fn) => listeners.set(type, fn),
	removeEventListener: (type, fn) => {
		if (listeners.get(type) === fn) listeners.delete(type);
	},
};

/* ------------------------------ tiny hooks runtime ------------------------------ */

let current = null;
let elementId = 0;

const React = {
	createElement: (type, props, ...children) => ({ id: ++elementId, type, props: props ?? {}, children: children.flat() }),
	useState(initial) {
		const runtime = current;
		const index = runtime.index++;
		let slot = runtime.slots[index];
		if (slot === undefined) {
			slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
			runtime.slots[index] = slot;
		}
		const setValue = (next) => {
			const value = typeof next === 'function' ? next(slot.value) : next;
			if (Object.is(value, slot.value)) return;
			slot.value = value;
			runtime.dirty = true;
		};
		return [slot.value, setValue];
	},
	useEffect(fn, deps) {
		const runtime = current;
		const index = runtime.index++;
		const previous = runtime.slots[index];
		const changed = previous === undefined || deps === undefined
			|| deps.length !== previous.deps.length
			|| deps.some((value, position) => !Object.is(value, previous.deps[position]));
		if (changed !== true) return;
		runtime.queue.push(() => {
			if (typeof previous?.cleanup === 'function') previous.cleanup();
			const cleanup = fn();
			runtime.slots[index] = { kind: 'effect', deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
		});
	},
	useMemo: (factory) => factory(),
	useCallback: (fn) => fn,
};

/**
 * Render `component` with working state and effects. Returns the latest tree
 * plus a `render()` to ask for another pass (e.g. after clicking something).
 */
function mount(component, props) {
	const runtime = { index: 0, slots: [], queue: [], dirty: false, mounted: true };
	const render = () => {
		let tree = null;
		for (let pass = 0; pass < 16; pass += 1) {
			runtime.index = 0;
			runtime.dirty = false;
			current = runtime;
			try {
				tree = component(props);
			} finally {
				current = null;
			}
			const queued = runtime.queue;
			runtime.queue = [];
			if (queued.length > 0) for (const run of queued) run();
			if (queued.length === 0 && runtime.dirty === false) break;
		}
		runtime.tree = tree;
		return tree;
	};
	const unmount = () => {
		runtime.mounted = false;
		for (const slot of runtime.slots) {
			if (slot?.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
		}
	};
	const tree = render();
	return { tree: () => runtime.tree, render, unmount };
}

/** Every element node in a tree, depth-first, expanding child components. */
function* walk(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return;
	if (Array.isArray(node)) {
		for (const child of node) yield* walk(child);
		return;
	}
	if (typeof node !== 'object') return;
	if (typeof node.type === 'function') {
		// None of the child components use hooks, so expanding them here is exact.
		yield* walk(node.type(node.props));
		return;
	}
	yield node;
	for (const child of node.children ?? []) yield* walk(child);
}

const find = (tree, predicate) => [...walk(tree)].find(predicate);
const findAll = (tree, predicate) => [...walk(tree)].filter(predicate);
const text = (tree) => JSON.stringify(tree);
const byClass = (tree, className) => findAll(tree, (node) => String(node.props.className ?? '').split(' ').includes(className));
const byTag = (tree, tag) => findAll(tree, (node) => node.type === tag);
/** The single text child of a leaf element. */
const caption = (node) => (Array.isArray(node.children) ? node.children[0] : node.children);
const buttonWith = (tree, labelText) => byTag(tree, 'button').find((node) => caption(node) === labelText);

/* ------------------------------ module loader ------------------------------ */

let definition;
globalThis.window = {
	__ModuleLoader__: {
		load: (value) => {
			definition = value;
		},
	},
};

await import('../client.js');
assert.ok(definition, 'client.js must call window.__ModuleLoader__.load');
assert.equal(definition.id, 'dsh-peak-guard', 'the loader id must equal the package name');

const mod = definition.factory((specifier) => {
	assert.equal(specifier, 'react', 'the bundle may only require react');
	return React;
});
assert.deepEqual(mod.inject, ['slots', 'locale'], 'the bundle must declare the services it waits for');
assert.equal(typeof mod.apply, 'function');

/* ------------------------------ fake client ctx ------------------------------ */

const registrations = [];
const dictionaries = [];
const effects = [];

const ctx = {
	effect(fn, label) {
		const dispose = fn();
		effects.push({ label, dispose });
		return dispose;
	},
	locale: {
		register(ns, dicts) {
			dictionaries.push({ ns, dicts });
			return () => {
				const index = dictionaries.findIndex((entry) => entry.ns === ns);
				if (index >= 0) dictionaries.splice(index, 1);
			};
		},
	},
	slots: {
		inject(key, callback) {
			return callback();
		},
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
};

mod.apply(ctx);

assert.equal(styles.length, 1, 'the bundle must inject one style sheet');
assert.match(styles[0].textContent, /\.pg-panel/, 'the style sheet carries the panel rules');
assert.match(styles[0].textContent, /\.pg-switch/, 'the style sheet carries the switch rules');
assert.ok(styles[0].attributes['data-peak-guard-style'] !== undefined, 'the style sheet is tagged for cleanup');

assert.equal(dictionaries.length, 1, 'one dictionary registration');
assert.equal(dictionaries[0].ns, 'peak-guard');
assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'], 'both languages registered');

assert.equal(registrations.length, 3, 'three faces register');
const face = (name) => registrations.filter((entry) => entry.options.name === name);
const sidebar = face('sidebar.panellist')[0];
const panel = face('main')[0];
const dock = face('conversation.composer.dock')[0];
assert.ok(sidebar && panel && dock, 'sidebar icon, main panel and dock are registered');
assert.equal(face('settings.general.item').length, 0, 'the switch no longer lives in Settings');
assert.equal(sidebar.options.id, 'peak-guard', 'the sidebar id addresses the main panel key');
assert.equal(panel.options.key, 'peak-guard', 'the main panel uses that same key');
assert.equal(dock.options.id, 'peak-guard-status');
assert.equal(sidebar.options.order, 40);
assert.equal(dock.options.order, 6);
assert.equal(typeof sidebar.options.label, 'function', 'the sidebar resolves its own label');

const zh = dictionaries[0].dicts.zh;
const t = (key, params) => {
	const template = zh[key];
	assert.ok(template !== undefined, `missing zh string: ${key}`);
	return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (_, name) => String(params[name] ?? `{${name}}`));
};

/* ------------------------------ sidebar icon ------------------------------ */

const icon = mount(sidebar.component, { size: 20, active: true, t });
assert.equal(icon.tree().type, 'svg');
assert.equal(icon.tree().props.width, 20, 'the icon follows the slot size');
assert.equal(icon.tree().props['aria-label'], '峰时守卫');
assert.equal(icon.tree().props.style.opacity, 1, 'the active icon is fully opaque');
const idleIcon = mount(sidebar.component, { size: 20, active: false, t });
assert.equal(idleIcon.tree().props.style.opacity, 0.72, 'the inactive icon is dimmed');

/* ------------------------------ panel: loading ------------------------------ */

const store = panel.options.inject().store;
const panelView = mount(panel.component, { store, t });

const loadingTree = panelView.tree();
assert.match(text(loadingTree), /正在读取主机状态/, 'the panel starts on the loading copy');
const loadingSwitch = byClass(loadingTree, 'pg-switch')[0];
assert.equal(loadingSwitch.props['aria-checked'], false, 'loading renders the switch off');
assert.equal(loadingSwitch.props.disabled, true, 'loading leaves the switch disabled');
assert.equal(byClass(loadingTree, 'pg-card').length, 0, 'no cards before the host answers');

/* ------------------------------ panel: live state ------------------------------ */

await store.refresh();
assert.ok(fetchCalls[0].url.endsWith('/plugins/peak-guard/state'), 'the store polls the plugin route');
assert.equal(fetchCalls[0].init.credentials, 'same-origin');

const liveTree = panelView.render();
assert.equal(byClass(liveTree, 'pg-card').length, 3, 'three cards once the host answers: windows, status, actions');
assert.match(text(liveTree), /谷时/, 'off-peak copy is rendered');
assert.match(text(liveTree), /10-20 14:00/, 'the next peak label is rendered');
assert.equal(byClass(liveTree, 'pg-switch')[0].props['aria-checked'], true, 'the switch mirrors the host');

const selects = byTag(liveTree, 'select');
assert.equal(selects.length, 4, 'two windows render two selects each');
assert.equal(byTag(selects[0], 'option').length, 49, 'the hour choices run 00:00-24:00 at half-hour steps');
assert.equal(caption(byTag(selects[0], 'option')[0]), '00:00');
assert.equal(caption(byTag(selects[0], 'option')[48]), '24:00');
assert.equal(selects[0].props.value, '9', 'the first window starts at 09:00');
assert.equal(selects[1].props.value, '12', 'the first window ends at 12:00');
assert.match(text(liveTree), /与当前生效时段一致/, 'a freshly seeded editor is clean');

const saveButton = () => buttonWith(panelView.tree(), '保存');
assert.equal(saveButton().props.disabled, true, 'save stays disabled while clean');

/* ------------------------------ panel: edit + save ------------------------------ */

selects[1].props.onChange({ currentTarget: { value: '12.5' } });
const dirtyTree = panelView.render();
assert.match(text(dirtyTree), /有未保存的改动/, 'editing marks the editor dirty');
const dirtySave = buttonWith(dirtyTree, '保存');
assert.equal(dirtySave.props.disabled, false, 'save wakes up when dirty');

await dirtySave.props.onClick();
const saveCall = fetchCalls.at(-1);
assert.equal(saveCall.init.method, 'POST');
assert.deepEqual(JSON.parse(saveCall.init.body), { action: 'set-windows', windows: [[9, 12.5], [14, 18]] }, 'save posts the draft in canonical form');
assert.deepEqual(hostState.windowSpec, [[9, 12.5], [14, 18]], 'the host accepted the edit');
assert.deepEqual(hostState.windows, ['09:00–12:30', '14:00–18:00'], 'the host re-labels the windows');

const savedTree = panelView.render();
assert.match(text(savedTree), /与当前生效时段一致/, 'the editor re-seeds from the saved state');
assert.equal(byTag(savedTree, 'select')[1].props.value, '12.5', 'the editor shows the saved value');

// A rejected edit keeps the draft and shows the host error.
globalThis.fetch = async (url, init = {}) => {
	fetchCalls.push({ url, init });
	return { ok: true, status: 400, json: async () => ({ ok: false, error: '时段 3 与时段 2 重叠', state: { ...hostState } }) };
};
const selectsNow = byTag(panelView.tree(), 'select');
selectsNow[3].props.onChange({ currentTarget: { value: '17' } });
await buttonWith(panelView.render(), '保存').props.onClick();
assert.match(text(panelView.render()), /重叠/, 'a rejected edit surfaces the host error');
assert.match(text(panelView.tree()), /有未保存的改动/, 'a rejected edit keeps the draft dirty');
globalThis.fetch = hostFetch;

/* ------------------------------ panel: switch + actions ------------------------------ */

await byClass(panelView.render(), 'pg-switch')[0].props.onClick();
const toggleCall = fetchCalls.at(-1);
assert.deepEqual(JSON.parse(toggleCall.init.body), { action: 'set-enabled', enabled: false }, 'the switch posts the new value');
assert.equal(hostState.enabled, false, 'the host turned the guard off');
assert.match(text(panelView.render()), /已关闭 · 峰时也会照常思考/, 'the panel says the guard is off');

await byClass(panelView.render(), 'pg-switch')[0].props.onClick();
assert.equal(hostState.enabled, true, 'the switch toggles back on');

const actionButton = (captionText) => buttonWith(panelView.tree(), captionText);
assert.equal(actionButton('立即继续').props.disabled, true, 'resume is disabled off-peak');
assert.equal(actionButton('取消本次豁免').props.disabled, true, 'nothing to clear without an exemption');

// Peak + frozen: resume becomes available and the status rows report the hold.
const peakSnapshot = () => ({
	...hostState,
	peak: true,
	window: '14:00–18:00',
	peakEndsAt: 3_000_000,
	peakEndsAtLabel: '10-20 18:00',
	frozen: [{ agentId: 'a1' }],
	frozenMessages: 1,
});
globalThis.fetch = async (url, init = {}) => {
	fetchCalls.push({ url, init });
	if ((init.method ?? 'GET') === 'POST') {
		if (JSON.parse(init.body).action === 'resume') {
			hostState.overrideUntil = hostState.now + 60_000;
			hostState.overrideLabel = '10-20 18:00';
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, message: '', state: peakSnapshot() }) };
	}
	return { ok: true, status: 200, json: async () => peakSnapshot() };
};
await store.refresh();
const peakTree = panelView.render();
assert.match(text(peakTree), /峰时/, 'the panel reports the peak window');
assert.match(text(peakTree), /已暂停 1 个回合、1 条输入/, 'the panel reports the frozen messages');
assert.equal(actionButton('立即继续').props.disabled, false, 'resume lights up during a peak');

await actionButton('立即继续').props.onClick();
assert.equal(JSON.parse(fetchCalls.at(-1).init.body).action, 'resume', 'resume hits the action route');
assert.equal(hostState.overrideUntil > hostState.now, true, 'the host recorded the exemption');
assert.match(text(panelView.render()), /本次已豁免/, 'the panel reports the exemption');
assert.equal(actionButton('取消本次豁免').props.disabled, false, 'the exemption can be cleared');

/* ------------------------------ panel: older host half ------------------------------ */

// A host half installed before the window editor exposes only the rendered labels.
const staleState = { ...hostState };
delete staleState.windowSpec;
delete staleState.defaultWindowSpec;
const staleStore = {
	get: () => ({ phase: 'ready', error: '', state: staleState }),
	subscribe: () => () => {},
	act: async () => null,
};
const stalePanel = mount(panel.component, { store: staleStore, t });
const staleSelects = byTag(stalePanel.tree(), 'select');
assert.equal(staleSelects.length, 4, 'the windows are parsed out of the labels');
assert.equal(staleSelects[0].props.value, '9', 'the first window still starts at 09:00');
assert.equal(staleSelects[1].props.value, '12.5', 'half hours survive the label round trip');
assert.equal(staleSelects[0].props.disabled, true, 'an old host makes the editor read-only');
assert.match(text(stalePanel.tree()), /重启一次 DSH/, 'the panel says a restart is needed');
assert.equal(buttonWith(stalePanel.tree(), '保存').props.disabled, true, 'saving is blocked on an old host');
assert.equal(buttonWith(stalePanel.tree(), '添加时段').props.disabled, true, 'adding is blocked on an old host');
stalePanel.unmount();

/* ------------------------------ dock ------------------------------ */

const frozenStore = {
	phase: 'ready',
	error: '',
	state: {
		...hostState,
		now: 1_000_000,
		peak: true,
		window: '14:00–18:00',
		peakEndsAt: 3_000_000,
		peakEndsAtLabel: '10-20 18:00',
		overrideUntil: 0,
		overrideLabel: '',
		frozen: [{ agentId: 'a1' }],
		frozenMessages: 1,
	},
};
frozenStore.get = () => frozenStore;
frozenStore.subscribe = () => () => {};
frozenStore.act = async (action) => {
	await globalThis.fetch('/plugins/peak-guard/action', { method: 'POST', body: JSON.stringify({ action }) });
	return null;
};

const dockView = mount(dock.component, { store: frozenStore, t });
const dockText = text(dockView.tree());
assert.match(dockText, /已暂停 1 个回合/, 'the dock reports the frozen turn');
assert.match(dockText, /立即继续/, 'the dock offers resume');
assert.equal(byClass(dockView.tree(), 'pg-dock-btn')[0].props.disabled, false);

const before = fetchCalls.length;
await byClass(dockView.tree(), 'pg-dock-btn')[0].props.onClick();
assert.equal(fetchCalls.length, before + 1, 'the dock resumes through the action route');
assert.deepEqual(JSON.parse(fetchCalls.at(-1).init.body), { action: 'resume' }, 'the dock posts a resume action');

const quietStore = { get: () => ({ phase: 'ready', error: '', state: { ...hostState, peak: false, frozen: [], frozenMessages: 0, overrideUntil: 0 } }), subscribe: () => () => {}, act: async () => null };
const quietDock = mount(dock.component, { store: quietStore, t });
assert.equal(quietDock.tree(), null, 'the dock stays hidden off-peak when nothing is frozen');

const disabledStore = { get: () => ({ phase: 'ready', error: '', state: { ...hostState, enabled: false, peak: true, frozenMessages: 1, frozen: [{}] } }), subscribe: () => () => {}, act: async () => null };
assert.equal(mount(dock.component, { store: disabledStore, t }).tree(), null, 'a disabled guard never shows the dock');

const exemptStore = { get: () => ({ phase: 'ready', error: '', state: { ...hostState, peak: true, overrideUntil: 5_000_000, overrideLabel: '10-20 18:00' } }), subscribe: () => () => {}, act: async () => null };
const exemptDock = mount(dock.component, { store: exemptStore, t });
assert.match(text(exemptDock.tree()), /豁免/, 'the dock reports the exemption');
assert.equal(byClass(exemptDock.tree(), 'pg-dock-btn').length, 0, 'no resume button while exempt');

/* ------------------------------ unreachable host ------------------------------ */

const errorStore = { get: () => ({ phase: 'error', error: 'HTTP 500', state: null }), subscribe: () => () => {}, act: async () => null };
const errorPanel = mount(panel.component, { store: errorStore, t });
assert.match(text(errorPanel.tree()), /连不上主机：HTTP 500/, 'the panel explains an unreachable host');

/* ------------------------------ cleanup ------------------------------ */

panelView.unmount();
dockView.unmount();
for (const effect of effects) if (typeof effect.dispose === 'function') effect.dispose();
assert.ok(styles[0].removed, 'disposing removes the style sheet');
assert.equal(dictionaries.length, 0, 'disposing releases the dictionaries');
assert.equal(timers, 0, 'disposing stops the poller');

console.log('ok — panel + sidebar icon + dock render, edit, save and resume');
