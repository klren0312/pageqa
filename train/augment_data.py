#!/usr/bin/env python3
"""
为「强化 assert_text 调用 + 步骤完成度」监督而做的数据增强。

做法：复用真实训练数据里的系统提示词与消息风格，手工构造一批「正确轨迹」，
每条都明确演示：
  - 每个「断言 …」都必须真的调用一次 [toolCall] assert_text {...}；
  - 每完成一步记「第 k 步完成：…」；
  - 结尾单独输出「步骤完成：k/n」；
  - 多步交互（fill / select_option / pick_date / click）之后才断言，不提前收尾。

输出到 train/data/augmented.jsonl（独立文件，不动 sessions.jsonl）：
export-sessions.mjs 每次导出会覆盖 sessions.jsonl，若直接追加合成数据会被抹掉；
prepare_data.py 会主动合并 augmented.jsonl，两者解耦且不会重复计数。
"""
import json
import os

# 以脚本自身位置推导项目根（与 filter_sessions.py 一致），避免硬编码绝对路径，
# 换机器 / 换盘符即失效的问题。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "train", "data")
SESSIONS = os.path.join(BASE, "sessions.jsonl")

if not os.path.exists(SESSIONS):
    raise SystemExit(
        f"[augment] 找不到 {SESSIONS}\n"
        f"请先运行：pnpm build && node scripts/export-sessions.mjs --out train/data/sessions.jsonl"
    )

os.makedirs(BASE, exist_ok=True)

# 取已有数据的真实系统提示词，保证分布一致
with open(SESSIONS, encoding="utf-8") as f:
    first = json.loads(f.readline())
SYS = next(m["content"] for m in first["messages"] if m["role"] == "system")


def tool_result(nav_url):
    return (
        f"已导航到 {nav_url}\ntab=1700000001 reached=domcontentloaded\nurl={nav_url}\n"
    )


def snap(elements):
    head = "【动作后的可交互元素】 @vom 1 @view 1419x812 @layers 1 focus=L1 L1 page\n RootWebArea \"Form 表单 | Element Plus\"\n"
    return head + "\n".join(elements) + "\n"


def waited(text, ms=12):
    return f"等待「文本「{text}」」：已达成（等待 {ms}ms）"


def asserted(text, ok=True):
    if ok:
        return f"断言「{text}」：成立。页面中包含「{text}」"
    return f"断言「{text}」：不成立。页面中不包含「{text}」"


def pick_result(date):
    return f"已选择日期 {date}（落点：textbox「Activity time」） picker ok tab=1700000001"


def select_result(opt):
    return f"已选择「{opt}」（落点：button「please select your zone」） click ok tab=1700000001"


def fill_result(val):
    return f"已在输入框填入「{val}」（落点：textbox） input ok tab=1700000001"


def click_result(label):
    return f"已点击「{label}」（落点：button） click ok tab=1700000001"


URL = "https://element-plus.org/zh-CN/component/form"

# 每条 session 的 messages 构造器
def s_form_structure():
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content":
         "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
         "### 步骤 2：读取页面内容\n"
         "### 步骤 3：断言标题包含 表单\n"
         "### 步骤 4：断言页面出现 Activity name\n"
         "### 步骤 5：断言页面出现 Instant delivery"},
        {"role": "assistant", "content":
         "I'll open the page first.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Now read the page.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e1 heading \"Form 表单\"",
            "@e2 textbox \"Activity name\"",
            "@e3 checkbox \"Instant delivery\"",
            "@e4 button \"Create\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开并读到 Form 表单内容。下面逐条断言。\n"
         "[toolCall] assert_text {\"expectation\":\"表单\"}"},
        {"role": "tool", "content": asserted("表单")},
        {"role": "assistant", "content":
         "第3步完成：标题包含「表单」成立。\n[toolCall] assert_text {\"expectation\":\"Activity name\"}"},
        {"role": "tool", "content": asserted("Activity name")},
        {"role": "assistant", "content":
         "第4步完成：页面出现 Activity name 成立。\n[toolCall] assert_text {\"expectation\":\"Instant delivery\"}"},
        {"role": "tool", "content": asserted("Instant delivery")},
        {"role": "assistant", "content":
         "第5步完成：页面出现 Instant delivery 成立。\n步骤完成：5/5"},
    ]


