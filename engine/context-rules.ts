/** Pattern sources and labels from the Python case_context reference. */
import { rule } from './text.js';

export const ALIAS_SUFFIX = rule("[（(]\\s*(?:以下)?简称[：:]?\\s*([^）)\\r\\n]{2,30})[）)]");
export const PERSON_ALIAS = rule("([\\u3400-\\u9fff](?:总|经理|主任|老师|师傅|老板|律师))\\s*(?:就是|是)\\s*(?:项目负责人|公司负责人|负责人|经办人)?");
export const FORMER_NAME = rule("(?:曾用名|原名|以前叫|绰号|外号|小名|网名|(?:微信|聊天)?昵称|显示名|备注名)(?:叫|为|是|[：:])?");
export const ALIAS_VALUE = rule("[“\"「]([^，。；！？\\r\\n”\"」]{1,24})[”\"」]|([\\w·・-]{2,12})");
export const STATEMENT_FOLLOWUP = rule("\\s*(?:(?:(?:这|该|此|上述)(?:一|个|种)?)?(?:说法|陈述|结论)|(?:并)?不属实|有待核实|尚未证实|无法确认|(?:更正|纠正)(?=\\s*[：:，,。]|\\s*$)|(?:刚才|前面|此前|上述)(?:的?(?:说法|陈述|内容))?(?:有误|说错了|不准确))");
export const UNCERTAIN_ASSERTION = rule("或者|或是|抑或|还是|(?:^|[，,：:\\s])或|[记说]不[清准]|不(?:确定|清楚|知道|记得)|拿不准|可能");
export const FOLLOWUP_CHOICE = rule("[ \\t]*(?:或者|或是|抑或|还是)");
export const CLAUSE = rule("[^，,。；;！!？?\\r\\n]+[。！？!?；;]?");
export const NEGATED = rule("不是|并非|没有|从未|不认识|未使用|否认|没用|不知道|不清楚");
export const NON_ASSERTION = rule("不是|并非|否认|是否|是不是|会不会|可能|假如|假设|如果|怀疑|谁|什么|[吗么呢](?=[，,。！？!?；;]|$)");
export const SENTENCE = rule("[^。！？!?；;\\r\\n]+[。！？!?；;]?");
export const WEAK_TITLE = rule("[\\u3400-\\u9fff](?:总|经理|主任|老师|师傅|老板|律师)");
export const TITLE_ORG = rule("(?P<unit>[\\u3400-\\u9fffA-Za-z0-9]{1,24}(?:公司|集团|事务所|分行|支行|中心|分校|工厂|研究院|协会|店|医院|委员会|合作社))的?$");
export const LABEL_BEFORE_ID = rule("^[\\s，,；;|｜]*(?:(?:公民身份号码|身份证号码?|证件号码?)\\s*[：:]\\s*)?$");
export const REPORTED = rule("转述|听说|据说|听.{1,8}说|猜测|推测");
export const DISPUTED = rule("(?:否认|质疑|更正|撤回|推翻).{0,6}(?:这|该|上述|此前)(?:种|一|个)?(?:说法|陈述|认定)");
export const TOPIC = rule("(?:昵称|网名|别称|曾用名|原名|称呼|身份|号码|登记|使用|地址|金额)");
export const SHORT_REPLY = rule("[ \\t]*(?:我是|我叫|是|叫)?[“\"「]?([\\u3400-\\u9fff·]{2,4})[”\"」]?[。！! \\t]*");
