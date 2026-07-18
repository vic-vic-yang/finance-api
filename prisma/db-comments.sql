-- ============================================================
-- 财记数据库注释（表 + 列）
-- 运行：psql -U postgres -d finance -f db-comments.sql
-- ============================================================

-- ── enum 注释（PostgreSQL 对 enum 值的注释通过 COMMENT ON TYPE） ──
COMMENT ON TYPE "BillType" IS '账单类型：income(收入) / expense(支出)';
COMMENT ON TYPE "AccountType" IS '账户类型：CASH(现金)/BANK(银行卡)/VIRTUAL(虚拟账户)/CREDIT(信用卡)/INVESTMENT(投资)/INSURANCE(社保)/DEBT(负债)/OTHER(其他)';
COMMENT ON TYPE "BudgetPeriod" IS '预算周期：MONTHLY(月度) / YEARLY(年度)';
COMMENT ON TYPE "LedgerRole" IS '账本角色：owner(拥有者) / member(成员)';
COMMENT ON TYPE "AiImportStatus" IS 'AI导入状态机：pending→extracting→parsing→dedupping→review_ready→applying→done/failed/partial';

-- ── User ──
COMMENT ON TABLE "User" IS '用户：注册登录/E2E密钥对/VIP/角色';
COMMENT ON COLUMN "User"."id" IS '主键(cuid)';
COMMENT ON COLUMN "User"."username" IS '用户名（唯一）';
COMMENT ON COLUMN "User"."nickname" IS '用户昵称，显示用；为空时回退到username';
COMMENT ON COLUMN "User"."role" IS '角色：user(普通) / admin(管理员)';
COMMENT ON COLUMN "User"."vipTier" IS 'VIP等级：free(免费)/vip/pro(预留)';
COMMENT ON COLUMN "User"."vipExpiresAt" IS 'VIP到期时间；null=永久';
COMMENT ON COLUMN "User"."vipNote" IS 'VIP备注（来源：手动开通/活动/付费单号）';
COMMENT ON COLUMN "User"."password" IS 'bcrypt密码哈希(12 rounds)';
COMMENT ON COLUMN "User"."createdAt" IS '注册时间';
COMMENT ON COLUMN "User"."currentLedgerId" IS '当前活动账本ID';
COMMENT ON COLUMN "User"."sm2PubKey" IS 'SM2公钥(hex, 未压缩04|x|y共130字符)';
COMMENT ON COLUMN "User"."sm2PrivByPwd" IS 'SM2私钥用KDF(密码)派生SM4加密(iv||ct||mac)';
COMMENT ON COLUMN "User"."sm2PrivByRecovery" IS 'SM2私钥用KDF(恢复码)派生SM4加密';
COMMENT ON COLUMN "User"."kdfSalt" IS '派生KEK用的salt（密码+恢复码共用）';
COMMENT ON COLUMN "User"."recoveryHash" IS '恢复码SM3(code||salt)哈希';

-- ── Ledger ──
COMMENT ON TABLE "Ledger" IS '账本：个人/共享账本，核心隔离单元';
COMMENT ON COLUMN "Ledger"."id" IS '主键(cuid)';
COMMENT ON COLUMN "Ledger"."name" IS '账本名称';
COMMENT ON COLUMN "Ledger"."icon" IS '账本图标(emoji)';
COMMENT ON COLUMN "Ledger"."ownerId" IS '拥有者用户ID';
COMMENT ON COLUMN "Ledger"."isPersonal" IS '是否为个人默认账本（不可删除/退出）';
COMMENT ON COLUMN "Ledger"."createdAt" IS '创建时间';

