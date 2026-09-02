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
 *   node scripts/oa_approval.js approve <affairId1,affairId2,...> [--dry-run]
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
  const executableGlobalRoot = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules');
  const candidates = [
    'playwright',
    path.join(__dirname, '../node_modules/playwright'),
    path.join(__dirname, '../../node_modules/playwright'),
    path.join(executableGlobalRoot, 'playwright'),
    '/usr/local/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
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

function cookieHeaderToBrowserCookies(cookieHeader) {
  return cookieHeader.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    return {
      name: part.slice(0, separator),
      value: part.slice(separator + 1),
      url: `${BASE_URL}/`,
    };
  }).filter(cookie => cookie.name && cookie.value);
}

function browserCookiesToHeader(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
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
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // 加载登录页获取 SecuritySeed
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const securitySeed = await page.evaluate(() =>
      typeof _SecuritySeed !== 'undefined' ? _SecuritySeed : null
    );
    if (!securitySeed) throw new Error('无法获取 SecuritySeed，请检查 OA_URL');

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
      document.querySelector('#login_form').submit();
    }, { enc: encryptedPass });

    try {
      await page.waitForURL(/main\.do\?method=main|indexOpenWindow/, { timeout: 15000 });
    } catch (_) {
      await page.waitForTimeout(2000);
    }

    const cookieList = await context.cookies();
    const sessionId = cookieList.find(cookie => cookie.name === 'JSESSIONID')?.value;
    const authenticated = cookieList.some(cookie => cookie.name === 'ts') &&
      !await page.locator('#login_username').isVisible().catch(() => false);

    if (!sessionId || !authenticated) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const reason = bodyText.replace(/\s+/g, ' ').trim().slice(0, 120) || '账号、密码或验证码校验未通过';
      throw new Error(`登录未成功，页面提示：${reason}`);
    }

    console.log(`  ✅ 登录成功 (JSESSIONID: ${sessionId.substring(0, 10)}...)`);
    return browserCookiesToHeader(cookieList);
  } finally {
    await browser.close().catch(() => {});
  }
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
    const result = JSON.parse(resp.body);
    if (!Array.isArray(result.data) || typeof result.total !== 'number') {
      throw new Error('响应中缺少待办列表字段，登录可能已失效');
    }
    return result;
  } catch (e) {
    if (e.message.includes('登录可能已失效')) throw e;
    throw new Error(`解析待办列表失败: ${resp.body.substring(0, 200)}`);
  }
}

// ==================== 获取所有页待办 ====================
async function getAllPendingTasks(cookies, verbose = true) {
  const first = await getPendingList(cookies, 1, 50);
  const total = first.total || 0;
  const pages = first.pages || 1;
  let tasks = first.data || [];

  if (verbose) console.log(`  📋 共 ${total} 条待办，${pages} 页`);

  for (let p = 2; p <= pages; p++) {
    const more = await getPendingList(cookies, p, 50);
    tasks = tasks.concat(more.data || []);
  }

  return tasks;
}

