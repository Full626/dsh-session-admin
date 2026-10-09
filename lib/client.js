/**
 * dsh-session-admin - browser half.
 *
 * A Settings section with two views: the stored sessions (archive / unarchive /
 * move to trash) and the trash itself (restore / purge). All state and every
 * destructive action live in the host half behind /api/dsh-session-admin; this
 * file is only the view.
 *
 * Written as a hand-authored DSH client bundle - the lazy CJS factory the boot
 * loader registers - so no bundler is involved. It depends on nothing but the
 * seeded "react" platform module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-admin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var NS = 'dsh-session-admin'
    var API = '/api/dsh-session-admin'
    var STYLE_ID = 'dsh-session-admin/section.css'
    /** The client context, kept so mutations can ask host-backed stores to re-pull. */
    var clientCtx = null

    var CSS = [
      '.dsa-wrap{display:flex;flex-direction:column;gap:12px;padding:16px 0}',
      '.dsa-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.dsa-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsa-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.dsa-tabs{display:inline-flex;gap:4px;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsa-tab{font:inherit;font-size:13px;line-height:20px;padding:3px 14px;border-radius:999px;cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsa-tab-on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-stroke)}',
      '.dsa-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:999px;cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:transparent}',
      '.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsa-btn:disabled{opacity:.5;cursor:default}',
      '.dsa-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsa-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsa-count{color:var(--dsw-alias-label-caption);font-size:12px;margin-left:auto}',
      '.dsa-table{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
      '.dsa-head,.dsa-row{display:grid;grid-template-columns:32px minmax(0,1fr) 120px 132px 78px;align-items:center;gap:8px;padding:6px 10px}',
      '.dsa-head{color:var(--dsw-alias-label-caption);font-size:12px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsa-row{border-top:.5px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsa-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsa-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsa-dim{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dsa-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;font-size:11px;line-height:16px;',
      'background:var(--dsw-alias-markdown-tag);color:var(--dsw-alias-label-secondary)}',
      '.dsa-tag-live{background:var(--dsw-alias-state-success-tertiary)}',
      '.dsa-empty,.dsa-err{padding:14px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dsa-err{color:var(--dsw-alias-state-error-primary)}',
      '.dsa-confirm{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-state-error-primary);font-size:13px;',
      'color:var(--dsw-alias-label-primary)}',
      '.dsa-ok{font-size:13px;color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-admin'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Call one host API action. */
    function api(action, body) {
      var init = { headers: { accept: 'application/json' } }
      if (body) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(API + '/' + action, init).then(function (res) {
        return res.json().catch(function () { return {} }).then(function (json) {
          if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status))
          return json
        })
      })
    }

    /**
     * Ask the official client stores to re-pull their baseline. A host-side move
     * does not push an update to every list, so the sidebar and the workspace
     * grouping would otherwise keep a trashed row until the app restarted.
     */
    function refreshHost() {
      if (!clientCtx) return
      var names = ['sessions', 'workspaces']
      for (var i = 0; i < names.length; i += 1) {
        try {
          var svc = clientCtx.get(names[i])
          if (svc && typeof svc.refresh === 'function') {
            var r = svc.refresh()
            if (r && typeof r.catch === 'function') r.catch(function () {})
          }
        } catch (error) { /* a missing store must never break the action */ }
      }
    }

    /** DSH generates a conversation title asynchronously, so a fresh one has none yet. */
    function nameOf(title, fallback) {
      return title && title.length > 0 ? title : fallback
    }

    function fmtBytes(n) {
      if (!n) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
      return (n / 1048576).toFixed(1) + ' MB'
    }

    function fmtTime(ms) {
      if (!ms) return '-'
      var d = new Date(ms)
      var two = function (x) { return (x < 10 ? '0' : '') + x }
      return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
    }

    function fmtDay(ms) {
      if (!ms) return '-'
      var d = new Date(ms)
      var left = Math.ceil((ms - Date.now()) / 86400000)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '（剩 ' + left + ' 天）'
    }

    /** The Settings section body. */
    function SessionAdminPage() {
      var statePair = React.useState({
        loading: true,
        error: '',
        sessions: [],
        trash: [],
        pending: [],
        note: '',
        hideEmpty: true,
        view: 'sessions',
        retentionDays: 90,
      })
      var state = statePair[0]
      var setState = statePair[1]
      var selPair = React.useState({})
      var selected = selPair[0]
      var setSelected = selPair[1]
      var confirmPair = React.useState(null)
      var confirming = confirmPair[0]
      var setConfirming = confirmPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var patch = function (fields) {
        setState(function (prev) { return Object.assign({}, prev, fields) })
      }

      var load = React.useCallback(function () {
        patch({ loading: true, error: '' })
        return Promise.all([api('list'), api('trash')]).then(function (both) {
          setState(function () {
            return {
              loading: false, error: '', note: '',
              sessions: both[0].sessions || [], pending: both[0].pending || [],
              trash: both[1].entries || [], retentionDays: both[1].retentionDays || 90,
              hideEmpty: true, view: 'sessions',
            }
          })
          setSelected({})
        }).catch(function (error) {
          patch({ loading: false, error: String(error.message || error) })
        })
      }, [])

      React.useEffect(function () { load() }, [load])

      var sessions = state.sessions
      var trash = state.trash
      var emptyCount = sessions.filter(function (s) { return s.empty }).length
      var shown = state.hideEmpty ? sessions.filter(function (s) { return !s.empty }) : sessions
      var pickedIds = Object.keys(selected).filter(function (id) { return selected[id] })
      var allPicked = shown.length > 0 && shown.every(function (s) { return !!selected[s.id] })

      var toggle = function (id) {
        setSelected(function (prev) { var next = Object.assign({}, prev); next[id] = !next[id]; return next })
      }
      var toggleAll = function () {
        if (allPicked) { setSelected({}); return }
        var next = {}
        shown.forEach(function (s) { next[s.id] = true })
        setSelected(next)
      }

      /** Run one host action, then refresh both our tables and the official stores. */
      var run = function (promise, describe, options) {
        setBusy(true)
        setConfirming(null)
        promise.then(function (data) {
          var text = describe(data)
          var failed = (data.results || []).filter(function (r) { return !r.ok })
          var skipped = failed.filter(function (r) { return r.reason === 'running' })
          var missing = failed.filter(function (r) { return r.reason === 'not-found' })
          if (skipped.length > 0) text += '（' + skipped.length + ' 个正在运行，已跳过）'
          if (missing.length > 0) text += '（' + missing.length + ' 个已不存在）'
          patch({ note: text, error: '' })
          setBusy(false)
          setSelected({})
          load()
          if (!options || options.refreshHost !== false) refreshHost()
        }).catch(function (error) {
          patch({ error: String(error.message || error), note: '' })
          setBusy(false)
        })
      }

      var pendingNote = state.pending.length > 0
        ? '有 ' + state.pending.length + ' 个会话仍在宿主内存中，将在下次启动时移入回收站。'
        : ''

      var sessionRows = shown.map(function (s) {
        return React.createElement('div', { className: 'dsa-row', key: s.id },
          React.createElement('input', { type: 'checkbox', checked: !!selected[s.id], onChange: function () { toggle(s.id) } }),
          React.createElement('div', { className: 'dsa-name', title: s.id },
            nameOf(s.title, '(新会话 · 标题生成中)'),
            s.live ? React.createElement('span', { className: 'dsa-tag dsa-tag-live' }, '内存中') : null,
            s.archived ? React.createElement('span', { className: 'dsa-tag' }, '已归档') : null
          ),
          React.createElement('div', { className: 'dsa-dim' }, String(s.workspace || '').split('\\').pop() || s.workspace || ''),
          React.createElement('div', { className: 'dsa-dim' }, fmtTime(s.modifiedAt)),
          React.createElement('div', { className: 'dsa-dim' }, fmtBytes(s.bytes))
        )
      })

      var trashRows = trash.map(function (t) {
        return React.createElement('div', { className: 'dsa-row', key: t.dirName },
          React.createElement('span', null, ''),
          React.createElement('div', { className: 'dsa-name', title: t.id }, nameOf(t.title, '(未命名会话)')),
          React.createElement('div', { className: 'dsa-dim' }, String(t.workspace || '').split('\\').pop() || ''),
          React.createElement('div', { className: 'dsa-dim', title: '删除时间' }, fmtDay(t.expiresAt)),
          React.createElement('div', { style: { display: 'flex', gap: 4 } },
            React.createElement('button', { className: 'dsa-btn', type: 'button', disabled: busy,
              onClick: function () { run(api('restore', { ids: [t.id] }), function () { return '已恢复 ' + (t.title || t.id) }) } }, '恢复'),
            React.createElement('button', { className: 'dsa-btn dsa-btn-danger', type: 'button', disabled: busy,
              onClick: function () { run(api('purge', { ids: [t.id] }), function () { return '已彻底删除 ' + (t.title || t.id) }, { refreshHost: false }) } }, '清除')
          )
        )
      })

      var tabs = React.createElement('div', { className: 'dsa-tabs' },
        React.createElement('button', {
          className: 'dsa-tab' + (state.view === 'sessions' ? ' dsa-tab-on' : ''), type: 'button',
          onClick: function () { patch({ view: 'sessions', note: '', error: '' }) },
        }, '会话 (' + sessions.length + ')'),
        React.createElement('button', {
          className: 'dsa-tab' + (state.view === 'trash' ? ' dsa-tab-on' : ''), type: 'button',
          onClick: function () { patch({ view: 'trash', note: '', error: '' }) },
        }, '回收站 (' + trash.length + ')')
      )

      var sessionsToolbar = [
        React.createElement('button', { className: 'dsa-btn', type: 'button', key: 'all', disabled: busy || shown.length === 0, onClick: toggleAll },
          allPicked ? '取消全选' : '全选'),
        React.createElement('button', { className: 'dsa-btn', type: 'button', key: 'arch', disabled: busy || pickedIds.length === 0,
          onClick: function () { run(api('archive', { ids: pickedIds }), function () { return '已归档 ' + pickedIds.length + ' 个会话' }) } }, '归档'),
        React.createElement('button', { className: 'dsa-btn', type: 'button', key: 'unarch', disabled: busy || pickedIds.length === 0,
          onClick: function () { run(api('unarchive', { ids: pickedIds }), function () { return '已取消归档 ' + pickedIds.length + ' 个会话' }) } }, '取消归档'),
        React.createElement('button', { className: 'dsa-btn dsa-btn-danger', type: 'button', key: 'del', disabled: busy || pickedIds.length === 0,
          onClick: function () { setConfirming(pickedIds.slice()) } }, '移入回收站'),
        React.createElement('button', { className: 'dsa-btn', type: 'button', key: 'hide', disabled: busy,
          onClick: function () { patch({ hideEmpty: !state.hideEmpty }) } },
          state.hideEmpty ? '显示空会话 (' + emptyCount + ')' : '隐藏空会话'),
        React.createElement('span', { className: 'dsa-count', key: 'count' }, shown.length + ' / ' + sessions.length + ' 个会话，已选 ' + pickedIds.length),
      ]

      var trashToolbar = [
        React.createElement('button', { className: 'dsa-btn', type: 'button', key: 'exp', disabled: busy || trash.length === 0,
          onClick: function () { run(api('purge-expired', {}), function (d) { return '已清理 ' + (d.purged || 0) + ' 个过期条目' }, { refreshHost: false }) } }, '清理过期'),
        React.createElement('span', { className: 'dsa-count', key: 'count' }, '回收站保留 ' + state.retentionDays + ' 天，过期自动清理'),
      ]

      var confirmText = state.view === 'sessions'
        ? '确认把 ' + (confirming ? confirming.length : 0) + ' 个会话移入回收站？可以在回收站里恢复。'
        : ''

      return React.createElement('div', { className: 'dsa-wrap' },
        React.createElement('div', { className: 'dsa-title' }, '会话管理'),
        React.createElement('div', { className: 'dsa-note' },
          '删除是移到回收站（保留 ' + state.retentionDays + ' 天，可恢复），不是直接抹掉。'
          + '「空会话」指开过但从未发过消息的会话（只有权限/沙箱这类引导记录，UI 里那句问候不会落盘）。'),
        tabs,
        React.createElement('div', { className: 'dsa-bar' }, state.view === 'sessions' ? sessionsToolbar : trashToolbar),
        confirming && state.view === 'sessions' ? React.createElement('div', { className: 'dsa-confirm' },
          React.createElement('span', null, confirmText),
          React.createElement('button', { className: 'dsa-btn dsa-btn-danger', type: 'button', disabled: busy,
            onClick: function () { run(api('delete', { ids: confirming }), function () { return '已移入回收站 ' + confirming.length + ' 个会话' }, { refreshHost: false }) } }, '移入回收站'),
          React.createElement('button', { className: 'dsa-btn', type: 'button', disabled: busy, onClick: function () { setConfirming(null) } }, '取消')
        ) : null,
        pendingNote ? React.createElement('div', { className: 'dsa-note' }, pendingNote) : null,
        state.note ? React.createElement('div', { className: 'dsa-ok' }, state.note) : null,
        state.error ? React.createElement('div', { className: 'dsa-err' }, state.error) : null,
        state.loading
          ? React.createElement('div', { className: 'dsa-empty' }, '正在读取…')
          : state.view === 'sessions'
            ? (shown.length === 0
                ? React.createElement('div', { className: 'dsa-empty' }, sessions.length === 0 ? '没有已存储的会话。' : '空会话已隐藏（点上方按钮显示）。')
                : React.createElement('div', { className: 'dsa-table' },
                    React.createElement('div', { className: 'dsa-head' },
                      React.createElement('span', null, ''),
                      React.createElement('span', null, '标题'),
                      React.createElement('span', null, '工作区'),
                      React.createElement('span', null, '最近修改'),
                      React.createElement('span', null, '大小')
                    ),
                    sessionRows
                  ))
            : (trash.length === 0
                ? React.createElement('div', { className: 'dsa-empty' }, '回收站是空的。')
                : React.createElement('div', { className: 'dsa-table' },
                    React.createElement('div', { className: 'dsa-head' },
                      React.createElement('span', null, ''),
                      React.createElement('span', null, '标题'),
                      React.createElement('span', null, '原工作区'),
                      React.createElement('span', null, '过期时间'),
                      React.createElement('span', null, '操作')
                    ),
                    trashRows
                  ))
      )
    }

    /** Client plugin body: put the section into Settings. */
    function apply(ctx) {
      ensureCss()
      clientCtx = ctx
      var slots = ctx.get('slots')
      if (!slots) return
      var locale = ctx.get('locale')
      ctx.effect(function () {
        return locale ? locale.register(NS, { 'settings.label': '会话管理' }) : function () {}
      }, 'dsh-session-admin: locale')
      ctx.effect(function () {
        return slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'dsh-session-admin',
            order: 60,
            label: function () { return '会话管理' },
            locale: NS,
          }, SessionAdminPage)
        })
      }, 'dsh-session-admin: settings section')
    }

    exports.apply = apply
    return module.exports
  },
})
