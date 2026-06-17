/**
 * 飞书消息加解密 (事件订阅 v2.0)
 * 文档: https://open.feishu.cn/document/server-docs/event-subscription-guide/encrypt-message
 */

import * as crypto from "crypto";

/**
 * 解密飞书事件回调 payload
 * @param encrypted - 飞书 POST body 中的 encrypt 字段 (base64 字符串)
 * @param encryptKey - 飞书后台 "Encrypt Key" (你 .env 的 FEISHU_ENCRYPT_KEY)
 * @returns 解密后的 JSON 字符串
 */
export function decryptFeishuEvent(encrypted: string, encryptKey: string): string {
  // 1. encryptKey 派生 AES-256 key (SHA256 哈希)
  const key = crypto.createHash("sha256").update(encryptKey).digest();

  // 2. base64 decode ciphertext
  const ciphertext = Buffer.from(encrypted, "base64");

  // 3. AES-256-CBC 解密 (PKCS#7 padding, IV = 前 16 字节)
  const iv = ciphertext.subarray(0, 16);
  const enc = ciphertext.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(enc);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}

/**
 * 加密飞书主动响应 (用于回调 URL 验证)
 */
export function encryptFeishuResponse(plain: string, encryptKey: string): string {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc]).toString("base64");
}

/**
 * 验证飞书 URL 验证请求 (事件订阅启用时)
 * 飞书 POST challenge, 我们用 challenge 直接回
 */
export function verifyFeishuUrl(payload: { challenge?: string }): string | null {
  return payload.challenge ?? null;
}

/**
 * 飞书 im/v1/messages API 响应 (发送消息)
 */
export interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: { message_id: string; chat_id: string; create_time: string };
}
