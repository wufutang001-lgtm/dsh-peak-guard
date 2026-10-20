/**
 * peak-guard — Web half.
 *
 * One store, three faces:
 *   1. a sidebar panel icon → the dedicated 峰时守卫 panel (`main` + `sidebar.panellist`),
 *   2. that panel's own master switch and peak-window editor,
 *   3. a slim strip above the composer that only appears while thinking is frozen.
 *
 * They talk to the host half over `GET /plugins/peak-guard/state` and
 * `POST /plugins/peak-guard/action` (registered with `ctx.webServer.register`).
 */
window.__ModuleLoader__.load({
	id: 'dsh-peak-guard',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'peak-guard';
		const STATE_URL = '/plugins/peak-guard/state';
		const ACTION_URL = '/plugins/peak-guard/action';
		const POLL_MS = 20000;
		const STYLE_ATTR = 'data-peak-guard-style';
		/** Half-hour quantum, matching the host's `snapHour`. */
		const STEP = 0.5;
		const HOUR_CHOICES = Array.from({ length: 49 }, (_, index) => index * STEP);

		const zh = {
			navLabel: '峰时守卫',
			panelTitle: '峰时守卫',
			panelIntro: '峰时冻结思考，省下计费时段的 token。这里调整开关与冻结时段。',
			on: '开',
			off: '关',
			loading: '正在读取主机状态…',
			unreachable: '连不上主机：{error}',
			peakNow: '峰时 {window} · {at} 自动继续',
			peakIdle: '峰时 {window} · 本回合已放行',
			offPeak: '谷时 · 下次峰时 {at}',
			noPeak: '谷时 · 一周内没有峰时',
			disabled: '已关闭 · 峰时也会照常思考',
			frozen: '已暂停 {turns} 个回合、{messages} 条输入',
			override: '本次已豁免，{at} 前不再暂停',
			weekend: '周末全天谷时',
			holiday: '今天按节假日（谷时）',
			actionFailed: '操作失败：{error}',
			switchTitle: '峰时冻结',
			switchLabel: '开启或关闭峰时冻结',
			windowsTitle: '冻结时段',
			windowsHint: '工作日（周一至周五）落在这些时段内时，不会发起新的模型请求。时间是北京时间，最小粒度 30 分钟。',
			windowsEmpty: '还没有时段——至少保留一个。',
			windowsStart: '开始',
			windowsEnd: '结束',
			windowsTo: '至',
			windowsRemove: '删除',
			windowsAdd: '添加时段',
			windowsReset: '恢复默认',
			windowsSave: '保存',
			windowsSaving: '保存中…',
			windowsDirty: '有未保存的改动',
			windowsClean: '与当前生效时段一致',
			windowsStale: '当前运行的宿主还是旧版本，时段只能看不能改——重启一次 DSH（关掉再打开）后即可保存。',
			statusTitle: '当前状态',
			kvNow: '现在',
			kvNext: '下次峰时',
			kvFrozen: '已暂停',
			kvOverride: '豁免',
			kvZone: '时区',
			kvStateFile: '状态文件',
			kvNone: '无',
			kvNever: '一周内没有',
			actTitle: '立即操作',
			actResume: '立即继续',
			actResumeOff: '现在不是峰时，无需放行',
			actClearOverride: '取消本次豁免',
			actClearOverrideOff: '当前没有豁免',
			dockPeak: '峰时 {window} · {at} 自动继续',
			dockFrozen: '峰时暂停中 · 已暂停 {turns} 个回合',
			dockOverride: '本次已豁免 · {at} 前不再暂停',
			dockResume: '立即继续',
			dockBusy: '处理中…',
			dockOpen: '打开面板',
		};

		const en = {
			navLabel: 'Peak Guard',
			panelTitle: 'Peak Guard',
			panelIntro: 'Freeze thinking during peak hours to save tokens in billed windows. Adjust the switch and the frozen windows here.',
			on: 'On',
			off: 'Off',
			loading: 'Reading host state…',
			unreachable: 'Host is unreachable: {error}',
			peakNow: 'Peak {window} · resumes at {at}',
			peakIdle: 'Peak {window} · this turn was let through',
			offPeak: 'Off-peak · next peak {at}',
			noPeak: 'Off-peak · no peak in the coming week',
			disabled: 'Off · thinking is never frozen',
			frozen: '{turns} turn(s) and {messages} message(s) on hold',
			override: 'Exempted until {at}',
			weekend: 'Weekend · off-peak all day',
			holiday: 'Holiday · off-peak all day',
			actionFailed: 'Action failed: {error}',
			switchTitle: 'Freeze at peak',
			switchLabel: 'Turn the peak-hour freeze on or off',
			windowsTitle: 'Frozen windows',
			windowsHint: 'On weekdays, these windows never start a new model request. Times are UTC+8, at half-hour resolution.',
			windowsEmpty: 'No windows yet — keep at least one.',
			windowsStart: 'Start',
			windowsEnd: 'End',
			windowsTo: 'to',
			windowsRemove: 'Remove',
			windowsAdd: 'Add window',
			windowsReset: 'Restore defaults',
			windowsSave: 'Save',
			windowsSaving: 'Saving…',
			windowsDirty: 'Unsaved changes',
			windowsClean: 'Matches the live windows',
			windowsStale: 'The running host still uses the previous build, so windows are read-only here — restart DSH once to save changes.',
			statusTitle: 'Current state',
			kvNow: 'Now',
			kvNext: 'Next peak',
			kvFrozen: 'On hold',
			kvOverride: 'Exemption',
			kvZone: 'Zone',
			kvStateFile: 'State file',
			kvNone: 'none',
			kvNever: 'none in the coming week',
			actTitle: 'Act now',
			actResume: 'Resume now',
			actResumeOff: 'Not peak right now, nothing to release',
			actClearOverride: 'Clear exemption',
			actClearOverrideOff: 'No exemption in effect',
			dockPeak: 'Peak {window} · resumes at {at}',
			dockFrozen: 'Frozen · {turns} turn(s) on hold',
			dockOverride: 'Exempted until {at}',
			dockResume: 'Resume now',
			dockBusy: 'Working…',
			dockOpen: 'Open panel',
		};

		const CSS = `
.pg-panel{box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;padding:26px 26px 48px;display:flex;flex-direction:column;gap:16px;overflow:auto;color:var(--dsw-alias-label-primary,inherit)}
.pg-panel-head{display:flex;align-items:flex-start;gap:16px;padding-bottom:4px}
.pg-panel-headings{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.pg-panel-title{margin:0;font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.pg-panel-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));overflow-wrap:anywhere}
.pg-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.pg-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));box-sizing:border-box}
.pg-card-title{margin:0;font-size:13px;line-height:20px;font-weight:600}
.pg-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.pg-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#c2790a)}
.pg-hint[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d64545)}
.pg-sub[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#c2790a)}
.pg-sub[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d64545)}
.pg-sub[data-tone="muted"]{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.pg-switch{position:relative;flex:none;width:38px;height:22px;margin-top:2px;padding:0;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.45));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.22));transition:background .15s ease,border-color .15s ease}
.pg-switch[data-on="true"]{background:var(--dsw-alias-brand-primary,#247bbf);border-color:transparent}
.pg-switch:disabled{opacity:.55;cursor:default}
.pg-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.pg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s ease}
.pg-switch[data-on="true"] .pg-knob{transform:translateX(16px)}
.pg-win{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pg-select{font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;cursor:pointer;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4))}
.pg-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.pg-sep{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.pg-btn{font:inherit;font-size:12px;line-height:18px;padding:5px 11px;border-radius:8px;cursor:pointer;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));background:transparent}
.pg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.16))}
.pg-btn:disabled{opacity:.5;cursor:default}
.pg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.pg-btn[data-kind="primary"]{color:#fff;background:var(--dsw-alias-brand-primary,#247bbf);border-color:transparent}
.pg-btn[data-kind="primary"]:hover:not(:disabled){filter:brightness(1.06)}
.pg-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary,#d64545)}
.pg-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pg-grow{flex:1 1 auto}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:12px;line-height:18px}
.pg-kv dt{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.pg-kv dd{margin:0;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.pg-dock{display:flex;align-items:center;gap:8px;margin:0 auto 6px;padding:5px 10px;max-width:100%;box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary,inherit)}
.pg-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d99408)}
.pg-dock-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-dock-btn{flex:none;font:inherit;font-size:12px;padding:2px 9px;border-radius:999px;cursor:pointer;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));background:transparent}
.pg-dock-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.16))}
.pg-dock-btn:disabled{opacity:.55;cursor:default}
.pg-dock-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.pg-icon{display:block}
`;

		/* ------------------------------------------------------------ *
		 * Copy
		 * ------------------------------------------------------------ */

		function interpolate(template, params) {
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		/** `09:30` for a decimal hour. */
		const hourLabel = (value) => {
			const hour = Math.floor(value);
			const minute = Math.round((value - hour) * 60);
			return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
		};

		/**
		 * Translate without trusting slot-injected props: bind the namespace once
		 * and fall back to the bundled Chinese dict when `locale` is unavailable.
		 */
		function createTranslator(ctx) {
			let bound = null;
			try {
				if (typeof ctx.locale?.bind === 'function') bound = ctx.locale.bind(NS);
			} catch {
				bound = null;
			}
			return (key, params) => {
				if (bound !== null) {
					try {
						const text = bound(key, params);
						if (typeof text === 'string' && text !== '' && text !== key) return text;
					} catch {
						/* fall through to the bundled dict */
					}
				}
				return interpolate(zh[key] ?? key, params);
			};
		}

		/** One-line status used by both the panel head and the dock. */
		function describe(snapshot, t) {
			const state = snapshot?.state;
			if (snapshot?.phase === 'error' && state === null) return { text: t('unreachable', { error: snapshot.error }), tone: 'error' };
			if (state === null || state === undefined) return { text: t('loading'), tone: 'muted' };
			if (snapshot.error !== '') return { text: t('actionFailed', { error: snapshot.error }), tone: 'error' };
			if (state.enabled !== true) return { text: t('disabled'), tone: 'muted' };
			if (state.overrideUntil > state.now) return { text: t('override', { at: state.overrideLabel }), tone: 'warn' };
			if (state.peak === true) {
				const base = t('peakNow', { window: state.window ?? '', at: state.peakEndsAtLabel });
				const frozen = Number(state.frozenMessages ?? 0);
				return { text: frozen > 0 ? `${base} · ${t('frozen', { turns: state.frozen?.length ?? 0, messages: frozen })}` : base, tone: 'warn' };
			}
			if (state.weekend === true) {
				const next = state.nextPeakAtLabel === '' ? t('noPeak') : t('offPeak', { at: state.nextPeakAtLabel });
				return { text: `${t('weekend')} · ${next}`, tone: 'muted' };
			}
			if (state.holiday === true) {
				const next = state.nextPeakAtLabel === '' ? t('noPeak') : t('offPeak', { at: state.nextPeakAtLabel });
				return { text: `${t('holiday')} · ${next}`, tone: 'muted' };
			}
			return { text: state.nextPeakAtLabel === '' ? t('noPeak') : t('offPeak', { at: state.nextPeakAtLabel }), tone: 'muted' };
		}

		/* ------------------------------------------------------------ *
		 * Store: one poller shared by every mounted face.
		 * ------------------------------------------------------------ */

		function createStore() {
			let snapshot = { phase: 'loading', state: null, error: '' };
			const listeners = new Set();
			let poll = null;
			let inflight = null;
			let disposed = false;

			const publish = (next) => {
				snapshot = next;
				for (const listener of [...listeners]) {
					try {
						listener(snapshot);
					} catch {
						/* a broken face must not stop the others */
					}
				}
			};

			const refresh = async () => {
				if (disposed) return;
				if (inflight !== null) return inflight;
				inflight = (async () => {
					try {
						const response = await fetch(STATE_URL, {
							credentials: 'same-origin',
							headers: { accept: 'application/json' },
							signal: AbortSignal.timeout(8000),
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const state = await response.json();
						if (state?.ok === false) throw new Error(String(state.error ?? 'host rejected the state read'));
						publish({ phase: 'ready', state, error: '' });
					} catch (error) {
						if (disposed) return;
						publish({ phase: 'error', state: snapshot.state, error: String(error?.message ?? error) });
					} finally {
						inflight = null;
					}
				})();
				return inflight;
			};

			const act = async (action, data) => {
				try {
					const response = await fetch(ACTION_URL, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ action, ...(data ?? {}) }),
						signal: AbortSignal.timeout(8000),
					});
					const payload = await response.json().catch(() => null);
					if (payload?.state) publish({ phase: 'ready', state: payload.state, error: payload.ok === false ? String(payload.error ?? '') : '' });
					else await refresh();
					return payload;
				} catch (error) {
					publish({ ...snapshot, error: String(error?.message ?? error) });
					return null;
				}
			};

			const onVisible = () => {
				if (document.visibilityState === 'visible') void refresh();
			};

			const start = () => {
				void refresh();
				poll = setInterval(() => {
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
					void refresh();
				}, POLL_MS);
				if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
			};

			const stop = () => {
				if (poll !== null) clearInterval(poll);
				poll = null;
				if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
			};

			return {
				get: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					if (listeners.size === 1) start();
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stop();
					};
				},
				act,
				refresh,
				dispose() {
					disposed = true;
					stop();
					listeners.clear();
				},
			};
		}

		/** Subscribe a component to the store. */
		function useSnapshot(store) {
			const [value, setValue] = React.useState(store.get());
			React.useEffect(() => store.subscribe(setValue), [store]);
			return value;
		}

		/* ------------------------------------------------------------ *
		 * Faces
		 * ------------------------------------------------------------ */

		/** Sidebar panel icon: the sidebar owns the button, this is only the glyph. */
		function PanelIcon({ size, active, t }) {
			const edge = Number.isFinite(size) && size > 0 ? size : 20;
			return h('svg', {
				className: 'pg-icon',
				viewBox: '0 0 24 24',
				width: edge,
				height: edge,
				role: 'img',
				'aria-label': t('navLabel'),
				style: { opacity: active === true ? 1 : 0.72 },
			},
			h('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
			h('path', { d: 'M12 7.2v5.1l3.4 2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
			h('path', { d: 'M9.6 4.4A8.2 8.2 0 0 1 12 3.9a8.1 8.1 0 0 1 7 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.5 }),
			);
		}

		function Switch({ on, busy, disabled, t, onToggle }) {
			return h('button', {
				type: 'button',
				className: 'pg-switch',
				role: 'switch',
				'aria-checked': on === true,
				'aria-label': t('switchLabel'),
				'data-on': on === true ? 'true' : 'false',
				disabled: busy === true || disabled === true,
				onClick: onToggle,
			}, h('span', { className: 'pg-knob' }));
		}

		/** Pick the first free hour for a freshly added window. */
		function suggestWindow(windows) {
			const taken = windows ?? [];
			for (let start = 0; start <= 22; start += 1) {
				const end = start + 1;
				const clash = taken.some(([from, to]) => start < to && end > from);
				if (clash !== true) return [start, end];
			}
			return [9, 10];
		}

		const FALLBACK_WINDOWS = [
			[9, 12],
			[14, 18],
		];

		/** "09:30" -> 9.5 (hours since local midnight). */
		function clockHours(text) {
			const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
			if (match === null) return null;
			return Number(match[1]) + Number(match[2]) / 60;
		}

		/**
		 * Older host halves expose only the rendered labels ("09:00–12:00") and no
		 * numeric `windowSpec`; parse them so the panel still shows the real windows
		 * instead of an empty editor. Saving stays disabled in that case.
		 */
		function parseWindows(labels) {
			if (!Array.isArray(labels)) return null;
			const parsed = [];
			for (const label of labels) {
				const parts = String(label).split(/[–—-]/).map((part) => part.trim());
				if (parts.length !== 2) continue;
				const start = clockHours(parts[0]);
				const end = clockHours(parts[1]);
				if (start === null || end === null) continue;
				parsed.push([start, end]);
			}
			return parsed.length === 0 ? null : parsed;
		}

		function HourSelect({ label, value, disabled, onChange }) {
			return h('select', {
				className: 'pg-select',
				'aria-label': label,
				value: String(value),
				disabled: disabled === true,
				onChange: (event) => onChange(Number(event.currentTarget.value)),
			}, HOUR_CHOICES.map((choice) => h('option', { key: String(choice), value: String(choice) }, hourLabel(choice))));
		}

		function PeakGuardPanel({ store, t }) {
			const snapshot = useSnapshot(store);
			const state = snapshot.state;
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState('');
			const [draft, setDraft] = React.useState(null);

			const live = state !== null && state !== undefined;
			const hostSpec = live && Array.isArray(state.windowSpec) ? state.windowSpec : null;
			// A host half built before the window editor has no numeric spec; parse the
			// labels it does expose, and block saving until the host is restarted.
			const stale = live && hostSpec === null;
			const spec = hostSpec ?? parseWindows(state?.windows) ?? FALLBACK_WINDOWS;
			const defaults = live && Array.isArray(state.defaultWindowSpec) ? state.defaultWindowSpec : FALLBACK_WINDOWS;
			const specKey = JSON.stringify(spec);

			// Seed the editor from the host, and re-seed after every save.
			React.useEffect(() => {
				if (specKey === '') return;
				const parsed = JSON.parse(specKey);
				setDraft(parsed.map((window) => [window[0], window[1]]));
			}, [specKey]);

			const on = state?.enabled === true;
			const detail = describe(snapshot, t);
			const dirty = draft !== null && JSON.stringify(draft) !== specKey;
			const matchesDefaults = draft !== null && defaults !== null && JSON.stringify(draft) === JSON.stringify(defaults);
			const peak = state?.peak === true;
			const override = state !== null && state !== undefined && Number(state.overrideUntil ?? 0) > Number(state.now ?? 0);
			const frozenMessages = Number(state?.frozenMessages ?? 0);
			const turns = state?.frozen?.length ?? 0;

			const toggle = async () => {
				if (busy) return;
				setBusy(true);
				setNotice('');
				try {
					await store.act('set-enabled', { enabled: !on });
				} finally {
					setBusy(false);
				}
			};

			const save = async () => {
				if (busy || draft === null) return;
				setBusy(true);
				setNotice('');
				try {
					const result = await store.act('set-windows', { windows: draft });
					if (result !== null && result !== undefined) {
						if (result.ok === false) setNotice(String(result.error ?? t('actionFailed', { error: '' })));
						else setDraft(null); // re-seed from the new host state
					}
				} finally {
					setBusy(false);
				}
			};

			const run = async (action) => {
				if (busy) return;
				setBusy(true);
				setNotice('');
				try {
					const result = await store.act(action);
					if (result?.ok === false) setNotice(String(result.error ?? ''));
				} finally {
					setBusy(false);
				}
			};

			const editEdge = (index, edge, value) => {
				setDraft((current) => {
					if (current === null) return current;
					return current.map((window, position) => {
						if (position !== index) return window;
						return edge === 0 ? [value, window[1]] : [window[0], value];
					});
				});
			};

			const addWindow = () => {
				setDraft((current) => [...(current ?? []), suggestWindow(current)]);
			};

			const removeWindow = (index) => {
				setDraft((current) => (current === null ? current : current.filter((_, position) => position !== index)));
			};

			const resetWindows = () => {
				if (defaults === null) return;
				setDraft(defaults.map((window) => [window[0], window[1]]));
			};

			const rows = (draft ?? []).map((window, index) => h('div', { className: 'pg-win', key: `w${index}` },
				h(HourSelect, { label: t('windowsStart'), value: window[0], disabled: stale, onChange: (value) => editEdge(index, 0, value) }),
				h('span', { className: 'pg-sep' }, t('windowsTo')),
				h(HourSelect, { label: t('windowsEnd'), value: window[1], disabled: stale, onChange: (value) => editEdge(index, 1, value) }),
				h('button', {
					type: 'button',
					className: 'pg-btn',
					'data-kind': 'danger',
					disabled: busy || stale || (draft ?? []).length <= 1,
					onClick: () => removeWindow(index),
				}, t('windowsRemove')),
			));

			return h('div', { className: 'pg-panel' },
				h('header', { className: 'pg-panel-head' },
					h('div', { className: 'pg-panel-headings' },
						h('h1', { className: 'pg-panel-title' }, t('panelTitle')),
						h('p', { className: 'pg-panel-sub', 'data-tone': detail.tone }, detail.text),
					),
					h(Switch, { on, busy, disabled: state === null || state === undefined, t, onToggle: toggle }),
				),
				h('p', { className: 'pg-intro' }, t('panelIntro')),

				state === null || state === undefined
					? null
					: h('section', { className: 'pg-card' },
						h('h2', { className: 'pg-card-title' }, t('windowsTitle')),
						h('p', { className: 'pg-hint' }, t('windowsHint')),
						rows.length === 0 ? h('p', { className: 'pg-hint', 'data-tone': 'warn' }, t('windowsEmpty')) : rows,
						stale ? h('p', { className: 'pg-hint', 'data-tone': 'warn' }, t('windowsStale')) : null,
						h('div', { className: 'pg-footer' },
							h('button', { type: 'button', className: 'pg-btn', disabled: busy || stale || draft === null || (draft ?? []).length >= 8, onClick: addWindow }, t('windowsAdd')),
							h('button', { type: 'button', className: 'pg-btn', disabled: busy || stale || matchesDefaults, onClick: resetWindows }, t('windowsReset')),
							h('span', { className: 'pg-grow' }),
							h('span', { className: 'pg-hint', 'data-tone': dirty ? 'warn' : undefined }, dirty ? t('windowsDirty') : t('windowsClean')),
							h('button', { type: 'button', className: 'pg-btn', 'data-kind': 'primary', disabled: busy || stale || dirty !== true, onClick: save }, busy ? t('windowsSaving') : t('windowsSave')),
						),
					),

				notice === '' ? null : h('p', { className: 'pg-hint', 'data-tone': 'warn' }, notice),

				state === null || state === undefined
					? null
					: h('section', { className: 'pg-card' },
						h('h2', { className: 'pg-card-title' }, t('statusTitle')),
						h('dl', { className: 'pg-kv' },
							h('dt', null, t('kvNow')),
							h('dd', null, detail.text),
							h('dt', null, t('kvNext')),
							h('dd', null, state.peak === true || state.nextPeakAtLabel === '' ? t('kvNever') : String(state.nextPeakAtLabel)),
							h('dt', null, t('kvFrozen')),
							h('dd', null, frozenMessages === 0 ? t('kvNone') : t('frozen', { turns, messages: frozenMessages })),
							h('dt', null, t('kvOverride')),
							h('dd', null, override ? String(state.overrideLabel) : t('kvNone')),
							h('dt', null, t('kvZone')),
							h('dd', null, `${String(state.timezone ?? 'UTC+8')} · ${String(state.local ?? '')}`),
							h('dt', null, t('kvStateFile')),
							h('dd', null, String(state.statePath ?? '')),
						),
					),

				state === null || state === undefined
					? null
					: h('section', { className: 'pg-card' },
						h('h2', { className: 'pg-card-title' }, t('actTitle')),
						h('div', { className: 'pg-footer' },
							h('button', { type: 'button', className: 'pg-btn', 'data-kind': 'primary', disabled: busy || peak !== true, onClick: () => run('resume') }, t('actResume')),
							h('button', { type: 'button', className: 'pg-btn', disabled: busy || override !== true, onClick: () => run('clear-override') }, t('actClearOverride')),
						),
						h('p', { className: 'pg-hint' }, peak === true ? t('windowsHint') : t('actResumeOff')),
					),
			);
		}

		function DockStrip({ store, t }) {
			const snapshot = useSnapshot(store);
			const [busy, setBusy] = React.useState(false);
			const state = snapshot.state;
			if (state === null || state === undefined) return null;
			if (state.enabled !== true) return null;
			const frozen = Number(state.frozenMessages ?? 0);
			const turns = state.frozen?.length ?? 0;
			const override = state.overrideUntil > state.now;
			const peak = state.peak === true;
			if (peak !== true && frozen === 0 && override !== true) return null;
			let text;
			if (override) text = t('dockOverride', { at: state.overrideLabel });
			else if (frozen > 0) text = t('dockFrozen', { turns });
			else text = t('dockPeak', { window: state.window ?? '', at: state.peakEndsAtLabel });
			const resume = async () => {
				if (busy) return;
				setBusy(true);
				try {
					await store.act('resume');
				} finally {
					setBusy(false);
				}
			};
			return h('div', { className: 'pg-dock' },
				h('span', { className: 'pg-dot' }),
				h('span', { className: 'pg-dock-text' }, text),
				peak && override !== true
					? h('button', { type: 'button', className: 'pg-dock-btn', disabled: busy, onClick: resume }, busy ? t('dockBusy') : t('dockResume'))
					: null,
			);
		}

		/* ------------------------------------------------------------ *
		 * Plugin
		 * ------------------------------------------------------------ */

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const store = createStore();
				const t = createTranslator(ctx);

				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'peak-guard: dictionaries');

				ctx.effect(() => {
					const style = document.createElement('style');
					style.setAttribute(STYLE_ATTR, '');
					style.textContent = CSS;
					document.head.append(style);
					return () => style.remove();
				}, 'peak-guard: styles');

				ctx.effect(() => () => store.dispose(), 'peak-guard: poller');

				// The sidebar owns the button; the id must match the `main` key.
				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: 'peak-guard',
					order: 40,
					label: () => t('navLabel'),
					inject: () => ({ t }),
				}, PanelIcon));

				ctx.slots.inject('main', () => ctx.slots.register({
					name: 'main',
					key: 'peak-guard',
					inject: () => ({ store, t }),
				}, PeakGuardPanel));

				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'peak-guard-status',
					order: 6,
					inject: () => ({ store, t }),
				}, DockStrip));
			},
		};
	},
});
