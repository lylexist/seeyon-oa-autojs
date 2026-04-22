#!/usr/bin/env node
/**
 * 致远 OA (Seeyon V9) 流程审批自动化脚本
 *
 * 功能：
 *   1. list    - 获取所有待办流程列表
 *   2. approve - 批量同意指定或全部待办流程
 *   3. detail  - 查看单个流程详情
 *
 * 用法：
 *   node scripts/oa_approval.js list
 *   node scripts/oa_approval.js approve all [--opinion "同意"]
 *   node scripts/oa_approval.js approve <affairId1,affairId2,...>
 *   node scripts/oa_approval.js detail <affairId>
 *
 * 配置：在项目根目录创建 .env 文件（参考 .env.example），或通过环境变量传入。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ==================== 加载 .env ====================
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = val;
  }
})();

// ==================== 动态查找 playwright ====================
function requirePlaywright() {
  const candidates = [
    'playwright',
    path.join(__dirname, '../node_modules/playwright'),
    path.join(__dirname, '../../node_modules/playwright'),
    path.join(process.env.HOME || '', 'oa-api-probe/node_modules/playwright'),
  ];
  for (const p of candidates) {
    try { return require(p); } catch (_) {}
  }
  throw new Error(
    '未找到 playwright 模块。\n' +
    '请在项目目录执行: npm install playwright\n' +
    '或全局安装: npm install -g playwright'
  );
}

// ==================== 配置 ====================
const BASE_URL = (process.env.OA_URL || '').replace(/\/$/, '');
const OA_USER = process.env.OA_USER || '';
const OA_PASS = process.env.OA_PASS || '';
const OA_OPINION = process.env.OA_OPINION || '同意';

if (!BASE_URL || !OA_USER || !OA_PASS) {
  console.error('错误：缺少配置。请创建 .env 文件（参考 .env.example）或设置环境变量 OA_URL / OA_USER / OA_PASS');
  process.exit(1);
}

// ==================== HTTP 工具 ====================
async function httpRequest(method, urlStr, body, cookies) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (OA-Automation)',
      },
    };

    if (cookies) options.headers['Cookie'] = cookies;
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ==================== 登录 ====================
async function login() {
  console.log(`🔐 正在登录 ${BASE_URL}...`);

  // 使用 Playwright 浏览器获取 SecuritySeed 并完成 DES 加密登录
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // 加载登录页获取 SecuritySeed
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const securitySeed = await page.evaluate(() =>
    typeof _SecuritySeed !== 'undefined' ? _SecuritySeed : null
  );
  if (!securitySeed) throw new Error('无法获取 SecuritySeed，请检查 OA_URL');
  console.log(`  SecuritySeed: ${securitySeed}`);

  // 在页面内完成 DES 加密
  const encryptedPass = await page.evaluate(({ pass, seed }) => {
    try {
      return CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(pass), seed).toString();
    } catch(e) { return null; }
  }, { pass: OA_PASS, seed: securitySeed });

  if (!encryptedPass) throw new Error('密码加密失败');

  // 提交登录表单
  await page.fill('#login_username', OA_USER);
  await page.evaluate(({ enc }) => {
    let h = document.querySelector('#login_password');
    if (!h) {
      h = document.createElement('input');
      h.type = 'hidden'; h.id = 'login_password'; h.name = 'login_password';
      document.querySelector('#login_form').appendChild(h);
    }
    h.value = enc;
    document.querySelector('#login_password1').disabled = true;
    if (typeof getCtpTop !== 'undefined') getCtpTop().encryptedLoginPassword = enc;
  }, { enc: encryptedPass });

  await page.evaluate(() => document.querySelector('#login_form').submit());
  try {
    await page.waitForURL(/main\.do\?method=main|indexOpenWindow/, { timeout: 15000 });
  } catch (_) {
    await page.waitForTimeout(5000);
  }

  // 提取 session cookies
  const cookieList = await context.cookies();
  const JSESSIONID = cookieList.find(c => c.name === 'JSESSIONID')?.value;
  const ts = cookieList.find(c => c.name === 'ts')?.value;

  await browser.close();

  if (!JSESSIONID) throw new Error('登录失败：未获取到 JSESSIONID');

  const cookieStr = `JSESSIONID=${JSESSIONID}; ts=${ts || ''}; login_locale=zh_CN`;
  console.log(`  ✅ 登录成功 (JSESSIONID: ${JSESSIONID.substring(0, 10)}...)`);
  return cookieStr;
}

// ==================== 获取待办列表 ====================
async function getPendingList(cookies, page = 1, pageSize = 50) {
  const url = `${BASE_URL}/ajax.do?method=ajaxAction&managerName=colManager&rnd=${Date.now()}`;
  const body = `managerMethod=getPendingList&arguments=${encodeURIComponent(
    JSON.stringify([{ page: page }, { aiSort: 'false', templeteIds: '' }])
  )}`;

  const resp = await httpRequest('POST', url, body, cookies);

  if (resp.status !== 200) {
    throw new Error(`获取待办列表失败: HTTP ${resp.status}`);
  }

  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`解析待办列表失败: ${resp.body.substring(0, 200)}`);
  }
}

// ==================== 获取所有页待办 ====================
async function getAllPendingTasks(cookies) {
  const first = await getPendingList(cookies, 1, 50);
  const total = first.total || 0;
  const pages = first.pages || 1;
  let tasks = first.data || [];

  console.log(`  📋 共 ${total} 条待办，${pages} 页`);

  for (let p = 2; p <= pages; p++) {
    const more = await getPendingList(cookies, p, 50);
    tasks = tasks.concat(more.data || []);
  }

  return tasks;
}

// ==================== 批量审批 ====================
async function batchApprove(cookies, tasks, opinion = OA_OPINION) {
  if (!tasks || tasks.length === 0) {
    console.log('  ⚠️  没有需要审批的任务');
    return [];
  }

  const results = [];
  console.log(`\n🚀 开始批量审批 ${tasks.length} 个任务，审批意见：「${opinion}」\n`);

  for (const task of tasks) {
    const { affairId, summaryId, processId, subject, startMemberName } = task;
    console.log(`  ▶ 处理: ${subject} (发起人: ${startMemberName})`);

    // Step 1: preBatch - 验证任务可审批
    const preBatchUrl = `${BASE_URL}/collaboration/batchController.do?method=preBatch`;
    const preBatchBody = new URLSearchParams({
      affairId: affairId,
      summaryId: summaryId || '',
      category: '',
      processId: processId || '',
    }).toString();

    const preBatch = await httpRequest('POST', preBatchUrl, preBatchBody, cookies);
    // preBatch 返回 HTML 对话框，状态码 200 即视为成功

    if (preBatch.status !== 200) {
      console.log(`    ❌ preBatch 失败: HTTP ${preBatch.status}`);
      results.push({ affairId, subject, success: false, error: `HTTP ${preBatch.status}` });
      continue;
    }

    // Step 2: batch - 提交审批（同意）
    const batchUrl = `${BASE_URL}/collaboration/batchController.do?method=batch&attitude=agree&opinion=${encodeURIComponent(opinion)}`;
    const batchBody = new URLSearchParams({
      affairId: affairId,
      summaryId: summaryId || '',
      category: '',
      processId: processId || '',
      resultCode: '',
      parameter: `agree_${opinion}`,
    }).toString();

    const batchResp = await httpRequest('POST', batchUrl, batchBody, cookies);

    let success = false;
    let resultMsg = '';

    try {
      const json = JSON.parse(batchResp.body);
      success = json.success === true || json.code === 0 || json.result === 'success';
      resultMsg = json.message || json.msg || JSON.stringify(json).substring(0, 100);
    } catch (_) {
      // 某些情况下返回 HTML 或其他格式
      success = batchResp.status === 200 && !batchResp.body.includes('error') && !batchResp.body.includes('失败');
      resultMsg = batchResp.body.substring(0, 100);
    }

    if (success) {
      console.log(`    ✅ 审批成功`);
    } else {
      console.log(`    ⚠️  审批结果: ${resultMsg}`);
    }

    results.push({ affairId, subject, success, message: resultMsg });

    // 避免过快请求
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

// ==================== 格式化显示 ====================
function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) {
    console.log('\n📭 暂无待办任务\n');
    return;
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`待办任务列表（共 ${tasks.length} 条）`);
  console.log('='.repeat(80));

  tasks.forEach((task, i) => {
    const idx = String(i + 1).padStart(2, ' ');
    const date = task.receiveTime || task.startDate || '';
    const state = task.subStateName || '待处理';
    console.log(`\n[${idx}] ${task.subject}`);
    console.log(`     affairId: ${task.affairId}`);
    console.log(`     发起人: ${task.startMemberName}  |  接收时间: ${date}  |  状态: ${state}`);
    console.log(`     当前节点: ${task.affairNodeName || task.nodeName || '-'}`);
    if (task.summaryId) console.log(`     summaryId: ${task.summaryId}`);
  });

  console.log('\n' + '='.repeat(80) + '\n');
}

// ==================== 主流程 ====================
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  let cookies;
  try {
    cookies = await login();
  } catch (e) {
    console.error(`\n❌ 登录失败: ${e.message}`);
    process.exit(1);
  }

  if (command === 'list') {
    // 列出所有待办
    console.log('\n📋 获取待办任务列表...');
    const tasks = await getAllPendingTasks(cookies);
    formatTaskList(tasks);

    // 输出 JSON 以便脚本处理
    if (process.env.JSON_OUTPUT) {
      console.log('JSON_OUTPUT:' + JSON.stringify(tasks));
    }

  } else if (command === 'approve') {
    // 审批指定或全部任务
    const target = args[1]; // 'all' 或 逗号分隔的 affairId 列表
    const opinionArg = args.indexOf('--opinion');
    const opinion = opinionArg >= 0 ? args[opinionArg + 1] : OA_OPINION;

    console.log('\n📋 获取待办任务列表...');
    const allTasks = await getAllPendingTasks(cookies);

    let tasksToApprove;
    if (!target || target === 'all') {
      tasksToApprove = allTasks;
      console.log(`  🎯 将审批全部 ${allTasks.length} 个待办任务`);
    } else {
      const ids = target.split(',').map(s => s.trim());
      tasksToApprove = allTasks.filter(t => ids.includes(t.affairId));
      console.log(`  🎯 将审批 ${tasksToApprove.length} 个指定任务`);

      if (tasksToApprove.length === 0) {
        console.error('  ❌ 未找到指定的任务 ID，可用的 affairId:');
        allTasks.forEach(t => console.log(`     ${t.affairId}: ${t.subject}`));
        process.exit(1);
      }
    }

    formatTaskList(tasksToApprove);

    // 确认提示
    if (!process.env.OA_AUTO_CONFIRM) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(res => rl.question(`\n⚠️  确认同意以上 ${tasksToApprove.length} 个任务？(y/N): `, res));
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('\n取消操作');
        process.exit(0);
      }
    }

    const results = await batchApprove(cookies, tasksToApprove, opinion);

    console.log('\n📊 审批结果汇总:');
    const success = results.filter(r => r.success).length;
    const fail = results.filter(r => !r.success).length;
    console.log(`  ✅ 成功: ${success}  ❌ 失败/待确认: ${fail}`);

    if (fail > 0) {
      console.log('\n  需确认的任务:');
      results.filter(r => !r.success).forEach(r => {
        console.log(`    - ${r.subject}: ${r.message}`);
      });
    }

  } else if (command === 'detail') {
    // 查看单个任务详情
    const affairId = args[1];
    if (!affairId) {
      console.error('用法: node oa_approval.js detail <affairId>');
      process.exit(1);
    }
    console.log('\n📋 获取任务详情...');
    const tasks = await getAllPendingTasks(cookies);
    const task = tasks.find(t => t.affairId === affairId);
    if (task) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.error(`未找到 affairId: ${affairId}`);
    }

  } else {
    console.error(`未知命令: ${command}`);
    console.log('用法: node oa_approval.js [list|approve|detail]');
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`\n❌ 错误: ${e.message}`);
  process.exit(1);
});
