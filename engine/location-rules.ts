/** Pattern sources and labels from the Python case_locations reference. */
import { rule } from './text.js';

export const FORMAL_COMPANY = rule("(?:股份有限公司|有限责任公司|有限公司)$");
export const PARTY_LEAD = rule("(?:原告|被告|第三人|甲方|乙方|委托方)\\s*$");
export const BRANCH = rule("(?:分校|校区|分院|分公司|分店|门店|支行|分行|分所)$");
export const PARENT_ORG = rule("(?:大学|学院|医院|有限公司|有限责任公司|银行)$");
export const PUBLIC_OFFICE = rule("(?:[（(][A-Za-z][A-Za-z .'-]{0,35}[）)])?(?:人民政府|人民检察院|(?:人民)?法院(?:赔偿委员会|审判委员会)?)");
export const JUDICIAL_COMMITTEE = rule("最高人民法院(?:赔偿委员会|审判委员会)");
export const GEO_JOIN = rule("联邦");
export const COMPANY_DEFINITION = rule("[\\u3400-\\u9fffA-Za-z0-9]{2,22}?公司(?=[（(]\\s*以下(?:简称|称))");
export const NAMED_PLATFORM = rule("(?:在|通过|经由)([\\u3400-\\u9fffA-Za-z0-9]{2,12}?(?:网|平台))(?=上(?:开设|开店|下单|发布|销售))");
export const GENERIC_PLATFORM = new Set(["互联网", "交易平台", "因特网", "电商平台", "社交平台", "网络平台"]);
export const ADMIN_LEVEL = {
  "省": 0,
  "自治区": 0,
  "自治州": 1,
  "市": 1,
  "区": 2,
  "县": 2,
  "街道": 3,
  "镇": 3,
  "乡": 3,
  "村": 4,
};
export const ADMIN_PART = rule("([\\u3400-\\u9fff]{1,6}?)(省|自治区|自治州|市|区|县|街道|镇|乡|村)");
export const ADMIN_END = rule("(?:省|自治区|自治州|市|区|县|街道|镇|乡|村)$");
export const ADDRESS_EDGE = rule("$|[\\s、，。；！？,.;!?）)》]|范围|境内|附近|辖内|办理|设立|登记");
export const DELIVERY_SITE_END = rule("(?:大道|街道|路|街|巷|弄|(?:小区|社区|花园|公寓|大厦|广场|家园|新村|园区|苑)|\\d号)$");
export const ADDRESS_SITE = rule("[\\u3400-\\u9fff0-9]{1,12}?(?:大道|路|街|巷)[\\u3400-\\u9fffA-Za-z0-9]{0,8}?(?:营业厅|服务大厅|办事大厅)");
export const PLACE_SEPARATOR = rule("^(?:的|由|向|对|从|与|以及|位于|经营|征收|批准|设立|申请|实施|人民政府)");
