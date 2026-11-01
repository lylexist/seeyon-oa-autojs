#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

(function loadEnv(){
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath,'utf8').split('\n')) {
    const t=line.trim(); if(!t||t.startsWith('#')) continue;
    const i=t.indexOf('='); if(i<0) continue;
    const k=t.slice(0,i).trim(); let v=t.slice(i+1).trim();
    if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
    if (k && !process.env[k]) process.env[k]=v;
  }
})();

const BASE_URL=(process.env.OA_URL||'').replace(/\/$/,'');
const OA_USER=process.env.OA_USER||'';
const OA_PASS=process.env.OA_PASS||'';
const OA_OPINION=process.env.OA_OPINION||'同意';
if(!BASE_URL||!OA_USER||!OA_PASS){ console.error('缺少 OA_URL/OA_USER/OA_PASS'); process.exit(1); }

function req(method, urlStr, body, headers={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(urlStr); const lib=u.protocol==='https:'?https:http;
    const opts={ hostname:u.hostname, port:u.port||(u.protocol==='https:'?443:80), path:u.pathname+u.search, method,
      rejectUnauthorized:false, headers:{ 'User-Agent':'Mozilla/5.0 (OA-Automation)', ...headers } };
    if(body && !opts.headers['Content-Length']) opts.headers['Content-Length']=Buffer.byteLength(body);
    const r=lib.request(opts,res=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode, headers:res.headers, body:d}));});
    r.on('error',reject); if(body) r.write(body); r.end();
  });
}

function requirePlaywright(){
  const candidates=['playwright', path.join(__dirname,'../node_modules/playwright'), path.join(__dirname,'../../node_modules/playwright')];
  for(const p of candidates){ try{return require(p);}catch(_){} }
  throw new Error('未找到 playwright');
}

async function login(){
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({channel:'chrome', headless:true, args:['--ignore-certificate-errors','--no-sandbox']});
  const context = await browser.newContext({ ignoreHTTPSErrors:true });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/`, {waitUntil:'domcontentloaded', timeout:30000});
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
  const cookies = await context.cookies();
  await browser.close();
  const js = cookies.find(c=>c.name==='JSESSIONID')?.value;
  const ts = cookies.find(c=>c.name==='ts')?.value;
  if(!js) throw new Error('登录失败: 无 JSESSIONID');
  return `JSESSIONID=${js}; ts=${ts||''}; login_locale=zh_CN`;
}

async function getPendingPage(cookies, page=1){
  const body=`managerMethod=getPendingList&arguments=${encodeURIComponent(JSON.stringify([{page},{aiSort:'false',templeteIds:''}]))}`;
  const r=await req('POST', `${BASE_URL}/ajax.do?method=ajaxAction&managerName=colManager&rnd=${Date.now()}`, body, {
    'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest','Cookie':cookies
  });
  return JSON.parse(r.body);
}

async function getPendingList(cookies){
  const first = await getPendingPage(cookies, 1);
  const pages = first.pages || 1;
  let tasks = first.data || [];
  for (let page = 2; page <= pages; page++) {
    const more = await getPendingPage(cookies, page);
    tasks = tasks.concat(more.data || []);
  }
  return tasks;
}

async function initDetail(cookies, affairId){
  const commonHeaders={ 'Cookie':cookies, 'X-Requested-With':'XMLHttpRequest' };
  const baseInfo = await req('GET', `${BASE_URL}/rest/collaboration/v1/web/new/baseInfo?method=summary&affairId=${affairId}&showTab=true&openFrom=listPending&bodyType=20&theme=simple&designTplId=67081001&templateId=&from=listPending&projectId=&summaryId=&baseObjectId=&baseApp=&cashId=&processId=&designId=&docId=`, null, commonHeaders);
  const nodePerm = await req('GET', `${BASE_URL}/rest/collaboration/v1/web/new/deal/nodePermission/${affairId}?hasFormLock=false&isInSpecialBack=false`, null, commonHeaders);
  let base = {}, perm = {};
  try { base = JSON.parse(baseInfo.body); } catch(_) {}
  try { perm = JSON.parse(nodePerm.body); } catch(_) {}
  return { base, perm };
}

function deepGet(obj, pathArr){ let o=obj; for(const k of pathArr){ if(o==null) return undefined; o=o[k]; } return o; }

async function approveOne(cookies, task, opinion=OA_OPINION){
  const { base, perm } = await initDetail(cookies, task.affairId);
  const content = deepGet(base, ['data','content']) || deepGet(base, ['content']) || {};
  const formData = base?.data || base || {};
  const workflow = perm?.data || perm || {};

  const payload = {
    collaborationDealParamData: {
      comment: {
        attitude: { code: 'agree', subject: '同意', isDefault: true },
        content: opinion,
        pushMessageUserIds: [], praiseToSummary: false, richContent: '', isRichContent: false,
        assDocDomain: [], attFileDomain: [], hidden: false,
        showToId: deepGet(formData,['formmain_0116','field0104']) || ''
      },
      superviseSet: workflow.superviseSet || { detailId:'', superviseAwakeDate:'', superviseTitle:'', supervisorIds:'', supervisorNames:'', isModifySupervise:false },
      trackSet: workflow.trackSet || { isTrack:false, isTrackAll:true, trackMembers:'', trackMemberNames:'' },
      dealDepartment: workflow.dealDepartment || deepGet(perm,['dealDepartment']) || {},
      isPigeonhole: false,
      assDocDomain: [], attFileDomain: [], attachmentLogs: [], modifyType: 0, submitCode: 'ContinueSubmit'
    },
    thirdpartParamData: { data: [], thirdPartyContext: {} },
    otherParamData: { data: {} },
    formParamData: { data: formData },
    workflowParamData: { context: workflow.context || workflow, cpMatchResult: workflow.cpMatchResult || { allNotSelectNodes:[], allSelectNodes:[], allSelectInformNodes:[], pop:'false', token:'', last:'false', alreadyChecked:'false', workflowPreCommitInfo:{} }, weekSubmit: false }
  };

  const r = await req('POST', `${BASE_URL}/rest/collaboration/v1/web/new/deal/${task.affairId}`, JSON.stringify(payload), {
    'Cookie': cookies,
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json, text/plain, */*',
    'Origin': BASE_URL.replace(/\/seeyon$/,''),
    'Referer': `${BASE_URL}/app/collaboration/index.html?method=summary&affairId=${task.affairId}&showTab=true&openFrom=listPending&bodyType=20&theme=simple&designTplId=67081001`
  });
  return { status:r.status, body:r.body.slice(0,1000) };
}

(async()=>{
  const target = process.argv[2] || 'all';
  const cookies = await login();
  const tasks = await getPendingList(cookies);
  let selected;
  if (target === 'all') {
    selected = tasks;
  } else if (target === 'fixed-vehicle') {
    selected = tasks.filter(t => /园区固定车辆申请/.test(String(t.subject||'')));
  } else {
    const ids = target.split(',').map(s => s.trim()).filter(Boolean);
    selected = tasks.filter(t => ids.includes(String(t.affairId)));
  }
  if(!selected.length){ console.log('NO_TASK'); process.exit(0); }
  console.log(`SELECTED ${selected.length}/${tasks.length} pending tasks; target=${target}`);
  for(const t of selected){
    console.log(`APPROVING ${t.affairId} ${t.subject}`);
    const res = await approveOne(cookies, t, OA_OPINION);
    console.log(JSON.stringify(res, null, 2));
  }
})();