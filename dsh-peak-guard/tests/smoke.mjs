/**
 * Offline smoke test for the peak-guard host half.
 *
 * Runs the real plugin against a fake Cordis context: no Harness needed.
 *   node tests/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'peak-guard-'));

const plugin = await import('../host.js');

const ALWAYS_PEAK = { enabled: true, autoResume: true, offsetMinutes: 480, windows: [[0, 24]], holidays: [] };

/** Minimal stand-in for `ReactLoopInbox` (only what the guard touches). */
function createInbox(initial = []) {
	const nextTurn = [...initial];
	const nextStep = [];
	const all = () => [...nextStep, ...nextTurn];
	return {
		get nextTurn() {
			return nextTurn;
		},
		get nextStep() {
			return nextStep;
		},
		get hasPending() {
			return all().length > 0;
		},
		prepend(target, message) {
			const bucket = target === 'next-turn' ? nextTurn : nextStep;
			if (all().some((pending) => pending.id === message.id)) throw new Error(`message "${message.id}" is already pending`);
			bucket.unshift(message);
		},
		append(target, message) {
			const bucket = target === 'next-turn' ? nextTurn : nextStep;
			if (all().some((pending) => pending.id === message.id)) throw new Error(`message "${message.id}" is already pending`);
			bucket.push(message);
		},
		/** Simulate `claim('next-turn')`: next-step all + one next-turn message. */
		claim() {
			const claimed = nextStep.splice(0, nextStep.length);
			claimed.push(...nextTurn.splice(0, 1));
			return claimed;
		},
		drain() {
			return nextStep.splice(0, nextStep.length).concat(nextTurn.splice(0, nextTurn.length));
		},
	};
}

function createAgent(id, messages) {
	return {
		id,
		session: { id: `session-${id}` },
		status: 'idle',
		inbox: createInbox(messages),
		followups: [],
		followup(message) {
			this.followups.push(message);
			this.inbox.append('next-turn', message);
		},
	};
}

function createHarness(config) {
	// Each harness gets its own state file, otherwise pause counters leak between tests.
	process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'peak-guard-'));
	const handlers = new Map();
	const routes = new Map();
	const disposers = [];
	const ctx = {
		logger: { warn: () => {} },
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		inject(deps, callback) {
			const scoped = {};
			for (const dep of deps) scoped[dep] = services[dep];
			callback(scoped);
			return { dispose() {} };
		},
	};
	const services = {
		commands: {
			registered: [],
			register(definition) {
				this.registered.push(definition);
				return () => {};
			},
		},
		webServer: {
			register(route) {
				routes.set(`${route.kind}:${route.path}`, route);
				const dispose = () => routes.delete(`${route.kind}:${route.path}`);
				disposers.push(dispose);
				return dispose;
			},
		},
	};
	plugin.apply(ctx, config);
	return { handlers, routes, services, ctx };
}

/** Invoke a registered route with a fake request/response pair. */
async function callRoute(routes, path, options = {}) {
	const route = routes.get(`exact:${path}`);
	assert.ok(route, `route ${path} is not registered`);
	const method = options.method ?? 'GET';
	let status = 0;
	let payload = '';
	const res = {
		writeHead(code) {
			status = code;
			return this;
		},
		end(body) {
			payload = body ?? '';
			return this;
		},
	};
	const request = (async function* stream() {
		if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body), 'utf8');
	})();
	Object.assign(request, { method });
	await route.handler(request, res);
	return { status, json: payload === '' ? null : JSON.parse(payload) };
}

const userMessage = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text: text ?? `input ${id}` }], source: { kind: 'user' } });

/* ---------------------------------------------------------------- *
 * 1. Peak freezes the step, keeps the input, and never wakes itself
 * ---------------------------------------------------------------- */
{
	const harness = createHarness(ALWAYS_PEAK);
	const preStep = harness.handlers.get('agent/pre-step');
	const agent = createAgent('a1', [userMessage('m1'), userMessage('m2')]);
	const claimed = agent.inbox.claim();
	let entered = false;
	const decision = await preStep({ agent, messages: claimed, turn: 1, step: 0, signal: undefined }, () => {
		entered = true;
		return { kind: 'enter', messages: claimed };
	});
	assert.deepEqual(decision, { kind: 'reject' }, 'peak must reject the step');
	assert.equal(entered, false, 'peak must not fall through to the model');
	assert.deepEqual(agent.inbox.nextStep.map((m) => m.id), ['m1'], 'claimed input must be restored');
	assert.deepEqual(agent.inbox.nextTurn.map((m) => m.id), ['m2'], 'unclaimed input must stay in next-turn');
	assert.deepEqual(agent.followups, [], 'freezing must never wake the agent');

	const view = (await callRoute(harness.routes, '/plugins/peak-guard/state')).json;
	assert.equal(view.ok, true);
	assert.equal(view.peak, true);
	assert.equal(view.enabled, true);
	assert.equal(view.frozen.length, 1);
	assert.equal(view.frozenMessages, 1);
	assert.equal(view.pauses, 1);
	assert.ok(view.peakEndsAt > view.now, 'peak must report when it ends');
	console.log('ok 1 — peak reject + inbox restore + state view');
}

