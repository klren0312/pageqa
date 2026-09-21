# 冒烟测试页面实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个用于冒烟测试的示例页面，具备路由切换、表单填写、文件上传、提交表单等功能，并提供对应的 pageqa 测试用例文件。

**Architecture:** 单页面应用（SPA），使用原生 JavaScript 实现 Hash 路由系统，所有页面内容都在同一个 HTML 文件中通过路由切换显示。使用内联 CSS 和 JavaScript，无需构建工具或服务器支持。

**Tech Stack:** HTML5, CSS3, 原生 JavaScript（ES6+）

## Global Constraints

1. 页面必须可以直接在浏览器中打开（无需服务器）
2. 使用 Hash 路由（非 History 路由）
3. 使用原生文件上传（非组件库）
4. 提交表单后显示成功消息（不刷新页面）
5. 页面文件路径：`examples/smoke-test-page.html`
6. 测试用例文件路径：`examples/smoke-test.md`

---

## 文件结构

```
examples/
├── smoke-test-page.html   # 冒烟测试示例页面
└── smoke-test.md          # pageqa 测试用例文件
```

---

### Task 1: 创建 HTML 页面基础结构

**Files:**
- Create: `examples/smoke-test-page.html`

**Interfaces:**
- 页面包含导航栏、路由内容区域、页脚
- 使用 `data-route` 属性标识不同路由的内容

- [ ] **Step 1: 创建 HTML 文件基础结构**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>冒烟测试页面</title>
  <style>
    /* CSS 样式将在后续步骤中添加 */
  </style>
</head>
<body>
  <!-- 导航栏 -->
  <!-- 路由内容区域 -->
  <!-- 页脚 -->
  <script>
    // JavaScript 逻辑将在后续步骤中添加
  </script>
</body>
</html>
```

- [ ] **Step 2: 添加导航栏**

```html
<nav class="navbar">
  <a href="#/" class="nav-link" data-route="/">首页</a>
  <a href="#/form1" class="nav-link" data-route="/form1">表单页面 1</a>
  <a href="#/form2" class="nav-link" data-route="/form2">表单页面 2</a>
  <a href="#/upload" class="nav-link" data-route="/upload">文件上传</a>
</nav>
```

- [ ] **Step 3: 添加路由内容区域占位符**

```html
<main class="content">
  <section id="home" class="route-content" data-route="/">
    <h1>欢迎来到冒烟测试页面</h1>
    <p>请选择上方导航栏的页面开始测试。</p>
  </section>
  <section id="form1" class="route-content" data-route="/form1" style="display:none;">
    <!-- 表单页面 1 内容 -->
  </section>
  <section id="form2" class="route-content" data-route="/form2" style="display:none;">
    <!-- 表单页面 2 内容 -->
  </section>
  <section id="upload" class="route-content" data-route="/upload" style="display:none;">
    <!-- 文件上传页面内容 -->
  </section>
</main>
```

- [ ] **Step 4: 添加基础 CSS 样式**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #f5f5f5;
  color: #333;
  line-height: 1.6;
}

.navbar {
  background-color: #fff;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  padding: 1rem 2rem;
  display: flex;
  gap: 1rem;
}

.nav-link {
  text-decoration: none;
  color: #333;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  transition: background-color 0.3s;
}

.nav-link:hover {
  background-color: #e8e8e8;
}

.nav-link.active {
  background-color: #007bff;
  color: #fff;
}

.content {
  max-width: 800px;
  margin: 2rem auto;
  padding: 0 1rem;
}

.route-content {
  background-color: #fff;
  padding: 2rem;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

h1, h2 {
  margin-bottom: 1rem;
  color: #007bff;
}

.form-group {
  margin-bottom: 1.5rem;
}

label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}

input[type="text"],
input[type="email"],
input[type="date"],
select {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

input[type="text"]:focus,
input[type="email"]:focus,
input[type="date"]:focus,
select:focus {
  outline: none;
  border-color: #007bff;
}

.btn {
  background-color: #007bff;
  color: #fff;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: background-color 0.3s;
}

.btn:hover {
  background-color: #0056b3;
}

.btn:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}

.error {
  color: #dc3545;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

.success-message {
  background-color: #d4edda;
  color: #155724;
  padding: 1rem;
  border-radius: 4px;
  margin-top: 1rem;
}

.file-input-wrapper {
  margin-bottom: 1rem;
}

.file-list {
  margin-top: 1rem;
}

.file-item {
  background-color: #f8f9fa;
  padding: 0.5rem;
  border-radius: 4px;
  margin-bottom: 0.5rem;
}
```

