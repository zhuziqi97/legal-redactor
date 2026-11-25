import * as R from './number-rules.js';
import { char, digits, length, rule, slice, trim, type Match, type Rule } from './text.js';

export type PatternHit = {
  category: string; text: string; start: number; end: number; confidence: 'high' | 'medium'; auto_replace: boolean; notes: string;
};

const separators = rule('[\\s-]');
const accountSeparators = rule('[\\s\\u3000-]');
const identity = rule('[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]');
const loginPrefix = rule('https?://[^/\\s@]+:$');

function digitValue(value: string) {
  if (!digits(value)) return NaN;
  const point = value.codePointAt(0)!;
  if (point >= 48 && point <= 57) return point - 48;
  let base = point;
  while (digits(String.fromCodePoint(base - 1))) base--;
  return (point - base) % 10;
}

export function idChecksum(value: string) {
  const code = Array.from(separators.replace(value, '').toUpperCase());
  if (code.length !== 18) return false;
  return R._ID_CHECK[code.slice(0, 17).reduce((sum, ch, index) => sum + digitValue(ch) * R._ID_WEIGHTS[index], 0) % 11] === code[17];
}

export function luhn(value: string) {
  const numbers = Array.from(value).filter(digits).map(digitValue);
  if (numbers.length < 16) return false;
  const parity = numbers.length % 2;
  const checksum = numbers.reduce((sum, value, index) => sum + (index % 2 === parity ? value * 2 - (value > 4 ? 9 : 0) : value), 0);
  return checksum % 10 === 0;
}

function creditChecksum(value: string) {
  const code = value.toUpperCase();
  if (code.length !== 18) return false;
  const numbers = Array.from(code).slice(0, 17).map(ch => R._USCC_ALPHABET.indexOf(ch));
  if (numbers.includes(-1)) return false;
  return R._USCC_ALPHABET[(31 - numbers.reduce((sum, value, index) => sum + value * R._USCC_WEIGHTS[index], 0) % 31) % 31] === code[17];
}

export function structuralCandidates(text: string) {
  const result: PatternHit[] = [];
  const add = (category: string, match: Match, group = 0, valid = true, notes = '', auto = true) => {
    result.push({category, text: match.group(group)!, start: match.start(group), end: match.end(group),
      confidence: valid ? 'high' : 'medium', auto_replace: auto, notes});
  };
  const addAll = (category: string, pattern: Rule, group = 0) => {
    for (const match of pattern.finditer(text)) add(category, match, group);
  };
  for (const match of R._ID18.finditer(text)) {
    const valid = idChecksum(match.value);
    add('id_card', match, 0, valid, valid ? '' : 'id_checksum_fail');
  }
  for (const match of R._ID15.finditer(text)) add('id_card', match, 0, false, 'legacy_15_digit');
  addAll('mobile', R._MOBILE_SPACED);
  for (const match of R._ID18_SPACED.finditer(text)) {
    const compact = separators.replace(match.value, '');
    if (length(compact) !== 18 || !identity.fullmatch(compact)) continue;
    const valid = idChecksum(compact);
    add('id_card', match, 0, valid, valid ? '' : 'id_checksum_fail');
  }
  addAll('landline', R._LANDLINE);
  addAll('landline', R._HOTLINE);
  for (const match of R._EMAIL.finditer(text)) {
    if (!loginPrefix.test(slice(text, Math.max(0, match.start() - 80), match.start()))) add('email', match);
  }
  addAll('notary_number', R._NOTARY_NO);
  addAll('case_number', R._CASE_NO);
  for (const match of R._USCC.finditer(text)) {
    if (digits(match.value)) continue;
    const valid = creditChecksum(match.value);
    const prefix = slice(text, Math.max(0, match.start() - 12), match.start());
    const labeled = prefix.includes('信用代码') || prefix.includes('纳税人识别号');
    add('uscc', match, 0, valid, valid ? '' : labeled ? 'uscc_checksum_fail_labeled' : 'uscc_checksum_fail', valid || labeled);
  }
  for (const match of R._LABELED_USCC.finditer(text)) {
    const compact = rule('[\\s\\u3000]').replace(match.group(1)!, '').toUpperCase();
    if (digits(compact) || compact.length < 17 || compact.length > 18) continue;
    const valid = creditChecksum(compact);
    add('uscc', match, 1, valid, valid ? '' : 'uscc_checksum_fail_labeled');
  }
  const labeledAccounts = [];
  for (const match of R._LABELED_ACCOUNT.finditer(text)) {
    const compact = accountSeparators.replace(match.group(1)!, '');
    if (compact.length < 8 || compact.length > 22 || !digits(compact) || identity.fullmatch(compact)) continue;
    labeledAccounts.push(match.span(1));
    const valid = luhn(compact);
    add('bank_account', match, 1, valid, valid ? '' : 'luhn_fail_labeled');
  }
  for (const match of R._BANK.finditer(text)) {
    if (R._LICENSE_LABEL.test(slice(text, Math.max(0, match.start() - 12), match.start()))) continue;
    if (labeledAccounts.some(([a, b]) => match.end() > a && match.start() < b) || identity.fullmatch(match.value)) continue;
    const valid = luhn(match.value);
    add('bank_account', match, 0, valid, valid ? '' : 'luhn_fail_unlabeled', valid);
  }
  addAll('passport', R._LABELED_PASSPORT, 1);
  addAll('hk_mo_permit', R._LABELED_HK_MO, 1);
  addAll('plate', R._PLATE);
  addAll('property_cert', R._PROPERTY);
  addAll('wechat_qq', R._LABELED_WECHAT_QQ, 1);
  addAll('ip', R._IP);
  addAll('mac', R._MAC);
  addAll('url_secret', R._URL_USERINFO, 1);
  for (const match of R._URL_QUERY_SECRET.finditer(text)) add('url_secret', match);
  addAll('share_code', R._SHARE_CODE, 1);
  for (const match of R._URL.finditer(text)) {
    const raw = trim(match.value, '.,;:)>】」』', 'right');
    if (length(raw) < 12) continue;
    result.push({category: 'url', text: raw, start: match.start(), end: match.start() + length(raw), confidence: 'high', auto_replace: true, notes: ''});
  }
  for (const match of R._BIRTH_INLINE.finditer(text)) {
    const suffix = slice(text, match.end(), match.end() + 2) === '出生' ? '出生' : '';
    result.push({category: 'birth_date', text: match.value + suffix, start: match.start(), end: match.end() + length(suffix), confidence: 'high', auto_replace: true, notes: ''});
  }
  addAll('birth_date', R._BIRTH_LABELED, 1);
  return result;
}

export function translateWidth(text: string) {
  return text.replace(/[０-９＋Ｘｘ－]/gu, value => char('0123456789+Xx-', '０１２３４５６７８９＋Ｘｘ－'.indexOf(value)));
}
