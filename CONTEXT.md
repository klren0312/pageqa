# pageqa

用自然语言描述页面测试意图，由 LLM 驱动真实浏览器执行；跑通之后可以把操作序列固化成回放脚本，之后零模型重跑同一条用例。

## Language

**用例（Case）**：
一段用自然语言描述页面测试意图的文本，按非空行拆成若干步骤。
_Avoid_：测试脚本、case 文件

**场景（Scenario）**：
用例文件中由 `## 标题` 分隔的独立运行单元，拥有独立的 bsk session 与浏览器窗口，也是回放的独立执行单元。
_Avoid_：测试集、suite 项

**用例步骤（Case Step）**：
用例中的一个非空行（`#`、`>` 行除外），运行前由 pageqa 统一编号为「第 k 步」。
_Avoid_：指令、命令行

**动作（Action）**：
一次浏览器操作（navigate / click / fill / upload / hover / scroll / wait），是回放脚本的最小执行单位。
_Avoid_：操作指令、tool call

**断言（Assertion）**：
对页面内容的校验，决定场景结论是 PASS 还是 FAIL。
_Avoid_：检查点、验证点

**录制（Recording）**：
一次带模型的运行中，把成功执行过的动作与断言记下来的过程。
_Avoid_：抓取、采集

**回放脚本（Replay Script）**：
从一次录制固化出来的、可零模型重跑的步骤序列。
_Avoid_：执行脚本、录制文件、trace、固化脚本

**回放（Replay）**：
按回放脚本逐步驱动浏览器，全程不调用任何大模型。
_Avoid_：重跑、执行脚本

**定位符（Locator）**：
元素的可复用语义描述：角色 + 可访问名 + 同名序号。
_Avoid_：选择器、xpath、ref