// ==================== 批量审批（UI 自动化，最稳定方式） ====================
// 通过 Playwright 模拟真实用户操作：勾选任务 → 批处理 → 填写意见 → 确认
async function batchApprove(cookies, tasks, opinion = OA_OPINION, dryRun = false) {
  if (!tasks || tasks.length === 0) {
    console.log('  ⚠️  没有需要审批的任务');
    return [];
  }

  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies(cookieHeaderToBrowserCookies(cookies));
    const page = await context.newPage();
    const listUrl = `${BASE_URL}/collaboration/collaboration.do?method=listPending`;
    const taskMap = new Map(tasks.map(task => [String(task.affairId), task]));
    const remainingIds = new Set(taskMap.keys());
    const results = [];

    console.log(`\n${dryRun ? '🧪 开始审批模拟验证' : '🚀 开始批量审批'} ${tasks.length} 个任务，审批意见：「${opinion}」\n`);

    async function openPendingPage() {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('tr[data-row-key]', { timeout: 20000 });
      if (!page.url().includes('method=listPending')) {
        throw new Error('待办页面打开失败，登录会话可能已失效');
      }
    }

    async function selectTargetsOnCurrentPage() {
      const visibleIds = await page.evaluate(targetIds => {
        const targets = new Set(targetIds);
        const rows = Array.from(document.querySelectorAll('tr[data-row-key]'));

        for (const row of rows) {
          const id = row.getAttribute('data-row-key');
          const checkbox = row.querySelector('input[type=checkbox]');
          if (!checkbox) continue;
          const shouldSelect = targets.has(id);
          if (checkbox.checked !== shouldSelect) {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }

        return rows.map(row => row.getAttribute('data-row-key'));
      }, [...remainingIds]);

      await page.waitForTimeout(500);
      const selectedIds = await page.locator('tr[data-row-key]').evaluateAll(rows => rows
        .filter(row => row.querySelector('input[type=checkbox]')?.checked)
        .map(row => row.getAttribute('data-row-key')));
      const expectedIds = visibleIds.filter(id => remainingIds.has(id));
      if (selectedIds.length !== expectedIds.length ||
          selectedIds.some(id => !expectedIds.includes(id))) {
        throw new Error(`复选框校验失败：期望 ${expectedIds.join(',')}，实际 ${selectedIds.join(',')}`);
      }
      return selectedIds;
    }

    async function findAndSelectTargets() {
      const visitedPages = new Set();
      while (true) {
        const activePage = await page.locator('.ant-pagination-item-active').textContent().catch(() => '1');
        if (visitedPages.has(activePage)) return [];
        visitedPages.add(activePage);

        const selectedIds = await selectTargetsOnCurrentPage();
        if (selectedIds.length > 0) return selectedIds;

        const next = page.locator('.ant-pagination-next:not(.ant-pagination-disabled)').first();
        if (await next.count() === 0) return [];
        const previousFirstId = await page.locator('tr[data-row-key]').first().getAttribute('data-row-key').catch(() => null);
        await next.dispatchEvent('click');
        await page.waitForFunction(previousId => {
          const first = document.querySelector('tr[data-row-key]');
          return first && first.getAttribute('data-row-key') !== previousId;
        }, previousFirstId, { timeout: 10000 });
      }
    }

    await openPendingPage();

    while (remainingIds.size > 0) {
      const selectedIds = await findAndSelectTargets();
      if (selectedIds.length === 0) {
        for (const id of remainingIds) {
          const task = taskMap.get(id);
          results.push({ affairId: id, subject: task.subject, success: false, message: '待办页面中未找到对应 affairId' });
        }
        break;
      }

      console.log(`  🎯 已精确选中 ${selectedIds.length} 个任务: ${selectedIds.join(', ')}`);
      await page.locator('#button-batchDeal').dispatchEvent('click');

      let batchFrame;
      for (let attempt = 0; attempt < 40; attempt++) {
        batchFrame = page.frames().find(frame => frame.url().includes('batchController.do?method=batch'));
        if (batchFrame) break;
        await page.waitForTimeout(250);
      }
      if (!batchFrame) throw new Error('批处理对话框加载失败');

      const agreeRadio = batchFrame.locator('input[name=atts][value=agree]');
      const opinionArea = batchFrame.locator('textarea[name=content]');
      await agreeRadio.check({ force: true });
      await opinionArea.fill(opinion);

      if (dryRun) {
        const formReady = await agreeRadio.isChecked() && await opinionArea.inputValue() === opinion;
        if (!formReady) throw new Error('模拟验证失败：审批态度或意见未正确写入');
        const cancelButton = page.locator('a.layui-layer-btn1:visible').last();
        if (await cancelButton.count() > 0) await cancelButton.dispatchEvent('click');
        for (const id of selectedIds) {
          const task = taskMap.get(id);
          console.log(`  ✅ 已验证精确选择且未提交: ${task.subject}`);
          results.push({ affairId: id, subject: task.subject, success: true, dryRun: true });
          remainingIds.delete(id);
        }
        if (remainingIds.size > 0) await openPendingPage();
        continue;
      }

      const confirmButton = page.locator('a.layui-layer-btn0:visible').last();
      if (await confirmButton.count() === 0) throw new Error('批处理对话框中未找到“确定”按钮');

      const submitResponsePromise = page.waitForResponse(response =>
        response.url().includes('batch.do?method=doBatch'), { timeout: 15000 }
      ).catch(() => null);
      await confirmButton.dispatchEvent('click');
      const submitResponse = await submitResponsePromise;
      if (submitResponse && submitResponse.status() >= 400) {
        throw new Error(`审批提交失败: HTTP ${submitResponse.status()}`);
      }

      await page.waitForTimeout(2000);
      let pendingAfter = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const currentCookies = browserCookiesToHeader(await context.cookies());
        pendingAfter = await getAllPendingTasks(currentCookies, false);
        if (selectedIds.every(id => !pendingAfter.some(task => String(task.affairId) === id))) break;
        await page.waitForTimeout(1500);
      }

      const pendingIds = new Set(pendingAfter.map(task => String(task.affairId)));
      for (const id of selectedIds) {
        const task = taskMap.get(id);
        const success = !pendingIds.has(id);
        console.log(`  ${success ? '✅' : '❌'} ${task.subject}${success ? '' : '（提交后仍在待办列表）'}`);
        results.push({
          affairId: id,
          subject: task.subject,
          success,
          ...(success ? {} : { message: '提交后仍在待办列表' }),
        });
        remainingIds.delete(id);
      }

      if (remainingIds.size > 0) await openPendingPage();
    }

    return results;
  } finally {
    await browser.close().catch(() => {});
  }
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
    const dryRun = args.includes('--dry-run');

    if (opinionArg >= 0 && (!opinion || opinion.startsWith('--'))) {
      console.error('  ❌ --opinion 后必须提供审批意见');
      process.exit(1);
    }

    console.log('\n📋 获取待办任务列表...');
    const allTasks = await getAllPendingTasks(cookies);

    let tasksToApprove;
    if (!target) {
      console.error('用法: node scripts/oa_approval.js approve all|<affairId1,affairId2,...>');
      process.exit(1);
    } else if (target === 'all') {
      tasksToApprove = allTasks;
      console.log(`  🎯 将审批全部 ${allTasks.length} 个待办任务`);
    } else {
      const ids = [...new Set(target.split(',').map(s => s.trim()).filter(Boolean))];
      const availableIds = new Set(allTasks.map(task => String(task.affairId)));
      const missingIds = ids.filter(id => !availableIds.has(id));
      if (missingIds.length > 0) {
        console.error(`  ❌ 以下 affairId 不在当前待办中: ${missingIds.join(', ')}`);
        process.exit(1);
      }
      tasksToApprove = allTasks.filter(task => ids.includes(String(task.affairId)));
      console.log(`  🎯 将审批 ${tasksToApprove.length} 个指定任务`);

      if (tasksToApprove.length === 0) {
        console.error('  ❌ 未找到指定的任务 ID，可用的 affairId:');
        allTasks.forEach(t => console.log(`     ${t.affairId}: ${t.subject}`));
        process.exit(1);
      }
    }

    formatTaskList(tasksToApprove);

    // 确认提示
    if (!dryRun && !process.env.OA_AUTO_CONFIRM) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(res => rl.question(`\n⚠️  确认同意以上 ${tasksToApprove.length} 个任务？(y/N): `, res));
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('\n取消操作');
        process.exit(0);
      }
    }

    const results = await batchApprove(cookies, tasksToApprove, opinion, dryRun);

    console.log(`\n📊 ${dryRun ? '模拟验证' : '审批'}结果汇总:`);
    const success = results.filter(r => r.success).length;
    const fail = results.filter(r => !r.success).length;
    console.log(`  ✅ ${dryRun ? '验证通过' : '成功'}: ${success}  ❌ 失败/待确认: ${fail}`);

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
