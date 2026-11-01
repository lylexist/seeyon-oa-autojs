#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 0) continue;
    const k = t.slice(0,i).trim(); const v = t.slice(i+1).trim();
    if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g,'');
  }
}
loadEnv();
const { chromium } = require('playwright');
const BASE_URL = (process.env.OA_URL || '').replace(/\/$/, '');
const OA_USER = process.env.OA_USER; const OA_PASS = process.env.OA_PASS;
const affairId = process.argv[2];
if (!affairId) { console.error('usage: node probe_detail_submit.js <affairId>'); process.exit(1); }
(async()=>{
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors','--no-sandbox']});
  const context = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await context.newPage();
  const logs = [];
  page.on('request', req => {
    const u = req.url();
    if (/seeyon\//.test(u)) logs.push({type:'request', method:req.method(), url:u, postData:req.postData()||null, headers:req.headers()});
  });
  page.on('response', async res => {
    const u = res.url();
    if (/seeyon\//.test(u)) {
      let body = null;
      try { body = await res.text(); } catch(_) {}
      logs.push({type:'response', status:res.status(), url:u, body: body && body.slice(0,2000)});
    }
  });
  await page.goto(`${BASE_URL}/`, {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  const seed = await page.evaluate(() => typeof _SecuritySeed !== 'undefined' ? _SecuritySeed : null);
  await page.fill('#login_username', OA_USER);
  await page.evaluate(({ pass, seed }) => {
    const enc = CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(pass), seed).toString();
    if (typeof getCtpTop !== 'undefined') getCtpTop().encryptedLoginPassword = enc;
    let h = document.querySelector('#login_password') || (() => { const n=document.createElement('input'); n.type='hidden'; n.id='login_password'; n.name='login_password'; document.querySelector('#login_form').appendChild(n); return n;})();
    h.value = enc; document.querySelector('#login_password1').disabled = true;
  }, { pass: OA_PASS, seed });
  await page.evaluate(() => document.querySelector('#login_form').submit());
  try { await page.waitForURL(/main\.do\?method=main|indexOpenWindow|main\.do/, {timeout:15000}); } catch(_) {}
  await page.goto(`${BASE_URL}/app/collaboration/index.html?method=summary&affairId=${affairId}&showTab=true&openFrom=listPending&bodyType=20&theme=simple&designTplId=67081001`, {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(5000);
  try {
    const opinion = page.locator('textarea').first();
    await opinion.fill('同意');
    await page.getByRole('button', { name:'提交' }).click();
    await page.waitForTimeout(5000);
  } catch (e) {
    logs.push({type:'local-error', error:String(e)});
  }
  console.log(JSON.stringify(logs, null, 2));
  await browser.close();
})();