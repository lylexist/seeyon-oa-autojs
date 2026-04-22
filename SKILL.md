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

1. 先运行 `list` 命令查看当前待办列表，向用户确认任务范围
2. 根据用户确认，运行 `approve all` 或 `approve <ids>` 执行审批
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
分两步：预检 + 提交。

**步骤一：预检（preBatch）**
```
POST https://weoa.ysiadata.cn:8443/seeyon/collaboration/batchController.do?method=preBatch
Cookie: JSESSIONID=<session>

affairId=<id>&summaryId=<id>&category=&processId=<id>
```
返回 HTML 对话框（状态码 200 即成功）。

**步骤二：提交审批（batch）**
```
POST https://weoa.ysiadata.cn:8443/seeyon/collaboration/batchController.do?method=batch&attitude=agree&opinion=<opinion>
Cookie: JSESSIONID=<session>

affairId=<id>&summaryId=<id>&category=&processId=<id>&resultCode=&parameter=agree_<opinion>
```

- `attitude` 可选值: `agree`（同意）、`disagree`（不同意）、`haveRead`（知会）
- `opinion` 是审批意见文本（如 "同意"）
- `parameter` 格式: `<attitude>_<opinion>`

### 4. 查看任务详情页
```
GET https://weoa.ysiadata.cn:8443/seeyon/app/collaboration/index.html?method=summary&affairId=<id>&bodyType=20&theme=simple&designTplId=67081001
```

### 5. 其他有用接口
- 获取待办中心 portlet 列表: `GET /seeyon/rest/coll/portlet/list?spaceId=8793152774030575267`
- 获取分组组织树（用于过滤）: `POST /ajax.do?...&managerName=pendingManager&managerMethod=getTreeData4PendingStaff`
- 已办流程列表: `/seeyon/collaboration/collaboration.do?method=listDone`

## 注意事项
- 系统有单会话保护，同一账号同一时间只能有一个活跃会话
- 审批操作不可撤销，请在执行前确认任务范围
- 审批意见为必填项，不填则系统可能拒绝
- 某些任务类型（如知会类）可能需要使用 `haveRead` 而非 `agree`
- 建议先运行 `list` 确认任务列表后再执行批量审批
