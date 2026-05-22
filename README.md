# PaperFeed — 期刊论文桌面推送挂件

像刷小红书一样读论文。自动抓取爱斯维尔 (ScienceDirect) 期刊最新论文，AI 翻译 + 分析，卡片流推送，支持收藏、筛选、AI 对话。

## 功能概览

- **自动抓取**：定时从 ScienceDirect RSS 获取最新论文，CrossRef API 分页补充
- **中英双语**：腾讯云/阿里云机器翻译 + Ollama 本地兜底，自动翻译标题和摘要
- **AI 分析**：DeepSeek 一键概括 + 多轮对话（独立窗口）
- **卡片流推送**：不推送/跳过/收藏/分析，滑动浏览
- **偏好学习**：收藏和列出的论文自动排除，不再重复推送
- **多主题**：6 种配色（深色/亮色/午夜蓝/森林绿/玫瑰金/纸张）
- **可调字体**：13–36px 滑动调节
- **额度管理**：翻译字符限额 + 用量仪表盘，防超额
- **期刊可配**：编辑 `journals.json` 自定义期刊列表

## 系统要求

- Windows 10+ (macOS 理论上可编译但未测试)
- [Node.js](https://nodejs.org/) 18+
- [Ollama](https://ollama.com/)（可选，用于本地翻译兜底）

## 快速开始（开发版）

```bash
# 1. 克隆仓库
git clone https://github.com/你的用户名/paper-feed-widget.git
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
# 安装程序在 release/PaperFeed Setup x.x.x.exe
```

安装后可在设置页填入 API 密钥，或者在安装目录的 `resources/journals.json` 中修改期刊列表。

---

## API 配置

PaperFeed 依赖以下云服务，**至少需要配置其中一项翻译服务才能正常翻译论文**。

### 1. 机器翻译（必选其一）

#### 腾讯云机器翻译（推荐）

- 每月 **500 万字符**免费额度
- [开通服务](https://console.cloud.tencent.com/tmt)
- 创建子用户：[访问管理](https://console.cloud.tencent.com/cam) → 用户 → 新建用户 → **编程访问**
- **必须给子用户配置以下权限**：
  - `QcloudTMTFullAccess`（机器翻译全读写）
  - `QcloudFinanceBillReadOnlyAccess`（费用只读，可选，用于查账单）
- 得到 `SecretId` 和 `SecretKey`
- 在 `.env.local` 中填写 `TENCENT_SECRET_ID` 和 `TENCENT_SECRET_KEY`
- ⚠️ **务必去腾讯云控制台关闭机器翻译后付费**，避免超额欠费

#### 阿里云机器翻译（备用）

- 每月 **100 万字符**免费额度
- [开通服务](https://www.aliyun.com/product/ai/base_alimt)
- 创建 AccessKey：[RAM 访问控制](https://ram.console.aliyun.com/manage/ak)
- **必须给子用户配置以下权限**：
  - `AliyunMTFullAccess`（机器翻译全读写）
- 得到 `AccessKey ID` 和 `AccessKey Secret`
- 在 `.env.local` 中填写 `ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET`

#### Ollama（本地，免费）

- [安装 Ollama](https://ollama.com/) 并拉取模型：`ollama pull gemma3:4b`
- 无需 API Key，但翻译质量低于云服务

### 2. Elsevier ScienceDirect API

- 用于获取论文摘要和元数据
- [申请 API Key](https://dev.elsevier.com/)
- 在 `.env.local` 中填写 `ELSEVIER_API_KEY`

### 3. DeepSeek API（AI 分析）

- 用于文章一键概括和 AI 对话
- [注册并获取 API Key](https://platform.deepseek.com/api_keys)
- 在 `.env.local` 中填写 `DEEPSEEK_API_KEY`
- 在设置页设置本月预算（默认 $2/月），超预算自动暂停

---

## 自定义期刊

编辑项目根目录的 `journals.json`，按以下格式添加或删除期刊：

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

> 目前仅支持 ScienceDirect 平台的 RSS 格式。如需支持其他平台，请在 Issue 中提出。

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
│       ├── recommender.ts # 推荐引擎
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

## 常见问题

**Q: 安装后 APP 打不开？**  
A: 检查是否已安装 VC++ 运行库。如果命令行启动报错，请在终端执行 `chcp 65001 && "C:\Users\你的用户名\AppData\Local\Programs\PaperFeed\PaperFeed.exe"` 查看错误日志。

**Q: 翻译不工作？**  
A: 在设置页确认翻译引擎密钥已填写且未超额。后台会按 腾讯云 → 阿里云 → Ollama 的优先级降级。

**Q: 如何避免超额费用？**  
A: 设置页已预设腾讯云 500 万/阿里云 100 万字符限额，达到 90% 自动暂停。同时建议在云控制台关闭后付费。

## License

MIT
