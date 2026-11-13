/**
 * Web client half of `@darkmintis/dsh-device-fleet`.
 *
 * Registers one read-only `tool.call.toolview` card per fleet tool (keyed by the
 * wire tool name). The cards render inside the conversation's tool-call rows and
 * never perform device work themselves: the Host tools stay authoritative and
 * this half only presents their result.
 *
 * Result data is read defensively. The Host tools persist their complete result
 * envelope as `output.presentationMeta`, so a settled block carries
 * `block.meta = { ok, tool, ...payload }`; older logs may only carry rendered
 * text, so the first text content block is parsed as a JSON or an `Error [CODE]`
 * line as a fallback. Every phase and every partial shape renders safely:
 * `preparing`/`start` show a lightweight placeholder, results with no usable
 * data render a bounded text card, and nothing ever throws.
 *
 * Only `react` is required from the browser module table; colors come from the
 * `--dsw-alias-*` theme tokens only.
 */

window.__ModuleLoader__.load({
  id: '@darkmintis/dsh-device-fleet',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace shared by every slot below. */
    const LOCALE_NS = 'device-fleet';

    /** Alias tokens: the only colors this half is allowed to use. */
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    const MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
    const BODY = '13px';
    const SMALL = '11.5px';
    const PULSE_CSS = '@keyframes dshFleetPulse{0%,100%{opacity:.25}50%{opacity:1}}';
    const MAX_LOGCAT_LINES = 30;
    const COLLAPSED_LOGCAT_LINES = 6;

    /** The 13 wire tool names this half owns. */
    const TOOL_NAMES = [
      'fleet_list',
      'device_install',
      'device_launch',
      'device_stop',
      'device_clear_data',
      'device_screenshot',
      'device_logcat',
      'device_deep_link',
      'device_pull',
      'device_which',
      'emulator_start',
      'emulator_stop',
    ];

    /** Tools whose Host call is gated by the approval service. */
    const DESTRUCTIVE = new Set(['device_install', 'device_clear_data']);

    /** English fallbacks, used when the locale namespace is briefly unavailable. */
    const FALLBACK_LABELS = {
      fleet_list: 'Device fleet',
      device_install: 'Install APK',
      device_launch: 'Launch app',
      device_stop: 'Force-stop app',
      device_clear_data: 'Clear app data',
      device_screenshot: 'Screenshot',
      device_logcat: 'Logcat',
      device_deep_link: 'Deep link',
      device_shell: 'Adb shell',
      device_pull: 'Pull file',
      device_which: 'Toolchain',
      emulator_start: 'Start emulator',
      emulator_stop: 'Stop emulator',
    };

    /** Argument that best identifies a compact row, per tool. */
    const KEY_ARG_FIELDS = {
      device_install: 'apkPath',
      device_launch: 'packageName',
      device_stop: 'packageName',
      device_clear_data: 'packageName',
      device_deep_link: 'url',
      device_shell: 'command',
      device_pull: 'remotePath',
      emulator_start: 'avdName',
      emulator_stop: 'serial',
    };

    /** Device state → display color / label. */
    const STATE_COLORS = { device: C.ok, offline: C.warn, unauthorized: C.err };
    const STATE_LABELS = { device: 'ready', offline: 'offline', unauthorized: 'unauthorized' };
    const STATE_HINTS = { unauthorized: 'hint.unauthorized', offline: 'hint.offline' };

    /** Locale dictionaries. `en` and `zh` carry the same key set. */
    const EN = {
      'tool.fleet_list': 'Device fleet',
      'tool.device_install': 'Install APK',
      'tool.device_launch': 'Launch app',
      'tool.device_stop': 'Force-stop app',
      'tool.device_clear_data': 'Clear app data',
      'tool.device_screenshot': 'Screenshot',
      'tool.device_logcat': 'Logcat',
      'tool.device_deep_link': 'Deep link',
      'tool.device_shell': 'Adb shell',
      'tool.device_pull': 'Pull file',
      'tool.device_which': 'Toolchain',
      'tool.emulator_start': 'Start emulator',
      'tool.emulator_stop': 'Stop emulator',
      'common.preparing': 'Preparing',
      'common.running': 'Running',
      'common.done': 'Done',
      'common.failed': 'Failed',
      'common.stopped': 'Stopped',
      'common.approvalGated': 'Approval required',
      'common.showMore': 'Show more',
      'common.showLess': 'Show less',
      'common.noData': 'No structured result',
      'list.title': 'Device fleet',
      'list.adb': 'adb',
      'list.ready': 'ready',
      'list.connected': 'connected',
      'list.sdk': 'Android SDK',
      'list.noDevices': 'No ready devices. Connect a phone with USB debugging, or boot an emulator.',
      'state.device': 'ready',
      'state.offline': 'offline',
      'state.unauthorized': 'unauthorized',
      'device.battery': 'battery',
      'device.screenOn': 'screen on',
      'device.screenOff': 'screen off',
      'device.emulator': 'emulator',
      'device.android': 'Android',
      'device.package': 'package',
      'hint.unauthorized': 'Tap "Allow USB debugging" on the device.',
      'hint.offline': 'Reconnect the device or restart adb.',
      'screenshot.title': 'Screenshot saved',
      'screenshot.hint': 'Open this absolute path, or read it with the read_image tool.',
      'logcat.title': 'logcat',
      'logcat.matched': 'matched',
      'logcat.filter': 'filter',
      'logcat.truncated': 'older matches dropped',
      'logcat.noMatches': 'No matching lines',
      'logcat.limitNote': 'Showing the last 30 lines.',
      'shell.exit': 'exit',
      'install.size': 'APK size',
      'duration': 'duration',
      'units.kb': 'KB',
      'emulator.pid': 'pid',
      'toolchain.missing': 'not found',
    };

    const ZH = {
      'tool.fleet_list': '设备列表',
      'tool.device_install': '安装 APK',
      'tool.device_launch': '启动应用',
      'tool.device_stop': '强制停止应用',
      'tool.device_clear_data': '清除应用数据',
      'tool.device_screenshot': '截图',
      'tool.device_logcat': '日志',
      'tool.device_deep_link': '深链跳转',
      'tool.device_shell': 'ADB 命令',
      'tool.device_pull': '拉取文件',
      'tool.device_which': '工具链',
      'tool.emulator_start': '启动模拟器',
      'tool.emulator_stop': '停止模拟器',
      'common.preparing': '准备中',
      'common.running': '运行中',
      'common.done': '完成',
      'common.failed': '失败',
      'common.stopped': '已停止',
      'common.approvalGated': '需要审批',
      'common.showMore': '显示更多',
      'common.showLess': '收起',
      'common.noData': '无结构化结果',
      'list.title': '设备列表',
      'list.adb': 'adb',
      'list.ready': '就绪',
      'list.connected': '已连接',
      'list.sdk': 'Android SDK',
      'list.noDevices': '没有就绪的设备。请连接手机并开启 USB 调试，或启动模拟器。',
      'state.device': '就绪',
      'state.offline': '离线',
      'state.unauthorized': '未授权',
      'device.battery': '电量',
      'device.screenOn': '屏幕已亮',
      'device.screenOff': '屏幕已灭',
      'device.emulator': '模拟器',
      'device.android': 'Android',
      'device.package': '应用包',
      'hint.unauthorized': '请在设备上点按“允许 USB 调试”。',
      'hint.offline': '请重新连接设备或重启 adb。',
      'screenshot.title': '截图已保存',
      'screenshot.hint': '可用 read_image 工具打开该绝对路径。',
      'logcat.title': '日志',
      'logcat.matched': '匹配',
      'logcat.filter': '过滤',
      'logcat.truncated': '较早的匹配已截断',
      'logcat.noMatches': '没有匹配的日志行',
      'logcat.limitNote': '仅显示最后 30 行。',
      'shell.exit': '退出码',
      'install.size': 'APK 大小',
      'duration': '耗时',
      'units.kb': 'KB',
      'emulator.pid': '进程',
      'toolchain.missing': '未找到',
    };

    // ------------------------------------------------------------------
    // Defensive readers
    // ------------------------------------------------------------------

    /**
     * @param {unknown} value Candidate.
     * @returns {value is Record<string, any>} whether it is a plain object.
     */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * @param {unknown} value Candidate.
     * @returns {string | undefined} non-empty string.
     */
    function asString(value) {
      return typeof value === 'string' && value !== '' ? value : undefined;
    }

    /**
     * @param {unknown} value Candidate.
     * @returns {number | undefined} finite number.
     */
    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    /**
     * Collapse whitespace and truncate one display line.
     * @param {unknown} value Candidate.
     * @param {number} [max] Maximum characters.
     * @returns {string} display text ("" when empty).
     */
    function oneLine(value, max) {
      let text;
      try {
        text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
      } catch {
        return '';
      }
      text = text.replace(/\s+/gu, ' ').trim();
      if (max !== undefined && text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`;
      return text;
    }

    /**
     * Bound multi-line text by line and character count.
     * @param {string} text Source text.
     * @param {number} maxLines Maximum lines.
     * @param {number} maxChars Maximum characters.
     * @returns {string} bounded text.
     */
    function boundedText(text, maxLines, maxChars) {
      const lines = String(text).split('\n').slice(-maxLines);
      let result = lines.join('\n');
      if (result.length > maxChars) result = `${result.slice(result.length - maxChars)}…`;
      return result;
    }

    /**
     * @param {string} text Candidate JSON text.
     * @returns {Record<string, any> | undefined} parsed object.
     */
    function parseJsonObject(text) {
      if (typeof text !== 'string') return undefined;
      try {
        const value = JSON.parse(text);
        return isRecord(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * @param {unknown} block Result view block.
     * @returns {string[]} text content block strings.
     */
    function textBlocks(block) {
      try {
        if (!isRecord(block) || !Array.isArray(block.content)) return [];
        const out = [];
        for (const item of block.content) {
          if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') out.push(item.text);
        }
        return out;
      } catch {
        return [];
      }
    }

    /**
     * @param {unknown} block Result view block.
     * @returns {string} flattened result text.
     */
    function contentText(block) {
      try {
        return textBlocks(block).join('\n').trim();
      } catch {
        return '';
      }
    }

    /**
     * Tool arguments, from the settled `call.argsRaw`, the running `argsRaw`, or
     * the lazy argument reader when only partial values exist.
     * @param {unknown} block View block.
     * @returns {Record<string, any>} best-effort argument object.
     */
    function argsObject(block) {
      /** @type {Record<string, any>} */
      const out = {};
      if (!isRecord(block)) return out;
      try {
        const raw = isRecord(block.call) ? block.call.argsRaw : block.argsRaw;
        const parsed = typeof raw === 'string' ? parseJsonObject(raw) : undefined;
        if (parsed !== undefined) return parsed;
      } catch {
        /* fall through to the lazy reader */
      }
      try {
        const reader = block.args;
        if (isRecord(reader) && typeof reader.text === 'function') {
          for (const key of ['serial', 'packageName', 'apkPath', 'url', 'command', 'remotePath', 'avdName', 'preset', 'filter']) {
            const value = reader.text(key);
            if (typeof value === 'string' && value !== '') out[key] = value;
          }
        }
      } catch {
        /* partial argument readers may throw while streaming */
      }
      return out;
    }

    /**
     * Normalize the lifecycle stage of a tool view.
     * @param {Record<string, any>} props Owner props.
     * @returns {'preparing' | 'start' | 'result'} stage.
     */
    function phaseOf(props) {
      const phase = isRecord(props) ? props.phase : undefined;
      if (phase === 'preparing' || phase === 'start' || phase === 'result') return phase;
      const block = isRecord(props) ? props.block : undefined;
      if (isRecord(block)) {
        if (block.phase === 'preparing' || block.phase === 'start') return block.phase;
        if ('kind' in block) return 'result';
      }
      return 'start';
    }

    /**
     * Build a tolerant translator for the slot-supplied locale seat.
     * @param {unknown} t Slot translator (may be absent off-page).
     * @returns {(key: string, fallback: string) => string} translator.
     */
    function translator(t) {
      return function tr(key, fallback) {
        try {
          if (typeof t === 'function') {
            const value = t(key);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          }
        } catch {
          /* a missing locale face must not break a card */
        }
        return fallback;
      };
    }

    /**
     * Localized tool label.
     * @param {(key: string, fallback: string) => string} tr Translator.
     * @param {string} toolName Wire tool name.
     * @returns {string} display label.
     */
    function toolLabel(tr, toolName) {
      return tr(`tool.${toolName}`, FALLBACK_LABELS[toolName] ?? toolName);
    }

    /**
     * Normalize one tool view into the facts a card needs. Never throws.
     * @param {Record<string, any>} props Owner props.
     * @returns {{phase: string, data: Record<string, any> | undefined, text: string, failed: boolean, stopped: boolean, message: string, code: string, hint: string}} view facts.
     */
    function readView(props) {
      const phase = phaseOf(props);
      const block = isRecord(props) ? props.block : undefined;
      const text = contentText(block);
      /** @type {Record<string, any> | undefined} */
      let data;

      if (isRecord(block)) {
        for (const key of ['meta', 'result', 'value', 'structuredContent', 'structured']) {
          const candidate = block[key];
          if (isRecord(candidate) && (typeof candidate.ok === 'boolean' || typeof candidate.tool === 'string')) {
            data = candidate;
            break;
          }
        }
      }
      if (data === undefined) {
        for (const part of textBlocks(block)) {
          const parsed = parseJsonObject(part);
          if (parsed !== undefined) {
            data = parsed;
            break;
          }
        }
      }

      const error = isRecord(block) ? block.error : undefined;
      const errorCode = isRecord(error) ? asString(error.code) : undefined;
      const stopped = errorCode === 'interrupted';
      let failed = stopped;
      if (isRecord(block) && block.isError === true) failed = true;
      if (isRecord(data) && data.ok === false) failed = true;

      let code = isRecord(data) ? asString(data.code) : undefined;
      let message = isRecord(data) ? asString(data.error) : undefined;
      if (message === undefined && isRecord(error)) {
        message = asString(error.reason) ?? asString(error.message);
      }
      // Older sessions may only carry rendered `Error [CODE]: message` text.
      if (message === undefined && text !== '') {
        const match = /^Error \[([A-Z_]+)\]:\s*([\s\S]*)$/u.exec(text);
        if (match !== null) {
          code = code ?? match[1];
          message = oneLine(match[2], 400);
          if (data === undefined) failed = true;
        }
      }
      if (message === undefined && failed && text !== '') message = oneLine(text, 400);

      return {
        phase,
        data,
        text,
        failed,
        stopped,
        message: message ?? '',
        code: code ?? errorCode ?? '',
        hint: isRecord(data) ? asString(data.hint) ?? '' : '',
      };
    }

    // ------------------------------------------------------------------
    // Small presentational pieces
    // ------------------------------------------------------------------

    /** Cell padding/style shared by the card shell. */
    const CARD_STYLE = {
      border: `0.5px solid ${C.border1}`,
      borderRadius: '8px',
      background: C.layer1,
      padding: '8px 10px',
      margin: '3px 0 3px 4px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      maxWidth: '100%',
      boxSizing: 'border-box',
      color: C.text,
      fontSize: BODY,
      lineHeight: '1.45',
    };

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      minHeight: '18px',
    };

    const MONO_STYLE = {
      fontFamily: MONO,
      fontSize: SMALL,
      color: C.sub,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0,
    };

    /**
     * @param {{ label: string, color?: string, icon?: any, title?: string }} props Chip fields.
     * @returns {any} chip element.
     */
    function Chip(props) {
      return h(
        'span',
        {
          title: props.title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            height: '16px',
            padding: '0 6px',
            borderRadius: '999px',
            border: `0.5px solid ${C.border2}`,
            background: C.layer2,
            color: props.color ?? C.sub,
            fontSize: '11px',
            lineHeight: '15px',
            whiteSpace: 'nowrap',
            flex: 'none',
          },
        },
        props.icon,
        props.label,
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} device glyph.
     */
    function DeviceGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('rect', { key: 'a', x: 4, y: 1.5, width: 8, height: 13, rx: 1.6 }),
        h('path', { key: 'b', d: 'M7 13h2' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} camera glyph.
     */
    function CameraGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { key: 'a', d: 'M2 5.5h2.2L5.5 3.6h5L11.8 5.5H14v8H2z' }),
        h('circle', { key: 'b', cx: 8, cy: 9.2, r: 2.4 }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} terminal glyph.
     */
    function TerminalGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('rect', { key: 'a', x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6 }),
        h('path', { key: 'b', d: 'M4.5 6l2 2-2 2M8.5 10h3' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} lock glyph.
     */
    function LockGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true, style: { flex: 'none' } },
        h('rect', { key: 'a', x: 3, y: 7, width: 10, height: 7, rx: 1.6 }),
        h('path', { key: 'b', d: 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} play glyph.
     */
    function PlayGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { key: 'a', d: 'M5 3.2l7 4.8-7 4.8z', strokeLinejoin: 'round' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} stop glyph.
     */
    function StopGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('rect', { key: 'a', x: 4, y: 4, width: 8, height: 8, rx: 1.4 }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} trash glyph.
     */
    function TrashGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { key: 'a', d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} download glyph.
     */
    function DownloadGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { key: 'a', d: 'M8 2.5v7M5 6.5l3 3 3-3M3 13h10' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} link glyph.
     */
    function LinkGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('path', { key: 'a', d: 'M6.5 9.5a3 3 0 0 0 4.2 0l1.6-1.6a3 3 0 1 0-4.2-4.2L7 4.8M9.5 6.5a3 3 0 0 0-4.2 0L3.7 8.1a3 3 0 1 0 4.2 4.2l1.1-1.1' }),
      );
    }

    /**
     * @param {number} size Icon size.
     * @returns {any} search glyph.
     */
    function SearchGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true, style: { flex: 'none' } },
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4 }),
        h('path', { key: 'b', d: 'M10 10l4 4' }),
      );
    }

    /**
     * Pick a glyph for the compact rows.
     * @param {string} toolName Wire tool name.
     * @returns {any} icon element.
     */
    function toolGlyph(toolName) {
      switch (toolName) {
        case 'device_screenshot':
          return CameraGlyph(14);
        case 'device_logcat':
        case 'device_shell':
          return TerminalGlyph(14);
        case 'device_deep_link':
          return LinkGlyph(14);
        case 'device_which':
          return SearchGlyph(14);
        case 'device_install':
        case 'device_pull':
          return DownloadGlyph(14);
        case 'device_launch':
        case 'emulator_start':
          return PlayGlyph(14);
        case 'device_stop':
        case 'emulator_stop':
          return StopGlyph(14);
        case 'device_clear_data':
          return TrashGlyph(14);
        default:
          return DeviceGlyph(14);
      }
    }

    /**
     * One compact status chip.
     * @param {{ phase: string, failed: boolean, stopped: boolean, tr: (key: string, fallback: string) => string }} props Status fields.
     * @returns {any} chip element.
     */
    function StatusChip(props) {
      if (props.phase === 'preparing') return Chip({ label: props.tr('common.preparing', 'Preparing'), color: C.sub });
      if (props.phase === 'start') return Chip({ label: props.tr('common.running', 'Running'), color: C.brand });
      if (props.stopped) return Chip({ label: props.tr('common.stopped', 'Stopped'), color: C.warn });
      if (props.failed) return Chip({ label: props.tr('common.failed', 'Failed'), color: C.err });
      return Chip({ label: props.tr('common.done', 'Done'), color: C.ok });
    }

    /**
     * Approval chip: only ever states that the Host gates the call, never that an
     * approval was granted.
     * @param {{ tr: (key: string, fallback: string) => string }} props Translator.
     * @returns {any} chip element.
     */
    function ApprovalChip(props) {
      return Chip({
        label: props.tr('common.approvalGated', 'Approval required'),
        color: C.warn,
        icon: LockGlyph(10),
        title: props.tr('common.approvalGated', 'Approval required'),
      });
    }

    /**
     * Lightweight placeholder for the preparing/start stages.
     * @param {{ toolName: string, phase: string, t: unknown }} props Placeholder fields.
     * @returns {any} row element.
     */
    function Placeholder(props) {
      const tr = translator(props.t);
      const phase = props.phase === 'preparing' ? 'preparing' : 'start';
      return h(
        'div',
        { 'data-tool': props.toolName, 'data-phase': phase, style: { ...ROW_STYLE, padding: '2px 2px', color: C.text, fontSize: BODY } },
        h('style', { key: 'css' }, PULSE_CSS),
        h('span', {
          key: 'dot',
          'aria-hidden': true,
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: C.brand,
            flex: 'none',
            animation: 'dshFleetPulse 1.2s ease-in-out infinite',
          },
        }),
        h('span', { key: 'label', style: { fontWeight: 500, whiteSpace: 'nowrap' } }, toolLabel(tr, props.toolName)),
        h('span', { key: 'sep', 'aria-hidden': true, style: { color: C.sub } }, '·'),
        h('span', { key: 'state', style: { color: C.sub, ...MONO_STYLE } }, phase === 'preparing' ? tr('common.preparing', 'Preparing') : tr('common.running', 'Running')),
      );
    }

    /**
     * Terminal failure card shared by the fleet/screenshot/logcat views.
     * @param {{ toolName: string, view: any, t: unknown }} props Failure fields.
     * @returns {any} card element.
     */
    function FailureCard(props) {
      const tr = translator(props.t);
      const view = props.view;
      return h(
        'div',
        { 'data-tool': props.toolName, 'data-phase': 'result', 'data-state': 'error', style: CARD_STYLE },
        h(
          'div',
          { style: ROW_STYLE },
          h('span', { key: 'icon', style: { display: 'inline-flex', color: C.err } }, toolGlyph(props.toolName)),
          h('span', { key: 'label', style: { fontWeight: 600 } }, toolLabel(tr, props.toolName)),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h(StatusChip, { key: 'status', phase: 'result', failed: true, stopped: view.stopped, tr }),
        ),
        view.message !== ''
          ? h(
              'div',
              { key: 'message', style: { color: C.err, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
              view.message,
            )
          : null,
        view.hint !== ''
          ? h('div', { key: 'hint', style: { color: C.sub, fontSize: SMALL, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, view.hint)
          : null,
        view.code !== '' ? h('div', { key: 'code', style: { ...MONO_STYLE, fontSize: '11px' } }, view.code) : null,
        DESTRUCTIVE.has(props.toolName) ? h(ApprovalChip, { key: 'approval', tr }) : null,
      );
    }

    /**
     * Bounded read-only text card for results with no structured payload.
     * @param {{ toolName: string, view: any, t: unknown }} props Text card fields.
     * @returns {any} card element.
     */
    function TextCard(props) {
      const tr = translator(props.t);
      const text = boundedText(props.view.text, 14, 2400);
      if (text === '') return null;
      const color = props.view.failed ? C.err : C.sub;
      return h(
        'div',
        { 'data-tool': props.toolName, 'data-phase': 'result', style: CARD_STYLE },
        h(
          'div',
          { style: ROW_STYLE },
          h('span', { key: 'icon', style: { display: 'inline-flex', color: props.view.failed ? C.err : C.sub } }, toolGlyph(props.toolName)),
          h('span', { key: 'label', style: { fontWeight: 600, color: C.text } }, toolLabel(tr, props.toolName)),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h(StatusChip, { key: 'status', phase: 'result', failed: props.view.failed, stopped: props.view.stopped, tr }),
        ),
        h(
          'div',
          {
            key: 'body',
            style: {
              background: C.layer2,
              border: `0.5px solid ${C.border2}`,
              borderRadius: '6px',
              padding: '6px 8px',
              fontFamily: MONO,
              fontSize: SMALL,
              color,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          text,
        ),
      );
    }

    // ------------------------------------------------------------------
    // fleet_list
    // ------------------------------------------------------------------

    /**
     * One device row inside the fleet list.
     * @param {{ device: Record<string, any>, tr: (key: string, fallback: string) => string }} props Device fields.
     * @returns {any} device card element.
     */
    function DeviceCard(props) {
      const device = props.device;
      const tr = props.tr;
      const state = asString(device.state) ?? 'device';
      const stateColor = STATE_COLORS[state] ?? C.sub;
      const serial = asString(device.serial) ?? 'unknown';
      const model = asString(device.model) ?? asString(device.device);
      const manufacturer = asString(device.manufacturer);
      const android = asString(device.androidVersion);
      const sdk = asNumber(device.sdk);
      const battery = asNumber(device.batteryPct);
      const screenOn = device.screenOn === true ? true : device.screenOn === false ? false : undefined;
      const emulator = device.isEmulator === true;
      const pkg = isRecord(device.package) ? device.package : undefined;

      /** @type {any[]} */
      const facts = [];
      if (android !== undefined) facts.push(h('span', { key: 'android' }, `${tr('device.android', 'Android')} ${android}`));
      if (sdk !== undefined) facts.push(h('span', { key: 'sdk' }, `SDK ${sdk}`));
      if (battery !== undefined) facts.push(h('span', { key: 'battery' }, `${Math.round(battery)}% ${tr('device.battery', 'battery')}`));
      if (screenOn !== undefined) {
        facts.push(h('span', { key: 'screen' }, screenOn ? tr('device.screenOn', 'screen on') : tr('device.screenOff', 'screen off')));
      }
      if (pkg !== undefined) {
        const name = asString(pkg.name);
        const versionName = asString(pkg.versionName);
        const versionCode = asNumber(pkg.versionCode);
        const version = versionName !== undefined ? `${versionName}${versionCode !== undefined ? ` (${versionCode})` : ''}` : versionCode !== undefined ? `(${versionCode})` : '';
        if (name !== undefined || version !== '') {
          facts.push(
            h(
              'span',
              { key: 'package', style: { fontFamily: MONO } },
              `${tr('device.package', 'package')} ${[name, version].filter((part) => part !== undefined && part !== '').join(' ')}`,
            ),
          );
        }
      }

      const hintKey = STATE_HINTS[state];
      const hint = hintKey === undefined ? '' : tr(hintKey, hintKey === 'hint.unauthorized' ? 'Tap "Allow USB debugging" on the device.' : 'Reconnect the device or restart adb.');

      return h(
        'div',
        {
          'data-serial': serial,
          'data-state': state,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            padding: '6px 8px',
            background: C.base,
            border: `0.5px solid ${C.border2}`,
            borderRadius: '6px',
          },
        },
        h(
          'div',
          { style: ROW_STYLE },
          h('span', { key: 'dot', 'aria-hidden': true, style: { width: '7px', height: '7px', borderRadius: '50%', background: stateColor, flex: 'none' } }),
          h('span', { key: 'serial', style: { fontFamily: MONO, fontSize: '12px', fontWeight: 600, color: C.text, whiteSpace: 'nowrap' } }, serial),
          model !== undefined
            ? h(
                'span',
                {
                  key: 'model',
                  style: { color: C.text, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
                  title: manufacturer !== undefined ? `${manufacturer} ${model}` : model,
                },
                manufacturer !== undefined ? `${manufacturer} ${model}` : model,
              )
            : null,
          emulator ? h('span', { key: 'emulator', style: { flex: 'none' } }, Chip({ label: tr('device.emulator', 'emulator'), color: C.brand })) : null,
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('span', { key: 'state', style: { color: stateColor, fontSize: '11.5px', fontWeight: 600, flex: 'none' } }, tr(`state.${state}`, STATE_LABELS[state] ?? state)),
        ),
        facts.length > 0
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  columnGap: '10px',
                  rowGap: '2px',
                  fontSize: SMALL,
                  color: C.sub,
                  paddingLeft: '13px',
                },
              },
              facts,
            )
          : null,
        hint !== ''
          ? h('div', { style: { color: stateColor, fontSize: SMALL, paddingLeft: '13px' } }, hint)
          : null,
      );
    }

    /**
     * `fleet_list`: adb header plus one card per device.
     * @param {Record<string, any>} props Owner props.
     * @returns {any} card element.
     */
    function FleetListCard(props) {
      try {
        const tr = translator(props.t);
        const view = readView(props);
        if (view.phase !== 'result') return h(Placeholder, { toolName: props.toolName, phase: view.phase, t: props.t });
        if (view.failed && view.data === undefined) return h(FailureCard, { toolName: props.toolName, view, t: props.t });
        if (view.data === undefined) return h(TextCard, { toolName: props.toolName, view, t: props.t });
        const data = view.data;
        if (data.ok === false) return h(FailureCard, { toolName: props.toolName, view, t: props.t });

        const adb = isRecord(data.adb) ? data.adb : {};
        const adbPath = asString(adb.path);
        const adbVersion = asString(adb.version);
        const androidSdk = asString(data.androidSdk);
        const devices = Array.isArray(data.devices) ? data.devices.filter((entry) => isRecord(entry)) : [];
        const unauthorized = Array.isArray(data.unauthorized) ? data.unauthorized.filter((entry) => isRecord(entry)) : [];
        const offline = Array.isArray(data.offline) ? data.offline : [];
        const count = asNumber(data.count) ?? devices.length;
        const total = asNumber(data.total);

        /** @type {any[]} */
        const children = [];
        children.push(
          h(
            'div',
            { key: 'header', style: ROW_STYLE },
            h('span', { key: 'icon', style: { display: 'inline-flex', color: C.sub } }, DeviceGlyph(14)),
            h('span', { key: 'title', style: { fontWeight: 600, whiteSpace: 'nowrap' } }, tr('list.title', 'Device fleet')),
            h(
              'span',
              { key: 'adb', style: { flex: '1 1 auto', minWidth: 0, ...MONO_STYLE }, title: adbPath !== undefined ? `${adbPath}${adbVersion !== undefined ? ` v${adbVersion}` : ''}` : undefined },
              adbPath !== undefined ? adbPath : tr('list.adb', 'adb'),
            ),
            h(Chip, { key: 'count', label: `${count} ${tr('list.ready', 'ready')}`, color: C.ok }),
            total !== undefined && total !== count ? h(Chip, { key: 'total', label: `${total} ${tr('list.connected', 'connected')}` }) : null,
          ),
        );
        if (androidSdk !== undefined) {
          children.push(h('div', { key: 'sdk', style: { ...MONO_STYLE, fontSize: '11px' }, title: androidSdk }, `${tr('list.sdk', 'Android SDK')} · ${androidSdk}`));
        }
        if (devices.length === 0) {
          children.push(h('div', { key: 'empty', style: { color: C.sub, fontSize: '12px' } }, tr('list.noDevices', 'No ready devices. Connect a phone with USB debugging, or boot an emulator.')));
        } else {
          children.push(
            h(
              'div',
              { key: 'devices', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              devices.map((device, index) => h(DeviceCard, { key: `${asString(device.serial) ?? 'device'}-${index}`, device, tr })),
            ),
          );
        }
        if (unauthorized.length > 0) {
          children.push(
            h(
              'div',
              { key: 'unauthorized', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              unauthorized.map((entry, index) => {
                const serial = asString(entry.serial) ?? 'unknown';
                const hint = asString(entry.hint) ?? tr('hint.unauthorized', 'Tap "Allow USB debugging" on the device.');
                return h(
                  'div',
                  { key: `unauthorized-${index}`, style: { color: C.err, fontSize: SMALL, display: 'flex', gap: '6px', minWidth: 0 } },
                  h('span', { style: { fontFamily: MONO, fontWeight: 600, flex: 'none' } }, serial),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hint),
                );
              }),
            ),
          );
        }
        if (offline.length > 0) {
          children.push(
            h(
              'div',
              { key: 'offline', style: { color: C.warn, fontSize: SMALL } },
              offline
                .map((entry) => (isRecord(entry) ? asString(entry.serial) : oneLine(entry, 40)))
                .filter((serial) => serial !== undefined && serial !== '')
                .join(', '),
            ),
          );
        }
        const warnings = Array.isArray(data.warnings) ? data.warnings.map((entry) => oneLine(entry, 200)).filter((entry) => entry !== '') : [];
        if (warnings.length > 0) {
          children.push(
            h(
              'div',
              { key: 'warnings', style: { color: C.warn, fontSize: SMALL, display: 'flex', flexDirection: 'column', gap: '1px' } },
              warnings.map((warning, index) => h('div', { key: `warning-${index}` }, warning)),
            ),
          );
        }
        return h('div', { 'data-tool': props.toolName, 'data-phase': 'result', style: CARD_STYLE }, children);
      } catch {
        return null;
      }
    }

    // ------------------------------------------------------------------
    // device_screenshot
    // ------------------------------------------------------------------

    /**
     * `device_screenshot`: saved path, dimensions, and how to read it.
     * @param {Record<string, any>} props Owner props.
     * @returns {any} card element.
     */
    function ScreenshotCard(props) {
      try {
        const tr = translator(props.t);
        const view = readView(props);
        if (view.phase !== 'result') return h(Placeholder, { toolName: props.toolName, phase: view.phase, t: props.t });
        if (view.data !== undefined && view.data.ok === false) return h(FailureCard, { toolName: props.toolName, view, t: props.t });
        const data = view.data;
        if (data === undefined || asString(data.path) === undefined) {
          if (view.failed) return h(FailureCard, { toolName: props.toolName, view, t: props.t });
          return h(TextCard, { toolName: props.toolName, view, t: props.t });
        }
        const path = asString(data.path);
        const serial = asString(data.serial);
        const width = asNumber(data.width);
        const height = asNumber(data.height);
        const bytes = asNumber(data.bytes);
        /** @type {any[]} */
        const facts = [];
        if (width !== undefined && height !== undefined) facts.push(h('span', { key: 'dims' }, `${width}×${height}`));
        if (bytes !== undefined) facts.push(h('span', { key: 'bytes' }, `${Math.round(bytes / 1024)} ${tr('units.kb', 'KB')}`));
        if (serial !== undefined) facts.push(h('span', { key: 'serial', style: { fontFamily: MONO } }, serial));

        return h(
          'div',
          { 'data-tool': props.toolName, 'data-phase': 'result', style: CARD_STYLE },
          h(
            'div',
            { key: 'header', style: ROW_STYLE },
            h('span', { key: 'icon', style: { display: 'inline-flex', color: C.sub } }, CameraGlyph(14)),
            h('span', { key: 'title', style: { fontWeight: 600, whiteSpace: 'nowrap' } }, tr('screenshot.title', 'Screenshot saved')),
            h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
            h(StatusChip, { key: 'status', phase: 'result', failed: false, stopped: false, tr }),
          ),
          h(
            'div',
            {
              key: 'path',
              style: {
                fontFamily: MONO,
                fontSize: SMALL,
                color: C.text,
                background: C.layer2,
                border: `0.5px solid ${C.border2}`,
                borderRadius: '6px',
                padding: '6px 8px',
                wordBreak: 'break-all',
              },
            },
            path === undefined ? '—' : path,
          ),
          facts.length > 0 ? h('div', { key: 'facts', style: { display: 'flex', flexWrap: 'wrap', columnGap: '12px', rowGap: '2px', fontSize: SMALL, color: C.sub } }, facts) : null,
          h('div', { key: 'hint', style: { color: C.sub, fontSize: SMALL } }, tr('screenshot.hint', 'Open this absolute path, or read it with the read_image tool.')),
        );
      } catch {
        return null;
      }
    }

    // ------------------------------------------------------------------
    // device_logcat
    // ------------------------------------------------------------------

    /**
     * Render the body of the logcat card (kept out of the component so the hook
     * count stays stable).
     * @param {Record<string, any>} props Owner props.
     * @param {boolean} expanded Disclosure state.
     * @param {(updater: (value: boolean) => boolean) => void} setExpanded State setter.
     * @returns {any} card element.
     */
    function renderLogcatCard(props, expanded, setExpanded) {
      const tr = translator(props.t);
      const view = readView(props);
      if (view.phase !== 'result') return h(Placeholder, { toolName: props.toolName, phase: view.phase, t: props.t });
      if (view.data !== undefined && view.data.ok === false) return h(FailureCard, { toolName: props.toolName, view, t: props.t });
      const data = view.data;
      if (data === undefined) {
        if (view.failed) return h(FailureCard, { toolName: props.toolName, view, t: props.t });
        return h(TextCard, { toolName: props.toolName, view, t: props.t });
      }
      const serial = asString(data.serial);
      const preset = asString(data.presetLabel) ?? asString(data.preset);
      const filter = asString(data.filter);
      const matched = asNumber(data.matched);
      const total = asNumber(data.total);
      const lines = Array.isArray(data.lines) ? data.lines.map((line) => (typeof line === 'string' ? line : oneLine(line, 400))) : [];
      const trimmed = lines.length > MAX_LOGCAT_LINES ? lines.slice(-MAX_LOGCAT_LINES) : lines;
      const visible = expanded ? trimmed : lines.slice(-Math.min(COLLAPSED_LOGCAT_LINES, lines.length));
      const canExpand = lines.length > COLLAPSED_LOGCAT_LINES;

      /** @type {any[]} */
      const chips = [];
      if (preset !== undefined) chips.push(h(Chip, { key: 'preset', label: preset, color: C.brand }));
      if (matched !== undefined || total !== undefined) {
        chips.push(h(Chip, { key: 'count', label: `${matched ?? 0}/${total ?? 0} ${tr('logcat.matched', 'matched')}` }));
      }
      if (filter !== undefined) chips.push(h(Chip, { key: 'filter', label: `${tr('logcat.filter', 'filter')} ${filter}`, title: filter }));
      if (data.truncated === true) chips.push(h(Chip, { key: 'truncated', label: tr('logcat.truncated', 'older matches dropped'), color: C.warn }));

      return h(
        'div',
        { 'data-tool': props.toolName, 'data-phase': 'result', style: CARD_STYLE },
        h(
          'div',
          { key: 'header', style: { ...ROW_STYLE, flexWrap: 'wrap' } },
          h('span', { key: 'icon', style: { display: 'inline-flex', color: C.sub } }, TerminalGlyph(14)),
          h('span', { key: 'title', style: { fontWeight: 600, whiteSpace: 'nowrap' } }, tr('logcat.title', 'logcat')),
          serial !== undefined ? h('span', { key: 'serial', style: { ...MONO_STYLE, flex: '0 1 auto' }, title: serial }, serial) : null,
          ...chips,
        ),
        lines.length === 0
          ? h('div', { key: 'empty', style: { color: C.sub, fontSize: SMALL } }, tr('logcat.noMatches', 'No matching lines'))
          : h(
              'div',
              {
                key: 'lines',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0,
                  background: C.layer2,
                  border: `0.5px solid ${C.border2}`,
                  borderRadius: '6px',
                  padding: '6px 8px',
                  fontFamily: MONO,
                  fontSize: '11.5px',
                  lineHeight: '16px',
                  color: C.text,
                },
              },
              visible.map((line, index) =>
                h('div', { key: `line-${index}`, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, line === '' ? ' ' : line),
              ),
            ),
        canExpand
          ? h(
              'div',
              { key: 'footer', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h(
                'button',
                {
                  type: 'button',
                  'aria-expanded': expanded,
                  onClick: () => {
                    setExpanded((value) => !value);
                  },
                  style: {
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    color: C.brand,
                    font: 'inherit',
                    fontSize: SMALL,
                    cursor: 'pointer',
                    textDecoration: 'underline dotted',
                  },
                },
                expanded ? tr('common.showLess', 'Show less') : tr('common.showMore', 'Show more'),
              ),
              expanded && lines.length > MAX_LOGCAT_LINES
                ? h('span', { key: 'note', style: { color: C.sub, fontSize: SMALL } }, tr('logcat.limitNote', 'Showing the last 30 lines.'))
                : null,
            )
          : null,
      );
    }

    /**
     * `device_logcat`: preset/filter header plus a bounded monospace tail.
     * @param {Record<string, any>} props Owner props.
     * @returns {any} card element.
     */
    function LogcatCard(props) {
      let expanded = false;
      let setExpanded = () => {};
      try {
        const state = React.useState(false);
        expanded = state[0];
        setExpanded = state[1];
      } catch {
        /* a host without hook support still renders the collapsed tail */
      }
      try {
        return renderLogcatCard(props ?? {}, expanded, setExpanded);
      } catch {
        return null;
      }
    }

    // ------------------------------------------------------------------
    // Compact one-row cards
    // ------------------------------------------------------------------

    /**
     * Secondary facts for one compact row.
     * @param {string} toolName Wire tool name.
     * @param {Record<string, any> | undefined} data Result payload.
     * @param {(key: string, fallback: string) => string} tr Translator.
     * @returns {{ text: string, color?: string }} extra fact text.
     */
    function compactExtras(toolName, data, tr) {
      if (data === undefined) return { text: '' };
      if (toolName === 'device_shell') {
        const exitCode = asNumber(data.exitCode);
        if (exitCode !== undefined) return { text: `${tr('shell.exit', 'exit')} ${exitCode}`, color: exitCode === 0 ? C.sub : C.warn };
      }
      if (toolName === 'device_install') {
        const bytes = asNumber(data.apkBytes);
        const duration = asNumber(data.durationMs);
        const parts = [];
        if (bytes !== undefined) parts.push(`${Math.round(bytes / 1024)} ${tr('units.kb', 'KB')}`);
        if (duration !== undefined) parts.push(`${duration} ms`);
        return { text: parts.join(' · ') };
      }
      if (toolName === 'device_pull') {
        const bytes = asNumber(data.bytes);
        return { text: bytes === undefined ? '' : `${Math.round(bytes / 1024)} ${tr('units.kb', 'KB')}` };
      }
      if (toolName === 'emulator_start') {
        const pid = asNumber(data.pid);
        return { text: pid === undefined ? '' : `${tr('emulator.pid', 'pid')} ${pid}` };
      }
      if (toolName === 'device_launch') {
        return { text: asString(data.component) ?? '' };
      }
      return { text: '' };
    }

    /**
     * Key argument (or identifying result field) for one compact row.
     * @param {string} toolName Wire tool name.
     * @param {Record<string, any> | undefined} data Result payload.
     * @param {Record<string, any>} args Parsed arguments.
     * @param {(key: string, fallback: string) => string} tr Translator.
     * @returns {string} display text.
     */
    function compactKeyArg(toolName, data, args, tr) {
      if (toolName === 'device_which' && data !== undefined) {
        const parts = [];
        const platform = asString(data.platform);
        if (platform !== undefined) parts.push(platform);
        const adb = isRecord(data.adb) ? data.adb : undefined;
        if (adb !== undefined) {
          const found = adb.found === true;
          const path = asString(adb.path);
          parts.push(found && path !== undefined ? path : tr('toolchain.missing', 'not found'));
        }
        return parts.join(' · ');
      }
      const field = KEY_ARG_FIELDS[toolName];
      if (field !== undefined) {
        if (data !== undefined && typeof data[field] === 'string' && data[field] !== '') return oneLine(data[field], 120);
        if (typeof args[field] === 'string' && args[field] !== '') return oneLine(args[field], 120);
      }
      return '';
    }

    /**
     * Compact one-row card for every non-fleet tool.
     * @param {Record<string, any>} props Owner props.
     * @returns {any} row element.
     */
    function CompactCard(props) {
      try {
        const tr = translator(props.t);
        const toolName = props.toolName;
        const view = readView(props);
        const destructive = DESTRUCTIVE.has(toolName);
        const data = view.data;
        const args = argsObject(isRecord(props) ? props.block : undefined);
        const failed = view.phase === 'result' && view.failed;
        const serial = (data !== undefined ? asString(data.serial) : undefined) ?? asString(args.serial);
        const keyArg = compactKeyArg(toolName, data, args, tr);
        const extras = compactExtras(toolName, data, tr);

        const failedMessage =
          failed && view.message !== '' ? h('div', { key: 'message', style: { color: C.err, fontSize: SMALL, paddingLeft: '20px', wordBreak: 'break-word' } }, oneLine(view.message, 220)) : null;

        return h(
          'div',
          { 'data-tool': toolName, 'data-phase': view.phase, style: { padding: '2px 2px 2px 4px' } },
          h(
            'div',
            { style: ROW_STYLE },
            h('span', { key: 'icon', style: { display: 'inline-flex', color: failed ? C.err : C.sub } }, toolGlyph(toolName)),
            h('span', { key: 'label', style: { fontWeight: 500, whiteSpace: 'nowrap', color: C.text } }, toolLabel(tr, toolName)),
            serial !== undefined ? h('span', { key: 'sep', 'aria-hidden': true, style: { color: C.sub } }, '·') : null,
            serial !== undefined ? h('span', { key: 'serial', style: { fontFamily: MONO, fontSize: SMALL, color: C.sub, whiteSpace: 'nowrap', flex: 'none' } }, serial) : null,
            keyArg !== '' ? h('span', { key: 'keyArg', title: keyArg, style: { ...MONO_STYLE, flex: '0 1 auto' } }, keyArg) : null,
            extras.text !== ''
              ? h('span', { key: 'extras', style: { color: extras.color ?? C.sub, fontSize: SMALL, whiteSpace: 'nowrap', flex: 'none' } }, extras.text)
              : null,
            h('span', { key: 'spacer', style: { flex: '1 1 auto', minWidth: 0 } }),
            h(StatusChip, { key: 'status', phase: view.phase, failed, stopped: view.stopped, tr }),
            destructive ? h(ApprovalChip, { key: 'approval', tr }) : null,
          ),
          failedMessage,
        );
      } catch {
        return null;
      }
    }

    // ------------------------------------------------------------------
    // Device fleet panel: main column surface + sidebar entry
    // ------------------------------------------------------------------

    /** Panel id shared by the `main` key and the `sidebar.panellist` entry. */
    const PANEL_ID = 'device-fleet';
    /** Host HTTP API prefix, resolved against the page base URL. */
    const API_PREFIX = 'dsh-device-fleet/api/';
    /** Device polling cadence while the panel is open. */
    const DEVICE_POLL_MS = 4_000;
    /** Log snapshot cadence while the log drawer is open. */
    const LOG_POLL_MS = 2_000;

    /**
     * Build an absolute API URL from the page base.
     * @param {string} endpoint API endpoint name.
     * @param {Record<string, string | number | undefined>} [params] Query values; empty values are skipped.
     * @returns {string} absolute URL.
     */
    function apiUrl(endpoint, params) {
      const url = new URL(API_PREFIX + endpoint, document.baseURI);
      if (params !== undefined) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === '') continue;
          url.searchParams.set(key, String(value));
        }
      }
      return url.href;
    }

    /**
     * Fetch one JSON payload with same-origin credentials.
     * @param {string} url Absolute URL.
     * @param {{ method?: string, body?: unknown }} [options] Request options.
     * @returns {Promise<Record<string, any>>} parsed payload.
     */
    async function fetchJson(url, options = {}) {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error('This page is not authorized against the Host. Reload the Web UI.');
      }
      const payload = await response.json().catch(() => null);
      if (payload === null) throw new Error(`Host returned ${response.status} without JSON.`);
      if (response.ok !== true) throw new Error(typeof payload.error === 'string' ? payload.error : `Host returned ${response.status}.`);
      if (payload.ok === false) throw new Error(typeof payload.error === 'string' ? payload.error : 'Host request failed.');
      return payload;
    }

    /** Panel layout constants. */
    const PANEL = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        background: C.base,
        color: C.text,
      },
      header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { color: C.sub, fontSize: SMALL },
      toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      input: {
        font: 'inherit',
        fontSize: SMALL,
        padding: '4px 8px',
        borderRadius: '6px',
        border: `1px solid ${C.border2}`,
        background: C.layer1,
        color: C.text,
        minWidth: '180px',
      },
      button: {
        font: 'inherit',
        fontSize: SMALL,
        padding: '4px 9px',
        borderRadius: '6px',
        border: `1px solid ${C.border2}`,
        background: C.layer2,
        color: C.text,
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: SMALL,
        padding: '4px 9px',
        borderRadius: '6px',
        border: `1px solid ${C.brand}`,
        background: C.layer1,
        color: C.brand,
        cursor: 'pointer',
        fontWeight: 600,
      },
      buttonDanger: {
        font: 'inherit',
        fontSize: SMALL,
        padding: '4px 9px',
        borderRadius: '6px',
        border: `1px solid ${C.err}`,
        background: C.layer1,
        color: C.err,
        cursor: 'pointer',
      },
      grid: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${C.border1}`,
        background: C.layer1,
        minWidth: 0,
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', fontSize: SMALL, color: C.sub },
      modal: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${C.border2}`,
        background: C.layer1,
        minHeight: 0,
      },
      pre: {
        fontFamily: MONO,
        fontSize: '11px',
        lineHeight: 1.45,
        margin: 0,
        padding: '8px',
        borderRadius: '6px',
        border: `1px solid ${C.border1}`,
        background: C.base,
        color: C.text,
        maxHeight: '260px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      toast: (tone) => ({
        padding: '6px 10px',
        borderRadius: '6px',
        border: `1px solid ${tone === 'error' ? C.err : C.border2}`,
        color: tone === 'error' ? C.err : C.text,
        background: C.layer1,
        fontSize: SMALL,
        whiteSpace: 'pre-wrap',
      }),
      error: { padding: '6px 10px', borderRadius: '6px', border: `1px solid ${C.err}`, color: C.err, background: C.layer1, fontSize: SMALL },
      pill: (tone) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: `1px solid ${tone}`,
        color: tone,
        fontSize: '11px',
        fontWeight: 600,
      }),
      dot: (tone) => ({ width: '8px', height: '8px', borderRadius: '50%', background: tone, flex: 'none' }),
    };

    /**
     * Device state → tone token.
     * @param {string} state Device state.
     * @returns {string} theme token.
     */
    function stateTone(state) {
      if (state === 'device') return C.ok;
      if (state === 'offline') return C.warn;
      return C.err;
    }

    /**
     * One device card in the selection gateway. Clicking the card toggles the
     * device in the action set; there are no per-card buttons, so the panel
     * stays a simple "pick devices, then act" surface.
     * @param {Record<string, any>} props Card props.
     * @returns {any} card element.
     */
    /**
     * Small device-type glyph: a phone for physical devices, a monitor for emulators.
     * @param {{ emulator?: boolean }} props Glyph props.
     * @returns {any} svg element.
     */
    function DeviceKindGlyph(props) {
      const shared = {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { flex: 'none', color: C.sub },
      };
      if (props.emulator === true) {
        return h(
          'svg',
          shared,
          h('rect', { x: '2.5', y: '4', width: '19', height: '13', rx: '2' }),
          h('path', { d: 'M8 21h8' }),
          h('path', { d: 'M12 17v4' }),
        );
      }
      return h(
        'svg',
        shared,
        h('rect', { x: '7', y: '2', width: '10', height: '20', rx: '2' }),
        h('path', { d: 'M11 18.5h2' }),
      );
    }

    /**
     * One device box in the fleet panel. The left edge is colored by device type
     * (brand = emulator, success = physical) so each device is identifiable at a
     * glance, and the whole box is the selection target.
     * @param {Record<string, any>} props Card props.
     * @returns {any} card element.
     */
    function PanelDeviceCard(props) {
      const device = props.device ?? {};
      const serial = typeof device.serial === 'string' ? device.serial : 'unknown';
      const state = typeof device.state === 'string' ? device.state : 'unknown';
      const isEmulator = device.isEmulator === true;
      const ready = state === 'device';
      const tone = ready ? (isEmulator ? C.brand : C.ok) : stateTone(state);
      const selected = props.selected === true;
      const pkg = isRecord(device.package) ? device.package : undefined;
      const disabled = props.busy !== null;
      const chips = [];
      if (device.androidVersion !== undefined && device.androidVersion !== null) chips.push(`Android ${String(device.androidVersion)}`);
      if (typeof device.batteryPct === 'number') chips.push(`Battery ${Math.round(device.batteryPct)}%`);
      chips.push(isEmulator ? 'emulator' : 'physical');
      return h(
        'div',
        {
          key: serial,
          'data-device': serial,
          'data-state': state,
          'data-device-kind': isEmulator ? 'emulator' : 'physical',
          'data-selected': selected ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          'aria-pressed': selected,
          onClick: () => {
            if (!disabled) props.onToggle(serial);
          },
          onKeyDown: (event) => {
            if (!disabled && (event.key === 'Enter' || event.key === ' ')) props.onToggle(serial);
          },
          style: {
            ...PANEL.card,
            gap: '8px',
            padding: '10px 12px',
            borderRadius: '10px',
            border: `1px solid ${selected ? C.brand : C.border2}`,
            borderLeft: `3px solid ${tone}`,
            background: selected ? C.layer2 : C.layer1,
            cursor: disabled ? 'default' : 'pointer',
            outline: 'none',
            opacity: ready ? 1 : 0.7,
          },
        },
        h(
          'div',
          { style: PANEL.row },
          h(
            'span',
            {
              'aria-hidden': true,
              style: {
                width: '15px',
                height: '15px',
                borderRadius: '4px',
                border: `1px solid ${selected ? C.brand : C.border2}`,
                background: selected ? C.brand : 'transparent',
                color: C.base,
                fontSize: '10px',
                lineHeight: '15px',
                textAlign: 'center',
                flex: 'none',
              },
            },
            selected ? '✓' : '',
          ),
          h(DeviceKindGlyph, { emulator: isEmulator }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: '1 1 auto' } },
            h('span', { style: { fontWeight: 700, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(device.model ?? serial)),
            h('span', { style: { color: C.sub, fontFamily: MONO, fontSize: '10.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, serial),
          ),
          h('span', { style: PANEL.pill(tone) }, ready ? (isEmulator ? 'emulator' : 'phone') : state),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          chips.map((label) =>
            h(
              'span',
              {
                key: label,
                style: { fontSize: '10.5px', color: C.sub, border: `1px solid ${C.border1}`, borderRadius: '6px', padding: '2px 8px', background: C.layer2 },
              },
              label,
            ),
          ),
        ),
        pkg !== undefined ? h('div', { style: PANEL.sub }, `app ${String(pkg.versionName ?? '?')} (${String(pkg.versionCode ?? '?')})`) : null,
      );
    }

    /**
     * Device gateway: select any number of devices, then run one action on the
     * whole selection. No package/APK/deep-link inputs: the Host resolves the
     * app from each device's foreground activity.
     * @param {Record<string, any>} props Panel props.
     * @returns {any} panel element.
     */
    function FleetPanel(props) {
      const { useState, useEffect, useRef, useCallback } = React;
      const [listing, setListing] = useState(null);
      const [selected, setSelected] = useState([]);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(null);
      const [toast, setToast] = useState(null);
      const [logs, setLogs] = useState({ open: false, serial: 'all', preset: 'all', filter: '', data: null, error: null, loading: false });
      const [shots, setShots] = useState({ open: false, list: [] });
      const [capabilities, setCapabilities] = useState(null);
      const timers = useRef({});

      const refresh = useCallback(async () => {
        try {
          const payload = await fetchJson(apiUrl('devices'));
          setListing(payload.value ?? null);
          setError(null);
          const devices = Array.isArray(payload.value?.devices) ? payload.value.devices : [];
          const readySerials = devices.filter((device) => device.state === 'device').map((device) => String(device.serial));
          setSelected((current) => {
            const kept = current.filter((serial) => readySerials.includes(serial));
            if (kept.length > 0) return kept;
            const hostSelection = Array.isArray(payload.selected) ? payload.selected.map(String).filter((serial) => readySerials.includes(serial)) : [];
            return hostSelection.length > 0 ? hostSelection : readySerials;
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(() => refresh(), DEVICE_POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 5_000);
        return () => clearTimeout(timer);
      }, [toast]);

      const devices = Array.isArray(listing?.devices) ? listing.devices : [];
      const ready = devices.filter((device) => device.state === 'device');

      const persistSelection = useCallback(async (serials) => {
        setSelected(serials);
        try {
          await fetchJson(apiUrl('select'), { method: 'POST', body: { serials } });
        } catch {
          // Selection still works in the panel; the Host falls back to all ready
          // devices until the next successful sync.
        }
      }, []);

      const toggle = useCallback(
        (serial) => {
          const next = selected.includes(serial) ? selected.filter((entry) => entry !== serial) : [...selected, serial];
          persistSelection(next);
        },
        [selected, persistSelection],
      );

      const runAction = useCallback(
        async (action, extra = {}) => {
          if (selected.length === 0) return;
          setBusy(action);
          try {
            const payload = await fetchJson(apiUrl('action'), { method: 'POST', body: { action, serials: selected, ...extra } });
            const results = Array.isArray(payload.results) ? payload.results : [];
            const failed = results.filter((entry) => entry.ok !== true);
            if (failed.length > 0) {
              setToast({ tone: 'error', text: failed.map((entry) => `${entry.serial}: ${oneLine(entry.text, 240)}`).join('\n') });
            } else {
              setToast({ tone: 'ok', text: payload.text ?? `${action} finished on ${results.length} device(s)` });
            }
            await refresh();
          } catch (cause) {
            setToast({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
          } finally {
            setBusy(null);
          }
        },
        [selected, refresh],
      );

      const restartAdb = useCallback(async () => {
        setBusy('adb');
        try {
          const payload = await fetchJson(apiUrl('adb/restart'), { method: 'POST' });
          const devices = payload.value?.devices;
          setToast({ tone: 'ok', text: `ADB restarted · ${typeof devices === 'number' ? devices : '?'} device(s) visible` });
          await refresh();
        } catch (cause) {
          setToast({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          setBusy(null);
        }
      }, [refresh]);

      const captureShot = useCallback(async (serial) => {
        setBusy(`shot:${serial}`);
        try {
          const response = await fetch(apiUrl('screenshot', { serial }), { credentials: 'same-origin' });
          if (response.status === 401 || response.status === 403) throw new Error('This page is not authorized against the Host.');
          const type = response.headers.get('content-type') ?? '';
          if (!type.startsWith('image/')) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : 'Screenshot failed.');
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          setShots((current) => {
            const previous = current.list.find((shot) => shot.serial === serial);
            if (previous !== undefined) URL.revokeObjectURL(previous.url);
            return { open: true, list: [...current.list.filter((shot) => shot.serial !== serial), { serial, url }] };
          });
        } catch (cause) {
          setToast({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          setBusy(null);
        }
      }, []);

      const shootSelected = useCallback(async () => {
        for (const serial of selected) await captureShot(serial);
      }, [selected, captureShot]);

      const fetchLogs = useCallback(async () => {
        setLogs((current) => ({ ...current, loading: true, error: null }));
        try {
          const targets = logs.serial === 'all' ? selected.join(',') : logs.serial;
          const payload = await fetchJson(
            apiUrl('logs', {
              serial: logs.serial === 'all' ? undefined : targets,
              serials: logs.serial === 'all' ? (targets === '' ? 'all' : targets) : undefined,
              preset: logs.preset,
              filter: logs.filter,
              lines: 120,
            }),
          );
          const value = payload.value ?? {};
          if (logs.serial === 'all') {
            const entries = Array.isArray(value.devices) ? value.devices : [];
            setLogs((current) => ({ ...current, data: entries, loading: false }));
          } else {
            const entry = Array.isArray(value.devices) ? value.devices[0] : undefined;
            setLogs((current) => ({ ...current, data: entry?.value ?? null, loading: false }));
          }
        } catch (cause) {
          setLogs((current) => ({ ...current, data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
        }
      }, [logs.serial, logs.preset, logs.filter, selected]);

      useEffect(() => {
        let cancelled = false;
        fetchJson(apiUrl('scrcpy'))
          .then((payload) => {
            if (!cancelled) setCapabilities(payload.value ?? null);
          })
          .catch(() => {
            if (!cancelled) setCapabilities({ scrcpy: { available: false, path: null } });
          });
        return () => {
          cancelled = true;
        };
      }, []);

      useEffect(() => {
        if (!logs.open) return undefined;
        fetchLogs();
        const timer = setInterval(() => fetchLogs(), LOG_POLL_MS);
        return () => clearInterval(timer);
      }, [logs.open, fetchLogs]);

      useEffect(
        () => () => {
          for (const shot of shots.list) URL.revokeObjectURL(shot.url);
        },
        [shots.list],
      );

      const selectedCount = selected.length;
      const actionDisabled = busy !== null || selectedCount === 0;

      return h(
        'div',
        { 'data-fleet-panel': props.variant === 'sidebar' ? 'sidebar' : props.onClose !== undefined ? 'overlay' : 'main', style: props.variant === 'sidebar' ? { ...PANEL.wrap, background: 'transparent', padding: '10px' } : props.onClose !== undefined ? { ...PANEL.wrap, height: 'auto', maxHeight: 'none', padding: '12px' } : PANEL.wrap },
        h(
          'div',
          { style: PANEL.header },
          h('span', { style: PANEL.title }, 'Devices'),
          h('span', { style: PANEL.sub }, listing === null ? '' : `${ready.length} ready · ${selectedCount} selected`),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              type: 'button',
              style: PANEL.button,
              onClick: () => restartAdb(),
              disabled: busy !== null,
              title: 'Restart the local adb server when a connected phone disappears',
            },
            'Restart ADB',
          ),
          h('button', { type: 'button', style: PANEL.button, onClick: () => refresh(), disabled: busy !== null }, 'Refresh'),
          props.onClose !== undefined
            ? h(
                'button',
                { type: 'button', style: { ...PANEL.button, padding: '1px 8px', borderRadius: '999px' }, onClick: props.onClose, 'aria-label': 'Close device fleet' },
                '✕',
              )
            : null,
        ),
        error !== null ? h('div', { style: PANEL.error }, error) : null,
        toast !== null ? h('div', { style: PANEL.toast(toast.tone) }, toast.text) : null,
        h(
          'div',
          { style: PANEL.toolbar },
          h('button', { type: 'button', style: PANEL.buttonPrimary, onClick: () => runAction('relaunch'), disabled: actionDisabled }, 'Relaunch'),
          h('button', { type: 'button', style: PANEL.button, onClick: () => runAction('stop'), disabled: actionDisabled }, 'Stop'),
          h('button', { type: 'button', style: PANEL.button, onClick: () => shootSelected(), disabled: actionDisabled }, 'Screenshot'),
          h(
            'button',
            {
              type: 'button',
              style: PANEL.button,
              onClick: () => setLogs((current) => ({ ...current, open: true, serial: 'all' })),
              disabled: actionDisabled,
            },
            'Logs',
          ),
          h(
            'button',
            {
              type: 'button',
              style: PANEL.button,
              onClick: () => runAction('mirror'),
              disabled: actionDisabled || capabilities?.scrcpy?.available !== true,
              title:
                capabilities?.scrcpy?.available === true
                  ? 'Open a read-only scrcpy mirror on every selected device'
                  : 'scrcpy not found. Install it with: winget install Genymobile.scrcpy',
            },
            'Mirror',
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            { type: 'button', style: PANEL.button, onClick: () => persistSelection(ready.map((device) => String(device.serial))), disabled: ready.length === 0 },
            'Select all',
          ),
          h('button', { type: 'button', style: PANEL.button, onClick: () => persistSelection([]), disabled: selectedCount === 0 }, 'None'),
        ),
        devices.length === 0
          ? h('div', { style: { ...PANEL.card, color: C.sub } }, 'No devices. Connect a phone with USB debugging or boot an emulator, then refresh.')
          : h(
              'div',
              { style: PANEL.grid },
              ...devices.map((device) =>
                h(PanelDeviceCard, {
                  key: String(device.serial),
                  device,
                  busy,
                  selected: selected.includes(String(device.serial)),
                  onToggle: toggle,
                }),
              ),
            ),
        logs.open
          ? h(PanelLogs, {
              ...logs,
              onClose: () => setLogs((current) => ({ ...current, open: false })),
              onRefresh: fetchLogs,
              onPreset: (preset) => setLogs((current) => ({ ...current, preset })),
              onFilter: (filter) => setLogs((current) => ({ ...current, filter })),
            })
          : null,
        shots.open ? h(PanelShots, { shots: shots.list, onClose: () => setShots({ open: false, list: shots.list }) }) : null,
      );
    }

    /** Floating launcher chrome, styled like the shipped menu surfaces. */
    const LAUNCHER = {
      position: 'fixed',
      right: '18px',
      bottom: '84px',
      zIndex: 4000,
      width: '44px',
      height: '44px',
      padding: 0,
      borderRadius: '999px',
      border: `1px solid ${C.border2}`,
      background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
      boxShadow: 'var(--dsw-elevation-prominent, none)',
      color: C.text,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      pointerEvents: 'auto',
      WebkitAppRegion: 'no-drag',
    };

    /**
     * Shared overlay state. The launcher button and the panel are separate
     * frame-overlay entries (like the host-health pills + dialog), so the
     * button never nests a fixed overlay inside its own layer.
     */
    const fleetView = { open: false };
    const fleetListeners = new Set();

    function fleetNotify() {
      for (const listener of fleetListeners) listener();
    }

    /**
     * @param {boolean} open New state.
     * @returns {void}
     */
    function fleetSetOpen(open) {
      fleetView.open = open;
      fleetNotify();
    }

    /** Subscribe a component to the shared overlay state. */
    function useFleetView() {
      const { useState, useEffect } = React;
      const [, setTick] = useState(0);
      useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        fleetListeners.add(listener);
        return () => fleetListeners.delete(listener);
      }, []);
      return fleetView;
    }

    /** Right-sidebar tab identity: the type id is the pane.tab slot key. */
    const FLEET_TAB_ID = '@darkmintis/dsh-device-fleet/devices';
    /** Right-sidebar tab kind opened by the header button and the guide entry. */
    const FLEET_TAB_KIND = 'device-fleet';
    /** Navigation controller captured from the soft injection; null in headless shells. */
    let sidebarRightController = null;

    /**
     * Body of the device-fleet right-sidebar tab: the gateway panel rendered as
     * the column's page.
     * @returns {any} tab body element.
     */
    function FleetBody() {
      return h(FleetPanel, { variant: 'sidebar' });
    }

    /**
     * Compact opener in the conversation header: one click expands the right
     * column on the device-fleet tab for the current session.
     * @param {Record<string, any>} props Owner props.
     * @returns {any} button element.
     */
    function FleetOpenButton(props) {
      const onClick = (event) => {
        const controller = sidebarRightController;
        if (controller === null || controller === undefined) return;
        try {
          const element = event !== null && event !== undefined ? event.currentTarget : null;
          const target = element !== null && typeof controller.commandTarget === 'function' ? controller.commandTarget(element) : undefined;
          if (target !== undefined && typeof controller.openTabFromTarget === 'function') {
            controller.openTabFromTarget(FLEET_TAB_KIND, target);
          } else if (typeof controller.openTab === 'function') {
            controller.openTab(FLEET_TAB_KIND);
          }
        } catch {
          // The right column may be closing; the next click retries.
        }
      };
      return h(
        'button',
        {
          type: 'button',
          'data-fleet-open': 'button',
          'aria-label': 'Open device fleet',
          title: 'Device fleet',
          onClick,
          style: {
            font: 'inherit',
            fontSize: SMALL,
            padding: '2px 6px',
            borderRadius: '6px',
            border: `1px solid ${C.border2}`,
            background: 'transparent',
            color: C.sub,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          },
        },
        h(FleetPanelIcon, { size: 14 }),
      );
    }

    /**
     * Visible failure surface: a crash inside the panel still renders text
     * instead of an invisible overlay.
     */
    class FleetGuard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
          return h(
            'div',
            { 'data-fleet-overlay-error': '1', style: { padding: '12px', color: C.err, fontSize: SMALL, whiteSpace: 'pre-wrap' } },
            `Device overlay failed: ${message}`,
          );
        }
        return this.props.children;
      }
    }

    /**
     * Round floating button that toggles the device fleet overlay.
     * @returns {any} launcher element.
     */
    function FleetLauncher() {
      const view = useFleetView();
      return h(
        'button',
        {
          type: 'button',
          'data-fleet-launcher': 'button',
          'aria-expanded': view.open,
          'aria-label': 'Device fleet',
          title: 'Device fleet',
          onClick: () => fleetSetOpen(!view.open),
          style: { ...LAUNCHER, color: view.open ? C.text : C.sub, background: view.open ? C.layer2 : LAUNCHER.background },
        },
        h(FleetPanelIcon, { size: 20, active: view.open }),
      );
    }

    /**
     * Frame-overlay panel: the device gateway card above the composer.
     * @returns {any|null} overlay element or null while closed.
     */
    function FleetLayer() {
      const { useRef, useEffect } = React;
      const view = useFleetView();
      const panelRef = useRef(null);

      useEffect(() => {
        if (!view.open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') fleetSetOpen(false);
        };
        const onPointerDown = (event) => {
          const target = event.target;
          const panel = panelRef.current;
          if (panel !== null && panel !== undefined && typeof panel.contains === 'function' && panel.contains(target) === true) return;
          if (target !== null && typeof target === 'object' && typeof target.closest === 'function' && target.closest('[data-fleet-launcher]') !== null) return;
          fleetSetOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [view.open]);

      if (!view.open) return null;
      return h(
        'div',
        { 'data-fleet-overlay': 'open', style: { position: 'fixed', inset: 0, zIndex: 4000, pointerEvents: 'none' } },
        h(
          'div',
          {
            ref: panelRef,
            style: {
              position: 'fixed',
              right: '18px',
              bottom: '136px',
              width: 'min(440px, calc(100vw - 20px))',
              maxHeight: 'min(72vh, 640px)',
              overflow: 'auto',
              borderRadius: '12px',
              background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
              boxShadow: 'var(--dsw-elevation-prominent, none)',
              backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
              border: 0,
              pointerEvents: 'auto',
            },
          },
          h(FleetGuard, null, h(FleetPanel, { onClose: () => fleetSetOpen(false) })),
        ),
      );
    }

    /**
     * Sidebar icon for the Device fleet panel.
     * @param {{ size?: number, active?: boolean }} props Icon props.
     * @returns {any} svg element.
     */
    function FleetPanelIcon(props) {
      const iconProps = props ?? {};
      const size = typeof iconProps.size === 'number' && iconProps.size > 0 ? iconProps.size : 20;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { color: iconProps.active === true ? C.text : C.sub, display: 'block' },
        },
        h('rect', { x: 2.5, y: 6, width: 7.5, height: 13, rx: 1.6 }),
        h('rect', { x: 14, y: 3, width: 7.5, height: 13, rx: 1.6 }),
        h('path', { d: 'M10 12.5h4' }),
        h('circle', { cx: 6.25, cy: 16, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17.75, cy: 13, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    // ------------------------------------------------------------------
    // Plugin body
    // ------------------------------------------------------------------

    /**
     * Client plugin body: register the locale dictionaries and one keyed slot
     * registration per wire tool name.
     * @param {any} ctx Client plugin context with `slots` and `locale`.
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en: EN, zh: ZH }), 'device-fleet: dictionaries');

      // The sidebar entry and the main-column panel are the visible cockpit:
      // the sidebar id addresses the panel with the same key.
      // The fleet lives in the right Sidebar: a tab type, its body, and a compact
      // opener in the conversation header utilities. The right column is only
      // present in some compositions, so the whole block is a soft injection.
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sidebarCtx) => {
        sidebarRightController = sidebarCtx.sidebarRight;
        sidebarCtx.effect(
          () =>
            sidebarCtx.sidebarRightTabs.register({
              id: FLEET_TAB_ID,
              kind: FLEET_TAB_KIND,
              multiple: true,
              priority: 'extension',
              title: () => 'Devices',
              guide: [
                {
                  id: 'devices',
                  order: 40,
                  title: () => 'Devices',
                  description: () => 'Phones and emulators: select devices, relaunch, mirror, and read logcat.',
                },
              ],
            }),
          'device-fleet: sidebar tab type',
        );
        sidebarCtx.effect(
          () =>
            sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
              sidebarCtx.slots.register({ name: 'sidebar.right.pane.tab', key: FLEET_TAB_ID, locale: LOCALE_NS }, FleetBody),
            ),
          'device-fleet: sidebar tab body',
        );
        sidebarCtx.effect(
          () =>
            sidebarCtx.slots.inject('conversation.session.header.utilities', () =>
              sidebarCtx.slots.register(
                { name: 'conversation.session.header.utilities', id: 'device-fleet-open', order: 30, label: 'Device fleet' },
                FleetOpenButton,
              ),
            ),
          'device-fleet: sidebar opener',
        );
      });

      const componentFor = (toolName) => {
        if (toolName === 'fleet_list') return FleetListCard;
        if (toolName === 'device_screenshot') return ScreenshotCard;
        if (toolName === 'device_logcat') return LogcatCard;
        return CompactCard;
      };

      ctx.slots.inject('tool.call.toolview', () => {
        /** @type {Array<() => void>} */
        const disposers = [];
        for (const toolName of TOOL_NAMES) {
          disposers.push(
            ctx.slots.register(
              {
                name: 'tool.call.toolview',
                key: toolName,
                locale: LOCALE_NS,
              },
              componentFor(toolName),
            ),
          );
        }
        return disposers;
      });
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
