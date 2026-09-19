# Element Plus 上传组件用例：点击 Click to upload 上传本地图片

> 本文件是 pageqa 的自然语言测试脚本。`# ` 标题与本节说明会被忽略，只有 `## ` 场景下的内容会被执行。
> 前置：bsk daemon 已连接一个真实浏览器；本地文件 `D:\Downloads\二维码.png` 存在。

## U1 点击 Click to upload 上传文件并校验文件出现在上传列表

打开 https://element-plus.org/zh-CN/component/upload
读取页面内容，确认已进入 Element Plus 的 Upload 上传组件文档页
在「基础用法」示例中定位显示「Click to upload」的上传触发按钮
点击该「Click to upload」按钮并上传本地文件 D:\Downloads\二维码.png（用 upload 工具把该按钮作为触发元素，不要单独 click，否则会弹出无法自动化的系统文件选择框）
等待 2 秒，让上传列表完成渲染
断言页面中已出现上传的文件名 二维码.png
