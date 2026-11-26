# dsh-session-trash

Reversible Session deletion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

DSH ships **archive** only: a Session log is an append-only fact record, so the product never deletes one. This plugin adds the deliberate exception — a **recycle bin**. Deleting a Session moves its log directory into the bin, where it can be restored at any time; only an explicit *purge* frees the bytes.

中文说明见下方。

## What it does

- **Delete = move to the bin.** The Session's log directory is renamed into `$DSH_HOME/session-trash/<id>/` — same volume, atomic, no copying.
- **Restore.** The log moves back to its original workspace bucket, the projection cache comes with it, and the Session is reattached to its Workspace (or to “Ungrouped” when that Workspace is gone).
- **Purge.** An explicit, confirmed action that removes the log directory and the bin entry. Irreversible.
- **The live Agent is released.** DSH keeps an opened Session's Agent in the Host process, and only its owner holds the `dispose` capability. This plugin captures those handles by wrapping `ctx.agents.create/resume`, so a deleted Session disappears from every surface instead of lingering as a ghost row.
- **Archived Sessions are first-class.** The panel's second segment lists the archive set and lets you unarchive or move an entry into the bin.
- **Agent tools too:** `trash_session`, `restore_session`, `purge_session`, `list_session_trash`, plus a maintenance tool `purge_orphan_caches` for projection-cache rows whose Session no longer exists.
- **Multi-select.** Every row carries a checkbox; a selection reveals a bulk bar with select-all, clear, and the segment's actions (restore / purge in the bin, unarchive / move to bin in the archive). The Host runs a batch sequentially and reports one outcome per Session, so a single failure does not stop the rest.

## Install

```bash
dsh plugin --profile <profile> add dsh-session-trash
```

Or install a local checkout by pointing at its directory from **Plugins › Add plugin**. A Node-side change needs a Host restart; the browser half reloads with the page.

## Use

- **Session row menu** (⋯) → “Delete”, below “Archive session”. Running work is refused first and offered as “Stop and move”.
- **Left rail → Recycle bin.** Two segments, grouped by project, with a search box and sorting by time or size. The split layout shows the selected Session's facts on the right; narrow windows fall back to inline expansion.
- **Undo.** The toast after a deletion restores the Session in one click.

## Where the data lives

```
$DSH_HOME/session-trash/
├─ index.json                      manifest: id, original bucket, cwd, title, facts
└─ session-<id>/
   ├─ session.v4.jsonl.zstd        the untouched log
   └─ .projcache.json              the parked projection cache (restored with it)
```

The bin **never expires on its own**; releasing the space is an explicit action. Because the log is stored untouched, you can also recover a Session by hand: move the directory back under `$DSH_HOME/sessions/<bucket>/`.

## Safety notes

- A Session that still runs work is not moved until you confirm stopping it; this plugin does not stop work on its own.
- Deleting the Session you are running a tool call from is refused.
- Subagent Sessions are **not** cascaded: a parent with children reports how many children remain instead of silently orphaning them.
- Attachments under `$DSH_HOME/attachments/` are not garbage-collected by a purge.

## Compatibility

- `engines.dsh`: `>=0.2.0 <0.3.0-0`; developed and tested against DSH **0.2.2-rc.5**.
- Depends on the default JSONL persistence layout (`sessions/`, `storages/session_projcache/`). Other storage backends keep the accounting half working but need the file half reworked.
- The Remote endpoint is published through live Service markers (the gateway's “SRC” mode) and called over the page's own `/api` carrier, so no generated Typert artifact is involved.
- UI text is localized (zh / en) through the Client locale service; the plugin page's title and description come from `locale/*.json`.

## Development

```bash
# regression harness: runs the whole flow against a throwaway DSH_HOME
ELECTRON_RUN_AS_NODE=1 "<dsh executable>" ./test/trash.test.mjs
```

The harness drives the very tool definitions the Host registers, so a change to the move/restore/purge order or the on-disk layout fails there instead of in someone's sidebar. It covers: empty bin → move (log + parked cache + facts) → listing → ghost-row self-heal → restore → purge.

## License

MIT. See [LICENSE](LICENSE).

---

# 会话回收站

DSH 只提供归档，不提供删除：会话日志是只追加的事实记录。本插件补上刻意的例外 —— **回收站**。删除即把日志目录搬进回收站，随时可以恢复；只有显式的「彻底删除」才真正释放空间。

- **删除 = 进回收站**：整目录 rename 到 `$DSH_HOME/session-trash/<id>/`，同卷原子，不复制字节
- **恢复**：搬回原工作区桶，投影缓存一起回来，并重新挂到原工作区（工作区没了就归「未分组」）
- **彻底删除**：显式确认后删除日志目录与清单条目，不可逆
- **释放内存里的 Agent**：DSH 把打开过的会话的 Agent 留在 Host 进程里，`dispose` 只属于它的所有者；本插件包一层 `ctx.agents.create/resume` 记录句柄，删除时调用，所以不会留下"删了还在"的鬼影行
- **归档也是一等公民**：面板第二段列出归档会话，可取消归档或移入回收站
- **多选**：每行带复选框，选中后出现批量条（全选 / 取消选择 / 该段的动作）；Host 顺序执行并逐条回报结果，单条失败不影响其余
- **工具**：`trash_session`、`restore_session`、`purge_session`、`list_session_trash`，以及维护用的 `purge_orphan_caches`

数据在 `$DSH_HOME/session-trash/`，**永不自动过期**。日志原样保存，也可以手动搬回 `sessions/` 恢复。

界面文案中英双语，跟随宿主语言。
