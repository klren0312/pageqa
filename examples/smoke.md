# 页面测试套件示例

用 `## ` 分隔多个测试场景，CLI 会逐个运行并汇总整体结论与退出码。

## A1 打开页面并断言标题
打开 https://example.com 并断言标题包含 Example

## A2 交互流程（点击链接 + 等待 + 断言）
打开 https://example.com 。点击页面上的「Learn more」链接，等待页面加载，然后断言页面包含 'IANA'。

## A3 失败场景（断言不存在文本）
打开 https://example.com 并断言页面包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'