def s_validation():
    case = (
        "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：点击「Create」按钮提交空表单\n"
        "### 步骤 4：等到页面出现 Please select Activity zone\n"
        "### 步骤 5：断言页面出现 Please select Activity zone"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the page.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Read page and locate the Create button.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e2 textbox \"Activity name\"", "@e4 button \"Create\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。点击 Create 提交空表单。\n[toolCall] click {\"target\":\"@e4\"}"},
        {"role": "tool", "content": click_result("Create")},
        {"role": "assistant", "content":
         "第3步完成：已点击 Create。等待校验提示出现。\n[toolCall] wait_for {\"text\":\"Please select Activity zone\"}"},
        {"role": "tool", "content": waited("Please select Activity zone")},
        {"role": "assistant", "content":
         "第4步完成：页面出现 Please select Activity zone。现在断言它存在。\n[toolCall] assert_text {\"expectation\":\"Please select Activity zone\"}"},
        {"role": "tool", "content": asserted("Please select Activity zone")},
        {"role": "assistant", "content":
         "第5步完成：断言成立。\n步骤完成：5/5"},
    ]


def s_dropdown():
    case = (
        "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：在「Activity zone」下拉框选择 Zone one\n"
        "### 步骤 4：等到页面出现 Zone one\n"
        "### 步骤 5：断言页面出现 Zone one"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the page.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Read page and locate the zone dropdown.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e2 textbox \"Activity name\"", "@e7 combobox \"Activity zone\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。用 select_option 选 Zone one。\n"
         "[toolCall] select_option {\"target\":\"@e7\",\"option\":\"Zone one\"}"},
        {"role": "tool", "content": select_result("Zone one")},
        {"role": "assistant", "content":
         "第3步完成：已选择 Zone one。等待回显。\n[toolCall] wait_for {\"text\":\"Zone one\"}"},
        {"role": "tool", "content": waited("Zone one")},
        {"role": "assistant", "content":
         "第4步完成：页面出现 Zone one。现在断言它存在。\n[toolCall] assert_text {\"expectation\":\"Zone one\"}"},
        {"role": "tool", "content": asserted("Zone one")},
        {"role": "assistant", "content":
         "第5步完成：断言成立。\n步骤完成：5/5"},
    ]


def s_date():
    case = (
        "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：在「Activity time」选择 2026-10-15\n"
        "### 步骤 4：等到页面出现 2026-10-15\n"
        "### 步骤 5：断言页面出现 2026-10-15"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the page.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Read page and locate the date input.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e2 textbox \"Activity name\"", "@e9 textbox \"Activity time\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。用 pick_date 选日期。\n"
         "[toolCall] pick_date {\"target\":\"@e9\",\"date\":\"2026-10-15\"}"},
        {"role": "tool", "content": pick_result("2026-10-15")},
        {"role": "assistant", "content":
         "第3步完成：已选择 2026-10-15。等待回显。\n[toolCall] wait_for {\"text\":\"2026-10-15\"}"},
        {"role": "tool", "content": waited("2026-10-15")},
        {"role": "assistant", "content":
         "第4步完成：页面出现 2026-10-15。现在断言它存在。\n[toolCall] assert_text {\"expectation\":\"2026-10-15\"}"},
        {"role": "tool", "content": asserted("2026-10-15")},
        {"role": "assistant", "content":
         "第5步完成：断言成立。\n步骤完成：5/5"},
    ]