/* ---------------------------------------------------------------- *
 * 2. A second frozen step must not double count messages
 * ---------------------------------------------------------------- */
{
	const harness = createHarness(ALWAYS_PEAK);
	const preStep = harness.handlers.get('agent/pre-step');
	const agent = createAgent('a1', [userMessage('m1')]);
	await preStep({ agent, messages: agent.inbox.claim(), turn: 1, step: 0 }, () => assert.fail('must reject'));
	await preStep({ agent, messages: agent.inbox.claim(), turn: 2, step: 0 }, () => assert.fail('must reject'));
	const view = (await callRoute(harness.routes, '/plugins/peak-guard/state')).json;
	assert.equal(view.frozenMessages, 1, 'a re-claimed message is not a new message');
	assert.equal(view.pauses, 1, 'one pause event per agent, not per turn');
	console.log('ok 2 — re-claim dedupes by message id');
}

/* ---------------------------------------------------------------- *
 * 3. 「继续」 lets the turn through and exempts the rest of the window
 * ---------------------------------------------------------------- */
{
	const harness = createHarness(ALWAYS_PEAK);
	const preStep = harness.handlers.get('agent/pre-step');
	const agent = createAgent('a1', [userMessage('m1')]);
	let entered = false;
	const decision = await preStep({ agent, messages: agent.inbox.claim(), turn: 1, step: 0 }, () => {
		entered = true;
		return { kind: 'enter', messages: [] };
	});
	assert.deepEqual(decision, { kind: 'reject' });
	assert.equal(entered, false);

	agent.inbox.append('next-turn', userMessage('m2', '继续'));
	const decision2 = await preStep({ agent, messages: agent.inbox.claim(), turn: 1, step: 0 }, () => {
		entered = true;
		return { kind: 'enter', messages: [] };
	});
	assert.deepEqual(decision2, { kind: 'enter', messages: [] }, 'a resume word must pass the step');
	assert.equal(entered, true);
	const view = (await callRoute(harness.routes, '/plugins/peak-guard/state')).json;
	assert.ok(view.overrideUntil > view.now, 'the resume command sets an exemption');
	assert.equal(view.frozen.length, 0, 'the frozen record is cleared on resume');
	assert.equal(view.lastResumeReason, 'user-command');

	const decision3 = await preStep({ agent, messages: agent.inbox.claim(), turn: 1, step: 0 }, () => ({ kind: 'enter', messages: [] }));
	assert.equal(decision3.kind, 'enter', 'the rest of the window stays exempt');
	console.log('ok 3 — 「继续」 passes the step and exempts the window');
}

/* ---------------------------------------------------------------- *
 * 4. Off-peak never interferes (and clears stale exemptions)
 * ---------------------------------------------------------------- */
{
	const harness = createHarness({ ...ALWAYS_PEAK, windows: [[9, 12]] });
	const preStep = harness.handlers.get('agent/pre-step');
	const agent = createAgent('a1', [userMessage('m1')]);
	const claimed = agent.inbox.claim();
	const decision = await preStep({ agent, messages: claimed, turn: 1, step: 0 }, () => ({ kind: 'enter', messages: claimed }));
	assert.equal(decision.kind, 'enter', 'off-peak must pass through untouched');
	assert.deepEqual(agent.inbox.nextStep, [], 'off-peak must not restore or duplicate input');
	const view = (await callRoute(harness.routes, '/plugins/peak-guard/state')).json;
	assert.equal(view.peak, false);
	assert.ok(view.nextPeakAt > view.now, 'off-peak must report the next peak');
	console.log('ok 4 — off-peak passthrough + next peak');

	const todayInShanghai = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
	const holiday = createHarness({ ...ALWAYS_PEAK, holidays: [todayInShanghai] });
	const holidayAgent = createAgent('a2', [userMessage('m9')]);
	const holidayClaimed = holidayAgent.inbox.claim();
	const holidayDecision = await holiday.handlers.get('agent/pre-step')({ holidayAgent, agent: holidayAgent, messages: holidayClaimed, turn: 1, step: 0 }, () => ({ kind: 'enter', messages: holidayClaimed }));
	assert.equal(holidayDecision.kind, 'enter', 'a holiday is off-peak even inside a peak window');
	console.log('ok 5 — holiday list overrides the window');
}

