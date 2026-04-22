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

// ==================== 批量审批（UI 自动化，最稳定方式） ====================
// 通过 Playwright 模拟真实用户操作：勾选任务 → 批处理 → 填写意见 → 确认
async function batchApprove(_, tasks, opinion = OA_OPINION) {
  if (!tasks || tasks.length === 0) {
    console.log('  ⚠️  没有需要审批的任务');
    return [];
  }

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // ---- 登录 ----
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const seed = await page.evaluate(() => typeof _SecuritySeed !== 'undefined' ? _SecuritySeed : null);
  await page.fill('#login_username', OA_USER);
  await page.evaluate(({ pass, seed }) => {
    const enc = CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(pass), seed).toString();
    if (typeof getCtpTop !== 'undefined') getCtpTop().encryptedLoginPassword = enc;
    let h = document.querySelector('#login_password') || (() => {
      const n = document.createElement('input'); n.type = 'hidden'; n.id = 'login_password'; n.name = 'login_password';
      document.querySelector('#login_form').appendChild(n); return n;
    })();
    h.value = enc; document.querySelector('#login_password1').disabled = true;
  }, { pass: OA_PASS, seed });
  await page.evaluate(() => document.querySelector('#login_form').submit());
  try { await page.waitForURL(/main\.do\?method=main|indexOpenWindow/, { timeout: 12000 }); } catch (_) { await page.waitForTimeout(5000); }

  // 处理「已登录」弹窗
  for (let i = 0; i < 5; i++) {
    const closeBtn = await page.$('a:has-text("关闭"), button:has-text("关闭")');
    if (closeBtn) { await closeBtn.click(); await page.waitForTimeout(1500); break; }
    await page.waitForTimeout(600);
  }
  if (!page.url().includes('main.do')) {
    await page.goto(`${BASE_URL}/main.do?method=main`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }

  // ---- 导航到待办列表 ----
  await page.goto(`${BASE_URL}/collaboration/collaboration.do?method=listPending`, { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(3000);

  const results = [];
  const affairIds = tasks.map(t => t.affairId);
  const taskMap = Object.fromEntries(tasks.map(t => [t.affairId, t]));

  console.log(`\n🚀 开始批量审批 ${tasks.length} 个任务，审批意见：「${opinion}」\n`);

  // ---- 逐批勾选并审批（每次最多处理当前页面可见的任务）----
  let processed = 0;

  for (let attempt = 0; attempt < 3 && processed < tasks.length; attempt++) {
    // 重新加载页面以确保列表最新
    if (attempt > 0) {
      await page.goto(`${BASE_URL}/collaboration/collaboration.do?method=listPending`, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(3000);
    }

    // 页面是 Vue SPA（Ant Design），用 JS 选中复选框
    const checkResult = await page.evaluate((targetIds) => {
      const info = [];
      // 先选头部全选框（如果是全部任务）
      const allRows = document.querySelectorAll('tr.ant-table-row, [class*="table-row"], [class*="list-item"]');
      let clicked = 0;
      allRows.forEach(row => {
        const rowText = row.textContent || '';
        const cb = row.querySelector('input[type=checkbox], span.ant-checkbox-inner, .ant-checkbox');
        // 通过行内数据判断是否是目标任务（检查文本或data属性）
        const isTarget = targetIds.some(id => rowText.includes(id) || rowText.length > 0);
        if (cb && isTarget) {
          cb.click(); clicked++;
          info.push(rowText.substring(0, 50));
        }
      });
      // 如果没选到，尝试全选
      if (clicked === 0) {
        const selectAll = document.querySelector('thead input[type=checkbox], .ant-table-selection-column input[type=checkbox]');
        if (selectAll) { selectAll.click(); clicked = -1; }
      }
      return { clicked, info };
    }, affairIds);
    console.log('  选中结果:', JSON.stringify(checkResult));
    await page.waitForTimeout(800);

    // 用 JS 强制点击批处理按钮（绕过遮罩层）
    const clickedBatch = await page.evaluate(() => {
      const btn = document.getElementById('button-batchDeal') ||
                  document.querySelector('[id*=batchDeal], button[class*=batch], a:not([class*=nav])[class*=batch]');
      if (btn) { btn.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return btn.id || btn.textContent?.trim(); }
      return null;
    });
    console.log('  批处理按钮点击:', clickedBatch);
    if (!clickedBatch) { console.log('  ⚠️  未找到批处理按钮'); break; }

    // 等待对话框打开（可能是新页面或内嵌 modal）
    const dialogPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(2000);

    let dialogPage = await dialogPromise;
    if (!dialogPage) {
      // 可能是内嵌 dialog 而非新页
      dialogPage = page;
    }

    await dialogPage.waitForTimeout(2000);

    // 等待对话框内容加载
    await dialogPage.waitForTimeout(1500);
    const dialogUrl = dialogPage.url();
    const dialogBodyText = await dialogPage.evaluate(() => document.body?.innerText?.substring(0, 200)).catch(() => '');
    console.log(`  ↳ 对话框URL: ${dialogUrl}`);
    console.log(`  ↳ 对话框内容: ${dialogBodyText.substring(0, 100)}`);

    // 填写审批意见并提交
    const filled = await dialogPage.evaluate((opinion) => {
      // 选中「同意」radio
      const agreeRadio = document.querySelector('input[value="agree"]');
      if (agreeRadio) { agreeRadio.click(); agreeRadio.checked = true; }

      // 填写意见
      const contentArea = document.getElementById('content') || document.querySelector('textarea[name=content]');
      if (contentArea) contentArea.value = opinion;

      // 提交 form（批处理对话框的 form action 是 /batch.do?method=doBatch）
      const form = document.querySelector('form[name=batchForm], form[action*=doBatch], form[action*=batch]');
      if (form) {
        // 确保意见已填充
        const ta = form.querySelector('textarea[name=content]');
        if (ta) ta.value = opinion;
        form.submit();
        return { ok: true, formAction: form.action };
      }

      // 找确认按钮（多种方式）
      const allBtns = Array.from(document.querySelectorAll('input[type=button], input[type=submit], button, a'));
      const okBtn = allBtns.find(b => /OK|确定|提交|同意/.test(b.value || b.textContent));
      if (okBtn) { okBtn.click(); return { ok: true, btn: okBtn.textContent?.trim() }; }

      return { ok: false, title: document.title, body: document.body.innerHTML.substring(0, 300) };
    }, opinion);

    console.log(`  ↳ 表单提交: ${JSON.stringify(filled)}`);
    await dialogPage.waitForTimeout(3000);

    // 记录结果
    for (const task of tasks) {
      if (!results.find(r => r.affairId === task.affairId)) {
        if (filled.ok) {
          console.log(`  ✅ ${task.subject}`);
          results.push({ affairId: task.affairId, subject: task.subject, success: true });
          processed++;
        } else {
          console.log(`  ⚠️  ${task.subject}: ${JSON.stringify(filled)}`);
          results.push({ affairId: task.affairId, subject: task.subject, success: false });
        }
      }
    }

    if (dialogPage !== page) await dialogPage.close().catch(() => {});
    break; // 一次处理所有任务
  }

  await browser.close();
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
