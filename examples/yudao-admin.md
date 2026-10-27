---
miniprogram:
  # 必须是编译产物目录（含 project.config.json），不是 uni-app 源码根
  projectPath: D:\1project\yudao-ui-admin-uniapp\dist\dev\mp-weixin
---

# 芋道管理后台小程序冒烟套件（--driver miniprogram）

> 用例头（frontmatter）里的 projectPath 就是这份用例要跑的小程序项目：
> 它覆盖 ~/.pageqa/config.json 与 PAGEQA_MINIPROGRAM_PROJECT_PATH，
> 换项目只改这里，不用再动配置文件。
> cliPath 没写时沿用配置/环境变量里的微信开发者工具 CLI 路径。
> 导航一律用 mp://页面路由 伪协议；出现 mp:// 会自动切到小程序驱动。

## W1 打开工作台并断言标题
打开 mp://pages/index/index 并断言页面包含 '工作台'

## W2 工作台加载用户与菜单区
打开 mp://pages/index/index
读取页面内容
等到页面出现 '工作台'
断言页面包含 '工作台'

## W3 从工作台进入搜索页并断言
打开 mp://pages/index/index
读取页面内容
等到页面出现 '工作台'
点击页面上的「搜索」图标
等到页面出现 '搜索'
断言页面包含 '搜索'

## W4 反向断言：不存在的占位文本
打开 mp://pages/index/index 并断言页面不包含 'THIS_TEXT_SHOULD_NOT_EXIST_XYZ'