-- ── LedgerMember ──
COMMENT ON TABLE "LedgerMember" IS '账本成员：成员关系+DEK信封加密';
COMMENT ON COLUMN "LedgerMember"."id" IS '主键(cuid)';
COMMENT ON COLUMN "LedgerMember"."ledgerId" IS '关联账本ID';
COMMENT ON COLUMN "LedgerMember"."userId" IS '关联用户ID';
COMMENT ON COLUMN "LedgerMember"."role" IS '角色：owner(拥有者)/member(成员)';
COMMENT ON COLUMN "LedgerMember"."joinedAt" IS '加入时间';
COMMENT ON COLUMN "LedgerMember"."dekWrapped" IS '用该成员SM2公钥包装后的DEK密文';
COMMENT ON COLUMN "LedgerMember"."dekVersion" IS 'DEK版本号（用于密钥轮换）';

-- ── LedgerInvite ──
COMMENT ON TABLE "LedgerInvite" IS '账本邀请码';
COMMENT ON COLUMN "LedgerInvite"."code" IS '6位邀请码（唯一）';
COMMENT ON COLUMN "LedgerInvite"."createdBy" IS '创建者用户ID';
COMMENT ON COLUMN "LedgerInvite"."expiresAt" IS '过期时间';
COMMENT ON COLUMN "LedgerInvite"."usedBy" IS '使用者用户ID';
COMMENT ON COLUMN "LedgerInvite"."usedAt" IS '使用时间';

-- ── Account ──
COMMENT ON TABLE "Account" IS '账户：现金/银行卡/信用卡/投资/负债等';
COMMENT ON COLUMN "Account"."id" IS '主键(cuid)';
COMMENT ON COLUMN "Account"."ledgerId" IS '所属账本ID';
COMMENT ON COLUMN "Account"."ownerId" IS '所有者(null=共享账户,非空=私人账户)';
COMMENT ON COLUMN "Account"."nameCipher" IS '账户名密文(SM4-CBC+HMAC, iv||ct||mac)';
COMMENT ON COLUMN "Account"."nameDekVer" IS '加密所用DEK版本';
COMMENT ON COLUMN "Account"."type" IS '账户类型';
COMMENT ON COLUMN "Account"."balance" IS '当前余额(Decimal 15,2)';
COMMENT ON COLUMN "Account"."initialBalance" IS '初始余额';
COMMENT ON COLUMN "Account"."icon" IS '图标(emoji)';
COMMENT ON COLUMN "Account"."color" IS '颜色(hex)';
COMMENT ON COLUMN "Account"."statementDay" IS '信用卡账单日(1-31)';
COMMENT ON COLUMN "Account"."dueDay" IS '信用卡还款日/负债月还款日(1-31)';
COMMENT ON COLUMN "Account"."creditLimit" IS '信用额度';
COMMENT ON COLUMN "Account"."interestRate" IS '年利率(%)';
COMMENT ON COLUMN "Account"."loanPrincipal" IS '贷款本金（原始金额）';
COMMENT ON COLUMN "Account"."loanTermMonths" IS '贷款期限(月)';
COMMENT ON COLUMN "Account"."firstPaymentDate" IS '首次还款日期';
COMMENT ON COLUMN "Account"."repaymentMethod" IS '还款方式：equal_payment/equal_principal/interest_only';
COMMENT ON COLUMN "Account"."autoDepositDay" IS '每月自动入账日(1-31)';
COMMENT ON COLUMN "Account"."autoDepositAmount" IS '每月自动入账金额';
COMMENT ON COLUMN "Account"."autoDepositCategoryId" IS '自动入账分类ID';
COMMENT ON COLUMN "Account"."lastAutoProcessedAt" IS '自动入账上次处理到的日期';

-- ── Category ──
COMMENT ON TABLE "Category" IS '分类：系统预置+账本自定义，支持二级';
COMMENT ON COLUMN "Category"."id" IS '主键(cuid)';
COMMENT ON COLUMN "Category"."ledgerId" IS '所属账本(null=系统分类全局共享)';
COMMENT ON COLUMN "Category"."userId" IS '创建者(null=系统)';
COMMENT ON COLUMN "Category"."name" IS '分类名称';
COMMENT ON COLUMN "Category"."type" IS '类型：income(收入)/expense(支出)';
COMMENT ON COLUMN "Category"."icon" IS '图标(emoji)';
COMMENT ON COLUMN "Category"."color" IS '颜色(hex)';
COMMENT ON COLUMN "Category"."isSystem" IS '是否为系统预置分类';
COMMENT ON COLUMN "Category"."parentId" IS '父分类ID(null=一级分类)';

