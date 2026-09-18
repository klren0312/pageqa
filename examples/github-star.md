# GitHub 仓库 Star 用例：klren0312/pageqa

> 本文件是 pageqa 的自然语言测试脚本。`# ` 标题与本节说明会被忽略，只有 `## ` 场景下的内容会被执行。
> 前置：bsk daemon 已连接一个**已登录 GitHub** 的真实浏览器；未登录时 Star 会跳转登录页，G2 将 FAIL。

## G1 打开仓库页并校验内容

打开 https://github.com/klren0312/pageqa
读取页面内容
断言标题包含 pageqa
断言页面包含 klren0312/pageqa

## G2 为仓库点 Star（幂等）

打开 https://github.com/klren0312/pageqa
读取页面内容，定位页面右上角的星标按钮（当前显示为「Star」或「Starred」）
如果星标按钮显示「Star」，点击它并等待 2 秒
如果星标按钮已经显示「Starred」，跳过点击，直接进入断言
断言星标按钮当前显示为「Starred」