- [ ] **Step 5: 添加页面标题**

```html
<title>冒烟测试页面</title>
```

---

### Task 2: 实现 Hash 路由系统

**Files:**
- Modify: `examples/smoke-test-page.html` (添加 JavaScript 逻辑)

**Interfaces:**
- 路由切换使用 `hashchange` 事件
- 默认路由为 `#/`
- 当前激活的导航链接高亮显示

- [ ] **Step 1: 实现路由切换函数**

```javascript
function switchRoute(route) {
  const contents = document.querySelectorAll('.route-content');
  contents.forEach(content => {
    content.style.display = 'none';
  });
  
  const target = document.querySelector(`[data-route="${route}"]`);
  if (target) {
    target.style.display = 'block';
  }
  
  const links = document.querySelectorAll('.nav-link');
  links.forEach(link => {
    link.classList.remove('active');
    if (link.getAttribute('href') === `#${route}` || (route === '/' && link.getAttribute('href') === '#/')) {
      link.classList.add('active');
    }
  });
}
```

- [ ] **Step 2: 实现路由初始化和事件监听**

```javascript
function initRouter() {
  const hash = window.location.hash || '#/';
  const route = hash === '#' ? '/' : hash.substring(1);
  switchRoute(route);
  
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash || '#/';
    const route = hash === '#' ? '/' : hash.substring(1);
    switchRoute(route);
  });
}

document.addEventListener('DOMContentLoaded', initRouter);
```

- [ ] **Step 3: 处理默认路由**

```javascript
if (!window.location.hash) {
  window.location.hash = '#/';
}
```

---

### Task 3: 创建表单页面 1（#/form1）

**Files:**
- Modify: `examples/smoke-test-page.html` (添加表单 HTML 和逻辑)

**Interfaces:**
- 包含文本输入框、下拉选择框、复选框、单选按钮、日期选择器
- 必填字段验证
- 提交后显示成功消息并重置表单

- [ ] **Step 1: 添加表单页面 1 HTML 结构**

```html
<section id="form1" class="route-content" data-route="/form1" style="display:none;">
  <h1>表单页面 1</h1>
  <form id="form1" class="test-form">
    <div class="form-group">
      <label for="name">姓名 <span class="required">*</span></label>
      <input type="text" id="name" name="name" placeholder="请输入姓名" required>
      <div class="error" id="name-error"></div>
    </div>
    
    <div class="form-group">
      <label for="city">城市 <span class="required">*</span></label>
      <select id="city" name="city" required>
        <option value="">请选择城市</option>
        <option value="北京">北京</option>
        <option value="上海">上海</option>
        <option value="广州">广州</option>
        <option value="深圳">深圳</option>
      </select>
      <div class="error" id="city-error"></div>
    </div>
    
    <div class="form-group">
      <label>兴趣爱好</label>
      <div class="checkbox-group">
        <label><input type="checkbox" name="hobbies" value="阅读"> 阅读</label>
        <label><input type="checkbox" name="hobbies" value="运动"> 运动</label>
        <label><input type="checkbox" name="hobbies" value="音乐"> 音乐</label>
        <label><input type="checkbox" name="hobbies" value="游戏"> 游戏</label>
      </div>
    </div>
    
    <div class="form-group">
      <label>性别 <span class="required">*</span></label>
      <div class="radio-group">
        <label><input type="radio" name="gender" value="男" required> 男</label>
        <label><input type="radio" name="gender" value="女"> 女</label>
      </div>
      <div class="error" id="gender-error"></div>
    </div>
    
    <div class="form-group">
      <label for="birthday">出生日期 <span class="required">*</span></label>
      <input type="date" id="birthday" name="birthday" required>
      <div class="error" id="birthday-error"></div>
    </div>
    
    <button type="submit" class="btn">提交表单</button>
    <div class="success-message" id="form1-success" style="display:none;">
      表单提交成功！
    </div>
  </form>
</section>
```

- [ ] **Step 2: 添加表单验证和提交逻辑**

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const form1 = document.getElementById('form1');
  if (form1) {
    form1.addEventListener('submit', (e) => {
      e.preventDefault();
      
      let isValid = true;
      const name = document.getElementById('name');
      const city = document.getElementById('city');
      const gender = document.querySelector('input[name="gender"]:checked');
      const birthday = document.getElementById('birthday');
      
      document.querySelectorAll('.error').forEach(el => el.textContent = '');
      
      if (!name.value.trim()) {
        document.getElementById('name-error').textContent = '请输入姓名';
        isValid = false;
      }
      
      if (!city.value) {
        document.getElementById('city-error').textContent = '请选择城市';
        isValid = false;
      }
      
      if (!gender) {
        document.getElementById('gender-error').textContent = '请选择性别';
        isValid = false;
      }
      
      if (!birthday.value) {
        document.getElementById('birthday-error').textContent = '请选择出生日期';
        isValid = false;
      }
      
      if (isValid) {
        document.getElementById('form1-success').style.display = 'block';
        setTimeout(() => {
          document.getElementById('form1-success').style.display = 'none';
        }, 3000);
        form1.reset();
      }
    });
  }
});
```

