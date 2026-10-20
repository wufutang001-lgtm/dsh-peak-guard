/**
 * peak-guard — 峰时冻结思考 / 谷时自动继续（Host half）。
 *
 * 口径（北京时间 UTC+8，可用 offsetMinutes 改）：
 *   峰时 = 周一至周五 09:00–12:00、14:00–18:00（左闭右开），法定节假日除外；
 *   谷时 = 其余全部时间。
 *
 * 冻结点：`agent/pre-step` 是回合内每步的收件箱认领边界。峰时在这里返回
 * `{ kind: 'reject' }`，agent-loop 会直接把该回合以 `blocked` 收口（不发出任何模型
 * 请求）。认领时消息已从收件箱移除，所以冻结前必须把它们原样放回 `next-step`，
 * 否则用户输入会凭空消失（这也是 `dsh-goal-round-driver` 的 restoreOtherClaimed 做法）。
 *
 * 续跑：用户发「继续」→ 命中 pre-step 时放行本回合；或谷时到点由定时器 followup 唤醒。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const name = 'peak-guard';

const STATE_PATH = ['peak-guard', 'state.json'];
const ROUTE_STATE = '/plugins/peak-guard/state';
const ROUTE_ACTION = '/plugins/peak-guard/action';

const RESUME_WORDS = new Set([
	'继续',
	'继续任务',
	'继续吧',
	'峰时继续',
	'强制继续',
	'resume',
	'continue',
]);

const DEFAULT_WINDOWS = [
	[9, 12],
	[14, 18],
];

const DEFAULTS = {
	enabled: true,
	offsetMinutes: 480,
	windows: DEFAULT_WINDOWS,
	holidays: [],
	autoResume: true,
};

/* ------------------------------------------------------------------ *
 * 时间口径：Asia/Shanghai 常年 UTC+8，无夏令时，直接按固定偏移换算，
 * 比每步跑 Intl.DateTimeFormat 便宜两个数量级。
 * ------------------------------------------------------------------ */

const pad = (value) => String(value).padStart(2, '0');

/** Local wall-clock parts for an epoch instant. weekday: 0=Sunday. */
function localParts(ms, offsetMinutes) {
	const shifted = new Date(ms + offsetMinutes * 60000);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
		weekday: shifted.getUTCDay(),
	};
}

/** Epoch instant for one local wall-clock time. */
function epochOfLocal(parts, hour, minute, offsetMinutes) {
	return Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0) - offsetMinutes * 60000;
}

/** `YYYY-MM-DD HH:mm` in the configured zone. */
function stamp(ms, offsetMinutes) {
	const p = localParts(ms, offsetMinutes);
	return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** `MM-DD HH:mm`, compact enough for a one-line notice. */
function shortStamp(ms, offsetMinutes) {
	const p = localParts(ms, offsetMinutes);
	return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** `09:30` for a decimal hour; `24:00` stays representable. */
function hourLabel(hour) {
	const [h, m] = hourMinute(hour);
	return `${pad(h)}:${pad(m)}`;
}

/** Decimal hour → [hour, minute]. */
function hourMinute(value) {
	const hour = Math.floor(value);
	return [hour, Math.round((value - hour) * 60)];
}

/* ------------------------------------------------------------------ *
 * 配置归一化
 * ------------------------------------------------------------------ */

/** Half-hour quantum: the finest granularity the editor offers. */
const snapHour = (value) => Math.round(value * 2) / 2;

function normalizeWindows(raw) {
	if (!Array.isArray(raw)) return DEFAULT_WINDOWS;
	const windows = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length !== 2) continue;
		const start = snapHour(Number(entry[0]));
		const end = snapHour(Number(entry[1]));
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		if (start < 0 || end > 24 || start >= end) continue;
		windows.push([start, end]);
	}
	windows.sort((left, right) => left[0] - right[0]);
	const merged = [];
	for (const window of windows) {
		const previous = merged[merged.length - 1];
		if (previous !== undefined && window[0] <= previous[1]) {
			previous[1] = Math.max(previous[1], window[1]);
			continue;
		}
		merged.push([...window]);
	}
	return merged.length > 0 ? merged : DEFAULT_WINDOWS;
}

