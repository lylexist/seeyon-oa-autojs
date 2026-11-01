---
name: seeyon-oa-approval
description: >
  致远 OA (Seeyon V9) 流程审批自动化。能够登录 OA 系统、获取所有待办流程列表、对单个或批量待办流程执行同意审批操作。
  当用户提到"OA审批"、"待办流程"、"批量同意"、"自动审批"、"查看待办"、"审批流程"等关键词时，使用本 skill。
  即使用户没有明确提到"OA"，只要涉及流程审批、待办处理、审批同意等工作场景，也应主动使用本 skill。
---

# 致远 OA 流程审批自动化

## 概述
本 skill 针对致远 OA V9 系统（Seeyon V9），通过逆向工程已确认的 API 接口，
实现自动登录、获取待办流程列表、批量执行审批同意操作。

## 环境要求
- Node.js >= 16
- Google Chrome
- Playwright：在项目目录执行 `npm install playwright` 安装

## 使用前配置
复制 `.env.example` 为 `.env` 并填入真实的 OA 地址和账号密码：
```bash
cp .env.example .env
```

## 系统信息（已验证）
- 系统类型：致远 OA V9.0 SP1（2024-07-31）
- 认证方式：账号密码 + 动态 SecuritySeed DES 加密

## 使用方法

### 查看所有待办任务
```bash
node scripts/oa_approval.js list
```

### 批量同意全部待办
```bash
OA_AUTO_CONFIRM=1 node scripts/oa_approval.js approve all
```

### 同意指定 affairId 的任务（逗号分隔）
```bash
OA_AUTO_CONFIRM=1 node scripts/oa_approval.js approve 4381277163918150844,2729739659408917657
```

### 安全验证审批界面（不提交）
```bash
node scripts/oa_approval.js approve 4381277163918150844 --dry-run
```

### 批量同意并自定义审批意见
```bash
OA_AUTO_CONFIRM=1 OA_OPINION="已阅，同意" node scripts/oa_approval.js approve all
```

### 查看单个任务详情（JSON 格式）
```bash
node scripts/oa_approval.js detail 4381277163918150844
```

## 环境变量说明
- `OA_URL` - OA 系统地址（必须，以 `/` 结尾）
- `OA_USER` - 登录用户名（必须）
- `OA_PASS` - 登录密码（必须）
- `OA_OPINION` - 默认审批意见，默认为"同意"（可选）
- `OA_AUTO_CONFIRM` - 设为 `1` 跳过确认提示，直接审批（可选，用于自动化）

## 操作流程说明

当用户要求执行 OA 审批时，按以下步骤操作：

1. 先运行 `list` 命令查看当前待办列表
2. 默认按用户最新规则执行全部审批：即使混有非车辆申请，也执行“同意”审批；使用 `OA_AUTO_CONFIRM=1 OA_OPINION=同意 node scripts/oa_approval.js approve all`，审批后复核，如仍有待办则重复执行直到清零或无减少
3. 审批完成后，再次运行 `list` 确认待办清零

如果用户只是想查看待办而不需要审批，只运行 `list` 即可。

如果用户指定了特定类型的任务（如"只审批日志类"），先列出所有任务，
人工筛选出对应的 affairId，再用逗号连接传给 approve 命令。

## 已验证的 API 接口

以下接口已通过 Playwright 逆向工程实际验证（2026-04-22）。

### 1. 登录认证
系统使用 DES 加密密码，加密密钥（SecuritySeed）从登录页面动态获取。
- 步骤一：GET `https://weoa.ysiadata.cn:8443/seeyon/` → 提取 `_SecuritySeed` 变量
- 步骤二：在浏览器页面上下文中执行 `CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(password), seed).toString()` 获取加密密码
- 步骤三：POST `https://weoa.ysiadata.cn:8443/seeyon/main.do?method=login`
  - Body: `login_username=<user>&login_password=<encrypted>`
  - 成功标志: 返回重定向到 `indexOpenWindow.jsp` 或 `main.do?method=main`
  - 获取 Cookie: `JSESSIONID`（后续所有请求携带此 Cookie）

