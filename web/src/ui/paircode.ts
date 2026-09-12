/**
 * 数字配对码的显示与规整（ADR-0017）。16 位十进制，显示成 1234-5678-9012-3456。
 * 输入时空格、-、全角横线都接受，其余字符剥掉 —— 服务端也做同样的规整。
 */

/** 只留数字。 */
export function normalizePairDigits(s: string): string {
  return s.replace(/\D+/g, '')
}

/** 4 位一组、- 分隔，最多 16 位。 */
export function formatPairDigits(s: string): string {
  return normalizePairDigits(s)
    .slice(0, 16)
    .replace(/(\d{4})(?=\d)/g, '$1-')
}

export const PAIR_DIGITS_LEN = 16