/* ---------------------------------------------------------------- *
 * 6. The master switch: off releases everything and stops freezing
 * ---------------------------------------------------------------- */
{
	const harness = createHarness(ALWAYS_PEAK);
	const preStep = harness.handlers.get('agent/pre-step');
	const agent = createAgent('a1', [userMessage('m1')]);
	await preStep({ agent, messages: agent.inbox.claim(), turn: 1, step: 0 }, () => assert.fail('must reject first'));

	const off = await callRoute(harness.routes, '/plugins/peak-guard/action', { method: 'POST', body: { action: 'set-enabled', enabled: false } });
	assert.equal(off.status, 200);
	assert.equal(off.json.ok, true);
	assert.equal(off.json.state.enabled, false);
	assert.equal(agent.followups.length, 1, 'switching off wakes whatever it released');
	assert.match(agent.followups[0].content[0].text, /peak-guard/);

	agent.inbox.drain();
	const after = await preStep({ agent, messages: agent.inbox.claim(), turn: 2, step: 0 }, () => ({ kind: 'enter', messages: [] }));
	assert.equal(after.kind, 'enter', 'a disabled guard never freezes');

	const on = await callRoute(harness.routes, '/plugins/peak-guard/action', { method: 'POST', body: { action: 'set-enabled', enabled: true } });
	assert.equal(on.json.state.enabled, true);
	const refused = await preStep({ agent, messages: [userMessage('m4')], turn: 3, step: 0 }, () => assert.fail('must reject again'));
	assert.deepEqual(refused, { kind: 'reject' });
	console.log('ok 6 — master switch releases and re-arms');
}

/* ---------------------------------------------------------------- *
 * 7. Slash command + malformed requests
 * ---------------------------------------------------------------- */
{
	const harness = createHarness(ALWAYS_PEAK);
	const command = harness.services.commands.registered[0];
	assert.ok(command, 'the /peak command is registered');
	assert.equal(command.name, 'peak');
	const status = command.handler({ rawInput: '', agent: createAgent('a1', []) });
	assert.equal(status.kind, 'success');
	assert.match(status.text, /峰时/);
	const off = command.handler({ rawInput: 'off', agent: createAgent('a1', []) });
	assert.equal(off.kind, 'success');
	const on = command.handler({ rawInput: 'on', agent: createAgent('a1', []) });
	assert.match(on.text, /开启/);

	const bad = await callRoute(harness.routes, '/plugins/peak-guard/action', { method: 'POST', body: { action: 'nope' } });
	assert.equal(bad.status, 400);
	const wrongMethod = await callRoute(harness.routes, '/plugins/peak-guard/action', { method: 'GET' });
	assert.equal(wrongMethod.status, 405);
	console.log('ok 7 — /peak command and request validation');
}

/* ---------------------------------------------------------------- *
 * 8. Window editor: validation, half hours, persistence
 * ---------------------------------------------------------------- */
{
	const harness = createHarness({ ...ALWAYS_PEAK });
	const act = (body) => callRoute(harness.routes, '/plugins/peak-guard/action', { method: 'POST', body });

	const empty = await act({ action: 'set-windows', windows: [] });
	assert.equal(empty.status, 400);
	assert.match(empty.json.error, /至少/);

	const backwards = await act({ action: 'set-windows', windows: [[14, 9]] });
	assert.equal(backwards.status, 400);
	assert.match(backwards.json.error, /早于/);

	const overlapping = await act({ action: 'set-windows', windows: [[9, 13], [12, 18]] });
	assert.equal(overlapping.status, 400);
	assert.match(overlapping.json.error, /重叠/);

	const half = await act({ action: 'set-windows', windows: [[9, 12.5], [14, 18]] });
	assert.equal(half.status, 200);
	assert.deepEqual(half.json.state.windowSpec, [[9, 12.5], [14, 18]]);
	assert.deepEqual(half.json.state.windows, ['09:00–12:30', '14:00–18:00']);

	const saved = JSON.parse(readFileSync(half.json.state.statePath, 'utf8'));
	assert.deepEqual(saved.windows, [[9, 12.5], [14, 18]], 'edited windows survive a restart');

	const defaults = await act({ action: 'set-windows', windows: [[9, 12], [14, 18]] });
	assert.equal(defaults.status, 200);
	assert.deepEqual(defaults.json.state.windowSpec, defaults.json.state.defaultWindowSpec);
	console.log('ok 8 — window editor validation, half hours, persistence');
}

console.log('\nall smoke tests passed');