-- ── LedgerLlmConfig ──
COMMENT ON TABLE "LedgerLlmConfig" IS '账本共享LLM配置(BYOK)：一人配置全员共享';
COMMENT ON COLUMN "LedgerLlmConfig"."ledgerId" IS '关联账本(每账本最多一条)';
COMMENT ON COLUMN "LedgerLlmConfig"."ownerUserId" IS '配置者(只有此人可改/删)';
COMMENT ON COLUMN "LedgerLlmConfig"."provider" IS '服务商：deepseek/qwen/kimi/glm/custom';
COMMENT ON COLUMN "LedgerLlmConfig"."baseUrl" IS 'API端点地址';
COMMENT ON COLUMN "LedgerLlmConfig"."modelId" IS '文本模型名';
COMMENT ON COLUMN "LedgerLlmConfig"."visionModelId" IS '视觉模型名(可选)';
COMMENT ON COLUMN "LedgerLlmConfig"."apiKeyEnc" IS 'API Key(AES-256-GCM加密)';

-- ── CategorySort ──
COMMENT ON TABLE "CategorySort" IS '分类自定义排序（覆盖系统默认顺序）';
COMMENT ON COLUMN "CategorySort"."sortOrder" IS '排序序号(越小越靠前)';

-- ── Bill ──
COMMENT ON TABLE "Bill" IS '账单流水：收入/支出/转账记录，余额联动核心';
COMMENT ON COLUMN "Bill"."id" IS '主键(cuid)';
COMMENT ON COLUMN "Bill"."ledgerId" IS '所属账本ID';
COMMENT ON COLUMN "Bill"."userId" IS '记账用户ID';
COMMENT ON COLUMN "Bill"."accountId" IS '关联账户ID';
COMMENT ON COLUMN "Bill"."categoryId" IS '关联分类ID';
COMMENT ON COLUMN "Bill"."type" IS '类型：income(收入)/expense(支出)';
COMMENT ON COLUMN "Bill"."amount" IS '金额(正数, Decimal 15,2)';
COMMENT ON COLUMN "Bill"."noteCipher" IS '备注密文(SM4-CBC+HMAC, iv||ct||mac)';
COMMENT ON COLUMN "Bill"."noteDekVer" IS '加密所用DEK版本';
COMMENT ON COLUMN "Bill"."date" IS '交易日期';
COMMENT ON COLUMN "Bill"."externalId" IS '平台交易订单号(支付宝/微信)用于去重';
COMMENT ON COLUMN "Bill"."source" IS '来源渠道：alipay/wechat/bank/manual';
COMMENT ON COLUMN "Bill"."isTransfer" IS '是否为转账(不计入收支统计/预算)';
COMMENT ON COLUMN "Bill"."bankBalance" IS '银行联机余额(用于高精度去重+余额校准)';
COMMENT ON COLUMN "Bill"."merchantHash" IS '商户名sha256哈希(用于分类纠正记忆)';

-- ── CategoryCorrection ──
COMMENT ON TABLE "CategoryCorrection" IS '商户→分类纠正记忆：用户修正一次以后AI自动套用';
COMMENT ON COLUMN "CategoryCorrection"."merchantHash" IS '商户名哈希';
COMMENT ON COLUMN "CategoryCorrection"."categoryId" IS '纠正后的分类ID';

