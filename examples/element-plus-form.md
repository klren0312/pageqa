# Element Plus 表单组件文档页测试用例

> 被测页面：https://element-plus.org/zh-CN/component/form （Element Plus 官方 Form 组件文档，含可交互的实时 demo）。
> 目标：覆盖「页面打开 / 标题与结构断言」「必填校验」「下拉选择回填」「日期选择回填」「组合填写提交」等核心表单交互。
> 说明：该页是 Vue 单页应用，所有 demo 在加载后真实渲染，可直接用可见文本定位；断言一律挑只在表单区域印出的文案（label、校验提示、下拉回显），不拿侧边栏导航上的字当断言。

## 打开表单文档页与结构断言

打开 https://element-plus.org/zh-CN/component/form
读取页面内容
断言标题包含 表单
断言页面出现 Activity name
断言页面出现 Instant delivery

> `Activity name` 与 `Instant delivery` 是「典型表单」demo 里印在页面上的字段 label，侧边栏没有，能确认典型表单 demo 已渲染。
> 标题断言只比侧边栏更可靠：`表单` 二字侧边栏也印着，所以用「标题包含」而非「页面出现」，避免路由没切对也被判通过。

## 表单校验：空提交触发必填提示

打开 https://element-plus.org/zh-CN/component/form
读取页面内容
点击包含「Activity count」字段的表单中的「Create」按钮
等到页面出现 Please select Activity zone
断言页面出现 Please select Activity zone

> 页面里第一个「典型表单」demo 的 Create 按钮只打印日志，不带校验；带 rules 的是它下方的「表单校验」demo，该 demo 多了「Activity count」字段，用它定位可区分两个 Create 按钮。
> 注意：官方这个 demo 的 `Activity name` 字段**预填了 `Hello`**，空提交时不会报名字错误；真正报错的是空的必填项 `Activity zone`，渲染 message `Please select Activity zone`，该文案仅在校验失败时出现在页面上。
> 等待用条件等待而非固定秒数：校验是同步渲染，但等一下更稳，且回放脚本里条件一成立就继续。

## 下拉选择回填

打开 https://element-plus.org/zh-CN/component/form
读取页面内容
点击「Activity zone」下拉框，在展开的选项中点击选择 Zone one
等到页面出现 Zone one
断言页面出现 Zone one

> 下拉**不是**文本框，所以用「点击下拉框 → 在展开选项中点选」的写法，不能写「填入」。
> 选中后 el-select 的显示区会回显选中的 label `Zone one`，这是能字面匹配的文本，证明选择生效。
> 注意：典型表单 demo 的选项 label 是 `Zone one` / `Zone two`（英文），不是「区域一」，写错会选不到。

## 日期选择回填

打开 https://element-plus.org/zh-CN/component/form
读取页面内容
在「Activity time」选择 ${timestamp:yyyy-MM-dd}
等到页面出现 ${timestamp:yyyy-MM-dd}
断言页面出现 ${timestamp:yyyy-MM-dd}

> `Activity time` 是日期选择器的字段 label；选中后输入框回显 `yyyy-MM-dd`（如 2026-10-15），可字面匹配。
> 用 `${timestamp:yyyy-MM-dd}` 占位符，每次运行按本机日期展开为带连字符的格式，避免与输入框回显对不上。

## 组合填写与提交

打开 https://element-plus.org/zh-CN/component/form
读取页面内容
在「Activity name」输入框填写 自动化测试活动${timestamp}
点击「Activity zone」下拉框，在展开的选项中点击选择 Zone two
在「Activity form」多行输入框填写 这是一次由 pageqa 驱动的自动化填写
等到页面出现 Zone two
断言页面出现 Zone two

> 组合场景：先填文本字段（用 `填写`，多行文本框同样用 `填写`，不是「填入」），再选下拉，验证多项交互互不干扰。
> 选择 `Zone two` 后其 label 会回显在页面，作为本场景唯一断言，证明整条填写链路走到下拉这步时状态正确。
> `${timestamp}` 让活动名称带时间戳，避免重复名；此处不把活动名称的值当断言（输入框 value 不在快照文本里，强行断言会变成自证的「永远成立」）。