def s_combined():
    case = (
        "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：在「Activity name」填写 自动化测试活动\n"
        "### 步骤 4：在「Activity zone」下拉框选择 Zone two\n"
        "### 步骤 5：在「Activity form」填写 这是一次自动化填写\n"
        "### 步骤 6：等到页面出现 Zone two\n"
        "### 步骤 7：断言页面出现 Zone two"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the page.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Read page and locate the fields.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e2 textbox \"Activity name\"", "@e7 combobox \"Activity zone\"",
            "@e10 textbox \"Activity form\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。填写 Activity name。\n"
         "[toolCall] fill {\"target\":\"@e2\",\"value\":\"自动化测试活动\"}"},
        {"role": "tool", "content": fill_result("自动化测试活动")},
        {"role": "assistant", "content":
         "第3步完成：已填写名称。选择 Zone two。\n"
         "[toolCall] select_option {\"target\":\"@e7\",\"option\":\"Zone two\"}"},
        {"role": "tool", "content": select_result("Zone two")},
        {"role": "assistant", "content":
         "第4步完成：已选 Zone two。填写 Activity form。\n"
         "[toolCall] fill {\"target\":\"@e10\",\"value\":\"这是一次自动化填写\"}"},
        {"role": "tool", "content": fill_result("这是一次自动化填写")},
        {"role": "assistant", "content":
         "第5步完成：已填写表单。等待 Zone two 回显。\n[toolCall] wait_for {\"text\":\"Zone two\"}"},
        {"role": "tool", "content": waited("Zone two")},
        {"role": "assistant", "content":
         "第6步完成：页面出现 Zone two。现在断言它存在。\n[toolCall] assert_text {\"expectation\":\"Zone two\"}"},
        {"role": "tool", "content": asserted("Zone two")},
        {"role": "assistant", "content":
         "第7步完成：断言成立。\n步骤完成：7/7"},
    ]


def s_generic_title():
    u = "https://example.com/docs"
    case = (
        "### 步骤 1：打开 https://example.com/docs\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：断言标题包含 Documentation"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the docs page.\n[toolCall] navigate {\"url\":\"https://example.com/docs\"}"},
        {"role": "tool", "content": tool_result(u)},
        {"role": "assistant", "content":
         "Read the page.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e1 heading \"Documentation\"", "@e2 link \"Getting Started\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。断言标题包含 Documentation。\n"
         "[toolCall] assert_text {\"expectation\":\"Documentation\"}"},
        {"role": "tool", "content": asserted("Documentation")},
        {"role": "assistant", "content":
         "第3步完成：断言成立。\n步骤完成：3/3"},
    ]


def s_generic_search():
    u = "https://example.com/search"
    case = (
        "### 步骤 1：打开 https://example.com/search\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：在搜索框填写 qwen\n"
        "### 步骤 4：点击搜索按钮\n"
        "### 步骤 5：等到页面出现 搜索结果\n"
        "### 步骤 6：断言页面出现 搜索结果"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the search page.\n[toolCall] navigate {\"url\":\"https://example.com/search\"}"},
        {"role": "tool", "content": tool_result(u)},
        {"role": "assistant", "content":
         "Read page and locate the search box.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e1 textbox \"搜索\"", "@e2 button \"搜索\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。填写搜索词。\n[toolCall] fill {\"target\":\"@e1\",\"value\":\"qwen\"}"},
        {"role": "tool", "content": fill_result("qwen")},
        {"role": "assistant", "content":
         "第3步完成：已填写。点击搜索按钮。\n[toolCall] click {\"target\":\"@e2\"}"},
        {"role": "tool", "content": click_result("搜索")},
        {"role": "assistant", "content":
         "第4步完成：已点击搜索。等待结果。\n[toolCall] wait_for {\"text\":\"搜索结果\"}"},
        {"role": "tool", "content": waited("搜索结果")},
        {"role": "assistant", "content":
         "第5步完成：页面出现搜索结果。现在断言它存在。\n[toolCall] assert_text {\"expectation\":\"搜索结果\"}"},
        {"role": "tool", "content": asserted("搜索结果")},
        {"role": "assistant", "content":
         "第6步完成：断言成立。\n步骤完成：6/6"},
    ]


