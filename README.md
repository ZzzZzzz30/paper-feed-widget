# PaperFeed — 期刊与会议论文桌面推送挂件

> 公开发行版：不包含 API 密钥、文章、收藏、笔记或个人配置；新用户首次启动时没有期刊订阅，会议默认均未启用，请在设置中自行添加/勾选。安装到已有 PaperFeed 的电脑仍会保留该电脑原有数据。

像刷小红书一样读论文。自动抓取 ScienceDirect 期刊和学术会议论文，AI 翻译 + 分析，卡片流推送，支持收藏、筛选、AI 对话。

## 功能概览

- **自动抓取**：定时从 ScienceDirect RSS 和 Crossref 获取所选最低出版年份起的期刊论文（默认 2025，可修改）；会议论文由官方目录、OpenReview、Crossref 和 OpenAlex 采集并逐篇去重
- **中英双语**：阿里云机器翻译 + Ollama 本地兜底，自动翻译标题和摘要
- **AI 分析**：DeepSeek 一键概括 + 多轮对话（阅读工作区）
- **卡片流推送**：不推送/收藏/分析，滑动浏览
- **去重过滤**：已收藏或标记为不推送的论文自动排除
- **多主题**：6 种配色（深色/亮色/午夜蓝/森林绿/玫瑰金/纸张）
- **可调字体**：13–36px 滑动调节
- **额度管理**：翻译字符限额 + 用量仪表盘，防超额
- **阅读设置**：最低出版年份可输入并保存，采集、后台翻译和推送使用该范围；修改年份不会删除已有文章。关键词支持逗号或换行分隔，默认留空。
- **文章统计**：手动刷新各来源已入库、已翻译、可推送数量和合计，显示最近更新时间。
- **期刊可配**：输入期刊名称检索并添加，支持 Crossref 收录的期刊

## 系统要求

