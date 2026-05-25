# 财记 · 数据加密设计文档

> **版本**：v1 · 2026-05  
> **算法栈**：全国密 SM2 / SM3 / SM4  
> **架构**：端到端（E2E）+ 信封加密（Envelope）  
> **合规目标**：密码法 / PIPL / 数据安全法 / 等保 2.0 三级

---

## 目录

- [1. 设计目标](#1-设计目标)
- [2. 威胁模型](#2-威胁模型)
- [3. 算法选型](#3-算法选型)
- [4. 三层密钥架构](#4-三层密钥架构)
- [5. 加密字段清单](#5-加密字段清单)
- [6. 数据库 schema](#6-数据库-schema)
- [7. 核心流程](#7-核心流程)
  - [7.1 注册](#71-注册)
  - [7.2 登录](#72-登录)
  - [7.3 创建账本](#73-创建账本)
  - [7.4 邀请新成员（信封加密）](#74-邀请新成员信封加密)
  - [7.5 记账单 / 加密字段](#75-记账单--加密字段)
  - [7.6 忘记密码（恢复码）](#76-忘记密码恢复码)
- [8. API 契约](#8-api-契约)
- [9. 后端实现](#9-后端实现)
- [10. 客户端实现](#10-客户端实现)
- [11. 密钥轮换](#11-密钥轮换)
- [12. 合规对照](#12-合规对照)
- [13. 部署 & 运维](#13-部署--运维)
- [14. 已知限制 & 未来工作](#14-已知限制--未来工作)
- [附录 A：SM4-AEAD 自封格式](#附录-asm4-aead-自封格式)
- [附录 B：服务端永不接触的数据清单](#附录-b服务端永不接触的数据清单)

---

## 1. 设计目标

| 目标 | 优先级 | 验收 |
|---|---|---|
| **服务端永不持有用户私钥** | P0 | DB 被脱库，攻击者也解不开 |
| **同账本下其他成员能解密共享数据** | P0 | Alice 记的账，Bob 能看到 |
| **服务端永不持有 DEK** | P0 | 共享账本数据对服务端不可读 |
| **忘记密码可以找回数据** | P1 | 用 24 位恢复码恢复 |
| **合规商用密码（GM SM 系列）** | P0 | 等保测评 / 密码法合规 |
| **金额可服务端聚合（预算、统计）** | P1 | amount / balance 不字段级加密 |
| **不依赖任何在线状态的"自动 wrap"** | P2 | 邀请人不在线也能加入（pending） |

非目标：
- 反"邀请人 + 服务端串谋"威胁（共享账本本质上需要信任邀请人）
- 反"用户密码极弱被暴力破解"（依赖密码强度 + PBKDF2 慢化）
- 字段级加密金额（牺牲服务端聚合能力换不来多少安全收益）

---

## 2. 威胁模型

| 攻击者 | 能做什么 | 我们的防御 |
|---|---|---|
| **外部攻击者** 拿到 DB 副本 | 看到全部密文、密文长度、记录数 | 字段级 SM4 加密 + PBKDF2 慢化 |
| **外部攻击者** 拿到一台后端服务器 | 上述 + 看到内存里短期 KEK | KEK 仅用于包装短密钥；用户 priv 永不入服务端内存 |
| **恶意 DBA** | 直接读 DB | 看到的全是密文 |
| **被胁迫的服务端** | 配合监管 | 没有用户 priv，配合不了（除非攻陷 KMS） |
| **中间人** | 截链路流量 | TLS 1.3（可选升级国密 SSL）|
| **同账本其他成员** | 解密共享账本数据 | **设计上就该能看到** —— 这是功能不是漏洞 |
| **被踢出的成员** | 解密旧数据 | DEK 轮换 + 全量重加密（手动触发）|
| **弱密码用户** | 自己被暴力 | PBKDF2 100k 迭代 + 强制复杂度（建议）|
| **用户手机丢失** | 解密用户数据 | 私钥靠密码派生密钥加密；建议 PIN + 生物锁 |

---

## 3. 算法选型

| 用途 | 算法 | 规范 | 参数 |
|---|---|---|---|
| 对称数据加密 | **SM4-CBC + SM3-HMAC** | GM/T 0002-2012 + GM/T 0004-2012 | 密钥 128 bit / IV 128 bit / MAC 256 bit |
| 非对称加密（包装 DEK） | **SM2** | GM/T 0003-2012 | C1C3C2 标准顺序，cipherMode=1 |
| 哈希 | **SM3** | GM/T 0004-2012 | 256 bit 输出 |
| 密钥派生 | **PBKDF2-SM3** | RFC 8018 + SM3 作 PRF | 100,000 迭代 / 16 字节输出 |
| 完整性 MAC | **SM3-HMAC** | RFC 2104 + SM3 | 256 bit 输出 |
| 密码哈希（登录验证） | **bcrypt** | — | cost factor 12 |

**为什么不用 GCM 模式 SM4？**  
`sm-crypto` (Node.js) 和 `dart_sm_new` (Flutter) 都不提供 SM4-GCM。我们自封 **CBC + SM3-HMAC** 实现 AEAD 风格，密文一体打包，两端实现完全一致。

**为什么 bcrypt 不换 SM3？**  
bcrypt 是登录验证用的密码哈希（"你打的密码对吗"），不参与加密。SM 系列没有等价物。bcrypt 跟加密链路解耦，保留。

---

## 4. 三层密钥架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 :  KEK (主密钥, Key Encryption Key)                │
│  ───────────────────────────────────────────────────        │
│  · SM4-128 bit                                              │
│  · 存放：环境变量 SM_KEK（生产环境改为云 KMS / HSM）        │
│  · 用途：只用于包装服务端兜底密钥；                          │
│         **本架构下用户私钥不用 KEK 包装，所以 KEK 现阶段** │
│         **只是基础设施位**                                   │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                            ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│  Layer 2A :             │   │  Layer 2B :                 │
│  用户 SM2 密钥对        │   │  账本 DEK                   │
│  ─────────────────────  │   │  ────────────────────────   │
│  · 每个用户 1 对        │   │  · 每个账本 1 把            │
│  · 客户端本地生成        │   │  · SM4-128 bit              │
│  · 公钥明文存 DB         │   │  · 客户端本地生成            │
│  · 私钥用 KDF(密码)     │   │  · 用每个成员的公钥 SM2     │
│    + KDF(恢复码) 各加密 │   │    包装一份，存             │
│    一份后存 DB           │   │    ledger_member_keys       │
│  · 服务端永远拿不到      │   │  · 服务端永远拿不到          │
│    私钥明文              │   │    DEK 明文                  │
└─────────────────────────┘   └─────────────────────────────┘
                                            │
                                            ▼
                ┌───────────────────────────────────────────┐
                │  Layer 3 :  业务数据                       │
                │  ────────────────────────────────────     │
                │  · bills.noteCipher   (SM4-CBC+HMAC)      │
                │  · accounts.nameCipher                    │
                │  · 客户端用 DEK 加密 → 服务端只存密文      │
                │  · 客户端用 DEK 解密 → 服务端永不解        │
                └───────────────────────────────────────────┘
```

### 为什么是三层

- **KEK**：保险柜钥匙的钥匙。轮换它只需重新包装少量短密钥，不动业务数据。
- **DEK**：保险柜钥匙。每个账本一把，独立可换。被踢出成员只需轮换 DEK + 重加密。
- **业务数据**：保险柜里的东西。永远只用 DEK 加密，永远不用 KEK 直接加密（KEK 一旦泄露不至于解开所有数据）。

---

## 5. 加密字段清单

| 表 | 字段 | 敏感度 | 是否加密 | 原因 |
|---|---|---|---|---|
| `bills` | `noteCipher` | 高 | ✅ SM4-CBC | 自由文本含人名 / 商家 / 用途 |
| `bills` | `amount` | 高 | ❌ 明文 | 需要服务端 SUM / 预算判定 / 统计图 |
| `bills` | `date / type / categoryId` | 低 | ❌ 明文 | 时间维度查询必须 |
| `accounts` | `nameCipher` | 中 | ✅ SM4-CBC | "老婆的卡"这种标识可能泄露关系 |
| `accounts` | `balance` | 高 | ❌ 明文 | 资产汇总 / 转账 / 自动入账依赖 |
| `accounts` | `creditLimit/loanPrincipal/interestRate` | 中 | ❌ 明文 | 服务端要算还款日提醒 |
| `users` | `password` | 极高 | bcrypt | 仅用于登录验证 |
| `users` | `sm2PrivByPwd / sm2PrivByRecovery` | 极高 | ✅ SM4-CBC | KDF 出的对称密钥加密 |
| `users` | `nickname/username` | 低 | ❌ 明文 | 共享账本要显示"谁记的"|
| `categories` | `name` | 低 | ❌ 明文 | 系统分类全局共享，无需加密 |

**金额为什么不加密？**  
1. 加了就不能 SUM / GROUP BY / 跑预算 / 出统计图，体验直接残废。  
2. 字段级加密的金额仍泄露密文长度（揭示数量级 1/10/100/1000）。  
3. 落盘风险靠 **PostgreSQL TDE + LUKS 磁盘加密** 兜底，已属于等保三级要求。

---

## 6. 数据库 schema

```prisma
model User {
  id              String         @id @default(cuid())
  username        String         @unique
  nickname        String?
  password        String         // bcrypt
  createdAt       DateTime       @default(now())
  currentLedgerId String?

  // ── 国密 SM2 用户密钥对（端到端加密基础） ──────────
  /// SM2 公钥（hex 字符串，未压缩 04|x|y 共 130 char）
  sm2PubKey         String?
  /// SM2 私钥用 KDF(密码) 派生的 SM4 密钥加密后的字节流（iv||ct||mac）
  sm2PrivByPwd      Bytes?
  /// SM2 私钥用 KDF(恢复码) 派生的 SM4 密钥加密后的字节流（找回密钥用）
  sm2PrivByRecovery Bytes?
  /// 派生 KEK 用的 salt（密码 + 恢复码共用同一个 salt）
  kdfSalt           Bytes?
  /// 恢复码 SM3(code || salt) 哈希，用于"忘密码 → 验证恢复码"
  recoveryHash      Bytes?

  ledgerMembers   LedgerMember[]
  ownedAccounts   Account[]      @relation("AccountOwner")
  bills           Bill[]
  // ... (其他关系略)
}

model LedgerMember {
  id        String     @id @default(cuid())
  ledgerId  String
  userId    String
  role      LedgerRole @default(member)
  joinedAt  DateTime   @default(now())

  // ── 信封加密：该账本 DEK 用该成员公钥 SM2 包装后的密文 ──
  /// 包装后的 DEK；新成员通过邀请码加入后此处先为 null，
  /// 由任意已持有 DEK 的在线成员客户端检测到后自动 wrap & 上传
  dekWrapped Bytes?
  /// DEK 版本号，支持密钥轮换（v2 起所有成员需重新 wrap）
  dekVersion Int        @default(1)

  @@unique([ledgerId, userId])
}

model Account {
  id         String      @id @default(cuid())
  ledgerId   String
  ownerId    String?     // null = 共享，非空 = 私人
  /// 账户名密文（iv||ct||mac），服务端永不解
  nameCipher Bytes
  nameDekVer Int         @default(1)
  type       AccountType
  balance    Decimal     @default(0) @db.Decimal(15, 2)
  // ... (信用卡 / 负债等明文配置字段略)
}

model Bill {
  id         String   @id @default(cuid())
  ledgerId   String
  userId     String   // 记账人
  accountId  String
  categoryId String
  type       BillType
  amount     Decimal  @db.Decimal(15, 2)
  /// 备注密文（iv||ct||mac）
  noteCipher Bytes
  /// 加密所用 DEK 版本；0 = 服务端写的"自动入账"系统占位
  noteDekVer Int      @default(1)
  date       DateTime
}
```

详见 `prisma/schema.prisma`。

---

## 7. 核心流程

### 7.1 注册

```
客户端                                          服务端
  │                                                │
  │ 1. 用户输入 username + password                │
  │                                                │
  │ 2. 本地一次性算好密钥包：                     │
  │    ┌─────────────────────────────────────┐   │
  │    │ kp = SM2.generateKeyPair()          │   │
  │    │ recoveryCode = 16 字节随机          │   │
  │    │ salt = 16 字节随机                  │   │
  │    │ kekPwd = PBKDF2_SM3(密码,salt,100k)  │   │
  │    │ kekRec = PBKDF2_SM3(恢复码,salt,100k)│   │
  │    │ privByPwd = SM4(kekPwd, kp.priv)    │   │
  │    │ privByRec = SM4(kekRec, kp.priv)    │   │
  │    │ recoveryHash = SM3(恢复码 ‖ salt)   │   │
  │    │ dek = 16 字节随机                    │   │
  │    │ dekWrapped = SM2(kp.pub, dek)       │   │
  │    └─────────────────────────────────────┘   │
  │                                                │
  │ 3. POST /auth/register                         │
  │    { username, password,                       │
  │      sm2PubKey, sm2PrivByPwd, sm2PrivByRecovery,│
  │      kdfSalt, recoveryHash,                    │
  │      personalLedgerDekWrapped }                │
  │ ──────────────────────────────────────────────▶│
  │                                                │
  │                                       4. bcrypt 哈希密码
  │                                       5. INSERT User (含所有密钥字段)
  │                                       6. createPersonalLedger (含 dekWrapped)
  │                                       7. 发 JWT
  │                                                │
  │ ◀────────────────────────────────────────────  │
  │   { token, user, keyBundle }                  │
  │                                                │
  │ 8. KeyChain.setSelf(pub, priv)（持久化到 Keystore）│
  │ 9. KeyChain.loadDek(personalLedgerId, dek)     │
  │ 10. 弹窗强制让用户保存恢复码                  │
  │ 11. 进入主页                                   │
```

**关键性质**：
- 服务端**只看到密文 + 公钥**，永远拿不到 privKey / DEK / recoveryCode 明文
- recoveryCode 显示一次后客户端就丢掉（除非用户复制保存）
- privKey 写进 Android Keystore / iOS Keychain（设备级加密），下次冷启动免输密码

### 7.2 登录

```
客户端                                          服务端
  │                                                │
  │ 1. POST /auth/login { username, password }     │
  │ ──────────────────────────────────────────────▶│
  │                                                │
  │                                       2. bcrypt.compare(密码)
  │                                       3. SELECT User (含 keyBundle)
  │                                       4. 发 JWT
  │                                                │
  │ ◀────────────────────────────────────────────  │
  │   { token, user,                              │
  │     keyBundle: { sm2PubKey, sm2PrivByPwd,    │
  │                  sm2PrivByRecovery, kdfSalt }}│
  │                                                │
  │ 5. kekPwd = PBKDF2_SM3(密码, kdfSalt, 100k)   │
  │ 6. priv = SM4_decrypt(kekPwd, sm2PrivByPwd)   │
  │ 7. KeyChain.setSelf(pub, priv) → 持久化       │
  │                                                │
  │ 8. GET /ledgers/keys/mine                      │
  │ ──────────────────────────────────────────────▶│
  │                                                │
  │ ◀──── { deks: [{ledgerId, dekWrapped, ver}] } │
  │                                                │
  │ 9. for each: dek = SM2_decrypt(priv, wrapped)  │
  │             KeyChain.loadDek(ledgerId, dek)    │
  │                                                │
  │ 10. unawaited(PendingDekResolver.resolveAll()) │
  │     给自己持有 DEK 的账本里 pending 的人补 wrap │
  │ 11. 进入主页                                   │
```

### 7.3 创建账本

```
客户端                                          服务端
  │                                                │
  │ 1. 本地: pack = KeyChain.newDekForOwner()      │
  │    { dek, dekWrappedBase64, dekVersion=1 }     │
  │                                                │
  │ 2. POST /ledgers                               │
  │    { name, icon?, dekWrapped }                 │
  │ ──────────────────────────────────────────────▶│
  │                                                │
  │                                       3. INSERT Ledger
  │                                       4. INSERT LedgerMember
  │                                          (role=owner, dekWrapped=入参,
  │                                           dekVersion=1)
  │                                                │
  │ ◀────────────────────────────────────────────  │
  │   { ledger, dekWrapped, dekVersion }          │
  │                                                │
  │ 5. KeyChain.loadDek(newId, wrapped)            │
  │    （此时 dek 已在 KeyChain 缓存，可立刻加密数据）│
```

### 7.4 邀请新成员（信封加密）

这是整个架构的"魔法"所在 —— **服务端不持有 DEK，也能把 DEK 安全传递给新成员**。

```
Step 1: Alice 创建邀请码（普通流程，不涉及加密）
  Alice ─POST /ledgers/:id/invite──▶ 服务端生成 6 位 code

Step 2: Bob 用邀请码加入
  Bob ──POST /ledgers/join {code}──▶ 服务端
                                       │
                                       INSERT LedgerMember {
                                         userId: Bob.id,
                                         dekWrapped: null  ← 关键
                                       }
                                       │
                                       ◀── { ledger, pending: true }
  Bob 客户端：进入账本但所有密文显示"【等待解密】"

Step 3: Alice 下次打开 App / 切到该账本 / 进账本管理页
  Alice 客户端：
    GET /ledgers/:id/pending-members
    ◀── { pending: [{ userId: Bob.id, sm2PubKey: <Bob 公钥> }],
          myDekVersion: 1 }
    │
    │ 本地操作（服务端不参与）：
    │   dek = KeyChain.dekOf(ledgerId)
    │   wrapped = SM2.encrypt(Bob.pubKey, dek)
    │
    POST /ledgers/:id/members/Bob.id/dek
         { dekWrapped: wrapped, dekVersion: 1 }
    ────────────────────────────────────▶ 服务端
                                            UPDATE LedgerMember
                                              SET dekWrapped = wrapped
                                              WHERE userId = Bob.id

Step 4: Bob 下次打开 App / 进账单 / 进账户 / 切账本
  Bob 客户端：
    if (!KeyChain.hasDek(ledgerId)) {
      GET /ledgers/keys/mine
      ◀── { deks: [{ledgerId, dekWrapped, ver}] }
      KeyChain.loadDek(ledgerId, wrapped)  ← 用 Bob 的 priv 解
    }
    现在所有密文都能解了！
```

**关键事实**：
- 服务端**从未**见过 DEK 明文
- Alice 必须用她的 privKey 解出 DEK，再用 Bob 的 pubKey 重新包装 —— **服务端做不到**
- Bob 必须用他的 privKey 解出 DEK —— **任何其他人都做不到**
- 如果 Alice 一直不上线，Bob 永远是 pending 状态（这是 E2E 的代价）

### 7.5 记账单 / 加密字段

**加密（创建账单）**：
```dart
// 在 add_bill_screen 的 _save() 里
final ledgerId = _selectedAccount!.ledgerId;
final dekVer = KeyChain.instance.dekVersionOf(ledgerId) ?? 1;
final noteCipher = KeyChain.instance.encryptText(
  ledgerId: ledgerId,
  plain: _noteCtrl.text.trim(),
);
await ApiService.createBill(
  type: _type,
  amount: amount,                  // 明文上送
  categoryId: ...,
  accountId: ...,
  noteCipher: noteCipher,          // base64 密文
  noteDekVer: dekVer,
  date: _date,
);
```

**解密（展示账单）**：
```dart
// Bill.note 是一个 getter
String get note {
  if (noteCipher == null) return '';
  if (noteDekVer == 0) return '自动入账';  // 服务端写的系统占位
  return KeyChain.instance.decryptText(
    ledgerId: ledgerId,
    cipherBase64: noteCipher!,
    dekVer: noteDekVer,
  );
  // 如果 KeyChain 没缓存该账本的 DEK，返回"【等待解密】"
}

// 调用方完全无感
Text(bill.note);
```

### 7.6 忘记密码（恢复码）

> ⚠️ **当前版本未提供 UI 入口**，但服务端 / 加密原语已就绪。

```
1. 用户在登录页点"忘记密码"
2. 输入 username + recoveryCode（24 位）
3. POST /auth/recover { username, recoveryCode }
4. 服务端：
   a) SELECT recoveryHash, kdfSalt FROM User WHERE username = ?
   b) 校验：SM3(recoveryCode ‖ kdfSalt) === recoveryHash ?
   c) 校验通过 → 进入"重置密码"流程，返回 keyBundle (privByRecovery + salt)
5. 客户端：
   a) kekRec = PBKDF2_SM3(recoveryCode, salt, 100k)
   b) priv = SM4_decrypt(kekRec, privByRecovery)
   c) 用户输入新密码 newPwd
   d) newKekPwd = PBKDF2_SM3(newPwd, salt, 100k)
   e) newPrivByPwd = SM4_encrypt(newKekPwd, priv)
   f) （可选）重新生成 recoveryCode 替换旧的
6. PUT /auth/me/keys { newPrivByPwd, optional newRecoveryHash + privByRecovery }
7. 重新登录
```

**关键不变量**：私钥**始终是同一把**，所以历史数据全部还能解。

---

## 8. API 契约

### POST /auth/register

```jsonc
// 请求
{
  "username": "alice",
  "password": "verystrong!",
  "sm2PubKey": "04abcd...130 hex chars",
  "sm2PrivByPwd": "<base64>",
  "sm2PrivByRecovery": "<base64>",
  "kdfSalt": "<base64, 16 bytes>",
  "recoveryHash": "<base64, 32 bytes>",
  "personalLedgerDekWrapped": "<base64>"
}

// 响应
{
  "message": "注册成功",
  "token": "<JWT>",
  "user": { "id", "username", "nickname", "displayName", "currentLedgerId" },
  "keyBundle": {
    "sm2PubKey": "...",
    "sm2PrivByPwd": "<base64>",
    "sm2PrivByRecovery": "<base64>",
    "kdfSalt": "<base64>"
  }
}
```

### POST /auth/login

请求同原版（`username` + `password`）；响应在原版基础上**新增 `keyBundle`**（同上）。

### POST /ledgers

```jsonc
{
  "name": "家庭账本",
  "icon": "👨‍👩‍👧",
  "dekWrapped": "<base64, 客户端用自己 pubKey 包装的 DEK>"
}
```

响应：
```jsonc
{
  "message": "创建成功",
  "ledger": { ... },
  "dekWrapped": "<同入参>",
  "dekVersion": 1
}
```

### GET /ledgers/keys/mine（新）

返回当前用户在所有账本里的 dekWrapped：
```jsonc
{
  "deks": [
    { "ledgerId": "...", "dekWrapped": "<base64>", "dekVersion": 1 },
    ...
  ]
}
```

### GET /ledgers/:id/pending-members（新）

```jsonc
{
  "selfPending": false,         // 我自己是不是也还在 pending
  "myDekVersion": 1,            // 我持有的 DEK 版本
  "pending": [
    { "userId": "...", "username": "bob", "nickname": null,
      "sm2PubKey": "04..." },
    ...
  ]
}
```

权限：必须是该账本成员，且 `dekWrapped != null`（自己持有 DEK 才能帮别人）。

### POST /ledgers/:id/members/:userId/dek（新）

```jsonc
{
  "dekWrapped": "<base64, 我用 target.pubKey 包装好的 DEK>",
  "dekVersion": 1               // 必须等于服务端记录的 myDekVersion
}
```

幂等：如果该成员已被别人 wrap，返回 `{ already: true }` 不报错。

### POST /bills

```jsonc
{
  "type": "expense",
  "amount": 89.50,                  // 明文
  "categoryId": "...",
  "accountId": "...",
  "noteCipher": "<base64>",
  "noteDekVer": 1,
  "date": "2026-05-25T12:34:56Z"
}
```

### GET /bills 响应

```jsonc
{
  "bills": [
    {
      "id": "...",
      "type": "expense",
      "amount": 89.50,
      "noteCipher": "<base64>",
      "noteDekVer": 1,             // 0 = 系统占位（"自动入账"）
      "date": "...",
      "account": {
        "id": "...",
        "nameCipher": "<base64>",
        "nameDekVer": 1,
        "type": "BANK"
      },
      "category": { ... },
      "user": { ... }
    }
  ],
  "summary": { "totalIncome": 0, "totalExpense": 0 },
  "pagination": { ... }
}
```

### POST /accounts

```jsonc
{
  "nameCipher": "<base64>",
  "nameDekVer": 1,
  "type": "BANK",
  "initialBalance": 0,
  // ... 其余明文配置字段
}
```

---

## 9. 后端实现

### 9.1 目录结构

```
backend/
├── src/
│   ├── crypto/
│   │   ├── sm.service.ts        # SM2/SM3/SM4 + SM3-HMAC + PBKDF2-SM3
│   │   ├── kms.service.ts       # 主密钥 KEK 加载 + 包装/解包
│   │   └── crypto.module.ts     # 全局 @Global 模块
│   ├── auth/
│   │   └── auth.service.ts      # register / login 持久化密钥包
│   ├── ledgers/
│   │   └── ledgers.service.ts   # createPersonalLedger / listMyDeks / attachDek
│   ├── bills/
│   │   └── bills.service.ts     # 只存密文，永不解
│   ├── accounts/
│   │   └── accounts.service.ts  # 同上
│   └── ...
├── prisma/
│   └── schema.prisma            # 加密字段
└── .env                         # SM_KEK
```

### 9.2 SmService 关键 API

```typescript
class SmService {
  // SM2
  generateKeyPair(): { publicKey: string; privateKey: string };
  sm2Encrypt(plain: Buffer, publicKeyHex: string): string;       // → hex
  sm2Decrypt(cipherHex: string, privateKeyHex: string): Buffer;

  // SM3
  sm3(data: Buffer | string): Buffer;
  sm3Hmac(key: Buffer, msg: Buffer): Buffer;

  // KDF
  pbkdf2Sm3(password: string, salt: Buffer,
            iterations: number, dkLen: number): Buffer;

  // SM4-CBC + SM3-HMAC AEAD
  generateSm4Key(): Buffer;                                        // 16 bytes
  sm4Encrypt(plain: Buffer, key: Buffer): Buffer;                  // iv||ct||mac
  sm4Decrypt(blob: Buffer, key: Buffer): Buffer;                   // 校验 MAC

  random(n: number): Buffer;
}
```

### 9.3 SM2 协议细节（前后端互通的关键）

**明文必须先 hex-encode 为 ASCII 字符串再喂给 SM2**：

```typescript
// 后端 (sm-crypto)
sm2Encrypt(plain: Buffer, publicKeyHex: string): string {
  const hexAsText = plain.toString('hex');  // 例如 b"\xde\xad" → "dead"
  return sm.sm2.doEncrypt(hexAsText, publicKeyHex, 1);  // cipherMode=1
}
```

```dart
// 客户端 (dart_sm_new)
static String sm2Encrypt(Uint8List plain, String publicKeyHex) {
  final hexAsText = _toHex(plain);
  return SM2.encrypt(hexAsText, publicKeyHex);  // 内部 utf8.encode("dead")
}
```

两边一致。**直接传原始字节会因 UTF-8 编码不可逆而失败**。

### 9.4 KMS 配置

```bash
# .env
SM_KEK="0fe7d4c5b3a298765432100123456789"   # 32 hex char = 16 bytes
```

生产环境强烈建议改为：
- 阿里云 KMS / DEW
- 华为云 DEW
- AWS KMS（如果跨境）
- 物理 HSM（金融级）

加载逻辑见 `KmsService.onModuleInit()`。

---

## 10. 客户端实现

### 10.1 目录结构

```
finance_app/
├── lib/
│   ├── crypto/
│   │   ├── sm_crypto.dart           # 与 sm.service.ts 1:1 对齐的原语
│   │   ├── key_chain.dart           # 单例：私钥 + DEK 缓存 + 字段加解密
│   │   └── crypto_bootstrap.dart    # 注册 / 找回 用的高层流程
│   ├── services/
│   │   ├── api_service.dart         # HTTP 包装
│   │   ├── auth_service.dart        # token + currentLedgerId
│   │   └── pending_dek_resolver.dart # 机会式补 wrap / rehydrate
│   ├── models/
│   │   ├── bill.dart                # .note getter 走 KeyChain
│   │   └── account.dart             # .name getter 走 KeyChain
│   └── screens/
│       ├── register_screen.dart     # CryptoBootstrap.prepareRegistration
│       ├── login_screen.dart        # decryptPrivateKeyByPassword
│       └── ...                      # 各业务页 import KeyChain 用
```

### 10.2 KeyChain 单例

```dart
class KeyChain {
  static final instance = KeyChain._();

  // 用户 SM2
  String? get sm2PubKey;
  String? get sm2PrivKey;
  Future<void> setSelf({pubKey, privKey, persist=true});
  Future<bool> restoreFromStorage();  // 启动时
  Future<void> clear();               // 退出登录

  // 账本 DEK
  void loadDek({ledgerId, dekWrappedBase64, dekVersion});
  Uint8List? dekOf(String ledgerId);
  int? dekVersionOf(String ledgerId);
  bool hasDek(String ledgerId);

  // 业务语法糖
  String encryptText({required String ledgerId, required String plain});
  String decryptText({
    required String ledgerId,
    required String cipherBase64,
    required int dekVer,
    String systemFallback = '自动入账',
  });

  // 邀请 / 创建
  ({Uint8List dek, String dekWrappedBase64, int dekVersion}) newDekForOwner();
  String wrapDekFor(Uint8List dek, String targetPubKey);
}
```

私钥用 `flutter_secure_storage`（iOS Keychain / Android Keystore）持久化，重启 App 免输密码。

### 10.3 PendingDekResolver 调用时机

| 触发 | 调用 | 作用 |
|---|---|---|
| 登录成功 | `resetCooldown` + `resolveAll` | 给所有账本里 pending 的人补 wrap |
| 注册成功 | `resolveAll` | 同上（一般没 pending）|
| 进账本管理页 `_load` | `resolveAll` + `rehydrate` | 双向：我帮人 + 看自己有没有被帮 |
| 切换账本 | `rehydrate(targetLedgerId)` + `resolveOne(targetLedgerId)` | 同上但只对目标账本 |
| 进账单页 `_load` | `rehydrate(currentLedgerId)` | Bob 端：等 DEK 到位 |
| 进账户页 `_load` | `rehydrate(currentLedgerId)` | 同上 |
| 退出登录 | `KeyChain.clear` + `resetCooldown` | 彻底清密钥 |

5 秒冷却防止短时间多个触发点重复刷接口。

### 10.4 模型层"惰性解密"

`Bill.note` 和 `Account.name` 都是 getter，按需调 `KeyChain.decryptText`。如果该账本 DEK 还没到位，返回 `"【等待解密】"`，UI 自动显示占位文本。这样：
- UI 代码完全不用关心加密细节
- 旧业务代码（`Text(bill.note)`）无需改动
- DEK 到位后再次 build，自动显示明文

---

## 11. 密钥轮换

### 11.1 DEK 轮换（账本级）

**触发场景**：
- 成员被踢出，要确保 ta 看不到新数据
- 定期安全策略（如每年一次）
- 怀疑某成员账号被盗

**流程**：
```
Owner 客户端：
  1. newDek = SM4.generateKey()
  2. for each member (含自己):
       wrapped = SM2(member.pubKey, newDek)
       INSERT/UPDATE ledger_member_keys 行
         SET dekWrapped = wrapped, dekVersion = oldVersion + 1
  3. 通知所有成员"密钥已更新，请下次同步"

后续：
  · 新写的 Bill / Account 都用 newDek 加密，noteDekVer = 新版本
  · 旧数据保留旧 dekVersion，按版本各自解
  · 客户端 KeyChain 同时持有 v1、v2，按 dekVer 选

可选：重加密旧数据（彻底切断旧 DEK 价值）
  · 客户端拉所有旧 Bill / Account
  · 用旧 DEK 解 → 用新 DEK 加密 → 推回服务端
  · 服务端 UPDATE noteCipher / nameCipher，noteDekVer 升到新版
  · 全部完成后旧 dekVersion 的 ledger_member_keys 行可删
```

⚠️ 当前版本**未提供轮换 UI**，但服务端已支持任意 dekVersion 共存。

### 11.2 KEK 轮换（服务端级）

由于本架构下 KEK 几乎不直接加密任何业务数据（用户私钥靠用户密码/恢复码加密，DEK 靠用户公钥包装），KEK 轮换实际上**不影响**任何业务数据。

如果将来加入"服务端兜底"功能（如管理员密钥托管），轮换 KEK 时：
1. 用旧 KEK 解出所有用 KEK 包装的短密钥
2. 用新 KEK 重新包装
3. 切换 `SM_KEK` 环境变量
4. 业务数据不动

### 11.3 用户密钥轮换（密码变更）

修改密码不需要换 SM2 keypair（数据全部用 pubKey 包装/不动）。只需：
1. 客户端用旧密码解出 privKey
2. 客户端用新密码派生 newKekPwd
3. SM4(newKekPwd, privKey) → newPrivByPwd
4. PUT /auth/me/keys 替换 DB 里的 sm2PrivByPwd

恢复码同理。

---

## 12. 合规对照

| 法规 / 标准 | 要求 | 本方案做法 |
|---|---|---|
| **密码法 (2020)** | 关键信息基础设施使用商用密码 | 全 SM2 / SM3 / SM4 |
| **PIPL (2021)** 第 51 条 | 处理敏感个人信息须加密 | 备注 + 账户名 SM4-AEAD 加密 |
| **数据安全法 (2021)** | 重要数据分级保护 + 完整性校验 | 三层密钥 + SM3-HMAC MAC |
| **GB/T 35273-2020** | 财务交易记录属敏感信息 | 字段级加密 + 端到端 |
| **等保 2.0 三级** 7.1.4.2 | 通信链路使用密码技术 | TLS 1.3（可升级国密 SSL）|
| **等保 2.0 三级** 7.1.4.3 | 存储重要数据使用密码技术 | SM4 字段级 + TDE 兜底 |
| **GM/T 0054-2018** 信息系统密码应用 | 密钥分级、独立、轮换 | 三层 KEK/DEK/PriKey + 版本字段 |

**未达成的**：
- 国密 SSL（TLCP）—— 当前用普通 TLS 1.3，迁移成本看 `ENCRYPTION.md` 同目录的另一份文档（待加）
- 商用密码应用安全性评估（密评）—— 需走专业测评机构

---

## 13. 部署 & 运维

### 13.1 生产部署清单

- [ ] `SM_KEK` 不能用 `.env` 明文，改为 KMS 注入（环境变量启动时拉一次）
- [ ] PostgreSQL 开 TDE（pgcrypto / 云厂商 KMS 集成）
- [ ] 服务器磁盘 LUKS 全盘加密
- [ ] DB 备份单独加密 + 异地存储
- [ ] 反向代理 nginx 升级到 Tongsuo 版（如需国密 SSL）
- [ ] 日志脱敏：禁止记录 `noteCipher / nameCipher / sm2Priv*` 字段
- [ ] 接口审计：记录"谁在什么时候 attach 了谁的 DEK"
- [ ] 监控：KeyChain 解密失败率（异常飙升 = 可能有人篡改密文）

### 13.2 监控指标

| 指标 | 阈值 | 含义 |
|---|---|---|
| `dek_wrap_pending_count` | > 10 持续 24 小时 | 邀请人长期不上线，提示用推送 |
| `decrypt_failure_rate` | > 0.1% | 数据被篡改 / 客户端 bug |
| `pbkdf2_p99_ms` | > 5000ms | 老设备性能问题，考虑降迭代 |
| `recovery_attempt_count` | 突增 | 可能被暴力 |

### 13.3 应急预案

| 场景 | 处理 |
|---|---|
| 用户忘记密码 + 丢失恢复码 | **数据无法找回**。重置密码 = 创建新身份 + 之前数据永远密文 |
| 服务端 SM_KEK 泄露 | 当前架构下 KEK 不加密业务数据，仅需轮换 KEK 即可。如果未来加了 KEK-wrapped 兜底密钥，需重包装所有受影响密钥 |
| DB 被脱裤 | 攻击者拿到大量密文 + 公钥 + bcrypt 哈希。无法解密。但需提醒用户改密码（防 bcrypt 暴力）|
| 单成员被盗号 | 该成员 logout 所有设备 + 轮换其所在所有账本的 DEK + 推送通知其他成员 |

---

## 14. 已知限制 & 未来工作

| 限制 | 影响 | 计划 |
|---|---|---|
| **邀请人必须上线** Bob 才能解密 | 体验：新成员 pending 等待 | 加推送通知 owner |
| **金额未字段级加密** | DB 脱库泄露金额数量级 | TDE + LUKS 兜底；如真需可改 |
| **无审计日志** | 不知道谁解过哪些数据 | 加 OpLog 表（"who attached whose DEK at when"）|
| **没有 DEK 轮换 UI** | 踢出成员后需手工触发 | 加管理页 |
| **没有恢复码 UI 入口** | 用户忘密码无法自助找回 | 加"忘记密码"页 |
| **没有国密 SSL** | 等保严格审查可能扣分 | 见 `GM-TLS-MIGRATION.md`（待写）|
| **客户端跨设备同步私钥** | 换手机 = 重输密码（如果没保存恢复码 = 失败）| iCloud Keychain / 自建备份服务 |

---

## 附录 A：SM4-AEAD 自封格式

由于 `sm-crypto` 和 `dart_sm_new` 都不提供 SM4-GCM，我们用 SM4-CBC + SM3-HMAC 自封一个 AEAD。

**密文格式**（一体打包）：

```
┌─────────────┬─────────────────────┬─────────────┐
│  IV (16B)   │  ciphertext (变长)   │  MAC (32B)  │
└─────────────┴─────────────────────┴─────────────┘
       │              │                    │
       │              │                    └── SM3_HMAC(key, IV ‖ ciphertext)
       │              │
       │              └── SM4-CBC(key, IV, plaintext + PKCS7 padding)
       │
       └── 16 字节随机
```

**加密**：
```
iv = random(16)
ct = SM4_CBC_encrypt(key, iv, plain)
mac = SM3_HMAC(key, iv ‖ ct)
output = iv ‖ ct ‖ mac
```

**解密**（必须先校 MAC，再解密）：
```
input = iv ‖ ct ‖ mac
if (SM3_HMAC(key, iv ‖ ct) !== mac):
  throw "完整性校验失败"  # 防篡改
plain = SM4_CBC_decrypt(key, iv, ct)
```

**安全性质**：
- IV 随机 → 同明文每次加密结果不同（语义安全）
- MAC over (IV ‖ ct) → 任何字节被篡改都会被发现
- 常数时间 MAC 比较（`crypto.timingSafeEqual`）→ 防 timing 攻击
- 等价于 Encrypt-then-MAC 范式，业界推荐写法

---

## 附录 B：服务端永不接触的数据清单

以下数据在整个系统生命周期中**只有客户端见过明文**：

| 数据 | 在哪里 |
|---|---|
| 用户 SM2 私钥明文 | 客户端 KeyChain 内存 + Keystore |
| 用户密码明文 | 仅在 HTTPS POST body 里一次（用完即丢，不入日志）|
| 用户恢复码明文 | 注册时显示一次 → 用户保存 → 客户端丢弃 |
| 账本 DEK 明文 | 客户端 KeyChain 内存（不持久化）|
| 账单备注明文 | 客户端 UI 渲染时 |
| 账户名明文 | 客户端 UI 渲染时 |

**服务端拿到的"密码"经过 bcrypt 哈希后存储**，但 bcrypt 是单向的，且每次登录请求都是新的输入 —— 服务端不会"记得"用户的明文密码。

**唯一的例外**：登录 / 注册请求的 HTTPS body 在到达 NestJS 进程内存时是明文密码，被 bcrypt 处理后立即被 JS GC 回收。这个窗口期攻击者需要：拿到生产服务器 root + dump 内存 + 在合适时刻执行 —— 跟拿到 KEK 等价的风险，已属物理安全范畴。

---

## 修订历史

| 版本 | 日期 | 改动 | 作者 |
|---|---|---|---|
| v1 | 2026-05 | 初版：三层密钥 + 信封加密 + 全 SM 算法 | — |
