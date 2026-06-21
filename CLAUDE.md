# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

「司库」(finance-api) — the NestJS backend for an AI-assisted personal/family finance manager. Pairs with the Flutter client `finance-app`.

## Commands

Package manager is **pnpm** (per README); `npm run <script>` and `npx` also work. The scripts:

```bash
pnpm start:dev          # dev server, watch mode, port 3000 (nest start --watch)
pnpm build              # production build → dist/   (then: node dist/main)
pnpm prisma:migrate     # create+apply migration from schema change (dev)
pnpm prisma:deploy      # apply migrations only (prod / fresh DB)
pnpm prisma:studio      # Prisma Studio DB browser
pnpm test               # Jest unit tests
```

**Correctness gate:** there is **no broad automated test suite**. Validate changes with:
- `npx tsc --noEmit` — the primary type/compile check, run after every change.
- `npx jest` — unit tests; only **pure-logic** modules have `*.spec.ts` (e.g. `src/ai/import-dedup.ts`, `src/ai/gateway-dedup.ts`). Run one suite: `npx jest import-dedup`.
- Manual run against the DB for integration paths.

**Windows gotcha:** stop the running Nest process before `prisma generate` / `prisma:migrate` — a live `node dist/main` locks the generated Prisma client engine and the migration/generate will fail with EPERM. `node dist/main` does **not** hot-reload; rebuild + restart to pick up changes (prefer `start:dev` for watch).

## Environment

`.env` (gitignored) drives config. Key vars: `DATABASE_URL`, `JWT_SECRET`, `SM_KEK` (KEK that wraps users' private-key ciphertext — KMS-style, see encryption note), `PORT`, `CORS_ORIGINS`, and LLM slots `LLM_n_URL`/`LLM_n_KEY`/`LLM_n_MODEL` (+ optional `LLM_n_VISION`) up to 20, with `AI_DEFAULT_TEXT_MODEL`/`AI_DEFAULT_VISION_MODEL`. See `.env.example`.

## Architecture

**Multi-domain NestJS monolith.** Each feature is a module (controller + service) registered in `src/app.module.ts`, sharing one `PrismaService` (`src/prisma/`) and one Postgres DB. The `finance-app` client uses the finance + AI domains; the others back adjacent products in the same app:
- **Finance core:** `auth`, `ledgers` (shared ledgers + invites + members), `accounts`, `categories`, `bills`, `budgets`, `recurring`, `goals`, `insights`, `stats`.
- **AI:** `ai/` — imports, NL parse, chat assistant, monthly report, insights.
- **Adjacent:** `cfo`, `news`, `picks` (stock daily-picks), `loans`, `tools`, `app-update` (client self-update). `common/` shared utils, `crypto/` server-side KEK helpers, `uploads/` static.

The Prisma schema (`prisma/schema.prisma`) therefore mixes finance tables (`Bill`, `Account`, `Category`, `Ledger`, `LedgerMember`, `LedgerInvite`, `Budget`, `RecurringBill`, `SavingsGoal`, `AiImport`, `AiInsightDismissal`) with other domains (`Proposal`, `NewsArticle`, `StockAnalysis`, `Loan`, `StockHolding`, `DailyPick`, …).

### End-to-end encryption is the defining constraint

Sensitive fields are encrypted **on the client** (SM2/SM3/SM4); the server stores only ciphertext and **cannot read them**:
- `Bill.noteCipher` (merchant/note), `Account.nameCipher` (account name), user private-key blobs.
- `SM_KEK` only wraps the user's private-key ciphertext; it does **not** give the server access to ledger data. Per-ledger **DEKs live on the client**; shared-ledger flows re-wrap a ledger's DEK to each member's SM2 pubkey (`ledgers` module, invite/join).

Consequences when writing server code:
- Any matching / dedup / search **must use plaintext columns only**: `amount`, `date`, `type`, `Bill.externalId`, `Bill.source`, foreign-key ids. You cannot match on merchant name or account name server-side — that logic lives in the client.
- `Bill.externalId` (platform order no.) + `Bill.source` (`alipay`/`wechat`/`bank`/`manual`) exist specifically to make dedup possible without reading ciphertext.

### AI import pipeline (`ai/` — the most intricate flow)

Upload → `AiImport` row drives a status machine: `pending → extracting → parsing → dedupping → review_ready → applying → done`/`failed`.
1. **Extract** (`ai/extractors/`, dispatched by file type): `decodeText` auto-detects UTF-8 vs **GB18030/GBK** (支付宝/银行 exports are GBK) via `iconv-lite`. The CSV extractor strips the 支付宝/微信 statement **preamble** (account/summary header block) before parsing, else the real column header is buried and parsing collapses.
2. **Parse** (`ai/llm/`): `llm-registry` loads OpenAI-compatible model slots from env; long text is chunked. `chat.service` runs multi-turn tool-calls (queryStats / manageBudget) for the assistant.
3. **Resolve** `categoryId` server-side against the ledger's categories, falling back to an auto-created "其他".
4. **Dedup** (`import-dedup.ts`): by `externalId` if present, else `date+amount`. Then **gateway cross-source dedup** (`gateway-dedup.ts`): for non-aggregator imports, drop "财付通/支付宝/微信" gateway rows that match an existing `source∈{alipay,wechat}` bill on amount + date (±4d).
5. `draftsJson` holds **transient plaintext** drafts until the client encrypts notes + resolves funding accounts and POSTs `/ai/imports/:id/apply` (which can also create transfers via `accounts.transfer`).

System categories (incl. L1/L2 sub-categories) are seeded in `categories.service` `onModuleInit` — runs **every boot**, idempotent (only inserts missing ones), so adding to the seed list back-fills existing DBs on restart.
