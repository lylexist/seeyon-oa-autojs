# seeyon-oa-approval

致远 OA (Seeyon V9) 流程审批自动化工具。通过逆向工程 OA 系统 API，实现命令行下的**查看待办、批量审批同意**等操作。

## 功能

- 查看所有待办流程列表（标题、发起人、接收时间、当前节点）
- 批量同意全部或指定待办流程
- 查看单个任务的完整 JSON 详情

## 环境要求

- Node.js >= 16
- Google Chrome（系统已安装）
- Playwright（用于登录时的 DES 密码加密）

安装 Playwright：

```bash
npm install playwright
```

> 若系统已全局安装或其他位置存在，脚本会自动查找，无需重复安装。

## 快速开始

**1. 配置凭据**

```bash
cp .env.example .env
# 编辑 .env，填入 OA_URL / OA_USER / OA_PASS
```

**2. 查看待办**

```bash
node scripts/oa_approval.js list
```

**3. 批量同意全部待办**

```bash
node scripts/oa_approval.js approve all
```

**4. 同意指定任务**

```bash
node scripts/oa_approval.js approve 4381277163918150844,2729739659408917657
```

**5. 查看单个任务详情**

```bash
node scripts/oa_approval.js detail 4381277163918150844
```

**6. 安全验证指定任务的审批 UI（不会提交）**

```bash
node scripts/oa_approval.js approve 4381277163918150844 --dry-run
```

## 配置说明

在项目根目录创建 `.env` 文件（复制自 `.env.example`）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `OA_URL` | ✅ | OA 地址，如 `https://your-oa/seeyon/`，保留末尾斜杠 |
| `OA_USER` | ✅ | 登录用户名 |
| `OA_PASS` | ✅ | 登录密码 |
| `OA_OPINION` | ❌ | 审批意见，默认 `同意` |
| `OA_AUTO_CONFIRM` | ❌ | 设为 `1` 跳过确认提示（用于自动化脚本） |

环境变量优先级高于 `.env` 文件，可在命令行临时覆盖：

```bash
OA_OPINION="已阅，同意" node scripts/oa_approval.js approve all
```

## 命令参考

```
node scripts/oa_approval.js <command> [options]

Commands:
  list                          列出所有待办任务
  approve all                   同意全部待办
  approve all --opinion <text>  同意全部，指定审批意见
  approve <id1,id2,...>         同意指定 affairId 的任务
  approve <ids> --dry-run       验证精确选择和审批表单，不提交
  detail <affairId>             查看任务完整数据（JSON）
```

## 工作原理

系统使用致远 OA 的 **DES 加密**认证机制：

1. 从登录页获取动态 `SecuritySeed`
2. 使用页面内置的 `CryptoJS.DES.encrypt` 完成密码加密
3. POST 提交到 `/main.do?method=login` 获取 `JSESSIONID`
4. 后续通过 `colManager.getPendingList` API 获取待办数据
5. 通过 `batchController.do?method=batch&attitude=agree` 执行审批

详细 API 文档见 [SKILL.md](./SKILL.md)。

## 注意事项

- **审批不可撤销**，请在执行前确认任务范围
- 系统有单会话保护，同一账号同时只能有一个活跃会话
- 知会类任务（如网络维修上报）审批时可能需要 `haveRead` 态度，当前默认使用 `agree`
- `.env` 文件包含敏感信息，已加入 `.gitignore`，**请勿提交到代码仓库**
