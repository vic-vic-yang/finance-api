# 司库 · 后端 (finance-api)

「司库」是一款 AI 加持的个人 / 家庭财务管家，支持共享账本、端到端加密、AI 智能导入、私人 CFO 助手、每周管家简报、财务健康评分、现金流预测、股票分析、财务工具箱，并为客户端提供自助升级。本仓库是其 **NestJS 后端**。

前端仓库：[finance-app](https://github.com/vic-vic-yang/finance-app)（Flutter）。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 20+ |
| 框架 | NestJS 10 (TypeScript) + Express |
| 数据库 | PostgreSQL 18 |
| ORM | Prisma 5 |
| 包管理 | pnpm 10 |
| 国密加密 | SM2 / SM3 / SM4（`sm-crypto`） |
| 定时任务 | `@nestjs/schedule`（每周管家简报 + CFO 主动扫描） |

## 快速开始

```bash
pnpm install                 # 安装依赖
cp .env.example .env         # 配置环境变量（见下）
pnpm prisma:deploy           # 按迁移建表（或 pnpm prisma:migrate 开发态）
pnpm start:dev               # 开发服务器（watch，端口 3000）
```

生产：`pnpm build` → `node dist/main`。

> Windows 提示：跑 `prisma generate` / `prisma:migrate` 前先停掉 NestJS 进程，否则 Prisma 无法覆盖被占用的生成文件。

### 常用命令

```bash
pnpm start:dev          # 开发（热重载）
pnpm build              # 生产构建 -> dist/
pnpm prisma:migrate     # 从 schema 变更生成并应用迁移（开发）
pnpm prisma:deploy      # 仅应用迁移（生产）
pnpm prisma:studio      # 打开 Prisma Studio
pnpm test               # 单元测试（Jest）
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | JWT 签名密钥 |
| `SM_KEK` | KMS 主密钥（加密用户私钥密文的密钥加密密钥） |
| `PORT` | 监听端口，默认 `3000` |
| `CORS_ORIGINS` | 允许的跨域来源（逗号分隔） |
| `LLM_n_URL` / `LLM_n_KEY` / `LLM_n_MODEL` | 第 n 个 LLM 槽位（OpenAI 兼容），最多 20 个 |
| `LLM_n_VISION` | 可选，覆盖视觉能力自动识别 |
| `AI_DEFAULT_TEXT_MODEL` / `AI_DEFAULT_VISION_MODEL` | 默认文本 / 视觉模型 |
| `LLM_CONFIG_SECRET` | 账本共享 LLM Key 的加密密钥（缺省回落 `JWT_SECRET`） |

> `.env` / `.env.local` 已被 `.gitignore`，**切勿提交密钥**。LLM 槽位示例见 `.env.example`。

## 架构

所有路由前缀 `/api`，RESTful，JWT 鉴权（升级接口除外），数据按用户「当前选中账本」隔离。

```
src/
├── auth/        注册 / 登录 / JWT / 改密 / 恢复码找回 / 资料
├── ledgers/     多账本 CRUD、邀请、成员、DEK 分发
├── accounts/    账户 CRUD、转账（原子事务）、余额校准
├── bills/       账单 CRUD（分页 / 多条件筛选）
├── budgets/     预算 CRUD + 已用 / 剩余计算
├── categories/  系统分类（启动播种）+ 账本自定义分类
├── stats/       收支汇总 + 分类占比
├── goals/       储蓄目标
├── ai/          AI 导入 + 对话助手（提取 → LLM 解析 → 去重 → 客户端应用）
│   └── llm/     OpenAI 兼容客户端 + 槽位注册中心（ai/cfo/tools/briefing 共用）
├── cfo/         私人 CFO：纯函数检测器 → 提议 → 审批 → 执行 → 学习
├── recurring/   周期账单 / 订阅管家（按需补算，无 cron）
├── insights/    AI 消费洞察
├── loans/       借贷往来（借出 / 借入 + 还款记录）
├── admin/       管理后台 API（用户 / VIP / 角色 / 概览）
├── uploads/     通用文件上传（凭证、图标等）
├── forecast/    现金流预测
├── notifications/ 通知中心 + CFO 主动扫描（每日 cron）
├── reconcile/   对账中心（四项一致性检查，只读报告）
├── health/      财务健康评分
├── briefing/    每周管家简报（周一 cron）
├── tools/       工具：汇率换算代理；股票分析（行情 / 基本面 / 评级 / 持仓 / AI 建议）
├── app-update/  App 自助升级：版本查询 + APK 下载（热读 app-release/）
├── crypto/      SM2/SM3/SM4 实现 + KMS
└── prisma/      Prisma 连接服务
```

### 端到端加密

敏感字段（账户名、账单备注）端到端加密，服务端只见密文：每用户 SM2 密钥对（私钥用密码 / 恢复码加密上传）+ 每账本 SM4 DEK（信封加密分发，服务端不见明文 DEK），对称加密用 SM4-CBC + SM3-HMAC。

### 私人 CFO

审批制财务 agent：检测器（纯函数，仅读 amount/date/categoryId/balance 等**明文**字段，结构性保证不碰加密 note/name）产出提议 → 用户确认 → 服务端执行 / 客户端补密文 → 学习（忽略多次则静音）。惰性按需生成，不用 cron。

### 每周管家简报与定时任务

- **CFO 主动扫描**（`notifications/proactive-scan.service.ts`）：每日 08:17 cron 对「近 30 天有记账」用户的账本跑检测器，新建 critical / warning 提案写入通知中心。
- **每周管家简报**（`briefing/briefing.scheduler.ts`）：每周一 08:37 cron 对「近 14 天有记账且开启简报」的用户生成上周周报（聚合事实 + LLM 正文，失败降级模板），写入通知中心。

### 股票分析 (`src/tools/stock.service.ts`)

- 行情 / 基本面 / 分析师评级走 Yahoo Finance（免 key，crumb 流程）；中文名经 LLM 转 ticker。
- **A 股 / 港股新闻走东方财富按个股流，美股走 Yahoo 按公司名** + LLM 相关性过滤。
- 结构化 AI 分析（公司简介 / 市场动态 / 评级 / 买入建议），结合用户**持仓**与上次快照做对比。
- `StockAnalysis`（查询历史快照）+ `StockHolding`（持仓）两表。

### App 自助升级 (`src/app-update/`)

- 公开接口（免登录）：`GET /api/app/version`（最新版本）、`GET /api/app/download`（下载 APK）。
- 热读 `backend/app-release/version.json` 与 APK。仓库根目录 `发布新版.bat` 只负责本地打包，随后由 Admin「发版管理」上传并原子发布，**发版无需重启后端**。

服务部署可运行仓库根目录 `部署服务.bat`，交互选择仅部署 API、仅部署 Admin、全部部署或仅执行数据库迁移；也可传 `api`、`admin`、`all`、`migrate` 参数。

## 数据库约定

- 金额 / 余额用 `Decimal(15,2)`，算术务必 `new Prisma.Decimal()`，禁用原生浮点。
- 改 schema：编辑 `prisma/schema.prisma` → `pnpm prisma:migrate`。
- 转账以两条 `isTransfer=true` 账单体现（转出 expense + 转入 income），所有收支求和处都过滤 `isTransfer:false`。

## 公网访问

通过 Cloudflare Tunnel 暴露：`手机 → 边缘域名 → Tunnel → 本机 :3000`。
# Admin 自动发版配置

管理后台发版需要在后端 `.env` 配置 `GITHUB_RELEASE_TOKEN`，并在 `finance-app` GitHub 仓库配置以下 Actions Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_SIGN_SHA256`
- `ECS_DEPLOY_HOST`
- `ECS_DEPLOY_USER`
- `ECS_DEPLOY_SSH_KEY`

ECS 首次部署时使用 `deploy/scripts/install-release-user.sh` 创建受限账号，再把 `deploy/nginx/admin-location.conf.example` 合并到站点配置。Admin 通过 `docker compose up -d --build admin` 启动，并仅绑定 `127.0.0.1:3001`。