- Windows 10+ (macOS 理论上可编译但未测试)
- [Node.js](https://nodejs.org/) 18+
- [Ollama](https://ollama.com/)（可选，用于本地翻译兜底）

## 快速开始（开发版）

```bash
# 1. 克隆仓库
git clone https://github.com/ZzzZzzz30/paper-feed-widget.git
cd paper-feed-widget

# 2. 安装依赖
npm install

# 3. 配置 API 密钥
cp .env.example .env.local
# 编辑 .env.local，填入你的 API 密钥（详见下方 API 配置）

# 4. 启动开发模式
npm run dev
```

## 打包安装（生成 .exe）

```bash
npm run build:win
# 安装程序在 release/PaperFeed-Setup-x.x.x.exe
```

安装后可在设置页填入 API 密钥。期刊、文章、收藏、翻译记录和 AI 对话保存在系统用户数据目录，与安装目录分离，重装或应用更新不会清除此数据。

---

## API 配置

PaperFeed 依赖以下云服务，**至少需要配置其中一项翻译服务才能正常翻译论文**。

### 1. 机器翻译（必选其一）

#### 阿里云机器翻译

- 每月 **100 万字符**免费额度
- [开通服务](https://www.aliyun.com/product/ai/base_alimt)
- 创建 AccessKey：[RAM 访问控制](https://ram.console.aliyun.com/manage/ak)
- **必须给子用户配置以下权限**：
  - `AliyunMTFullAccess`（机器翻译全读写）
- 得到 `AccessKey ID` 和 `AccessKey Secret`
- 在 `.env.local` 中填写 `ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET`

#### Ollama（本地，免费）

- [安装 Ollama](https://ollama.com/)，准备名为 `hy-mt-1.8b:latest` 的 HY-MT1.5-1.8B 模型（当前翻译调用使用此本地名称）
- 无需 API Key；在设置中选择 Ollama，或开启云端不可用时自动降级。

### 2. Elsevier ScienceDirect API

- 用于获取论文摘要和元数据
- [申请 API Key](https://dev.elsevier.com/)
- 在 `.env.local` 中填写 `ELSEVIER_API_KEY`

### 3. DeepSeek API（AI 分析）

- 用于文章一键概括和 AI 对话
- [注册并获取 API Key](https://platform.deepseek.com/api_keys)
- 在 `.env.local` 中填写 `DEEPSEEK_API_KEY`
- 调用 token 与本地估算费用会写入 `ai_usage`；当前界面未提供 AI 预算控制，翻译额度与 AI token 费用分别统计

---

## 自定义期刊

设置 → 期刊管理中输入期刊名称，点击“智能添加”。英文全名精确匹配时自动添加；中文名、缩写可使用已配置的 DeepSeek 识别，多个匹配时选择目标期刊。ISSN 来自 Crossref 真实期刊目录，无需手动填写。新安装不再预置期刊，删除全部期刊后也不会恢复默认列表。

也可以编辑项目根目录的 `journals.json`：

```json
[
  {
    "name": "期刊名称",
    "issn": "ISSN号",
    "rssUrl": "https://rss.sciencedirect.com/publication/science/ISSN号"
  }
]
```

**如何找到 RSS URL**：在 [ScienceDirect 期刊主页](https://www.sciencedirect.com/) 搜索期刊 → 点击期刊名 → 页面底部找到 RSS 图标 → 复制链接地址。

> ScienceDirect 期刊使用 RSS + Crossref；其他已登记的期刊使用 Crossref 分页抓取。新增期刊在下一次抓取时生效，无需重启。摘要可用性取决于数据源。

---

## 项目结构

```
paper-feed-widget/
├── electron/              # Electron 主进程
│   ├── main.ts            # 入口
│   ├── window.ts          # 窗口管理
│   ├── preload.ts         # IPC 桥接
│   ├── tray.ts            # 托盘图标
│   └── services/          # 后端服务
│       ├── fetcher.ts     # 文章抓取
│       ├── translator.ts  # 翻译调度
│       ├── translation/   # 翻译实现
│       ├── analysis/      # AI 分析
│       ├── push-manager.ts # 推送队列
│       └── db.ts          # SQLite 数据库
├── src/                   # React 前端
│   ├── components/        # UI 组件
│   ├── store/             # Zustand 状态管理
│   ├── styles/            # Tailwind + 自定义样式
│   └── types/             # TypeScript 类型
├── resources/             # 图标等静态资源
├── journals.json          # 期刊配置
└── .env.example           # 环境变量模板
```

## 数据保留与应用更新

- Windows 安装版数据库位于 `%APPDATA%\PaperFeed\paperfeed.db`。卸载器明确保留应用数据，安装目录可更改而不影响数据库。
- 设置页“数据”可查看当前版本并打开用户数据目录。
- 新版本通过本仓库 GitHub Releases 分发。开发者提交版本标签（例如 `v0.2.0`）后，GitHub Actions 自动构建 Windows 安装包和 `latest.yml` 更新清单。

## 模块说明

### Electron 主进程与窗口

`electron/main.ts` 初始化固定用户数据目录、数据库、桌面窗口、系统托盘、IPC 和后台任务。`window.ts` 创建置顶透明挂件窗口；`analysis-bubble-window.ts` 管理独立 AI 对话窗口；`tray.ts` 提供托盘菜单。

### React 界面与状态

`src/App.tsx` 根据 Zustand 状态切换推送、收藏和设置视图。`WidgetWindow.tsx` 恢复持久化的推送位置并按需补充队列；`CardStack.tsx` 处理收藏、不推送及分析操作；`ArticleCard.tsx` 显示论文标题、摘要和 DOI。`BookmarkList.tsx` 管理收藏和已读状态，`SettingsPanel.tsx` 配置密钥、期刊、额度和外观。

### 期刊发现与论文抓取

`src/components/JournalManager.tsx` 只接收期刊名称。`electron/services/journal-discovery.ts` 查询 Crossref 期刊目录，校验 ISSN，并在中文名或缩写输入时调用已配置的 DeepSeek 辅助生成检索词；有歧义时让用户选择候选项。`fetcher.ts` 每六小时从期刊 RSS 抓取最新论文，并以 Crossref ISSN 分页补充论文；每篇文章按 DOI 去重。`conference-fetcher.ts` 定时轮询 CVF、OpenReview、NeurIPS 官方目录及 Crossref/OpenAlex，把会议目录拆成逐篇记录；来源不可用时分别记录错误并允许其他来源继续补充。会议记录按 DOI、来源键和标题/作者匹配去重，无 DOI 论文使用稳定内部键。`abstract-fetcher.ts` 通过 Crossref 补 DOI/摘要，必要时使用 Elsevier API。

### 文章预处理与推送

`precache.ts` 在后台逐篇补全元数据、翻译标题和摘要，将文章标记为可推送、无摘要或失败；后续补到摘要时会重新进入预处理。`refill.ts` 监控可用队列数量并在低于阈值时重新抓取。`push-manager.ts` 只选所选最低出版年份起、可推送、已翻译且未收藏或标记为不推送的文章，按来源轮换，每轮从各个有候选文章的期刊或会议取一篇。会议来源选择和立即同步入口位于“设置 → 会议管理”。

### 数据持久化

`db.ts` 使用 `sql.js` 在应用数据目录读写 `paperfeed.db`。设置和互动立即保存，数据库定时落盘，退出前再保存一次；落盘通过临时文件替换，减少写入中断造成的损坏。`data-directory.ts` 固定安装版目录，并在目标数据库尚不存在时迁移旧目录中的数据库。

### 翻译与额度安全

`translation/service.ts` 按用户选择调用阿里云或 Ollama。阿里云按月统计字符并预占额度，达到停止线时暂停。开启自动降级时，阿里云不可用可尝试 Ollama。

### AI 阅读与历史

`analysis/analysis-service.ts` 使用 DeepSeek 生成论文概括并处理多轮对话；摘要缓存于 `article_ai_summaries`，会话和消息保存到数据库。`AnalysisDialog.tsx` 展示 Markdown 对话，`AnalysisBubblePage.tsx` 运行独立分析窗口页面。

### 安装包构建

`electron-builder.yml` 配置 NSIS 安装包和 GitHub Releases 发布信息；`.github/workflows/release.yml` 按匹配的版本标签自动构建并发布安装器、区块映射和 `latest.yml`。

### 当前功能边界与验证

- 之前清空文章和收藏只执行过一次；安装程序和启动逻辑中没有自动清空订阅或文章的步骤。`journals.json` 的空数组只是新安装的初始状态，已有数据库中的订阅优先。
- 数据保存在本机 Windows 用户目录，当前没有多设备云同步；主动删除用户目录会删除这些数据。
- AI 阅读以标题与摘要为上下文；PDF/图表相关服务保留在代码中，但尚未接入当前主阅读流程。
- 推送关键词默认为空，此时按期刊和会议来源轮换，来源内按入库顺序选取。用户保存关键词后，标题与摘要命中的不同关键词越多越优先，同分按来源轮换，未命中关键词的文章也可推送。新关键词用于后续生成或补充队列。
- 已删除未对接系统启动项的“开机自启动”选项。
- API 密钥通过 Electron safeStorage 加密落盘，旧明文值在启动时迁移；设置页只读取配置状态，可替换或删除密钥。
- 数据库仅在变更后保存，连续更新合并为 750 毫秒空闲后写盘；保留 30 秒脏数据检查与退出/安装更新前保存。

## 常见问题

**Q: 安装后 APP 打不开？**  
A: 检查是否已安装 VC++ 运行库。如果命令行启动报错，请在终端执行 `chcp 65001 && "C:\Users\你的用户名\AppData\Local\Programs\PaperFeed\PaperFeed.exe"` 查看错误日志。

**Q: 翻译不工作？**  
A: 在设置页确认翻译引擎密钥已填写且未超额。默认只使用所选引擎；仅开启“失败时自动降级”后，才按配置尝试其他引擎。

**Q: 如何避免超额费用？**  
A: 设置页已预设阿里云 100 万字符限额，达到 90% 自动暂停。同时建议在云控制台关闭后付费。

## License

MIT
