# 财记 · 后端 (finance-api)

「财记」是一款个人 / 家庭记账应用，支持共享账本、端到端加密、AI 智能导入、私人 CFO 助手、财经资讯与财务工具。本仓库是其 **NestJS 后端**。

前端仓库：[finance-app](https://github.com/vic-vic-yang/finance-app)（Flutter）。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 20+（开发用 24） |
| 框架 | NestJS 10 (TypeScript) + Express |
| 数据库 | PostgreSQL 18 |
| ORM | Prisma 5 |
| 包管理 | pnpm 10 |
| 国密加密 | SM2 / SM3 / SM4（`sm-crypto`） |
| 定时任务 | `@nestjs/schedule` |
| 资讯抓取 | `rss-parser` |

## 快速开始

```bash
pnpm install                 # 安装依赖
cp .env.example .env         # 配置环境变量（见下）
pnpm prisma:deploy           # 按迁移建表（或 pnpm prisma:migrate 开发态）
pnpm start:dev               # 开发服务器（watch，端口 3000）
```

生产：

```bash
pnpm build                   # 编译到 dist/
node dist/main               # 运行
```

> Windows 提示：跑 `prisma generate` / `prisma:migrate` 前先停掉 NestJS 进程，否则 Prisma 无法覆盖被占用的生成文件。

### 常用命令

```bash
pnpm start:dev          # 开发（热重载）
pnpm build              # 生产构建 -> dist/
pnpm prisma:migrate     # 从 schema 变更生成并应用迁移（开发）
pnpm prisma:deploy      # 仅应用迁移（生产，不新建）
pnpm prisma:studio      # 打开 Prisma Studio
pnpm test               # 单元测试（Jest）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串，如 `postgresql://user:pwd@localhost:5432/finance` |
| `JWT_SECRET` | JWT 签名密钥 |
| `SM_KEK` | KMS 主密钥（加密用户私钥密文的密钥加密密钥） |
| `PORT` | 监听端口，默认 `3000` |
| `CORS_ORIGINS` | 允许的跨域来源（逗号分隔） |
| `LLM_n_URL` / `LLM_n_KEY` / `LLM_n_MODEL` | 第 n 个 LLM 槽位（OpenAI 兼容），最多 20 个 |
| `LLM_n_VISION` | 可选，`true/false` 覆盖视觉能力自动识别 |
| `AI_DEFAULT_TEXT_MODEL` / `AI_DEFAULT_VISION_MODEL` | 默认文本 / 视觉模型名 |
| `NEWS_RSS_FEEDS` | 可选，覆盖默认财经 RSS 源列表（逗号分隔） |
| `NEWS_USE_LLM` | 可选，`false` 关闭新闻 LLM 富化（省 token），默认开 |
| `NEWS_ANALYZE_AT_INGEST` | 可选，`false` 关闭入库后全文分析，默认开 |
| `NEWS_ANALYZE_LIMIT` | 可选，每轮补齐全文分析的条数上限，默认 `200` |

> `.env` / `.env.local` 已被 `.gitignore`，**切勿提交密钥**。

### LLM 槽位示例

每个模型 3 行，复制改编号即可加新模型（同一 OpenAI 兼容协议）：

```
LLM_1_URL="https://api.deepseek.com"
LLM_1_KEY="sk-xxx"
LLM_1_MODEL="deepseek-chat"
```

视觉能力按模型名自动识别（含 `vl`/`vision`/`gpt-4o` 等），可用 `LLM_1_VISION` 覆盖。

## 架构

所有路由前缀 `/api`，RESTful 风格，JWT 鉴权，数据按用户「当前选中账本」隔离。

```
src/
├── auth/        注册 / 登录 / JWT / 改密 / 恢复码找回 / 资料
├── ledgers/     多账本 CRUD、邀请、成员、DEK 分发
├── accounts/    账户 CRUD、转账（原子事务）、余额校准
├── bills/       账单 CRUD（分页 / 按日期·类型·分类·账户筛选）
├── budgets/     预算 CRUD + 已用 / 剩余计算
├── categories/  系统分类（启动播种）+ 账本自定义分类
├── stats/       收支汇总 + 分类占比
├── goals/       储蓄目标
├── ai/          AI 导入（上传 → 提取 → LLM 解析 → 去重 → 客户端应用）
│   ├── extractors/  图片 / PDF / CSV / XLSX / 文本 提取器
│   └── llm/         OpenAI 兼容客户端 + 槽位注册中心
├── cfo/         私人 CFO：检测器（纯函数）→ 提议 → 审批 → 执行 → 学习
├── recurring/   周期账单 / 订阅管家
├── insights/    AI 洞察
├── news/        财经资讯 agent（RSS 聚合 + LLM 富化 + 全文要点分析）
├── tools/       工具：汇率换算代理
├── crypto/      SM2/SM3/SM4 实现 + KMS
├── prisma/      Prisma 连接服务
└── common/      全局异常过滤器等
```

### 端到端加密

敏感字段（账户名、账单备注）端到端加密，服务端只见密文：

1. **每用户 SM2 密钥对**：注册时客户端生成，私钥用 KDF(密码) 与 KDF(恢复码) 各加密一份后上传。
2. **每账本 DEK**（SM4-128）：客户端生成，数据到服务端前已加密。
3. **信封加密共享**：新成员入账本时，已有成员客户端用其 SM2 公钥包裹 DEK 上传，服务端不见明文 DEK。
4. **SM4-CBC + SM3-HMAC**（类 AEAD），密文格式 `iv(16) || ciphertext || mac(32)`。

### 私人 CFO

审批制财务 agent：检测器（纯函数，只读 amount/date/categoryId/balance 等**明文**字段，结构性保证不碰加密 note/name）产出提议 → 用户确认 → 服务端执行（调预算 / 改分类 / 删账单 / 转目标）→ 学习（忽略多次则静音）。惰性按需生成，不用 cron。

### 财经资讯 agent

- **源**：18 个 RSS（CNBC / MarketWatch / Yahoo / BBC / 卫报 / TechCrunch / CoinDesk / 36氪 等，`NEWS_RSS_FEEDS` 可覆盖）
- **抓取**：每天 7:00 / 12:00 / 20:00 定时 + 打开页面 >5h 按需补抓 + 启动补抓
- **富化**：LLM 翻译中文标题、一句话摘要、分类（股市 / 政治 / 加密 / 科技 / AI…）、重要性打分
- **全文分析**：扫库补齐——抓原文正文 + LLM 提炼要点（核心概要 + 要点），幂等、重启自愈；看详情时直接读库
- 去重按 url，保留 14 天

主要接口：`GET /api/news`、`GET /api/news/:id`、`POST /api/news/refresh`、`GET /api/tools/exchange-rates`

## 数据库约定

- 金额 / 余额用 `Decimal(15,2)`，算术务必 `new Prisma.Decimal()`，禁用原生浮点。
- 改 schema：编辑 `prisma/schema.prisma` → `pnpm prisma:migrate`。重置（清数据）：`pnpm prisma migrate reset`。
- 转账以两条 `isTransfer=true` 账单体现（转出 expense + 转入 income），所有收支求和处都过滤 `isTransfer:false`。

## 公网访问

通过 Cloudflare Tunnel 暴露，无需开端口 / 公网 IP：`手机 → 边缘域名 → Tunnel → 本机 :3000`。