/** Strict validation for the panel editor: rejects instead of silently dropping. */
function validateWindows(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '至少要保留一个时段' };
	if (raw.length > 8) return { ok: false, error: '最多 8 个时段' };
	const windows = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length !== 2) return { ok: false, error: '每个时段需要「开始」和「结束」两个时间' };
		const start = snapHour(Number(entry[0]));
		const end = snapHour(Number(entry[1]));
		if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: '时段必须是数字' };
		if (start < 0 || end > 24) return { ok: false, error: '时间必须在 00:00–24:00 之间' };
		if (start >= end) return { ok: false, error: `时段 ${hourLabel(start)}–${hourLabel(end)} 的开始时间必须早于结束时间` };
		windows.push([start, end]);
	}
	windows.sort((left, right) => left[0] - right[0]);
	for (let index = 1; index < windows.length; index += 1) {
		if (windows[index][0] < windows[index - 1][1]) {
			return { ok: false, error: `时段 ${hourLabel(windows[index - 1][0])}–${hourLabel(windows[index - 1][1])} 与 ${hourLabel(windows[index][0])}–${hourLabel(windows[index][1])} 有重叠` };
		}
	}
	return { ok: true, windows };
}

function normalizeHolidays(raw) {
	const exact = new Set();
	const recurring = new Set();
	if (!Array.isArray(raw)) return { exact, recurring };
	for (const entry of raw) {
		const text = String(entry ?? '').trim();
		if (text === '') continue;
		if (/^\d{4}-\d{2}-\d{2}$/.test(text)) exact.add(text);
		else if (/^\d{2}-\d{2}$/.test(text)) recurring.add(text);
	}
	return { exact, recurring };
}

function normalizeConfig(config) {
	const source = config && typeof config === 'object' ? config : {};
	const offsetMinutes = Number.isFinite(Number(source.offsetMinutes)) ? Number(source.offsetMinutes) : DEFAULTS.offsetMinutes;
	const holidays = Array.isArray(source.holidays) ? source.holidays : DEFAULTS.holidays;
	return {
		enabled: source.enabled !== false,
		autoResume: source.autoResume !== false,
		offsetMinutes,
		windows: normalizeWindows(source.windows),
		holidayList: holidays,
		holidays: normalizeHolidays(holidays),
	};
}

/* ------------------------------------------------------------------ *
 * 峰谷判定
 * ------------------------------------------------------------------ */

/** Whether one instant falls inside a weekday peak window. */
function isPeakInstant(ms, options) {
	const p = localParts(ms, options.offsetMinutes);
	if (p.weekday === 0 || p.weekday === 6) return false;
	const mmdd = `${pad(p.month)}-${pad(p.day)}`;
	if (options.holidays.recurring.has(mmdd)) return false;
	if (options.holidays.exact.has(`${p.year}-${mmdd}`)) return false;
	const minutes = p.hour * 60 + p.minute;
	return options.windows.some(([start, end]) => minutes >= start * 60 && minutes < end * 60);
}

/** Current peak verdict plus the boundaries the UI shows. */
function evaluate(ms, options) {
	const p = localParts(ms, options.offsetMinutes);
	const minutes = p.hour * 60 + p.minute;
	const weekend = p.weekday === 0 || p.weekday === 6;
	const mmdd = `${pad(p.month)}-${pad(p.day)}`;
	const holiday = options.holidays.recurring.has(mmdd) || options.holidays.exact.has(`${p.year}-${mmdd}`);
	const windowIndex = options.windows.findIndex(([start, end]) => minutes >= start * 60 && minutes < end * 60);
	const peak = !weekend && !holiday && windowIndex >= 0;
	const verdict = {
		now: ms,
		local: stamp(ms, options.offsetMinutes),
		peak,
		weekend,
		holiday,
		window: undefined,
		peakEndsAt: 0,
		nextPeakAt: 0,
	};
	if (peak) {
		const [start, end] = options.windows[windowIndex];
		verdict.window = `${hourLabel(start)}–${hourLabel(end)}`;
		verdict.peakEndsAt = epochOfLocal(p, ...hourMinute(end), options.offsetMinutes);
		verdict.nextPeakAt = 0;
	} else if (weekend || holiday) {
		verdict.nextPeakAt = scanNextPeak(ms, options);
	} else {
		const today = options.windows.find(([start]) => start * 60 > minutes);
		if (today !== undefined) verdict.nextPeakAt = epochOfLocal(p, ...hourMinute(today[0]), options.offsetMinutes);
		else verdict.nextPeakAt = scanNextPeak(ms, options);
	}
	return verdict;
}

