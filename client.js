/**
 * Client half of the local recycle bin: a Session row entry that moves a Session
 * into the bin, a two-segment panel (回收站 / 归档) that lists, restores, unarchives
 * and purges, and the in-app dialogs and toast that make it feel native.
 *
 * Everything talks to the Host through `sessionTrash/*` on the page's own `/api`
 * carrier, and the row list updates through the forwarded `api-session/*` events
 * the Host emits, so no action reloads the page.
 */
window.__ModuleLoader__.load({
  id: '@h_kevin/dsh-session-trash',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * DSH's own UI kit. The browser module table resolves it by package name, so
     * dialogs, buttons and segmented controls can look native; a composition
     * without it falls back to the hand-written surfaces below.
     */
    let ui
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      ui = undefined
    }

    /** Copy namespace registered with the Client locale service. */
    const NS = 'sessionTrash'

    /** Simplified Chinese dictionary, the key-set source of truth. */
    const zh = {
      'menu.delete': '删除',
      'menu.busy': '正在移入回收站…',
      'menu.confirmTitle': '删除这个会话？',
      'menu.confirmBody': '「{name}」会移入本地回收站，可以随时恢复。彻底删除是回收站里的另一个动作。',
      'menu.confirmHint': '回收站不会自动清理，占用的空间需要你显式释放。',
      'menu.toast': '「{name}」已移入回收站',
      'menu.noticeTitle': '已移入回收站，但有以下情况',
      'menu.failed': '移入回收站失败',
      'menu.undoFailed': '撤销失败',
      'common.cancel': '取消',
      'common.confirm': '确定',
      'common.ok': '知道了',
      'common.close': '关闭',
      'common.retry': '重试',
      'common.processing': '处理中…',
      'common.undo': '撤销',
      'busy.title': '这个会话还有任务在跑',
      'busy.action': '停止并移入',
      'tab.trash': '回收站',
      'tab.archive': '归档',
      'header.loading': '正在读取…',
      'header.refresh': '刷新',
      'header.readFailed': '读取失败：{message}',
      'header.binStats': '{count} 个会话 · 可释放 {size}',
      'header.archiveStats': '{count} 个归档会话',
      'search.placeholder': '搜索标题、会话 id 或目录',
      'search.aria': '搜索回收站',
      'sort.time': '按时间',
      'sort.size': '按大小',
      'group.count': '{count} 个会话',
      'group.unknownDir': '(未知目录)',
      'detail.sessionId': '会话 id',
      'detail.cwd': '原目录',
      'detail.workspace': '原工作区',
      'detail.createdAt': '创建时间',
      'detail.lastPromptAt': '最后活动',
      'detail.turns': '轮数',
      'detail.model': '模型',
      'detail.state': '会话状态',
      'detail.blank': '空会话（没有对话内容）',
      'detail.tokens': 'Token 输出',
      'detail.deletedAt': '删除时间',
      'detail.bytes': '占用空间',
      'detail.status': '状态',
      'detail.archived': '已归档（侧栏默认不显示）',
      'action.restore': '恢复到原工作区',
      'action.restoreBusy': '恢复中…',
      'action.purge': '彻底删除（不可恢复）',
      'action.unarchive': '取消归档',
      'action.moveToBin': '移入回收站',
      'purge.title': '彻底删除这个会话？',
      'purge.body': '「{name}」将释放 {size}，无法恢复。',
      'purge.hint': '这一步之后回收站里不会再有它。',
      'purge.action': '彻底删除',
      'archive.title': '把这个归档会话移入回收站？',
      'archive.body': '「{name}」会从归档里移到回收站，可以再恢复或彻底删除。',
      'restore.warn': '已恢复，但有以下情况',
      'restore.failed': '恢复失败',
      'action.failed': '操作失败',
      'empty.trashTitle': '回收站是空的',
      'empty.trashHint': '删除会话时选择「移入回收站」，它就会出现在这里，可随时恢复。',
      'empty.archiveTitle': '没有归档的会话',
      'empty.archiveHint': '在会话行菜单里选择「归档会话」，它就会出现在这里，可以取消归档或删除。',
      'pane.empty': '从左侧选一条会话查看详情',
      'bulk.selected': '已选 {count} 项',
      'bulk.selectAll': '全选',
      'bulk.clear': '取消选择',
      'bulk.restore': '恢复',
      'bulk.purge': '彻底删除',
      'bulk.unarchive': '取消归档',
      'bulk.trash': '移入回收站',
      'bulk.purgeTitle': '彻底删除选中的 {count} 个会话？',
      'bulk.purgeBody': '将释放 {size}，无法恢复。',
      'bulk.partial': '部分操作失败',
      'bulk.selectRow': '选择这个会话',
      'clear.button': '清空回收站…',
      'clear.title': '清空回收站？',
      'clear.body': '{count} 个会话将被永久删除，释放 {size}。',
      'clear.hint': '这一步之后无法恢复，也没有撤销。',
      'clear.action': '清空',
      'clear.done': '回收站已清空',
      'clear.failed': '清空失败',
      'footer.note': '回收站本体在宿主数据根下的 session-trash/ 里，不自动过期；清空后不可恢复。',
      'boundary.title': '这块界面出错了',
      'error.noConnection': '没有可用的 Host 连接',
      'error.unknown': '未知错误',
      'panel.label': '回收站',
    }

    /** English dictionary, checked against the Chinese key set. */
    const en = {
      'menu.delete': 'Delete',
      'menu.busy': 'Moving to the recycle bin…',
      'menu.confirmTitle': 'Delete this session?',
      'menu.confirmBody': '“{name}” moves to the local recycle bin and can be restored at any time. Purging is a separate action inside the bin.',
      'menu.confirmHint': 'The bin never expires on its own; releasing the space is an explicit action.',
      'menu.toast': '“{name}” moved to the recycle bin',
      'menu.noticeTitle': 'Moved to the bin, with notes',
      'menu.failed': 'Could not move the session to the bin',
      'menu.undoFailed': 'Undo failed',
      'common.cancel': 'Cancel',
      'common.confirm': 'OK',
      'common.ok': 'Got it',
      'common.close': 'Close',
      'common.retry': 'Retry',
      'common.processing': 'Working…',
      'common.undo': 'Undo',
      'busy.title': 'This session still has work running',
      'busy.action': 'Stop and move',
      'tab.trash': 'Recycle bin',
      'tab.archive': 'Archived',
      'header.loading': 'Reading…',
      'header.refresh': 'Refresh',
      'header.readFailed': 'Read failed: {message}',
      'header.binStats': '{count} session(s) · {size} reclaimable',
      'header.archiveStats': '{count} archived session(s)',
      'search.placeholder': 'Search title, session id or directory',
      'search.aria': 'Search the recycle bin',
      'sort.time': 'By time',
      'sort.size': 'By size',
      'group.count': '{count} session(s)',
      'group.unknownDir': '(unknown directory)',
      'detail.sessionId': 'Session id',
      'detail.cwd': 'Original directory',
      'detail.workspace': 'Workspace',
      'detail.createdAt': 'Created',
      'detail.lastPromptAt': 'Last activity',
      'detail.turns': 'Turns',
      'detail.model': 'Model',
      'detail.state': 'Session state',
      'detail.blank': 'Empty session (no messages)',
      'detail.tokens': 'Output tokens',
      'detail.deletedAt': 'Deleted',
      'detail.bytes': 'Size',
      'detail.status': 'State',
      'detail.archived': 'Archived (hidden from the sidebar by default)',
      'action.restore': 'Restore to its workspace',
      'action.restoreBusy': 'Restoring…',
      'action.purge': 'Delete permanently (cannot be undone)',
      'action.unarchive': 'Unarchive',
      'action.moveToBin': 'Move to bin',
      'purge.title': 'Delete this session permanently?',
      'purge.body': '“{name}” releases {size} and cannot be recovered.',
      'purge.hint': 'The bin will no longer hold it after this.',
      'purge.action': 'Delete permanently',
      'archive.title': 'Move this archived session to the bin?',
      'archive.body': '“{name}” leaves the archive for the bin, where it can be restored or purged.',
      'restore.warn': 'Restored, with notes',
      'restore.failed': 'Restore failed',
      'action.failed': 'Action failed',
      'empty.trashTitle': 'The recycle bin is empty',
      'empty.trashHint': 'Deleting a session with “move to recycle bin” places it here, restorable at any time.',
      'empty.archiveTitle': 'No archived sessions',
      'empty.archiveHint': '“Archive session” in a session row menu moves it here, where it can be unarchived or deleted.',
      'pane.empty': 'Pick a session on the left to see its details',
      'bulk.selected': '{count} selected',
      'bulk.selectAll': 'Select all',
      'bulk.clear': 'Clear selection',
      'bulk.restore': 'Restore',
      'bulk.purge': 'Delete permanently',
      'bulk.unarchive': 'Unarchive',
      'bulk.trash': 'Move to bin',
      'bulk.purgeTitle': 'Delete {count} selected session(s) permanently?',
      'bulk.purgeBody': 'This releases {size} and cannot be undone.',
      'bulk.partial': 'Some actions failed',
      'bulk.selectRow': 'Select this session',
      'clear.button': 'Empty the bin…',
      'clear.title': 'Empty the recycle bin?',
      'clear.body': '{count} session(s) will be deleted permanently, releasing {size}.',
      'clear.hint': 'This cannot be undone and has no undo.',
      'clear.action': 'Empty',
      'clear.done': 'Recycle bin emptied',
      'clear.failed': 'Could not empty the bin',
      'footer.note': 'The bin itself lives under session-trash/ in the host data root; it never expires, and emptying it is final.',
      'boundary.title': 'This surface hit an error',
      'error.noConnection': 'No Host connection available',
      'error.unknown': 'Unknown error',
      'panel.label': 'Recycle bin',
    }

    /** Replace `{name}` placeholders without relying on the locale service's formatter. */
    function interpolate(template, params) {
      if (params === undefined) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (match, key) => {
        const value = params[key]
        return value === undefined ? match : String(value)
      })
    }

    /** Bound translate; apply() swaps this for the locale service's binding. */
    let tr = (key, params) => interpolate(zh[key] ?? key, params)


    /** Panel identity in the layout's main-panel table. */
    const PANEL_ID = 'session-trash'

    /** Plugin context captured at apply time; one page, one plugin instance. */
    let pluginContext

    // ---- Host calls --------------------------------------------------------

    /**
     * Invoke a Host endpoint.
     * @param endpoint - `sessionTrash/<method>`.
     * @param args - named wire arguments.
     * @returns the Host result value.
     */
    async function callHost(endpoint, args) {
      const connection = pluginContext.get('connection')
      if (connection === undefined) throw new Error(tr('error.noConnection'))
      const result = await connection.rpc.call('/api', endpoint, { args }, new AbortController().signal)
      if (result.ok !== true) {
        const detail = result.error === undefined ? tr('error.unknown') : (result.error.message ?? result.error.code ?? tr('error.unknown'))
        throw new Error(detail)
      }
      return result.value
    }

    // ---- Error boundary ----------------------------------------------------

    /**
     * Keeps one crashing surface from blanking the page: a render error inside
     * the panel or an overlay shows the message and a retry instead.
     */
    class SurfaceBoundary extends React.Component {
      /** @param props - children to protect. */
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      /** React render-phase hook: capture the error into state. */
      static getDerivedStateFromError(error) {
        return { error }
      }

      /** Report the crash once for diagnosis. */
      componentDidCatch(error) {
        console.error('[session-trash] surface crashed', error)
      }

      /** @returns the fallback, or the protected children. */
      render() {
        if (this.state.error !== null) {
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
          return h('div', { style: { padding: '32px 24px', color: COLORS.text } },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, tr('boundary.title')),
            h('div', { style: { fontSize: 12, color: COLORS.textMuted, marginBottom: 14, wordBreak: 'break-word' } }, message),
            button(tr('common.retry'), () => { this.setState({ error: null }) }, { variant: 'primary' }))
        }
        return this.props.children
      }
    }

    /** Wrap one component in the boundary. */
    function guarded(Component) {
      return function Guarded() {
        return h(SurfaceBoundary, null, h(Component))
      }
    }

    // ---- In-app dialog + toast state --------------------------------------

    /** One pending dialog: its copy, its resolve, and whether it is destructive. */
    let pendingDialog = null
    /** One visible toast. */
    let currentToast = null
    const listeners = new Set()

    /** Tell every mounted surface to re-read the module state. */
    function notify() {
      for (const listener of listeners) listener()
    }

    /** Subscribe one surface. */
    function useSurfaceState() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => { listeners.delete(force) }
      }, [force])
    }

    /**
     * Ask the person to confirm an action in an app-styled dialog.
     * @param options - title, message, confirm label, danger styling, optional hint.
     * @returns whether they confirmed.
     */
    function askConfirm(options) {
      return new Promise((resolve) => {
        pendingDialog = {
          kind: 'confirm',
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel ?? tr('common.confirm'),
          cancelLabel: options.cancelLabel ?? tr('common.cancel'),
          danger: options.danger === true,
          hint: options.hint,
          resolve,
        }
        notify()
      })
    }

    /**
     * Show a one-button notice in the same dialog.
     * @param options - title and message.
     * @returns once dismissed.
     */
    function showNotice(options) {
      return new Promise((resolve) => {
        pendingDialog = {
          kind: 'notice',
          title: options.title,
          message: options.message,
          confirmLabel: tr('common.ok'),
          danger: false,
          resolve: () => { resolve() },
        }
        notify()
      })
    }

    /** Close the pending dialog with one answer. */
    function settleDialog(answer) {
      const dialog = pendingDialog
      pendingDialog = null
      notify()
      dialog?.resolve(dialog.kind === 'notice' ? undefined : answer)
    }

    /**
     * Show a toast; an optional undo action reverses what the toast reports.
     * @param options - message, undo callback, and lifetime.
     */
    function showToast(options) {
      if (currentToast?.timer !== undefined) clearTimeout(currentToast.timer)
      const timer = setTimeout(() => {
        currentToast = null
        notify()
      }, options.durationMs ?? 6000)
      currentToast = { message: options.message, undo: options.undo, timer }
      notify()
    }

    // ---- Shared visual pieces ---------------------------------------------

    /** Theme-facing colors with readable fallbacks. */
    const COLORS = {
      border: 'var(--dsh-color-border, rgba(255, 255, 255, 0.14))',
      borderSubtle: 'var(--dsh-color-border-subtle, rgba(255, 255, 255, 0.07))',
      text: 'var(--dsh-color-text-primary, #f2f2f2)',
      textMuted: 'var(--dsh-color-text-tertiary, #9a9a9a)',
      danger: 'var(--dsh-color-danger, #e5484d)',
      surface: 'var(--dsh-color-bg-elevated, #232323)',
      surfaceHover: 'var(--dsh-color-fill-secondary, rgba(255, 255, 255, 0.08))',
      primaryBg: 'var(--dsh-color-fill-primary, #f2f2f2)',
      primaryText: 'var(--dsh-color-text-on-primary, #141414)',
      accent: 'var(--dsh-color-accent, #6ea8fe)',
    }

    /** One button. */
    function button(label, onClick, options) {
      const variant = options?.variant ?? 'secondary'
      const disabled = options?.disabled === true
      const style = {
        padding: '6px 14px',
        borderRadius: 8,
        fontSize: 13,
        lineHeight: '18px',
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: '1px solid transparent',
        transition: 'background 120ms ease',
        whiteSpace: 'nowrap',
      }
      if (variant === 'primary') {
        Object.assign(style, { background: COLORS.primaryBg, color: COLORS.primaryText, borderColor: COLORS.primaryBg })
      } else if (variant === 'danger') {
        Object.assign(style, { background: COLORS.danger, color: '#fff', borderColor: COLORS.danger })
      } else if (variant === 'ghost') {
        Object.assign(style, { background: 'transparent', color: COLORS.textMuted, borderColor: 'transparent', padding: '6px 8px' })
      } else {
        Object.assign(style, { background: 'transparent', color: COLORS.text, borderColor: COLORS.border })
      }
      return h('button', { type: 'button', disabled, onClick, style }, label)
    }

    /** One button, on the DSH kit when it is available. */
    function UiButton(props) {
      const variant = props.variant ?? 'outline'
      if (ui?.Button !== undefined) {
        return h(ui.Button, {
          variant,
          size: 'sm',
          disabled: props.disabled === true,
          onClick: props.onClick,
        }, props.label)
      }
      return button(props.label, props.onClick, {
        variant: variant === 'primary' ? 'primary' : variant === 'danger' ? 'danger' : 'secondary',
        disabled: props.disabled === true,
      })
    }

    /** One segmented control, on the DSH kit when it is available. */
    function UiSegments(props) {
      if (ui?.SegmentedControl !== undefined) {
        return h(ui.SegmentedControl, {
          id: props.id,
          label: props.label,
          value: props.value,
          options: props.options.map(option => ({ value: option.value, label: option.label })),
          onChange: props.onChange,
        })
      }
      return h('div', { style: { display: 'flex', gap: 4 } },
        props.options.map(option => h(Segment, {
          key: option.value,
          label: option.label,
          active: props.value === option.value,
          onSelect: () => { props.onChange(option.value) },
        })))
    }

    /** A right-aligned footer strip. */
    function footer(children) {
      return h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 } }, children)
    }

    /**
     * One square icon button with a native tooltip and an accessible name.
     * A component, not a helper: it holds hover state, and calling a hook-bearing
     * function from a row loop would make the hook order depend on the list length.
     */
    function IconButton(props) {
      const disabled = props.disabled === true
      const danger = props.danger === true
      const [hovered, setHovered] = React.useState(false)
      return h('button', {
        type: 'button',
        title: props.label,
        'aria-label': props.label,
        disabled,
        onClick: props.onClick,
        onMouseEnter: () => { setHovered(true) },
        onMouseLeave: () => { setHovered(false) },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, padding: 0, borderRadius: 8,
          border: `1px solid ${danger ? COLORS.danger : COLORS.border}`,
          background: hovered && !disabled ? COLORS.surfaceHover : 'transparent',
          color: danger ? COLORS.danger : COLORS.text,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          transition: 'background 120ms ease',
        },
      }, props.icon)
    }

    /** Circular arrow: restore. */
    function IconRestore() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 12a8 8 0 1 0 2.6-5.9' }),
      h('path', { d: 'M4 4.5V10h5.5' }))
    }

    /** Trash can: purge or move to bin. */
    function IconTrash() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7' }),
      h('path', { d: 'M6.5 7l1 12a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l1-12' }),
      h('path', { d: 'M10.5 11v6M13.5 11v6' }))
    }

    /** Box with an up arrow: unarchive. */
    function IconUnarchive() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 8.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V8.5' }),
      h('path', { d: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V8H3z' }),
      h('path', { d: 'M12 17v-5.5' }),
      h('path', { d: 'M9.5 14L12 11.5 14.5 14' }))
    }

    // ---- Dialog surface ----------------------------------------------------

    /** The app-styled modal: one at a time, driven by module state. */
    function ConfirmSurface() {
      useSurfaceState()
      const dialog = pendingDialog
      React.useEffect(() => {
        if (dialog === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            settleDialog(false)
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            settleDialog(true)
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('keydown', onKey, true) }
      }, [dialog])

      if (dialog === null) return null
      const close = () => { settleDialog(false) }

      if (ui?.Modal !== undefined) {
        const actions = dialog.kind === 'notice'
          ? h(UiButton, { label: dialog.confirmLabel, variant: 'primary', onClick: () => { settleDialog(true) } })
          : h(React.Fragment, null,
            h(UiButton, { label: dialog.cancelLabel, onClick: close }),
            h(UiButton, {
              label: dialog.confirmLabel,
              variant: dialog.danger ? 'danger' : 'primary',
              onClick: () => { settleDialog(true) },
            }))
        return h(ui.Modal, {
          open: true,
          title: dialog.title,
          closeLabel: tr('common.close'),
          onClose: close,
          footer: actions,
        },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', {
            style: { fontSize: 14, lineHeight: '22px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: COLORS.text },
          }, dialog.message),
          dialog.hint === undefined
            ? null
            : h('div', { style: { fontSize: 12, lineHeight: '18px', color: COLORS.textMuted } }, dialog.hint)))
      }

      return h('div', {
        style: {
          position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.45)', zIndex: 60,
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
      },
      h('div', {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': dialog.title,
        style: {
          width: 520,
          maxWidth: 'calc(100vw - 64px)',
          boxSizing: 'border-box',
          background: COLORS.surface,
          color: COLORS.text,
          borderRadius: 12,
          border: `1px solid ${COLORS.borderSubtle}`,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
          padding: '20px 24px 20px',
          fontFamily: 'inherit',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
        h('div', { style: { flex: 1, fontSize: 16, fontWeight: 600, lineHeight: '24px' } }, dialog.title),
        dialog.kind === 'notice'
          ? null
          : h('button', {
            type: 'button',
            'aria-label': tr('common.close'),
            onClick: close,
            style: {
              background: 'transparent', border: 0, color: COLORS.textMuted, cursor: 'pointer',
              fontSize: 18, lineHeight: '20px', padding: 2, fontFamily: 'inherit',
            },
          }, '×')),
      h('div', {
        style: {
          marginTop: 16, fontSize: 14, lineHeight: '22px', color: COLORS.text,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      }, dialog.message),
      dialog.hint === undefined
        ? null
        : h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: '18px', color: COLORS.textMuted } }, dialog.hint),
      footer([
        dialog.kind === 'notice'
          ? button(dialog.confirmLabel, () => { settleDialog(true) }, { variant: 'primary' })
          : button(dialog.cancelLabel, close),
        dialog.kind === 'notice'
          ? null
          : button(dialog.confirmLabel, () => { settleDialog(true) }, { variant: dialog.danger ? 'danger' : 'primary' }),
      ])))
    }

    // ---- Toast surface -----------------------------------------------------

    /** The bottom-center toast that reports the last action, with undo. */
    function ToastSurface() {
      useSurfaceState()
      const toast = currentToast
      if (toast === null) return null
      return h('div', {
        style: {
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '10px 16px', borderRadius: 10, zIndex: 55,
          background: COLORS.surface, color: COLORS.text,
          border: `1px solid ${COLORS.borderSubtle}`,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
          fontSize: 13, lineHeight: '18px', fontFamily: 'inherit', maxWidth: '80vw',
        },
      },
      h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, toast.message),
      toast.undo === undefined
        ? null
        : h('button', {
          type: 'button',
          onClick: () => {
            const undo = toast.undo
            currentToast = null
            notify()
            if (undo !== undefined) void undo()
          },
          style: {
            background: 'transparent', border: 0, padding: '0 2px', cursor: 'pointer',
            color: COLORS.accent, fontSize: 13, fontFamily: 'inherit', fontWeight: 500,
          },
        }, tr('common.undo')))
    }

    // ---- Formatting --------------------------------------------------------

    /** Human-readable size. */
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || bytes <= 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** Human-readable time. */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
    }

    /** Human-readable time from an epoch-millisecond fact. */
    function formatEpoch(ms) {
      if (typeof ms !== 'number' || ms <= 0) return ''
      const at = new Date(ms)
      return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
    }

    /** Compact token count. */
    function formatTokens(count) {
      if (typeof count !== 'number' || count <= 0) return ''
      if (count < 1000) return String(count)
      return `${(count / 1000).toFixed(1)}k`
    }

    /** The row's display name: its stored title, else the id. */
    function nameOf(entry) {
      return typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.sessionId
    }

    // ---- Recycle bin panel -------------------------------------------------

    /** One list row with hover feedback and an inline expandable detail block. */
    function Row(props) {
      const [hovered, setHovered] = React.useState(false)
      const detail = props.detail
      return h('li', {
        onMouseEnter: () => { setHovered(true) },
        onMouseLeave: () => { setHovered(false) },
        style: {
          display: 'flex', flexDirection: 'column',
          background: hovered || props.expanded || props.selected ? COLORS.surfaceHover : 'transparent',
          borderBottom: `1px solid ${COLORS.borderSubtle}`,
        },
      },
      h('div', {
        onClick: props.onToggle,
        style: { display: 'flex', alignItems: 'center', gap: 16, padding: '12px 24px', cursor: 'pointer' },
      },
      h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        'aria-label': tr('bulk.selectRow'),
        onClick: (event) => { event.stopPropagation() },
        onChange: (event) => {
          if (props.onCheckedChange !== undefined) props.onCheckedChange(event.target.checked)
        },
        style: {
          width: 14, height: 14, margin: 0, flexShrink: 0, cursor: 'pointer',
          accentColor: 'var(--dsh-color-accent, #6ea8fe)',
        },
      }),
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
        h('div', { style: { fontSize: 12, color: COLORS.textMuted, marginTop: 3 } }, props.subtitle)),
      props.actions.length === 0
        ? null
        : h('div', {
          // Keeping the buttons out of the row's toggle keeps a click on them single-purpose.
          onClick: (event) => { event.stopPropagation() },
          style: { display: 'flex', gap: 8, flexShrink: 0 },
        }, props.actions)),
      props.expanded
        ? h('div', {
          style: {
            padding: '0 24px 14px',
            display: 'grid', gridTemplateColumns: '96px 1fr', gap: '6px 16px',
            fontSize: 12, lineHeight: '18px', color: COLORS.textMuted,
          },
        },
        detail.map(([label, value]) => h(React.Fragment, { key: label },
          h('div', { style: { color: COLORS.textMuted } }, label),
          h('div', { style: { color: COLORS.text, wordBreak: 'break-all' } }, value))))
        : null)
    }

    /** One segment of the header switcher. */
    function Segment(props) {
      return h('button', {
        type: 'button',
        onClick: props.onSelect,
        'aria-pressed': props.active,
        style: {
          padding: '5px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 13, lineHeight: '18px', border: `1px solid ${props.active ? COLORS.border : 'transparent'}`,
          background: props.active ? COLORS.surfaceHover : 'transparent',
          color: props.active ? COLORS.text : COLORS.textMuted,
          fontWeight: props.active ? 600 : 400,
        },
      }, props.label, props.count === undefined ? null : h('span', {
        style: { marginLeft: 6, fontSize: 12, color: COLORS.textMuted, fontWeight: 400 },
      }, String(props.count)))
    }

    /** The recycle bin page: the bin and archived segments. */
    function TrashPage() {
      const [tab, setTab] = React.useState('trash')
      const [entries, setEntries] = React.useState([])
      const [archived, setArchived] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [busyId, setBusyId] = React.useState('')
      const [expandedId, setExpandedId] = React.useState('')
      const [selectedIds, setSelectedIds] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [sort, setSort] = React.useState('time')
      const [selectedId, setSelectedId] = React.useState('')
      // Wide enough for a list + detail split; narrow keeps the inline expansion.
      const [wide, setWide] = React.useState(() => typeof window !== 'undefined' && window.innerWidth >= 980)

      React.useEffect(() => {
        const onResize = () => { setWide(window.innerWidth >= 980) }
        window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('resize', onResize) }
      }, [])

      // Keep a selection alive across reloads, and pick the first row when the
      // split appears so the right half is never an empty surprise. Declared
      // before any early return so the hook order never changes.
      React.useEffect(() => {
        if (!wide) return
        const list = tab === 'trash' ? entries : archived
        if (selectedId !== '' && list.some(entry => entry.sessionId === selectedId)) return
        setSelectedId(list[0]?.sessionId ?? '')
      }, [wide, entries, archived, tab, selectedId])

      const reload = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const [bin, arch] = await Promise.all([
            callHost('sessionTrash/list', {}),
            callHost('sessionTrash/listArchived', {}),
          ])
          // The Host answers with the array itself; tolerate a wrapped shape too.
          setEntries(Array.isArray(bin) ? bin : (Array.isArray(bin?.entries) ? bin.entries : []))
          setArchived(Array.isArray(arch) ? arch : (Array.isArray(arch?.entries) ? arch.entries : []))
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setEntries([])
          setArchived([])
        } finally {
          setLoading(false)
        }
      }, [])

      // Read on mount, then follow the Host's own Session events and the window's
      // focus, so a Session deleted from the sidebar shows up without pressing
      // refresh. The events are the same forwarded ones the sidebar list applies.
      React.useEffect(() => {
        void reload()
        const remote = typeof pluginContext.get === 'function' ? pluginContext.get('remote') : undefined
        const disposers = []
        try {
          disposers.push(remote?.$on?.('api-session/removed', () => { void reload() }))
          disposers.push(remote?.$on?.('api-session/added', () => { void reload() }))
        } catch {
          // Forwarded events unavailable in this composition; focus still refreshes.
        }
        const refresh = () => { void reload() }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              // Already released.
            }
          }
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
        }
      }, [reload])

      /** Run one row action with busy locking and a reload afterwards. */
      const run = async (entry, action) => {
        if (busyId !== '') return
        setBusyId(entry.sessionId)
        try {
          await action(entry)
          await reload()
        } catch (reason) {
          void showNotice({ title: tr('action.failed'), message: reason instanceof Error ? reason.message : String(reason) })
        } finally {
          setBusyId('')
        }
      }

      const restore = (entry) => run(entry, async () => {
        const result = await callHost('sessionTrash/restore', { sessionKey: entry.sessionId })
        if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
          void showNotice({ title: tr('restore.warn'), message: result.warnings.join('\n') })
        }
      })

      const purge = async (entry) => {
        const confirmed = await askConfirm({
          title: tr('purge.title'),
          message: tr('purge.body', { name: nameOf(entry), size: formatSize(entry.bytes) }),
          confirmLabel: tr('purge.action'),
          danger: true,
          hint: tr('purge.hint'),
        })
        if (!confirmed) return
        await run(entry, async () => {
          await callHost('sessionTrash/purge', { sessionKey: entry.sessionId })
        })
      }

      const unarchive = (entry) => run(entry, async () => {
        await callHost('sessionTrash/unarchive', { sessionKey: entry.sessionId })
      })

      const moveToBin = async (entry) => {
        const confirmed = await askConfirm({
          title: tr('archive.title'),
          message: tr('archive.body', { name: nameOf(entry) }),
          confirmLabel: tr('action.moveToBin'),
        })
        if (!confirmed) return
        await run(entry, async () => {
          try {
            await callHost('sessionTrash/delete', { sessionKey: entry.sessionId, stopRunning: false })
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason)
            if (!/still has work running/.test(message)) throw reason
            const stop = await askConfirm({ title: tr('busy.title'), message, confirmLabel: tr('busy.action'), danger: true })
            if (!stop) return
            await callHost('sessionTrash/delete', { sessionKey: entry.sessionId, stopRunning: true })
          }
        })
      }

      const binBytes = entries.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)

      /** Group rows by the project directory they came from. */
      const groupByCwd = (list) => {
        const groups = new Map()
        for (const entry of list) {
          const key = typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : tr('group.unknownDir')
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(entry)
        }
        return [...groups.entries()]
      }

      const header = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 24px 14px', borderBottom: `1px solid ${COLORS.borderSubtle}`,
        },
      },
      h(UiSegments, {
        id: 'session-trash-tabs',
        value: tab,
        options: [
          { value: 'trash', label: `${tr('tab.trash')} ${entries.length}` },
          { value: 'archive', label: `${tr('tab.archive')} ${archived.length}` },
        ],
        onChange: (next) => { setTab(next) },
      }),
      h('div', { style: { flex: 1 } }),
      h('span', { style: { fontSize: 12, color: COLORS.textMuted } },
        loading ? tr('header.loading') : (tab === 'trash' ? tr('header.binStats', { count: entries.length, size: formatSize(binBytes) }) : tr('header.archiveStats', { count: archived.length }))),
      h(UiButton, { label: tr('header.refresh'), variant: 'ghost', disabled: loading, onClick: () => { void reload() } }))

      if (error !== '') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } },
          header,
          h('p', { style: { color: COLORS.danger, fontSize: 13, padding: '24px' } }, tr('header.readFailed', { message: error })))
      }

      /** Facts shown in a row's inline expansion and in the wide detail pane. */
      const detailPairs = (entry) => (tab === 'trash'
        ? [
          [tr('detail.sessionId'), entry.sessionId],
          [tr('detail.cwd'), entry.cwd || ''],
          [tr('detail.workspace'), entry.workspaceTitle || ''],
          [tr('detail.createdAt'), formatEpoch(entry.createdAt)],
          [tr('detail.lastPromptAt'), formatEpoch(entry.lastPromptAt)],
          [tr('detail.turns'), typeof entry.turns === 'number' && entry.turns > 0 ? String(entry.turns) : ''],
          [tr('detail.model'), entry.model || ''],
          [tr('detail.state'), entry.blank === true ? tr('detail.blank') : ''],
          [tr('detail.tokens'), formatTokens(entry.outputTokens)],
          [tr('detail.deletedAt'), formatTime(entry.deletedAt)],
          [tr('detail.bytes'), formatSize(entry.bytes)],
        ]
        : [
          [tr('detail.sessionId'), entry.sessionId],
          [tr('detail.cwd'), entry.cwd || ''],
          [tr('detail.createdAt'), formatEpoch(entry.createdAt)],
          [tr('detail.lastPromptAt'), formatEpoch(entry.lastPromptAt)],
          [tr('detail.turns'), typeof entry.turns === 'number' && entry.turns > 0 ? String(entry.turns) : ''],
          [tr('detail.model'), entry.model || ''],
          [tr('detail.bytes'), formatSize(entry.bytes)],
          [tr('detail.status'), tr('detail.archived')],
        ]).filter(([, value]) => typeof value === 'string' && value.length > 0)

      /** Wide screens select into the detail pane; narrow ones expand inline. */
      const toggleEntry = (entry) => {
        if (wide) {
          setSelectedId(selectedId === entry.sessionId ? '' : entry.sessionId)
          return
        }
        setExpandedId(expandedId === entry.sessionId ? '' : entry.sessionId)
      }

      const rowFor = (entry) => tab === 'trash'
        ? h(Row, {
          key: entry.sessionId,
          title: nameOf(entry),
          subtitle: [formatTime(entry.deletedAt), formatSize(entry.bytes)].filter(Boolean).join(' · '),
          expanded: !wide && expandedId === entry.sessionId,
          selected: wide && selectedId === entry.sessionId,
          onToggle: () => { toggleEntry(entry) },
          checked: selectedIds.includes(entry.sessionId),
          onCheckedChange: on => { toggleSelected(entry.sessionId, on) },
          detail: [
            [tr('detail.sessionId'), entry.sessionId],
            [tr('detail.cwd'), entry.cwd || ''],
            [tr('detail.workspace'), entry.workspaceTitle || ''],
            [tr('detail.createdAt'), formatEpoch(entry.createdAt)],
            [tr('detail.lastPromptAt'), formatEpoch(entry.lastPromptAt)],
            [tr('detail.turns'), typeof entry.turns === 'number' && entry.turns > 0 ? String(entry.turns) : ''],
            [tr('detail.model'), entry.model || ''],
            [tr('detail.state'), entry.blank === true ? tr('detail.blank') : ''],
            [tr('detail.tokens'), formatTokens(entry.outputTokens)],
            [tr('detail.deletedAt'), formatTime(entry.deletedAt)],
            [tr('detail.bytes'), formatSize(entry.bytes)],
          ].filter(([, value]) => typeof value === 'string' && value.length > 0),
          // In the split layout the detail pane owns the actions, so the row stays
          // clean; without room for a pane the row keeps them.
          actions: wide ? [] : [
            h(IconButton, {
              key: 'restore',
              label: busyId === entry.sessionId ? tr('action.restoreBusy') : tr('action.restore'),
              icon: h(IconRestore),
              onClick: () => { void restore(entry) },
              disabled: busyId !== '',
            }),
            h(IconButton, {
              key: 'purge',
              label: tr('action.purge'),
              icon: h(IconTrash),
              onClick: () => { void purge(entry) },
              danger: true,
              disabled: busyId !== '',
            }),
          ],
        })
        : h(Row, {
          key: entry.sessionId,
          title: nameOf(entry),
          subtitle: formatSize(entry.bytes),
          expanded: !wide && expandedId === entry.sessionId,
          selected: wide && selectedId === entry.sessionId,
          onToggle: () => { toggleEntry(entry) },
          checked: selectedIds.includes(entry.sessionId),
          onCheckedChange: on => { toggleSelected(entry.sessionId, on) },
          detail: [
            [tr('detail.sessionId'), entry.sessionId],
            [tr('detail.cwd'), entry.cwd || ''],
            [tr('detail.createdAt'), formatEpoch(entry.createdAt)],
            [tr('detail.lastPromptAt'), formatEpoch(entry.lastPromptAt)],
            [tr('detail.turns'), typeof entry.turns === 'number' && entry.turns > 0 ? String(entry.turns) : ''],
            [tr('detail.model'), entry.model || ''],
            [tr('detail.bytes'), formatSize(entry.bytes)],
            [tr('detail.status'), tr('detail.archived')],
          ].filter(([, value]) => typeof value === 'string' && value.length > 0),
          // In the split layout the detail pane owns the actions, so the row stays
          // clean; without room for a pane the row keeps them.
          actions: wide ? [] : [
            h(IconButton, {
              key: 'unarchive',
              label: busyId === entry.sessionId ? tr('common.processing') : tr('action.unarchive'),
              icon: h(IconUnarchive),
              onClick: () => { void unarchive(entry) },
              disabled: busyId !== '',
            }),
            h(IconButton, {
              key: 'trash',
              label: tr('action.moveToBin'),
              icon: h(IconTrash),
              onClick: () => { void moveToBin(entry) },
              danger: true,
              disabled: busyId !== '',
            }),
          ],
        })

      const matches = (entry) => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return true
        return [nameOf(entry), entry.sessionId, entry.cwd]
          .some(value => typeof value === 'string' && value.toLowerCase().includes(needle))
      }
      const sortedList = (list) => [...list].sort((left, right) => {
        if (sort === 'size') return (right.bytes ?? 0) - (left.bytes ?? 0)
        const leftKey = tab === 'trash' ? String(left.deletedAt ?? '') : String(left.lastPromptAt ?? 0).padStart(16, '0')
        const rightKey = tab === 'trash' ? String(right.deletedAt ?? '') : String(right.lastPromptAt ?? 0).padStart(16, '0')
        return rightKey.localeCompare(leftKey)
      })
      const activeList = sortedList((tab === 'trash' ? entries : archived).filter(matches))

      /** Add or remove one row from the selection. */
      const toggleSelected = (sessionId, on) => {
        setSelectedIds(previous => (on
          ? [...new Set([...previous, sessionId])]
          : previous.filter(value => value !== sessionId)))
      }

      /** Run one action over the selection, reporting per-id failures. */
      const runBulk = async (action) => {
        const ids = selectedIds.filter(id => activeList.some(entry => entry.sessionId === id))
        if (ids.length === 0) return
        if (action === 'purge') {
          const size = activeList
            .filter(entry => ids.includes(entry.sessionId))
            .reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0)
          const confirmed = await askConfirm({
            title: tr('bulk.purgeTitle', { count: ids.length }),
            message: tr('bulk.purgeBody', { size: formatSize(size) }),
            confirmLabel: tr('purge.action'),
            danger: true,
          })
          if (!confirmed) return
        }
        try {
          const value = await callHost('sessionTrash/batch', { action, sessionKeys: ids })
          const results = Array.isArray(value?.results) ? value.results : []
          const failed = results.filter(result => result.ok !== true)
          setSelectedIds([])
          await reload()
          if (failed.length > 0) {
            void showNotice({
              title: tr('bulk.partial'),
              message: failed.map(result => `${result.sessionId}: ${result.message ?? ''}`).join('\n'),
            })
          }
        } catch (reason) {
          void showNotice({ title: tr('action.failed'), message: reason instanceof Error ? reason.message : String(reason) })
        }
      }

      const bulkBar = selectedIds.length === 0 ? null : h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '8px 24px', borderBottom: `1px solid ${COLORS.borderSubtle}`,
          background: COLORS.surfaceHover,
        },
      },
      h('span', { style: { fontSize: 12, color: COLORS.text, fontWeight: 500 } },
        tr('bulk.selected', { count: selectedIds.length })),
      h(UiButton, {
        label: tr('bulk.selectAll'),
        variant: 'ghost',
        onClick: () => { setSelectedIds(activeList.map(entry => entry.sessionId)) },
      }),
      h(UiButton, { label: tr('bulk.clear'), variant: 'ghost', onClick: () => { setSelectedIds([]) } }),
      h('div', { style: { flex: 1 } }),
      tab === 'trash'
        ? [
          h(UiButton, { key: 'bulk-restore', label: tr('bulk.restore'), onClick: () => { void runBulk('restore') } }),
          h(UiButton, { key: 'bulk-purge', label: tr('bulk.purge'), variant: 'danger', onClick: () => { void runBulk('purge') } }),
        ]
        : [
          h(UiButton, { key: 'bulk-unarchive', label: tr('bulk.unarchive'), onClick: () => { void runBulk('unarchive') } }),
          h(UiButton, { key: 'bulk-trash', label: tr('bulk.trash'), onClick: () => { void runBulk('trash') } }),
        ])
      const groups = groupByCwd(activeList).map(([cwd, list]) => h('section', { key: cwd, style: { paddingTop: 6 } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 24px 6px', fontSize: 12, color: COLORS.textMuted,
          },
        },
        h('span', { style: { color: COLORS.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cwd),
        h('span', null, tr('group.count', { count: list.length }))),
        h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, list.map(rowFor))))

      const emptyCopy = tab === 'trash'
        ? { title: tr('empty.trashTitle'), hint: tr('empty.trashHint') }
        : { title: tr('empty.archiveTitle'), hint: tr('empty.archiveHint') }

      const toolbar = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 24px 12px', borderBottom: `1px solid ${COLORS.borderSubtle}`,
        },
      },
      h('input', {
        value: query,
        onChange: (event) => { setQuery(event.target.value) },
        placeholder: tr('search.placeholder'),
        'aria-label': tr('search.aria'),
        style: {
          flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8,
          border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text,
          fontSize: 13, lineHeight: '18px', fontFamily: 'inherit', outline: 'none',
        },
      }),
      h(UiSegments, {
        id: 'session-trash-sort',
        value: sort,
        options: [
          { value: 'time', label: tr('sort.time') },
          { value: 'size', label: tr('sort.size') },
        ],
        onChange: (next) => { setSort(next) },
      }))

      const body = groups.length === 0
        ? h('div', { style: { padding: '64px 24px', textAlign: 'center', color: COLORS.textMuted } },
          h('div', { style: { fontSize: 14, marginBottom: 6 } }, emptyCopy.title),
          h('div', { style: { fontSize: 12 } }, emptyCopy.hint))
        : groups

      const emptyBinNow = async () => {
        const confirmed = await askConfirm({
          title: tr('clear.title'),
          message: tr('clear.body', { count: entries.length, size: formatSize(binBytes) }),
          confirmLabel: tr('clear.action'),
          danger: true,
          hint: tr('clear.hint'),
        })
        if (!confirmed) return
        try {
          await callHost('sessionTrash/empty', {})
          await reload()
          showToast({ message: tr('clear.done') })
        } catch (reason) {
          void showNotice({ title: tr('clear.failed'), message: reason instanceof Error ? reason.message : String(reason) })
        }
      }

      const footerBar = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
          padding: '10px 24px', borderTop: `1px solid ${COLORS.borderSubtle}`,
        },
      },
      h('span', {
        style: {
          flex: 1, minWidth: 0, fontSize: 12, lineHeight: '18px', color: COLORS.textMuted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      },
      tr('footer.note')),
      tab === 'trash' && entries.length > 0
        ? h(UiButton, { label: tr('clear.button'), variant: 'danger', disabled: busyId !== '', onClick: () => { void emptyBinNow() } })
        : null)

      const selectedEntry = activeList.find(entry => entry.sessionId === selectedId)

      const detailPane = !wide ? null : h('div', {
        style: {
          flex: 1, minWidth: 0, overflowY: 'auto',
          borderLeft: `1px solid ${COLORS.borderSubtle}`, padding: '18px 24px',
        },
      },
      selectedEntry === undefined
        ? h('div', { style: { color: COLORS.textMuted, fontSize: 13, paddingTop: 24 } }, tr('pane.empty'))
        : h(React.Fragment, null,
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4, wordBreak: 'break-word' } }, nameOf(selectedEntry)),
          h('div', { style: { fontSize: 12, color: COLORS.textMuted, marginBottom: 16 } },
            [selectedEntry.cwd, formatSize(selectedEntry.bytes)].filter(Boolean).join(' · ')),
          h('div', {
            style: { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '6px 16px', fontSize: 12, lineHeight: '18px' },
          },
          detailPairs(selectedEntry).map(([label, value]) => h(React.Fragment, { key: label },
            h('div', { style: { color: COLORS.textMuted } }, label),
            h('div', { style: { color: COLORS.text, wordBreak: 'break-all' } }, value)))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 } },
            tab === 'trash'              ? [
                h(IconButton, {
                  key: 'restore',
                  label: busyId !== '' ? tr('common.processing') : tr('action.restore'),
                  icon: h(IconRestore),
                  onClick: () => { void restore(selectedEntry) },
                  disabled: busyId !== '',
                }),
                h(IconButton, {
                  key: 'purge',
                  label: tr('action.purge'),
                  icon: h(IconTrash),
                  onClick: () => { void purge(selectedEntry) },
                  danger: true,
                  disabled: busyId !== '',
                }),
              ]
              : [
                h(IconButton, {
                  key: 'unarchive',
                  label: busyId !== '' ? tr('common.processing') : tr('action.unarchive'),
                  icon: h(IconUnarchive),
                  onClick: () => { void unarchive(selectedEntry) },
                  disabled: busyId !== '',
                }),
                h(IconButton, {
                  key: 'trash',
                  label: tr('action.moveToBin'),
                  icon: h(IconTrash),
                  onClick: () => { void moveToBin(selectedEntry) },
                  danger: true,
                  disabled: busyId !== '',
                }),
              ])))

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } },
        header,
        toolbar,
        bulkBar,
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
          h('div', { style: { flex: wide ? '0 0 54%' : 1, minWidth: 0, overflowY: 'auto' } }, body),
          detailPane),
        footerBar)
    }

    // ---- Session row entry -------------------------------------------------

    /**
     * Move one Session into the bin: confirm, offer stopping running work, then
     * report with an undo. Shared by the row menu contribution.
     * @param sessionId - exact Session id.
     * @param label - display title for the copy.
     */
    async function trashWithFlow(sessionId, label) {
      const confirmed = await askConfirm({
        title: tr('menu.confirmTitle'),
        message: tr('menu.confirmBody', { name: label }),
        confirmLabel: tr('action.moveToBin'),
        hint: tr('menu.confirmHint'),
      })
      if (!confirmed) return

      /** Send one delete request and report it. */
      const move = async (stopRunning) => {
        const result = await callHost('sessionTrash/delete', { sessionKey: String(sessionId), stopRunning })
        if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
          void showNotice({ title: tr('menu.noticeTitle'), message: result.warnings.join('\n') })
        }
        showToast({
          message: tr('menu.toast', { name: label }),
          undo: async () => {
            try {
              await callHost('sessionTrash/restore', { sessionKey: String(sessionId) })
            } catch (reason) {
              void showNotice({ title: tr('menu.undoFailed'), message: reason instanceof Error ? reason.message : String(reason) })
            }
          },
        })
      }

      try {
        try {
          await move(false)
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason)
          if (!/still has work running/.test(message)) throw reason
          const stop = await askConfirm({
            title: tr('busy.title'),
            message,
            confirmLabel: tr('busy.action'),
            danger: true,
          })
          if (!stop) return
          await move(true)
        }
      } catch (reason) {
        void showNotice({ title: tr('menu.failed'), message: reason instanceof Error ? reason.message : String(reason) })
      }
    }

    /** The rail icon for the bin panel. */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7' }),
      h('path', { d: 'M6.5 7l1 12a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l1-12' }),
      h('path', { d: 'M10.5 11v6M13.5 11v6' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginContext = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-trash: dictionaries')
        const bound = ctx.locale.bind(NS)
        tr = (key, params) => (params === undefined ? bound(key) : bound(key, params))

        // Surface registrations first: if the optional menu contribution below
        // fails in a given composition, the panel must still appear.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 31,
          locale: NS,
          label: () => tr('panel.label'),
        }, TrashIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, guarded(TrashPage)))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-trash.dialog',
          locale: NS,
        }, guarded(ConfirmSurface)))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-trash.toast',
          locale: NS,
        }, guarded(ToastSurface)))

        // The structured menu contribution, not the legacy slot: legacy entries
        // always render above Archive, and this action belongs below it. Menu
        // support is optional, so its absence must not keep the plugin pending.
        const menus = typeof ctx.get === 'function' ? ctx.get('contextMenus') : undefined
        if (menus === undefined) {
          console.warn('[session-trash] contextMenus is unavailable; the row menu entry is skipped')
          return
        }
        try {
          ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
            name: 'contextMenu.icon',
            key: 'session-trash.trash',
          }, TrashIcon))
          ctx.effect(() => menus.register({
            id: 'session-trash.trash',
            target: 'session',
            order: 700,
            resolve: ({ sessionId, displayTitle }) => [{
              id: 'trash',
              label: tr('menu.delete'),
              icon: { key: 'session-trash.trash' },
              danger: true,
              separatorBefore: true,
              run: () => { void trashWithFlow(sessionId, displayTitle ?? String(sessionId)) },
            }],
          }), 'session-trash: session menu action')
        } catch (error) {
          console.warn('[session-trash] session menu contribution failed:', error)
        }
      },
    }
  },
})
