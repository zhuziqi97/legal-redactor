/** Pattern sources and labels from the Python case_fields reference. */
import { rule } from './text.js';

export const REFERENCE_IDS = new Set(['设备编号', '设备号', '流水号', '业务流水号', '交易流水号']);
export const FIELD_TYPES: Record<string, string> = {
  "姓名": "person",
  "被询问人": "person",
  "被讯问人": "person",
  "询问人": "person",
  "讯问人": "person",
  "记录人": "person",
  "法定代表人": "person",
  "经办人": "person",
  "联系人": "person",
  "签名": "person",
  "签字": "person",
  "签署人": "person",
  "签名人": "person",
  "签字人": "person",
  "甲方": "party",
  "乙方": "party",
  "甲方名称": "party",
  "乙方名称": "party",
  "单位名称": "organization",
  "债权人名称": "party",
  "房号": "address",
  "户名": "party",
  "账户名称": "party",
  "对方户名": "party",
  "交易对手": "party",
  "开户名": "party",
  "身份证号": "id_card",
  "身份证号码": "id_card",
  "公民身份号码": "id_card",
  "证件号码": "id_card",
  "证件号": "id_card",
  "手机号": "mobile",
  "手机号码": "mobile",
  "电话": "mobile",
  "联系电话": "mobile",
  "联系人电话": "mobile",
  "手机": "mobile",
  "联系方式": "mobile",
  "座机": "mobile",
  "电话号码": "mobile",
  "开户账号": "bank_account",
  "收款账号": "bank_account",
  "账号": "bank_account",
  "账户账号": "bank_account",
  "对方账号": "bank_account",
  "银行账号": "bank_account",
  "银行卡号": "bank_account",
  "账号尾号": "tail",
  "银行卡尾号": "tail",
  "尾号": "tail",
  "案号": "case_number",
  "住址": "address",
  "地址": "address",
  "送达地址": "address",
  "现住址": "address",
  "户籍地址": "address",
  "居住地址": "address",
  "住所": "address",
  "住所地": "address",
  "微信号": "social",
  "微信账号": "social",
  "微信昵称": "nickname",
  "昵称": "nickname",
  "联系人备注": "nickname",
  "发言者": "nickname",
  "通话方": "nickname",
  "交易日期": "keep",
  "交易时间": "keep",
  "日期": "keep",
  "时间": "keep",
  "金额": "keep",
  "交易金额": "keep",
  "借方发生额": "keep",
  "贷方发生额": "keep",
  "收入": "keep",
  "支出": "keep",
  "余额": "keep",
  "方向": "keep",
  "借贷方向": "keep",
  ...Object.fromEntries([...REFERENCE_IDS].map(label => [label, 'keep'])),
};
export const NAME = "[\\u3400-\\u9fff]{2,6}(?:[·・][\\u3400-\\u9fff]{1,8})*";
export const ORG = "公司|集团|事务所|分行|支行|中心|分校|工厂|研究院|协会|店|医院|委员会|合作社";
export const ORG_END = rule("(分公司|公司|集团|分行|支行|银行|分校|大学|学院|学校|医院|事务所|法院|检察院|委员会|政府|研究院|中心|协会|合作社|工厂|门店|店|平台|网|系)$");
export const TITLE = rule("[\\u3400-\\u9fff](?:总|经理|主任|老师|师傅|老板|律师)|[\\u3400-\\u9fff]某(?:[甲乙丙丁0-9]+)?");
export const ROLE = rule("甲方|乙方|原告|被告|询问人|被询问人|讯问人|被讯问人|记录人|法定代表人|经办人|本人|客户|客服|卖方|买方|负责人|联系人|证人|工作人员|民警|法官");
export const EMPTY = new Set(["", "-", "/", "—", "不详", "同上", "无", "未填写", "未提供", "未知", "未记载"]);
export const STRUCTURAL: Record<string, string> = {
  id_card: "id_card",
  mobile: "mobile",
  landline: "mobile",
  bank_account: "bank_account",
  case_number: "case_number",
  wechat_qq: "social",
  email: "email",
};
export const LABEL = rule(
  "(?<![A-Za-z0-9_])(" + Object.keys(FIELD_TYPES).sort((a, b) => b.length - a.length).join('|') + ")[ \\t　]*[：:]",
);
export const CHAT = rule("^\\s*(?:(?:\\[)?(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}[ T]+)?\\d{1,2}:\\d\\d(?::\\d\\d)?(?:\\])?\\s+)([^：:\\n]{1,32})[：:]");
export const BARE_CHAT = rule("^\\s*([^：:\\n]{1,24})[：:]");
export const CHAT_HEADING = rule("^\\s*(?:[【\\[（#]+\\s*)?(?:微信|聊天|通话)(?:记录|节录|摘录|内容)");
export const HEADING = rule("^\\s*(?:[【\\[（#]+\\s*[^：:\\n]{2,35}[】\\]）]|#{1,6}\\s+[^：:\\n]+)\\s*$");
export const DATE_TIME = "(?:\\d{4}(?:[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\\d|3[01])(?!\\d)|年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\\d|3[01])(?!\\d)日?)|\\d{1,2}:\\d\\d(?::\\d\\d)?)";
export const AMOUNT_FIELD = rule("(?:[￥¥]\\s*)?[+−-]?(?:\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.\\d+)?(?!\\d|\\.\\d)\\s*(?:(?:亿元|万元|元|%))?");
export const DATE_AMOUNT = rule("(?<!\\d)(?:(?:\\d{4}(?:[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\\d|3[01])(?!\\d)|年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\\d|3[01])(?!\\d)日?)|\\d{1,2}:\\d\\d(?::\\d\\d)?)(?!\\d)|\\d{4}年|[￥¥]\\s*(?:\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.\\d+)?(?!\\d|\\.\\d)|(?:\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.\\d+)?\\s*(?:亿元|万元|元|%))");
export const CSV_CELL = rule("(\"(?:[^\"]|\"\")*\"|[^,\"\\r\\n\\f]*)(?=[,\\r\\n\\f]|$)");
export const RECORD_END = rule("\\r\\n|[\\r\\n\\f]");
export const FIELD_END = rule("[。；;！!？?\\r\\n|｜\\t]");
export const NUMBER_GROUP = rule("[0-9xX*×]+(?:[ \\t　－—-]+[0-9xX*×]+)*");
export const INTERNATIONAL = rule("(?<![0-9A-Za-z])(?:\\+|00)[0-9]{1,3}[ \\t　－—-]*(?:[（(][0-9]{1,5}[）)][ \\t　－—-]*)?[0-9xX*×]+(?:[ \\t　－—-]+[0-9xX*×]+)*");
const INTERNATIONAL_NUMBER = rule("(?:(?:[+＋]|00)[0-9]{1,3}[ \\t　－—-]*)?(?:[（(][0-9]{1,5}[）)][ \\t　－—-]*)?[0-9xX*×]+(?:[ \\t　－—-]+[0-9xX*×]+)*");
export const GROUPED_CARD = rule("\\d{4}(?:[ \\t　－—-]+\\d{4}){3}(?:[ \\t　－—-]+\\d{3})?");
export const ADDRESS_CONTINUATION = rule("\\s*(?:[\\u3400-\\u9fff]{1,8}(?:省|市|县|区|镇|乡|街道|路|街|巷|村)|\\d+[A-Za-z]?(?:号|栋|楼|层|单元|室|房))");
export const ADDRESS_DETAIL = rule("(?:(?:[0-9A-Za-z]+(?:号楼|号|楼|栋|幢|层|单元|座|室|房)|[零〇一二两三四五六七八九十百]+(?:楼|层|栋|幢|单元|室)|[东西南北中](?:区|楼|栋|座|单元))[ \\t]*)+(?:\\d{1,6})?");
export const TAIL = rule("(?:尾号|后四位)(?:为|是|[：:]\\s*)?\\s*([0-9]{4})(?![0-9])");
export const PARTY_DEFINITION = rule("^\\s*(甲方|乙方)\\s*(?:系|为)\\s*([^，。；;\\r\\n]+)");
export const TURN = rule("^\\s*(问话|答话|问|答)\\s*[：:]");
export const PERSON_VALUE = rule("(?:[\\u3400-\\u9fff]{2,4}|[\\u3400-\\u9fff]{1,8}(?:[·・][\\u3400-\\u9fff]{1,8})+|[A-Za-z]+(?:[ .'-][A-Za-z]+)*)");
export const PERSON_NOTE = rule("代签|签字|不详|未签|本人|由.+|疑为|已更名");
export const VALUE_PATTERNS: Record<string, ReturnType<typeof rule>> = {
  mobile: INTERNATIONAL_NUMBER,
  bank_account: NUMBER_GROUP,
  tail: NUMBER_GROUP,
  id_card: NUMBER_GROUP,
  social: rule("[A-Za-z0-9_][A-Za-z0-9_-]*"),
};
export const VALUE_LENGTHS: Record<string, [number, number]> = {
  mobile: [4, 15],
  bank_account: [4, 22],
  tail: [4, 4],
  id_card: [8, 24],
};
export const DEVICE_VALUE = rule("[A-Za-z0-9][A-Za-z0-9_/:：-]*(?:[ \\t　]+[A-Za-z0-9][A-Za-z0-9_/:：-]*)*");
export const SIGNATURE_LABELS = new Set(["签名", "签名人", "签字", "签字人", "签署人"]);
export const SIGN_ROLE = "(?:甲方|乙方|原告|被告|询问人|被询问人|讯问人|被讯问人|记录人|法定代表人|经办人|本人|客户|客服|卖方|买方|负责人|联系人|证人|工作人员|民警|法官|当事人|代理人|家属|见证人)";
export const SIGN_STATUS = rule("(?:(?:(?:甲方|乙方|原告|被告|询问人|被询问人|讯问人|被讯问人|记录人|法定代表人|经办人|本人|客户|客服|卖方|买方|负责人|联系人|证人|工作人员|民警|法官|当事人|代理人|家属|见证人))\\s*)?(?:(?:已经|已|尚未|未能|未|没有|没)?(?:拒绝|拒不|不愿|不能|无法|不|拒|补|代|亲自)?(?:在(?:本页|笔录|记录|文书)上)?(?:签字|签名|签署|签收|签章|签认|捺印|按手印|签)|(?:已阅|已核对|核对)(?:无误)?)");
export const SIGN_VERB_END = rule("(?:(?:已经|已|尚未|未能|未|没有|没)?(?:拒绝|拒不|不愿|不能|无法|不|拒|补|代|亲自)?(?:在(?:本页|笔录|记录|文书)上)?(?:签字|签名|签署|签收|签章|签认|捺印|按手印|签)|在场|到场|见证)$");
export const SIGN_ACTOR = rule("由?(?:甲方|乙方|原告|被告|询问人|被询问人|讯问人|被讯问人|记录人|法定代表人|经办人|本人|客户|客服|卖方|买方|负责人|联系人|证人|工作人员|民警|法官|当事人|代理人|家属|见证人)?\\s*(?P<name>(?:[\\u3400-\\u9fff]{2,4}|[\\u3400-\\u9fff]{1,8}(?:[·・][\\u3400-\\u9fff]{1,8})+|[A-Za-z]+(?:[ .'-][A-Za-z]+)*))");
export const SIGN_LIST = rule("[^，,、；;。！？!?（）()\\r\\n]+");
export const CASE_VALUE = rule("(?:[（(〔【]\\d{4}[）)〕】](?:[^（）()〔〕【】\\n]|[（(][一-鿿]{1,4}[）)]){0,20}?(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)(?:[^（）()〔〕【】\\n]|[（(][一-鿿]{1,4}[）)]){0,14}?\\d+号|[一-鿿]{2,16}仲[一-鿿]{0,6}[（(〔【]\\d{4}[）)〕】]第?\\d+号)|(?:\\d{4}[ \\t]*年?[ \\t]*)?(?:(?:最高法|[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼兵军港澳台])(?:\\d{2,6})?|[\\u3400-\\u9fff](?=(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)))(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)[\\u3400-\\u9fff]{0,5}\\d+号");
export const EXTENSION = rule("(?:分机(?:号)?[：:为]?|转)[ \\t]*([0-9]{1,6})(?!\\d)");
export const INLINE_IDENTIFIER = rule("(公民身份号码|身份证号码|联系人电话|银行卡尾号|身份证号|证件号码|手机号码|联系电话|联系方式|电话号码|开户账号|收款账号|账户账号|对方账号|银行账号|银行卡号|账号尾号|微信账号|证件号|手机号|微信号|电话|手机|座机|账号|尾号|案号)[ \\t]*(?:为|是)[ \\t]*(?=[+＋（(0-9A-Za-z*×]|(?:[（(〔【]\\d{4}[）)〕】](?:[^（）()〔〕【】\\n]|[（(][一-鿿]{1,4}[）)]){0,20}?(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)(?:[^（）()〔〕【】\\n]|[（(][一-鿿]{1,4}[）)]){0,14}?\\d+号|[一-鿿]{2,16}仲[一-鿿]{0,6}[（(〔【]\\d{4}[）)〕】]第?\\d+号)|(?:\\d{4}[ \\t]*年?[ \\t]*)?(?:(?:最高法|[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼兵军港澳台])(?:\\d{2,6})?|[\\u3400-\\u9fff](?=(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)))(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)[\\u3400-\\u9fff]{0,5}\\d+号)");
export const CONTACT_END = rule("[。！？!?\\r\\n|｜]");
export const NOTE = rule("[（(]([^()（）]*)[）)]");
export const NUMBER_KINDS = new Set(["bank_account", "id_card", "mobile", "number", "tail"]);
export const ADDRESS_PUNCT = rule("[（(）)，,、；;]|(?:后)?(?:(?:步行|开车|搬|迁|转|走|送)(?:到|至|往)|改寄|另寄)");
export const AREA = rule("([\\u3400-\\u9fff]{1,14}?)(自治区|自治州|自治县|省|市|地区|盟|旗|县|园区|社区|小区|区|街道|乡|镇|村)");
export const LEVEL = {
  "省": 0,
  "自治区": 0,
  "市": 1,
  "自治州": 1,
  "地区": 1,
  "盟": 1,
  "区": 2,
  "自治县": 2,
  "县": 2,
  "旗": 2,
  "园区": 3,
  "街道": 3,
  "乡": 3,
  "镇": 3,
  "社区": 4,
  "小区": 4,
  "村": 4,
};
export const ADDRESS_STATUS = rule("(?:(?:住址|地址|现址|去向|住所)(?:尚)?)?(?:不详|不明|未知|未提供|待核实)|无固定(?:住址|住所)|(?:已|已经)搬离");
export const ROUTED_ADDRESS = rule("(?:(?:另|改|转)(?:邮寄|寄|送达|送)(?:至|往|到)?|(?:邮寄|寄|送达|送)(?:至|往|到))\\s*");
export const ROAD_VALUE = rule("[\\u3400-\\u9fffA-Za-z0-9]+?(?:大道|街道|路|街|巷|弄)[ \\t]*\\d+(?:[-－]\\d+)?(?:号楼|号|弄)(?:(?:[0-9A-Za-z]+(?:号楼|号|楼|栋|幢|层|单元|座|室|房)|[零〇一二两三四五六七八九十百]+(?:楼|层|栋|幢|单元|室)|[东西南北中](?:区|楼|栋|座|单元)))*");
export const PREMISE = rule("([\\u3400-\\u9fffA-Za-z0-9]{1,18}?)((?:小区|社区|花园|公寓|大厦|广场|家园|新村|园区|苑))");
export const BUILDING = rule("(?:[0-9A-Za-z]+(?:号楼|号|楼|栋|幢|层|单元|座|室|房)|[零〇一二两三四五六七八九十百]+(?:楼|层|栋|幢|单元|室)|[东西南北中](?:区|楼|栋|座|单元))(?:[ \\t]*(?:[0-9A-Za-z]+(?:号楼|号|楼|栋|幢|层|单元|座|室|房)|[零〇一二两三四五六七八九十百]+(?:楼|层|栋|幢|单元|室)|[东西南北中](?:区|楼|栋|座|单元)))*");
export const ROOM_AFTER_BUILDING = rule("\\d{1,5}(?=$|[\\s，,、。；;！？!?（）()])");
export const NAMED_BUILDING = rule("[\\u3400-\\u9fff]{1,12}(?=[0-9A-Z]+(?:号楼|栋|幢|座|单元|室))");
export const ADDRESS_BREAK = rule("[，,、。；;！？!?（）()\\r\\n]|另寄|改寄|搬离|(?:步行|开车|搬|迁|转|走|送)(?:到|至|往)|已(?:经|搬|迁)|工作日|签收|收件|交付|交货|办理|登记|经营|收到|前往|随后|然后|转至");
export const HEADER_NAMES = new Set(["乙方", "乙方名称", "交易对手", "交易摘要", "交易日期", "交易时间", "交易类型", "交易金额", "住址", "住所", "余额", "借方发生额", "借贷方向", "公民身份号码", "单位名称", "发言者", "地址", "备注", "姓名", "对方户名", "对方账号", "尾号", "居住地址", "币种", "序号", "座机", "开户名", "开户行", "开户账号", "微信号", "微信昵称", "微信账号", "户名", "户籍地址", "手机", "手机号", "手机号码", "摘要", "支出", "收入", "收款账号", "方向", "日期", "时间", "昵称", "案号", "法定代表人", "渠道", "现住址", "用途", "甲方", "甲方名称", "电话", "电话号码", "签名", "签名人", "签字", "签字人", "签署人", "经办人", "联系人", "联系人备注", "联系人电话", "联系方式", "联系电话", "被讯问人", "被询问人", "讯问人", "记录人", "设备号", "设备编号", "证件号", "证件号码", "询问人", "账号", "账号尾号", "账户名称", "账户账号", "贷方发生额", "身份证号", "身份证号码", "送达地址", "通话方", "金额", "银行卡号", "银行卡尾号", "银行账号"]);
export const IDENTIFIER_FIELDS = new Set(["bank_account", "case_number", "id_card", "mobile", "social", "tail"]);
export const INTERVIEWEE = rule("^\\s*(?:被询问人|被讯问人)\\s*[：:]");
export const STREET_ADDRESS = rule("(?:[\\u3400-\\u9fff]{2,8}(?:省|自治区))?(?:[\\u3400-\\u9fff]{2,8}市|[\\u3400-\\u9fff]{2,8}(?:区|县))(?:[\\u3400-\\u9fff]{1,8}(?:区|县|旗|镇|街道)){0,3}[\\u3400-\\u9fff0-9]{1,16}(?:路|街|巷|大道|弄)\\s*[0-9]+(?:号楼|号|弄)(?:[0-9A-Za-z]+(?:号楼|号|楼|栋|幢|层|单元|座|室|房)){0,5}");
export const ADDRESS_INTRO = rule("位于|住在|送至|地址为|设在|居住[于的]|[该本](?:区|县|市|镇|村)|在|到了?|往|从|去");
export const DELIVERY_INTRO = rule("居住(?:在|于)|住在|住址为|地址为|位于|寄往|寄至|(?:步行|开车|搬|迁|转|走|送)(?:到了?|至|往)");