/** Next peak instant after `ms`, or 0 when the coming week has none. */
function scanNextPeak(ms, options) {
	const step = 60000;
	const limit = ms + 7 * 24 * 60 * step * 1;
	for (let cursor = ms + step; cursor <= limit; cursor += step) {
		if (isPeakInstant(cursor, options)) return cursor;
	}
	return 0;
}

/* ------------------------------------------------------------------ *
 * 消息工具
 * ------------------------------------------------------------------ */

/** Plain text of one message, ignoring non-text blocks. */
function messageText(message) {
	if (message === null || typeof message !== 'object') return '';
	if (!Array.isArray(message.content)) return '';
	return message.content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/** Whether a claimed message is the user's explicit resume instruction. */
function isResumeCommand(message) {
	if (message?.source?.kind !== 'user') return false;
	const text = messageText(message).replace(/\s+/gu, ' ').toLowerCase();
	if (text === '' || text.length > 24) return false;
	return RESUME_WORDS.has(text);
}

/** One synthetic user-role message; `{ kind: 'user' }` is the minimal legal source. */
function createNotice(text) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'user' },
	};
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(body);
}

async function readJson(req, limit = 16384) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error('request body too large');
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString('utf8');
	if (text.trim() === '') return {};
	return JSON.parse(text);
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
	const options = normalizeConfig(config);
	const statePath = resolveStatePath();
	const persisted = readPersisted(statePath);
	const state = {
		enabled: persisted.enabled ?? options.enabled,
		overrideUntil: Number.isFinite(persisted.overrideUntil) ? persisted.overrideUntil : 0,
		frozen: new Map(),
		pauses: Number.isFinite(persisted.pauses) ? persisted.pauses : 0,
		lastPauseAt: Number.isFinite(persisted.lastPauseAt) ? persisted.lastPauseAt : 0,
		lastResumeAt: Number.isFinite(persisted.lastResumeAt) ? persisted.lastResumeAt : 0,
		lastResumeReason: typeof persisted.lastResumeReason === 'string' ? persisted.lastResumeReason : '',
		releaseTimer: undefined,
	};

	/** Windows edited in the panel win over the patch config across restarts. */
	const restoredWindows = validateWindows(persisted.windows);
	if (restoredWindows.ok) options.windows = restoredWindows.windows;

	/** Log without ever letting logging break the guard. */
	function warn(text) {
		try {
			ctx.logger?.warn?.(`peak-guard: ${text}`);
		} catch {
			/* logging is best-effort */
		}
	}

	function persist() {
		try {
			mkdirSync(dirname(statePath), { recursive: true });
			writeFileSync(
				statePath,
				JSON.stringify(
					{
						enabled: state.enabled,
						overrideUntil: state.overrideUntil,
						pauses: state.pauses,
						lastPauseAt: state.lastPauseAt,
						lastResumeAt: state.lastResumeAt,
						lastResumeReason: state.lastResumeReason,
						windows: options.windows,
						updatedAt: Date.now(),
					},
					null,
					2,
				),
				'utf8',
			);
		} catch (error) {
			warn(`could not persist state to ${statePath}: ${String(error)}`);
		}
	}

	/* -------------------------------------------------------------- *
	 * 冻结 / 续跑
	 * -------------------------------------------------------------- */

	/** Put claimed messages back so a rejected step never swallows user input. */
	function restoreMessages(agent, messages) {
		for (const message of messages.toReversed()) {
			const pending = agent.inbox.nextStep.some((candidate) => candidate.id === message.id)
				|| agent.inbox.nextTurn.some((candidate) => candidate.id === message.id);
			if (pending) continue;
			agent.inbox.prepend('next-step', message);
		}
	}

	/** Record one frozen turn and keep the claimed messages pending. */
	function freeze(agent, messages, turn, verdict) {
		const existing = state.frozen.get(agent.id);
		const entry = existing ?? { agent, messages: [], frozenAt: Date.now(), turns: 0, lastTurn: 0 };
		entry.frozenAt = existing === undefined ? Date.now() : entry.frozenAt;
		entry.turns += 1;
		entry.lastTurn = typeof turn === 'number' ? turn : entry.lastTurn;
		for (const message of messages) {
			if (!entry.messages.some((known) => known.id === message.id)) entry.messages.push(message);
		}
		state.frozen.set(agent.id, entry);
		restoreMessages(agent, messages);
		if (existing === undefined) {
			state.pauses += 1;
			state.lastPauseAt = Date.now();
		}
		persist();
		scheduleRelease(verdict);
	}

	/** Wake one previously frozen agent so its pending input is claimed again. */
	function wake(entry, reason) {
		const agent = entry.agent;
		try {
			if (agent.status !== 'idle') return;
			if (!agent.inbox.hasPending) return;
			agent.followup(createNotice(
				`<peak-guard>谷时已开始（北京时间 ${stamp(Date.now(), options.offsetMinutes)}），继续之前被暂停的工作。</peak-guard>`,
			));
		} catch (error) {
			warn(`could not resume agent "${agent.id}": ${String(error)}`);
		}
		void reason;
	}

	/** Drop the frozen set, optionally waking every idle agent that still has input. */
	function resumeAll(reason, behavior = {}) {
		const entries = [...state.frozen.values()];
		state.frozen.clear();
		clearRelease();
		state.lastResumeAt = Date.now();
		state.lastResumeReason = reason;
		persist();
		if (behavior.wake === false) return entries.length;
		for (const entry of entries) wake(entry, reason);
		return entries.length;
	}

	/* -------------------------------------------------------------- *
	 * 谷时唤醒定时器
	 * -------------------------------------------------------------- */

	function clearRelease() {
		if (state.releaseTimer === undefined) return;
		try {
			globalThis.clearTimeout(state.releaseTimer);
		} catch {
			/* already cleared */
		}
		state.releaseTimer = undefined;
	}

	/** Arm one timer for the coming off-peak boundary while anything is frozen. */
	function scheduleRelease(verdict) {
		if (options.autoResume !== true) return;
		if (state.frozen.size === 0) return;
		const current = verdict ?? evaluate(Date.now(), options);
		if (current.peak !== true) return;
		const delay = Math.max(1000, current.peakEndsAt - Date.now() + 1000);
		clearRelease();
		try {
			const handle = globalThis.setTimeout(() => {
				state.releaseTimer = undefined;
				const now = evaluate(Date.now(), options);
				if (now.peak === true) {
					scheduleRelease(now);
					return;
				}
				if (state.frozen.size === 0) return;
				resumeAll('off-peak');
			}, delay);
			handle?.unref?.();
			state.releaseTimer = handle;
		} catch (error) {
			warn(`could not arm the off-peak timer: ${String(error)}`);
		}
	}

	/* -------------------------------------------------------------- *
	 * 冻结点
	 * -------------------------------------------------------------- */

	function preStep(payload, next) {
		try {
			if (state.enabled !== true) return next();
			const now = Date.now();
			const verdict = evaluate(now, options);
			if (verdict.peak !== true) {
				// 谷时若还留着冻结记录（进程重启、开关来回切），顺手放掉。
				if (state.frozen.size > 0 && state.overrideUntil <= now) resumeAll('off-peak');
				return next();
			}
			const agent = payload?.agent;
			if (agent === undefined || agent === null) return next();
			const messages = Array.isArray(payload.messages) ? payload.messages : [];
			if (state.overrideUntil > now) return next();
			// 用户自己按下「继续」：放行本回合，并把这段时间从本次会话里豁免掉。
			if (messages.some((message) => isResumeCommand(message))) {
				state.overrideUntil = verdict.peakEndsAt;
				resumeAll('user-command', { wake: false });
				persist();
				return next();
			}
			freeze(agent, messages, payload.turn, verdict);
			return { kind: 'reject' };
		} catch (error) {
			warn(`pre-step guard failed, letting the turn through: ${String(error)}`);
			return next();
		}
	}

	ctx.on('agent/pre-step', preStep);

	/* -------------------------------------------------------------- *
	 * 对外状态
	 * -------------------------------------------------------------- */

	function snapshot() {
		const now = Date.now();
		const verdict = evaluate(now, options);
		const frozen = [...state.frozen.values()].map((entry) => ({
			agentId: entry.agent.id,
			sessionId: entry.agent.session?.id ?? entry.agent.id,
			messages: entry.messages.length,
			turns: entry.turns,
			frozenAt: entry.frozenAt,
		}));
		return {
			ok: true,
			build: 'panel-2',
			now,
			local: verdict.local,
			timezone: `UTC+${options.offsetMinutes / 60}`,
			peak: verdict.peak,
			weekend: verdict.weekend,
			holiday: verdict.holiday,
			window: verdict.window,
			peakEndsAt: verdict.peakEndsAt,
			nextPeakAt: verdict.nextPeakAt,
			peakEndsAtLabel: verdict.peakEndsAt === 0 ? '' : shortStamp(verdict.peakEndsAt, options.offsetMinutes),
			nextPeakAtLabel: verdict.nextPeakAt === 0 ? '' : shortStamp(verdict.nextPeakAt, options.offsetMinutes),
			enabled: state.enabled,
			autoResume: options.autoResume,
			overrideUntil: state.overrideUntil,
			overrideLabel: state.overrideUntil > now ? shortStamp(state.overrideUntil, options.offsetMinutes) : '',
			windows: options.windows.map(([start, end]) => `${hourLabel(start)}–${hourLabel(end)}`),
			windowSpec: options.windows.map(([start, end]) => [start, end]),
			defaultWindowSpec: DEFAULT_WINDOWS.map(([start, end]) => [start, end]),
			holidays: options.holidayList,
			frozen,
			frozenMessages: frozen.reduce((total, entry) => total + entry.messages, 0),
			pauses: state.pauses,
			lastPauseLabel: state.lastPauseAt === 0 ? '' : shortStamp(state.lastPauseAt, options.offsetMinutes),
			lastResumeLabel: state.lastResumeAt === 0 ? '' : shortStamp(state.lastResumeAt, options.offsetMinutes),
			lastResumeReason: state.lastResumeReason,
			statePath,
		};
	}

	/** One-line human report, shared by the slash command and the notice text. */
	function report() {
		const view = snapshot();
		const head = view.peak === true
			? `⏸ 峰时 ${view.window ?? ''}（北京时间 ${view.local}）`
			: `▶ 谷时（北京时间 ${view.local}）`;
		const lines = [head];
		if (view.enabled !== true) lines.push('总开关：已关闭，峰时也会照常思考');
		else if (view.overrideUntil > view.now) lines.push(`本次已豁免，直到 ${view.overrideLabel}`);
		if (view.peak === true) {
			lines.push(`谷时开始：今天 ${view.peakEndsAtLabel}`);
			lines.push(view.frozen.length === 0
				? '当前没有被冻结的回合'
				: `已冻结 ${view.frozen.length} 个回合 / ${view.frozenMessages} 条输入，谷时自动继续`);
		} else {
			lines.push(`下次峰时：${view.nextPeakAtLabel === '' ? '一周内没有' : view.nextPeakAtLabel}`);
		}
		return lines.join('\n');
	}

	function applyAction(action) {
		switch (action.kind) {
			case 'toggle':
				return setEnabled(action.enabled !== false);
			case 'set-enabled':
				return setEnabled(action.enabled === true);
			case 'resume': {
				const verdict = evaluate(Date.now(), options);
				const released = resumeAll('manual', { wake: true });
				if (verdict.peak === true) state.overrideUntil = verdict.peakEndsAt;
				persist();
				return { ok: true, released, message: `已放行 ${released} 个冻结回合，本次峰时窗口（至 ${verdict.peak === true ? shortStamp(verdict.peakEndsAt, options.offsetMinutes) : '不适用'}）不再冻结` };
			}
			case 'freeze': {
				if (state.enabled !== true) state.enabled = true;
				state.overrideUntil = 0;
				persist();
				return { ok: true, message: '已取消豁免并重新启用冻结' };
			}
			case 'clear-override': {
				state.overrideUntil = 0;
				persist();
				return { ok: true, message: '已取消本次豁免' };
			}
			case 'set-windows':
				return setWindows(action.windows);
			default:
				return { ok: false, error: `unknown action: ${String(action.kind)}` };
		}
	}

	/** Replace the daily peak windows from the panel editor. */
	function setWindows(raw) {
		const validated = validateWindows(raw);
		if (validated.ok !== true) return { ok: false, error: validated.error };
		options.windows = validated.windows;
		const verdict = evaluate(Date.now(), options);
		if (verdict.peak !== true) {
			// 改完之后此刻已不在峰时：已经冻结的回合应当立刻放行。
			if (state.frozen.size > 0) resumeAll('windows-changed');
		} else if (state.enabled === true) {
			clearRelease();
			scheduleRelease(verdict);
		}
		persist();
		const labels = options.windows.map(([start, end]) => `${hourLabel(start)}–${hourLabel(end)}`);
		return { ok: true, windows: labels, message: `冻结时段已更新：${labels.join('、')}` };
	}

	function setEnabled(enabled) {
		state.enabled = enabled === true;
		if (state.enabled !== true) {
			state.overrideUntil = 0;
			resumeAll('disabled');
		} else {
			state.overrideUntil = 0;
			scheduleRelease(evaluate(Date.now(), options));
		}
		persist();
		return { ok: true, enabled: state.enabled, message: state.enabled ? '峰时冻结已开启' : '峰时冻结已关闭，冻结的回合已全部放行' };
	}

	/* -------------------------------------------------------------- *
	 * 斜杠命令
	 * -------------------------------------------------------------- */

	if (typeof ctx.inject === 'function') {
		ctx.inject(['commands'], (scoped) => {
			const register = scoped.commands?.register;
			if (typeof register !== 'function') return;
			try {
				scoped.commands.register({
					name: 'peak',
					description: '峰谷守卫：查看峰时状态 / on / off / resume',
					input: { hint: 'status | on | off | resume' },
					handler: (invocation) => {
						const verb = String(invocation?.rawInput ?? '').trim().toLowerCase();
						try {
							if (verb === 'on' || verb === 'off') return { kind: 'success', text: applyAction({ kind: 'set-enabled', enabled: verb === 'on' }).message };
							if (verb === 'resume' || verb === '继续') return { kind: 'success', text: applyAction({ kind: 'resume' }).message };
							if (verb === 'freeze' || verb === '冻结') return { kind: 'success', text: applyAction({ kind: 'freeze' }).message };
							return { kind: 'success', text: report() };
						} catch (error) {
							return { kind: 'error', text: `peak-guard: ${String(error)}` };
						}
					},
				});
			} catch (error) {
				warn(`could not register the /peak command: ${String(error)}`);
			}
		});
	}

	/* -------------------------------------------------------------- *
	 * Web 通道（给 UI 开关与状态条用）
	 * -------------------------------------------------------------- */

	function registerRoutes(scoped) {
		const server = scoped.webServer;
		if (server === undefined || typeof server.register !== 'function') return;
		const disposeState = server.register({
			kind: 'exact',
			path: ROUTE_STATE,
			handler: (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					sendJson(res, 405, { ok: false, error: 'method not allowed' });
					return;
				}
				sendJson(res, 200, snapshot());
			},
		});
		const disposeAction = server.register({
			kind: 'exact',
			path: ROUTE_ACTION,
			handler: async (req, res) => {
				if (req.method !== 'POST') {
					sendJson(res, 405, { ok: false, error: 'method not allowed' });
					return;
				}
				try {
					const body = await readJson(req);
					const result = applyAction({ kind: String(body?.action ?? 'status'), enabled: body?.enabled, windows: body?.windows });
					sendJson(res, result.ok === true ? 200 : 400, { ...result, state: snapshot() });
				} catch (error) {
					sendJson(res, 400, { ok: false, error: String(error) });
				}
			},
		});
		const release = () => {
			try {
				disposeState();
				disposeAction();
			} catch {
				/* already released */
			}
		};
		ctx.on('dispose', release);
	}

	if (typeof ctx.inject === 'function') {
		ctx.inject(['webServer'], (scoped) => registerRoutes(scoped));
	} else if (ctx.get?.('webServer') !== undefined) {
		registerRoutes(ctx);
	}

	ctx.on('dispose', () => {
		clearRelease();
		state.frozen.clear();
	});

	if (state.frozen.size === 0) scheduleRelease(evaluate(Date.now(), options));
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

function resolveStatePath() {
	const home = process.env.DSH_HOME;
	const base = typeof home === 'string' && home !== '' ? home : process.cwd();
	return join(base, ...STATE_PATH);
}

function readPersisted(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return parsed !== null && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}
