# 发布到插件市场

DSH **没有官方市场索引**：内置的插件目录只有 `@deepseek-ai/*`。`Discover` 标签页读的是用户自己添加的**格式 1 索引 JSON**。所以"发布"是三件事：发 npm 包、发一份索引、让别人把索引 URL 加进来。

## 0. 先选名字

`dsh-session-trash` 和 `dsh-session-recycle-bin` 在 npm 上都已被占用。建议用你的 npm scope：

```bash
node scripts/prepare-publish.mjs @你的用户名/dsh-session-trash
```

这条命令会同时改三处：`package.json` 的 `name`、`cordis.patch.yml` 里的 `name`、`market/index.json` 里的 `plugins[0].name` —— 三者必须一致，否则装上了但市场页对不上。

## 1. 填真实信息

- `package.json`：`author`、`repository`、`homepage`
- `market/index.json`：`author`、`homepage`、`repository`、每一版的 `publishTimestamp`（**Unix 秒**）
- `locale/*.json` 的 `meta.title` / `meta.description` 已经填好

## 2. 发布 npm 包

```bash
npm publish --access public
```

包里带的是 `index.js`（Host）、`client.js`（浏览器）、`cordis.patch.yml`、`locale/`、`icon.svg`、`docs/`、`README.md`、`LICENSE` —— 由 `package.json` 的 `files` 白名单决定。`market/`、`scripts/`、`test/` 不进包。

## 3. 托管索引

把 `market/index.json` 放到任意 https 静态托管（GitHub Pages、对象存储、自己的域名）。`icon` 字段是**相对索引 URL 解析**的，所以 `icon.svg` 要一起放在同一目录（或者改成绝对 https URL，或 base64 `data:`）。

## 4. 本地校验索引

用 DSH 自带的校验器（`@deepseek-ai/dsh-plugin-market-index`，随安装提供）先跑一遍，避免用户那边整页打不开：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& "D:\DevTools\DeepSeek Harness\DeepSeek Harness.exe" -e @'
const fs = require('node:fs'), path = require('node:path')
const anchor = process.env.DSH_INSTALL_DIR
const pkgPath = require.resolve('@deepseek-ai/dsh-plugin-market-index/package.json', { paths: [anchor] })
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const entry = pkg.exports['.']
const mod = require(path.resolve(path.dirname(pkgPath), typeof entry === 'string' ? entry : entry.default))
const raw = JSON.parse(fs.readFileSync('market/index.json', 'utf8'))
console.log(mod.parseMarketIndex(raw, 'https://example.com/index.json').plugins.length + ' plugin(s) valid')
'@
```

## 5. 让用户装上

1. 安装并启用 **Custom plugin indexes**：`dsh-experimental-plugin-market-bundle`
2. **Plugins › Discover › Add index source** → 填你的索引 URL
3. 搜索标题 → 安装

没有索引也可以直接装：`dsh plugin --profile <profile> add @你/dsh-session-trash`

## 6. 之后的版本

每发一版：改 `package.json` 的 `version` → 在 `market/index.json` 的 `versions` 数组**前面**插一条（`version` 精确 SemVer、`publishTimestamp` 为秒）→ 重新校验 → 重新托管。校验器会按 SemVer 降序排好。

## 索引里的字段速查

| 字段 | 说明 |
|---|---|
| `format` | 必须是 `1` |
| `title` | 必须含 `en`，可以再带 `zh` 等语言 |
| `metadata.categories/labels/sortKeys` | 声明式；插件只能引用已声明的 id |
| `plugins[].name` | npm 包名，索引内唯一 |
| `plugins[].icon` | 相对索引 URL 的路径、绝对 URL，或 base64 `data:`（解码后 ≤ 32 KiB） |
| `versions[]` | 非空、按 SemVer 降序；`source` 为 `{type:'npm'}` 或 `{type:'git',url,commit,path?}` |
| `engines.dsh` | 兼容的 DSH 版本区间，仅作文档性声明 |
