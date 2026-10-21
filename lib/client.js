/**
 * dsh-outcomes —— 客户端半部（手写，无需构建步骤）。
 *
 * 形态照 `@deepseek-ai/dsh-client-*` 的模块表约定：宿主 Web 端用
 * `window.__ModuleLoader__.load({ id, factory })` 加载，factory 里 `require('react')`
 * （react 是平台种子模块，不是依赖），返回一个 cordis 插件对象 `{ name, inject, apply }`。
 *
 * ⚠️ `id` **必须等于包名** `dsh-outcomes`：宿主按包名索引这条插件，写错不会报错，
 * 只会「设置里根本没有这一节」（详见 docs/CLIENT-HALF.md 第 ⑤ 步）。
 *
 * 它做两件事：在 **设置 → DSH outcomes** 注册一个分节，把清单规模和最近几条摊在应用内；
 * 以及给一个「打开管理页」的入口（宿主路由，同源）。真正的增删改在管理页与 agent 工具里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-outcomes',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 与 `lib/index.js` 的 GUARD_HEADER 必须一致（本节的按钮都是读操作，仅备将来写操作用）。 */
    const GUARD_HEADER = 'x-dsh-outcomes'
    /** 插件路由前缀（与 ROUTE_PREFIX 一致）。 */
    const PREFIX = '/__dsh-outcomes'
    /** 字典命名空间 = 插件名。 */
    const NS = 'dsh-outcomes'

    const zh = {
      'nav.label': '成果清单',
      'section.hint': '最终成果登记在这里：报告、网页、文档、表格、图片、数据表。agent 登记，你在这儿看。',
      'stat.active': '在用',
      'stat.deleted': '已取消登记',
      'stat.missing': '文件不在了',
      'list.title': '最近登记',
      'list.empty': '还没有登记任何成果。',
      'act.refresh': '刷新',
      'act.open': '打开管理页',
      'act.check': '体检（文件还在吗）',
      'busy': '读取中…',
      'status.dir': '数据目录',
      'status.ok': '全部文件都在',
      'status.missing': '{n} 个文件不在了（登记保留）',
      'error.noService': '宿主没有提供该路由（插件可能未启用，或需要重启 DSH）',
      'error.generic': '读取失败：{error}',
    }
    const en = {
      'nav.label': 'Outcomes',
      'section.hint': 'Final deliverables are registered here: reports, pages, documents, sheets, images, datasets. Agents register them; you browse them here.',
      'stat.active': 'Active',
      'stat.deleted': 'Unregistered',
      'stat.missing': 'Files gone',
      'list.title': 'Recently registered',
      'list.empty': 'Nothing registered yet.',
      'act.refresh': 'Refresh',
      'act.open': 'Open manager page',
      'act.check': 'Check files',
      'busy': 'Loading…',
      'status.dir': 'Data directory',
      'status.ok': 'All files are in place',
      'status.missing': '{n} file(s) are gone (registrations kept)',
      'error.noService': 'The host does not serve this route (plugin disabled, or DSH needs a restart)',
      'error.generic': 'Request failed: {error}',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px' },
      hint: { opacity: 0.75, fontSize: '12.5px', lineHeight: 1.5 },
      stats: { display: 'flex', gap: '18px', margin: '2px 0 4px' },
      stat: { display: 'flex', flexDirection: 'column' },
      statN: { fontSize: '20px', fontWeight: 650 },
      statK: { fontSize: '12px', opacity: 0.7 },
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '5px 0', borderBottom: '1px solid rgba(128,128,128,.22)' },
      title: { fontWeight: 550, flex: '1 1 auto', overflowWrap: 'anywhere' },
      meta: { fontSize: '12px', opacity: 0.7, whiteSpace: 'nowrap' },
      actions: { display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' },
      note: { fontSize: '12.5px', marginTop: '4px' },
      warn: { color: 'var(--warning, #b4690e)', fontSize: '12.5px' },
      err: { color: 'var(--danger, #c0392b)', fontSize: '12.5px' },
    }

    function fmt(iso) {
      return String(iso || '').slice(0, 16).replace('T', ' ')
    }

    function OutcomesSection(props) {
      const t = props.t
      const [state, setState] = React.useState({ loading: true, error: null, rows: [], stats: null, check: null })

      function request(path) {
        return fetch(PREFIX + path, { headers: { accept: 'application/json' } }).then(function (res) {
          if (res.status === 404 || res.status === 405) throw new Error('no-service')
          return res.json()
        })
      }

      function refresh() {
        setState(function (prev) { return { ...prev, loading: true, error: null } })
        Promise.all([request('/api/list?state=active&limit=8'), request('/api/status')])
          .then(function ([list, status]) {
            setState({ loading: false, error: null, rows: (list && list.rows) || [], stats: (status && status) || null, check: null })
          })
          .catch(function (error) {
            setState(function (prev) { return { ...prev, loading: false, error: String(error && error.message === 'no-service' ? 'no-service' : (error && error.message) || error) } })
          })
      }

      function check() {
        request('/api/check').then(function (result) {
          setState(function (prev) { return { ...prev, check: result } })
        }).catch(function () { /* 体检失败不覆盖已有视图 */ })
      }

      React.useEffect(function () { refresh() }, [])

      const stats = state.stats || {}
      const children = [
        h('div', { key: 'hint', style: styles.hint }, t('section.hint')),
      ]

      if (state.error) {
        children.push(h('div', { key: 'err', style: styles.err }, state.error === 'no-service' ? t('error.noService') : t('error.generic').replace('{error}', state.error)))
      } else if (state.loading && state.rows.length === 0) {
        children.push(h('div', { key: 'busy', style: styles.hint }, t('busy')))
      } else {
        children.push(h('div', { key: 'stats', style: styles.stats }, [
          h('div', { key: 'a', style: styles.stat }, [h('span', { key: 'n', style: styles.statN }, String(stats.active ?? state.rows.length)), h('span', { key: 'k', style: styles.statK }, t('stat.active'))]),
          h('div', { key: 'd', style: styles.stat }, [h('span', { key: 'n', style: styles.statN }, String(stats.deleted ?? 0)), h('span', { key: 'k', style: styles.statK }, t('stat.deleted'))]),
          h('div', { key: 'm', style: styles.stat }, [h('span', { key: 'n', style: styles.statN }, String(stats.missing ?? 0)), h('span', { key: 'k', style: styles.statK }, t('stat.missing'))]),
        ]))
        children.push(h('div', { key: 'lt', style: styles.hint }, t('list.title')))
        if (state.rows.length === 0) children.push(h('div', { key: 'empty', style: styles.hint }, t('list.empty')))
        else children.push(h('div', { key: 'rows' }, state.rows.map(function (row) {
          const flag = row.missing && row.missing.length ? h('span', { key: 'g', style: styles.warn }, ' ⚠') : null
          const link = h('a', { key: 'l', href: PREFIX + '/file/' + encodeURIComponent(row.id) + '/0', target: '_blank', rel: 'noreferrer' }, row.title)
          return h('div', { key: row.id, style: styles.row }, [
            h('span', { key: 't', style: styles.title }, [link, flag]),
            h('span', { key: 'm', style: styles.meta }, row.kind + ' · ' + fmt(row.at) + (row.by ? ' · ' + row.by : '')),
          ])
        })))
      }

      if (state.check) {
        children.push(h('div', { key: 'check', style: state.check.ok ? styles.hint : styles.warn },
          state.check.ok ? t('status.ok') : t('status.missing').replace('{n}', String(state.check.missing.length))))
      }

      children.push(h('div', { key: 'actions', style: styles.actions }, [
        h('button', { key: 'open', type: 'button', onClick: function () { window.open(PREFIX + '/', '_blank', 'noopener') } }, t('act.open')),
        h('button', { key: 'check', type: 'button', disabled: state.loading, onClick: check }, t('act.check')),
        h('button', { key: 'refresh', type: 'button', disabled: state.loading, onClick: refresh }, t('act.refresh')),
      ]))

      if (stats.dir) children.push(h('div', { key: 'dir', style: styles.hint }, t('status.dir') + '：' + stats.dir))

      return h('div', { style: styles.wrap }, children)
    }

    const plugin = {
      name: 'ui-dsh-outcomes',
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-outcomes: dictionaries')
        } else {
          ctx.locale.register(NS, { zh, en })
        }
        const dispose = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'outcomes',
              // kb-sync 用 90、trust-check 用 80；排到它们后面，避免争位。
              order: 95,
              locale: NS,
              label: () => ctx.locale.bind(NS)('nav.label'),
              inject: () => ({ t: ctx.locale.bind(NS) }),
            },
            OutcomesSection,
          ),
        )
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => dispose, 'dsh-outcomes: settings section')
        }
      },
    }

    // 测试缝：宿主只读 apply / inject，其余字段不影响加载。
    plugin.__internals = { GUARD_HEADER, PREFIX, NS, zh, en, OutcomesSection, fmt }

    return plugin
  },
})