---

### Task 4: 创建表单页面 2（#/form2）

**Files:**
- Modify: `examples/smoke-test-page.html` (添加表单 HTML 和逻辑)

**Interfaces:**
- 包含文本输入框、下拉选择框
- 必填字段验证
- 提交后显示成功消息并重置表单

- [ ] **Step 1: 添加表单页面 2 HTML 结构**

```html
<section id="form2" class="route-content" data-route="/form2" style="display:none;">
  <h1>表单页面 2</h1>
  <form id="form2" class="test-form">
    <div class="form-group">
      <label for="email">邮箱 <span class="required">*</span></label>
      <input type="email" id="email" name="email" placeholder="请输入邮箱" required>
      <div class="error" id="email-error"></div>
    </div>
    
    <div class="form-group">
      <label for="profession">职业 <span class="required">*</span></label>
      <select id="profession" name="profession" required>
        <option value="">请选择职业</option>
        <option value="学生">学生</option>
        <option value="工程师">工程师</option>
        <option value="设计师">设计师</option>
        <option value="产品经理">产品经理</option>
      </select>
      <div class="error" id="profession-error"></div>
    </div>
    
    <button type="submit" class="btn">提交表单</button>
    <div class="success-message" id="form2-success" style="display:none;">
      表单提交成功！
    </div>
  </form>
</section>
```

- [ ] **Step 2: 添加表单验证和提交逻辑**

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const form2 = document.getElementById('form2');
  if (form2) {
    form2.addEventListener('submit', (e) => {
      e.preventDefault();
      
      let isValid = true;
      const email = document.getElementById('email');
      const profession = document.getElementById('profession');
      
      document.querySelectorAll('.error').forEach(el => el.textContent = '');
      
      if (!email.value.trim()) {
        document.getElementById('email-error').textContent = '请输入邮箱';
        isValid = false;
      } else if (!email.value.includes('@')) {
        document.getElementById('email-error').textContent = '邮箱格式不正确';
        isValid = false;
      }
      
      if (!profession.value) {
        document.getElementById('profession-error').textContent = '请选择职业';
        isValid = false;
      }
      
      if (isValid) {
        document.getElementById('form2-success').style.display = 'block';
        setTimeout(() => {
          document.getElementById('form2-success').style.display = 'none';
        }, 3000);
        form2.reset();
      }
    });
  }
});
```

---

### Task 5: 创建文件上传页面（#/upload）

**Files:**
- Modify: `examples/smoke-test-page.html` (添加上传 HTML 和逻辑)

**Interfaces:**
- 原生 `<input type="file">` 文件选择
- 支持多文件选择
- 显示已选文件列表
- 上传后显示状态

- [ ] **Step 1: 添加文件上传页面 HTML 结构**

```html
<section id="upload" class="route-content" data-route="/upload" style="display:none;">
  <h1>文件上传</h1>
  <div class="upload-section">
    <div class="file-input-wrapper">
      <label for="fileInput">选择文件</label>
      <input type="file" id="fileInput" multiple accept="image/*,.pdf,.doc,.docx">
    </div>
    
    <div class="file-list" id="fileList">
      <p>尚未选择文件</p>
    </div>
    
    <button type="button" id="uploadBtn" class="btn" disabled>上传文件</button>
    <div class="upload-status" id="uploadStatus"></div>
  </div>
</section>
```

- [ ] **Step 2: 添加文件选择和上传逻辑**

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadStatus = document.getElementById('uploadStatus');
  
  let selectedFiles = [];
  
  fileInput.addEventListener('change', (e) => {
    selectedFiles = Array.from(e.target.files);
    renderFileList();
    uploadBtn.disabled = selectedFiles.length === 0;
  });
  
  function renderFileList() {
    if (selectedFiles.length === 0) {
      fileList.innerHTML = '<p>尚未选择文件</p>';
      return;
    }
    
    fileList.innerHTML = selectedFiles.map(file => `
      <div class="file-item">${file.name} (${formatFileSize(file.size)})</div>
    `).join('');
  }
  
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  
  uploadBtn.addEventListener('click', () => {
    if (selectedFiles.length === 0) return;
    
    uploadBtn.disabled = true;
    uploadStatus.innerHTML = '<p>上传中...</p>';
    
    setTimeout(() => {
      uploadStatus.innerHTML = `
        <div class="success-message">
          成功上传 ${selectedFiles.length} 个文件
        </div>
      `;
      uploadBtn.disabled = false;
      setTimeout(() => {
        uploadStatus.innerHTML = '';
      }, 3000);
    }, 1500);
  });
});
```