def s_generic_absent():
    u = "https://example.com/login"
    case = (
        "### 步骤 1：打开 https://example.com/login\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：断言页面不包含 404 Not Found"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the login page.\n[toolCall] navigate {\"url\":\"https://example.com/login\"}"},
        {"role": "tool", "content": tool_result(u)},
        {"role": "assistant", "content":
         "Read the page.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e1 textbox \"用户名\"", "@e2 textbox \"密码\"", "@e3 button \"登录\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。断言页面不包含 404 Not Found（absent=true）。\n"
         "[toolCall] assert_text {\"expectation\":\"404 Not Found\",\"absent\":true}"},
        {"role": "tool", "content": asserted("404 Not Found", ok=True)},
        {"role": "assistant", "content":
         "第3步完成：页面不包含该文本，断言成立。\n步骤完成：3/3"},
    ]


def s_multi_assert():
    case = (
        "### 步骤 1：打开 https://element-plus.org/zh-CN/component/form\n"
        "### 步骤 2：读取页面内容\n"
        "### 步骤 3：断言页面出现 Activity name\n"
        "### 步骤 4：断言页面出现 Activity zone\n"
        "### 步骤 5：断言页面出现 Create"
    )
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": case},
        {"role": "assistant", "content":
         "Open the page.\n[toolCall] navigate {\"url\":\"https://element-plus.org/zh-CN/component/form\"}"},
        {"role": "tool", "content": tool_result(URL)},
        {"role": "assistant", "content":
         "Read the page.\n[toolCall] snapshot {\"showPage\":true}"},
        {"role": "tool", "content": snap([
            "@e2 textbox \"Activity name\"", "@e7 combobox \"Activity zone\"", "@e4 button \"Create\"",
        ])},
        {"role": "assistant", "content":
         "第1、2步完成：页面已打开。逐条断言。\n[toolCall] assert_text {\"expectation\":\"Activity name\"}"},
        {"role": "tool", "content": asserted("Activity name")},
        {"role": "assistant", "content":
         "第3步完成：Activity name 成立。\n[toolCall] assert_text {\"expectation\":\"Activity zone\"}"},
        {"role": "tool", "content": asserted("Activity zone")},
        {"role": "assistant", "content":
         "第4步完成：Activity zone 成立。\n[toolCall] assert_text {\"expectation\":\"Create\"}"},
        {"role": "tool", "content": asserted("Create")},
        {"role": "assistant", "content":
         "第5步完成：Create 成立。\n步骤完成：5/5"},
    ]


BUILDERS = [
    s_form_structure, s_validation, s_dropdown, s_date, s_combined,
    s_generic_title, s_generic_search, s_generic_absent, s_multi_assert,
]

# 每个构造器复制 2 份（不同 id），增加 assert_text 监督密度
augmented = []
idx = 0
for b in BUILDERS:
    for copy in range(2):
        idx += 1
        augmented.append({
            "id": f"aug-assert-{idx:03d}",
            "model": "synthetic-assert-boost",
            "messages": b(),
        })

# 只写入持久化的增强文件；prepare_data.py 会自动把它并入训练集，
# 避免与「重新 export-sessions 覆盖 sessions.jsonl」冲突或重复计数。
with open(os.path.join(BASE, "augmented.jsonl"), "w", encoding="utf-8") as f:
    for rec in augmented:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

print(f"[augment] 写出 {len(augmented)} 条 assert_text/步骤完成度 强化轨迹 -> train/data/augmented.jsonl")
print(f"[augment] prepare_data.py 会自动并入，无需手动追加到 sessions.jsonl")