-- ── AiImport ──
COMMENT ON TABLE "AiImport" IS 'AI智能导入记录：文件上传到入库的完整状态追踪';
COMMENT ON COLUMN "AiImport"."filename" IS '原始文件名';
COMMENT ON COLUMN "AiImport"."fileType" IS '文件类型：image/pdf/csv/xlsx/text';
COMMENT ON COLUMN "AiImport"."fileSize" IS '文件大小(字节)';
COMMENT ON COLUMN "AiImport"."accountId" IS '用户选定的目标账户ID';
COMMENT ON COLUMN "AiImport"."modelName" IS 'AI模型名';
COMMENT ON COLUMN "AiImport"."status" IS '当前状态';
COMMENT ON COLUMN "AiImport"."progress" IS '进度(0-100)';
COMMENT ON COLUMN "AiImport"."message" IS '当前阶段说明或失败原因';
COMMENT ON COLUMN "AiImport"."parsedCount" IS 'AI解析出多少条';
COMMENT ON COLUMN "AiImport"."dupCount" IS '去重跳过多少条';
COMMENT ON COLUMN "AiImport"."insertedCount" IS '实际入库多少条';
COMMENT ON COLUMN "AiImport"."draftsJson" IS '明文草稿JSON(apply后清空)';
COMMENT ON COLUMN "AiImport"."rawOutput" IS 'LLM原始返回';
COMMENT ON COLUMN "AiImport"."errorTrace" IS '失败时的错误堆栈';

-- ── Budget ──
COMMENT ON TABLE "Budget" IS '预算：按分类设月度/年度预算';
COMMENT ON COLUMN "Budget"."categoryId" IS '分类ID(null=总预算)';
COMMENT ON COLUMN "Budget"."amount" IS '预算金额';
COMMENT ON COLUMN "Budget"."period" IS '周期：MONTHLY(月度)/YEARLY(年度)';
COMMENT ON COLUMN "Budget"."startDate" IS '预算起始日期';

-- ── RecurringBill ──
COMMENT ON TABLE "RecurringBill" IS '周期账单：房租/订阅等固定支出';
COMMENT ON COLUMN "RecurringBill"."noteCipher" IS '备注密文';
COMMENT ON COLUMN "RecurringBill"."noteDekVer" IS '加密所用DEK版本';
COMMENT ON COLUMN "RecurringBill"."cycleType" IS '周期类型：monthly/weekly/yearly';
COMMENT ON COLUMN "RecurringBill"."cycleDay" IS '几号(月度)/周几(周度,1-7)/mmdd(年度)';
COMMENT ON COLUMN "RecurringBill"."nextDate" IS '下次触发时间';
COMMENT ON COLUMN "RecurringBill"."isActive" IS '是否启用';
COMMENT ON COLUMN "RecurringBill"."isAuto" IS '是否AI自动发现的候选';
COMMENT ON COLUMN "RecurringBill"."confidence" IS 'AI识别置信度(0-1)';

-- ── SavingsGoal ──
COMMENT ON TABLE "SavingsGoal" IS '储蓄目标';
COMMENT ON COLUMN "SavingsGoal"."nameCipher" IS '目标名称密文';
COMMENT ON COLUMN "SavingsGoal"."nameDekVer" IS '加密所用DEK版本';
COMMENT ON COLUMN "SavingsGoal"."targetAmount" IS '目标金额';
COMMENT ON COLUMN "SavingsGoal"."startDate" IS '起算日';
COMMENT ON COLUMN "SavingsGoal"."accountId" IS '绑定账户ID(非空时用余额算进度)';
COMMENT ON COLUMN "SavingsGoal"."initialBalance" IS '绑定时初始余额快照(0=计入现有余额)';
COMMENT ON COLUMN "SavingsGoal"."deadline" IS '期望达成日';
COMMENT ON COLUMN "SavingsGoal"."icon" IS '图标(emoji)';
COMMENT ON COLUMN "SavingsGoal"."color" IS '颜色';
COMMENT ON COLUMN "SavingsGoal"."isCompleted" IS '是否已完成';

-- ── AiInsightDismissal ──
COMMENT ON TABLE "AiInsightDismissal" IS 'AI洞察忽略记录（过期后重现）';
COMMENT ON COLUMN "AiInsightDismissal"."type" IS '洞察类型：anomaly_cat/anomaly_bill/budget_alert/recurring_due/trend_up/trend_down';
COMMENT ON COLUMN "AiInsightDismissal"."target" IS '关联对象ID';
COMMENT ON COLUMN "AiInsightDismissal"."expireAt" IS '忽略到期时间';