### 2. 获取待办列表
```
POST https://weoa.ysiadata.cn:8443/seeyon/ajax.do?method=ajaxAction&managerName=colManager&rnd=<timestamp>
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Cookie: JSESSIONID=<session>

managerMethod=getPendingList&arguments=[{"page":1},{"aiSort":"false","templeteIds":""}]
```

响应格式：
```json
{
  "total": 22,
  "pages": 2,
  "data": [
    {
      "affairId": "4381277163918150844",
      "subject": "园区固定车辆申请(任亚强 2026-04-22 08:03)",
      "startMemberName": "任亚强",
      "startDate": "2026-04-22 08:04",
      "receiveTime": "2026-04-22 09:24",
      "summaryId": "-6733548842235311633",
      "processId": "3651491229130312546",
      "affairNodeName": "管理中心业务负责人",
      "subStateName": "未读",
      "workitemId": "...",
      "caseId": "..."
    }
  ]
}
```

翻页：修改 `arguments` 中的 `page` 值（从 1 开始）。

### 3. 批量审批（同意）

**实现方式：Playwright UI 自动化**（非直接 API 调用）

经验证，纯 HTTP API 方式存在 session 冲突问题（第二次登录时 preBatch 被重定向），
因此采用 Playwright 模拟真实用户操作：

1. 复用首次登录获得的浏览器会话，避免重复登录和 session 冲突
2. 导航到 `/collaboration/collaboration.do?method=listPending`
3. 以表格行的 `data-row-key` 精确匹配 `affairId`，再触发对应复选框
4. 用同样方式点击 `#button-batchDeal` 批处理按钮（父 div 遮罩拦截指针事件）
5. 在内嵌 iframe 中选择 `agree` 并填写 `textarea[name=content]`
6. 点击父页面批处理对话框的「确定」按钮
7. 再次查询待办列表，只有对应 `affairId` 消失才判定成功

**关键坑点**：
- 批处理按钮 `#button-batchDeal` 被父容器 `.pending-toolbar-conent` 遮挡，必须用 `dispatchEvent` 而非 Playwright `.click()`
- 页面是 Vue SPA（Ant Design），复选框需用 JS 触发点击并等待状态更新
- 匹配失败必须终止，禁止回退为全选
- `--dry-run` 会验证精确选择和批处理表单，然后取消，不产生审批

**参考 API（审批前查询用）**：
```
POST /seeyon/ajax.do?method=ajaxAction&managerName=pendingManager&rnd=<t>
managerMethod=getMoreList4SectionContion&arguments=[{"page":1},{"fragmentId":"2075546533064298488","state":"3","sectionName":"pendingSection","bigTitleIndex":"0","isTrack":"false","condition":"subject","textfield":"","aiSortValue":"0"}]
```
返回待办中心 widget 的任务列表（用于 `list` 命令）。

### 4. 查看任务详情页
```
GET https://weoa.ysiadata.cn:8443/seeyon/app/collaboration/index.html?method=summary&affairId=<id>&bodyType=20&theme=simple&designTplId=67081001
```

### 5. 其他有用接口
- 获取待办中心 portlet 列表: `GET /seeyon/rest/coll/portlet/list?spaceId=8793152774030575267`
- 获取分组组织树（用于过滤）: `POST /ajax.do?...&managerName=pendingManager&managerMethod=getTreeData4PendingStaff`
- 已办流程列表: `/seeyon/collaboration/collaboration.do?method=listDone`

## 注意事项
- **审批不可撤销**；执行前先用 `list` 核对任务范围。定时任务按用户既定规则默认审批全部待办，即使混有非车辆申请也执行“同意”审批
- 系统有单会话保护，审批阶段必须复用首次登录会话
- 脚本会逐页查找指定任务，并分批处理当前页中精确匹配的任务
- 知会类任务（如网络维修上报）用 `agree` 态度也能通过，系统自动处理
- `.env` 文件含敏感信息，已加入 `.gitignore`，请勿提交
