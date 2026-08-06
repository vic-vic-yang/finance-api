import {
  IsArray,
  IsBase64,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

/** 每类实体的行数上限（防滥用 / 防事务过大） */
export const BACKUP_ENTITY_LIMIT = 20000;

/**
 * 加密备份批量恢复。
 * 所有 cipher 字段保持密文（客户端已用新 DEK 重加密），服务端永不解密。
 * 实体字段即现有 model 字段的 JSON 形态（带「原 id」，服务端重映射为新 id）。
 */
export class ImportBackupDto {
  /** 新账本名称 */
  @IsString()
  @IsNotEmpty({ message: '账本名称不能为空' })
  @MaxLength(40, { message: '账本名称最长 40 字符' })
  name: string;

  @IsString()
  @IsOptional()
  icon?: string;

  /**
   * 新账本 DEK，用恢复者自己的 SM2 公钥包装（base64）。
   * 必须提供：恢复出的账本只有 owner 一个成员，现有 attachDek 要求
   * 调用者已持有 DEK，无法「自己给自己授权」，所以在此事务内一并写入。
   */
  @IsBase64({}, { message: 'dekWrapped 必须是 base64' })
  @IsNotEmpty({ message: '缺少 dekWrapped（新账本数据密钥）' })
  dekWrapped: string;

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `categories 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  categories?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `accounts 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  accounts?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `bills 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  bills?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `budgets 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  budgets?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `goals 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  goals?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `loans 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  loans?: Record<string, unknown>[];

  @IsArray()
  @ArrayMaxSize(BACKUP_ENTITY_LIMIT, {
    message: `recurring 超过单次上限 ${BACKUP_ENTITY_LIMIT}`,
  })
  @IsOptional()
  recurring?: Record<string, unknown>[];
}