-- ── Proposal ──
COMMENT ON TABLE "Proposal" IS 'CFO财务建议：检测器发现问题→生成建议→用户审批';
COMMENT ON COLUMN "Proposal"."type" IS '建议类型';
COMMENT ON COLUMN "Proposal"."status" IS '状态：pending/approved/dismissed/snoozed/done/expired';
COMMENT ON COLUMN "Proposal"."severity" IS '严重程度：info/warning/critical';
COMMENT ON COLUMN "Proposal"."title" IS '建议标题';
COMMENT ON COLUMN "Proposal"."body" IS '建议详细内容';
COMMENT ON COLUMN "Proposal"."actionKind" IS '动作类型';
COMMENT ON COLUMN "Proposal"."actionParams" IS '动作参数(JSON)';
COMMENT ON COLUMN "Proposal"."requiresClient" IS '是否需要客户端执行';
COMMENT ON COLUMN "Proposal"."evidenceRefs" IS '证据引用(JSON)';
COMMENT ON COLUMN "Proposal"."dedupeKey" IS '去重键(同类型+同内容不重复生成)';
COMMENT ON COLUMN "Proposal"."decidedAt" IS '用户决策时间';

-- ── ProposalFeedback ──
COMMENT ON TABLE "ProposalFeedback" IS 'CFO反馈学习：同类建议被忽略≥3次则静音30天';
COMMENT ON COLUMN "ProposalFeedback"."dismissed" IS '被忽略次数';
COMMENT ON COLUMN "ProposalFeedback"."approved" IS '被批准次数';
COMMENT ON COLUMN "ProposalFeedback"."mutedUntil" IS '静音到何时';

-- ── NewsArticle ──
COMMENT ON TABLE "NewsArticle" IS '财经资讯：RSS聚合+LLM富化';
COMMENT ON COLUMN "NewsArticle"."titleZh" IS 'LLM翻译的中文标题';
COMMENT ON COLUMN "NewsArticle"."summary" IS 'LLM中文摘要';
COMMENT ON COLUMN "NewsArticle"."source" IS '来源名';
COMMENT ON COLUMN "NewsArticle"."url" IS '原文链接(唯一)';
COMMENT ON COLUMN "NewsArticle"."imageUrl" IS '配图URL';
COMMENT ON COLUMN "NewsArticle"."category" IS '标签(LKM给)：股市/宏观/加密/科技/政策';
COMMENT ON COLUMN "NewsArticle"."importance" IS '重要性评分(0-100)';
COMMENT ON COLUMN "NewsArticle"."sentiment" IS '情绪：positive/neutral/negative';
COMMENT ON COLUMN "NewsArticle"."content" IS '抓取的原文正文(纯文本)';
COMMENT ON COLUMN "NewsArticle"."analysis" IS 'LLM要点分析';

-- ── StockAnalysis ──
COMMENT ON TABLE "StockAnalysis" IS '用户股票查询分析快照';
COMMENT ON COLUMN "StockAnalysis"."symbol" IS '股票代码';
COMMENT ON COLUMN "StockAnalysis"."name" IS '股票名称(英文)';
COMMENT ON COLUMN "StockAnalysis"."nameZh" IS '股票名称(中文)';
COMMENT ON COLUMN "StockAnalysis"."quote" IS '关键指标快照(JSON)';
COMMENT ON COLUMN "StockAnalysis"."analysis" IS 'LLM分析文本';
COMMENT ON COLUMN "StockAnalysis"."news" IS '相关新闻快照(JSON)';