---

### Task 6: 创建测试用例文件

**Files:**
- Create: `examples/smoke-test.md`

**Interfaces:**
- 使用 `## ` 分隔多个测试场景
- 每个场景包含自然语言描述的步骤
- 包含断言点

- [ ] **Step 1: 创建测试用例文件**

```markdown
# 冒烟测试用例

用 `## ` 分隔多个测试场景，CLI 会逐个运行并汇总整体结论与退出码。

## 路由切换测试

打开本地文件 `examples/smoke-test-page.html` 并断言页面标题包含 冒烟测试页面
点击页面上的「表单页面 1」链接，等待页面路由切换
断言页面中已出现表单内容
点击页面上的「文件上传」链接，等待页面路由切换
断言页面中已出现文件上传相关内容

## 表单填写测试

打开本地文件 `examples/smoke-test-page.html`
点击「表单页面 1」链接
在「姓名」输入框填写 `张三`
在下拉框中选择城市 `北京`
在「性别」中选择 `男`
在「出生日期」中选择一个日期
点击「提交表单」按钮
等待 1 秒，让表单提交完成
断言页面中已出现成功消息

## 表单页面 2 测试

打开本地文件 `examples/smoke-test-page.html`
点击「表单页面 2」链接
在「邮箱」输入框填写 `test@example.com`
在下拉框中选择职业 `工程师`
点击「提交表单」按钮
等待 1 秒，让表单提交完成
断言页面中已出现成功消息

## 文件上传测试

打开本地文件 `examples/smoke-test-page.html`
点击「文件上传」链接
点击「选择文件」按钮并上传本地文件 `D:\Downloads\test.png`
等待 1 秒，让文件列表完成渲染
断言页面中已出现上传的文件名
```

---

### Task 7: 完整性和自检

**Files:**
- Review: `examples/smoke-test-page.html`
- Review: `examples/smoke-test.md`

**Interfaces:**
- 所有约束条件满足
- 所有验证标准达成

- [ ] **Step 1: 验证约束条件**

确认以下内容：
- 页面可以直接在浏览器中打开（无需服务器）
- 使用 Hash 路由（非 History 路由）
- 使用原生文件上传（非组件库）
- 提交表单后显示成功消息（不刷新页面）

- [ ] **Step 2: 验证页面功能**

手动测试以下功能：
- [ ] 路由切换正常（首页、表单页面 1、表单页面 2、文件上传）
- [ ] 表单页面 1 可以填写所有字段并提交
- [ ] 表单页面 2 可以填写所有字段并提交
- [ ] 文件上传可以选择文件并显示文件名
- [ ] 表单提交后显示成功消息
- [ ] 导航栏链接正确高亮

- [ ] **Step 3: 验证测试用例**

运行测试用例文件：
```bash
pageqa examples/smoke-test.md
```

确认所有测试场景通过。

---

## 自检结果

### Spec 覆盖

| 规范要求 | 对应任务 | 状态 |
|---------|---------|------|
| 创建示例 HTML 页面 | Task 1-5 | ✅ |
| 创建测试用例文件 | Task 6 | ✅ |
| Hash 路由切换 | Task 2 | ✅ |
| 表单填写（所有字段类型） | Task 3-4 | ✅ |
| 原生文件上传 | Task 5 | ✅ |
| 表单提交后显示成功消息 | Task 3-4 | ✅ |

### 占位符扫描

未发现 TBD、TODO 或其他占位符。所有步骤包含具体代码。

### 类型一致性

所有字段 ID 和名称一致，无冲突。

---

## 执行选项

**计划完成并保存到 `docs/superpowers/plans/2026-09-21-smoke-test-page.md`。**

**两种执行方式：**

1. **Subagent-Driven (推荐)** - 我为每个任务派遣一个独立的子代理，任务间进行审查，快速迭代

2. **Inline Execution** - 在当前会话中执行所有任务，使用 executing-plans 进行批量执行

**选择哪种执行方式？**
