# 小程序冒烟套件示例（--driver miniprogram）

> 用 `## ` 分隔多个测试场景，CLI 会逐个运行并汇总整体结论与退出码。
> 小程序用例与 Web 用例的唯一区别：导航写成 `mp://页面路由`（伪协议），
> 其余动词（打开 / 点击 / 断言包含 / 断言不包含）完全一致。

## M1 打开首页并断言欢迎文案
打开 mp://pages/index/index 并断言页面包含 '欢迎'

## M2 交互：点击按钮并断言结果
打开 mp://pages/index/index 。点击页面上的「开始」按钮，然后断言页面包含 '已开启'。

## M3 断言不存在文本
打开 mp://pages/index/index 并断言页面不包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'