-- ── Loan ──
COMMENT ON TABLE "Loan" IS '借贷往来：借出(应收)/借入(应付)';
COMMENT ON COLUMN "Loan"."direction" IS '方向：lend(借出)/borrow(借入)';
COMMENT ON COLUMN "Loan"."amount" IS '本金金额';
COMMENT ON COLUMN "Loan"."repaidAmount" IS '已还/已收金额';
COMMENT ON COLUMN "Loan"."accountId" IS '出/入款账户ID';
COMMENT ON COLUMN "Loan"."noteCipher" IS '备注密文(base64,账本DEK加密)';
COMMENT ON COLUMN "Loan"."noteDekVer" IS '加密所用DEK版本';
COMMENT ON COLUMN "Loan"."voucherKey" IS '凭证图片key';
COMMENT ON COLUMN "Loan"."settledAt" IS '结清时间';

-- ── LoanRepayment ──
COMMENT ON TABLE "LoanRepayment" IS '还款/收款记录：借贷往来的还款流水';
COMMENT ON COLUMN "LoanRepayment"."amount" IS '本次还款金额';
COMMENT ON COLUMN "LoanRepayment"."billId" IS '对应账单ID(如果有)';

-- ── StockHolding ──
COMMENT ON TABLE "StockHolding" IS '用户股票持仓：每用户每股票一条';
COMMENT ON COLUMN "StockHolding"."symbol" IS '股票代码';
COMMENT ON COLUMN "StockHolding"."buyPrice" IS '买入均价';
COMMENT ON COLUMN "StockHolding"."shares" IS '持有数量(股)';
COMMENT ON COLUMN "StockHolding"."ledgerId" IS '关联账本(null=未关联，不自动结算)';
COMMENT ON COLUMN "StockHolding"."accountId" IS '关联投资账户';
COMMENT ON COLUMN "StockHolding"."lastPrice" IS '上次结算用的价格';
COMMENT ON COLUMN "StockHolding"."lastCalcAt" IS '上次成功结算时间';
COMMENT ON COLUMN "StockHolding"."advice" IS '每日AI持仓决策(JSON)';

-- ── DailyPickRun ──
COMMENT ON TABLE "DailyPickRun" IS '每日选股运行记录：一交易日一条';
COMMENT ON COLUMN "DailyPickRun"."tradeDate" IS '交易日(yyyy-MM-dd)';
COMMENT ON COLUMN "DailyPickRun"."boards" IS '强势板块JSON';
COMMENT ON COLUMN "DailyPickRun"."comment" IS '市场/板块解读(LLM)';

-- ── DailyPick ──
COMMENT ON TABLE "DailyPick" IS '每日机会股：每交易日Top N';
COMMENT ON COLUMN "DailyPick"."tradeDate" IS '交易日';
COMMENT ON COLUMN "DailyPick"."rank" IS '排名(1..N)';
COMMENT ON COLUMN "DailyPick"."code" IS '6位股票代码';
COMMENT ON COLUMN "DailyPick"."symbol" IS '带市场前缀代码';
COMMENT ON COLUMN "DailyPick"."name" IS '股票名称';
COMMENT ON COLUMN "DailyPick"."boardName" IS '所属强势板块名';
COMMENT ON COLUMN "DailyPick"."score" IS 'AI机会评分(0-100)';
COMMENT ON COLUMN "DailyPick"."action" IS '合规措辞';
COMMENT ON COLUMN "DailyPick"."reason" IS '入选理由';
COMMENT ON COLUMN "DailyPick"."risk" IS '主要风险';
COMMENT ON COLUMN "DailyPick"."lastPrice" IS '最近评估价格';
COMMENT ON COLUMN "DailyPick"."outcomePct" IS '自推荐以来累计收益%';
COMMENT ON COLUMN "DailyPick"."outcomeAt" IS '最近评估时间';

-- ── PicksMemory ──
COMMENT ON TABLE "PicksMemory" IS '选股agent策略记忆：累积经验+战绩快照(单行)';
COMMENT ON COLUMN "PicksMemory"."playbook" IS '累积的经验/策略(LLM每日复盘后更新)';
COMMENT ON COLUMN "PicksMemory"."stats" IS '样本数/胜率/平均收益等(JSON)';
