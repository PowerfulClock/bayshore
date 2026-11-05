/* Bayshore desktop (the launcher itself; main.js loads this file, or a newer copy it has downloaded).
   - The game file comes from GitHub (config.json: updateBase). At launch the app reads version.json there; if it names a
     newer build than the one cached on this computer, it downloads it, checks its SHA-256, and keeps it. No internet:
     it plays the cached build (or the one shipped inside the app the very first time).
   - The page is served from its own app:// origin, cross-origin isolated (COOP + COEP), so it may use SharedArrayBuffer
     and background workers on every core. The preload script tells the page it is the desktop app (BAYSHORE_NATIVE). */
const {app,BrowserWindow,protocol,net,ipcMain,dialog,shell}=require('electron');
const path=require('path'),fs=require('fs'),os=require('os'),crypto=require('crypto');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('force_high_performance_gpu');
// more of the CPU for the browser engine's own work: rasterising on several threads, textures uploaded without copies,
// a bigger JavaScript heap (fewer garbage-collection pauses)
app.commandLine.appendSwitch('num-raster-threads',String(Math.max(2,Math.min(8,os.cpus().length-2))));
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features','SharedArrayBuffer,CanvasOopRasterization');
app.commandLine.appendSwitch('js-flags','--max-old-space-size=4096');
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);

const HOME=global.BAYSHORE_APPDIR||__dirname;
const CFG=JSON.parse(fs.readFileSync(path.join(HOME,'config.json'),'utf8'));
const DATA=()=>path.join(app.getPath('userData'),'game');
const CACHED=()=>path.join(DATA(),'bayshore-game.html'),META=()=>path.join(DATA(),'version.json');
const BUNDLED=path.join(HOME,'game','bayshore-game.html'),BUNDLED_META=path.join(HOME,'game','version.json');
const readJSON=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){return null;}};
const newer=(a,b)=>{const pa=String(a||'0').split('.').map(Number),pb=String(b||'0').split('.').map(Number);for(let i=0;i<Math.max(pa.length,pb.length);i++){const x=pa[i]||0,y=pb[i]||0;if(x!==y)return x>y;}return false;};
let status={version:null,source:'bundled',update:'not checked',launcherFile:__filename};

function current(){const c=readJSON(META()),b=readJSON(BUNDLED_META);
  if(c&&fs.existsSync(CACHED())&&(!b||!newer(b.version,c.version)))return {file:CACHED(),version:c.version,source:'downloaded'};
  return {file:BUNDLED,version:b&&b.version,source:'bundled'};}
async function getText(url){const r=await net.fetch(url+(url.includes('?')?'&':'?')+'t='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status+' for '+url);return Buffer.from(await r.arrayBuffer());}
// the launcher's own code (this file, the preload): a newer copy is kept in userData/launcher and used from the next start
const LDIR=()=>path.join(app.getPath('userData'),'launcher');
async function launcherUpdate(){let man;try{man=JSON.parse((await getText(CFG.updateBase+CFG.manifest)).toString('utf8'));}catch(e){return;}const L=man.launcher;if(!L||!L.version||!Array.isArray(L.files))return;
  const mine=readJSON(path.join(LDIR(),'launcher.json')),built=readJSON(path.join(HOME,'launcher.json'));const have=[mine&&mine.version,built&&built.version].filter(Boolean).sort((a,b)=>newer(a,b)?-1:1)[0];
  if(have&&!newer(L.version,have))return;
  const tmp=LDIR()+'.part';fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(tmp,{recursive:true});
  for(const F of L.files){const rel=String(F.path||'');const name=path.basename(rel);if(!/^[\w.-]+$/.test(name))return;const b=await getText(CFG.updateBase+rel);
    if(F.sha256&&crypto.createHash('sha256').update(b).digest('hex')!==F.sha256)return;fs.writeFileSync(path.join(tmp,name),b);}
  fs.writeFileSync(path.join(tmp,'launcher.json'),JSON.stringify({version:L.version}));fs.rmSync(LDIR(),{recursive:true,force:true});fs.renameSync(tmp,LDIR());
  status.launcher='launcher '+L.version+' ready (next start)';
  for(const w of BrowserWindow.getAllWindows())w.webContents.executeJavaScript(`window.BAYSHORE_UPDATE&&BAYSHORE_UPDATE('Bayshore app updated: restart to use it')`).catch(()=>{});}
// look for a newer build; download, verify and keep it
async function checkUpdate(win){
  try{const man=JSON.parse((await getText(CFG.updateBase+CFG.manifest)).toString('utf8'));const cur=current();
    if(!man.version||!man.file){status.update='no manifest';return false;}
    if(!newer(man.version,cur.version)){status.update='up to date';return false;}
    if(win)win.webContents.executeJavaScript(`window.BAYSHORE_UPDATE&&BAYSHORE_UPDATE('Downloading update ${man.version}…')`).catch(()=>{});
    const buf=await getText(CFG.updateBase+man.file);const sum=crypto.createHash('sha256').update(buf).digest('hex');
    if(man.sha256&&man.sha256!==sum){status.update='update failed its checksum';return false;}
    fs.mkdirSync(DATA(),{recursive:true});
    // the files that go with it (engine sound recordings...): fetched when this computer's copy differs
    for(const A of man.assets||[]){const rel=String(A.path||'').replace(/\\/g,'/');if(!rel||rel.includes('..'))continue;const dst=path.join(DATA(),rel),own=fs.existsSync(dst)?dst:path.join(HOME,'game',rel);
      let have=null;try{have=crypto.createHash('sha256').update(fs.readFileSync(own)).digest('hex');}catch(e){}if(have===A.sha256)continue;
      const b=await getText(CFG.updateBase+rel);if(A.sha256&&crypto.createHash('sha256').update(b).digest('hex')!==A.sha256){status.update='an update file failed its checksum';return false;}
      fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,b);}
    fs.writeFileSync(CACHED()+'.part',buf);fs.renameSync(CACHED()+'.part',CACHED());fs.writeFileSync(META(),JSON.stringify(man));
    status.update='updated to '+man.version;return man.version;}
  catch(e){status.update='offline ('+e.message+')';return false;}
  finally{try{await launcherUpdate();}catch(e){console.warn('launcher update',e.message);}}}

// the three.js files the page loads from CDNs are shipped inside the app too, so it plays offline
const LIBS=[[/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/three\.min\.js/,'/lib/three.min.js'],[/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.128\.0\/(examples\/js\/.+\.js)/,'/lib/$1']];
function serve(){const {session}=require('electron');
  session.defaultSession.webRequest.onBeforeRequest({urls:['https://cdnjs.cloudflare.com/*','https://cdn.jsdelivr.net/*']},(d,cb)=>{for(const [re,to] of LIBS){const m=d.url.match(re);if(m){const local=to.replace('$1',m[1]||'');if(fs.existsSync(path.join(HOME,'game',local)))return cb({redirectURL:'app://bayshore'+local});}}cb({});});
  protocol.handle('app',async req=>{const u=new URL(req.url);let p=decodeURIComponent(u.pathname);if(p==='/'||p==='')p='/bayshore-game.html';
    const cur=current();let file=p==='/bayshore-game.html'?cur.file:p.startsWith('/lib/')?path.join(HOME,'game',p):path.join(DATA(),p);
    // everything else (the engine sounds...): the downloaded copy if there is one, else the one shipped in the app
    if(p!=='/bayshore-game.html'&&!p.startsWith('/lib/')&&!fs.existsSync(file))file=path.join(HOME,'game',p);
    let body;try{body=fs.readFileSync(file);}catch(e){return new Response('not found',{status:404});}
    const type=p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.js')?'text/javascript':p.endsWith('.json')?'application/json':'application/octet-stream';
    return new Response(body,{headers:{'content-type':type,'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'credentialless','Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'}});});}

ipcMain.handle('bayshore-info',()=>({app:'desktop',version:status.version,launcher:(readJSON(path.join(__dirname,'launcher.json'))||{}).version||app.getVersion(),cores:os.cpus().length,update:status.update,source:status.source}));
ipcMain.handle('bayshore-save',async(e,{filename,data})=>{const w=BrowserWindow.fromWebContents(e.sender);const r=await dialog.showSaveDialog(w,{defaultPath:path.join(app.getPath('pictures'),filename)});
  if(r.canceled||!r.filePath)return {status:'declined'};fs.writeFileSync(r.filePath,Buffer.from(data));return {status:'saved'};});

async function start(){serve();
  const win=new BrowserWindow({width:1600,height:900,backgroundColor:'#120820',title:'Bayshore',autoHideMenuBar:true,show:false,
    webPreferences:{preload:path.join(fs.existsSync(path.join(__dirname,'preload.js'))?__dirname:HOME,'preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
  win.setMenuBarVisibility(false);
  // check for an update first (a few seconds at most), then load whatever is newest here
  const t=new Promise(r=>setTimeout(()=>r(false),6000));await Promise.race([checkUpdate(null),t]);
  const cur=current();status.version=cur.version;status.source=cur.source;
  win.loadURL('app://bayshore/bayshore-game.html');
  if(process.env.BAYSHORE_SELFTEST){win.webContents.on('console-message',(e,l,m)=>{if(/error/i.test(m))console.log('[page]',m.slice(0,200));});setTimeout(async()=>{if(process.env.BAYSHORE_SELFTEST_JS){try{const r=await win.webContents.executeJavaScript(fs.readFileSync(process.env.BAYSHORE_SELFTEST_JS,'utf8'));console.log('SELFTEST',r);}catch(e){console.log('SELFTEST ERR',e.message);}app.quit();return;}try{const r=await win.webContents.executeJavaScript('JSON.stringify({iso:self.crossOriginIsolated,sab:typeof SharedArrayBuffer,native:!!window.BAYSHORE_NATIVE,cores:window.BAYSHORE_NATIVE&&BAYSHORE_NATIVE.cores,three:!!window.THREE,sky:!!(window.THREE&&THREE.Sky),bayg:!!window.BAYG,ld:(document.getElementById("ldStep")||{}).textContent})');console.log('SELFTEST',r,JSON.stringify(status));}catch(e){console.log('SELFTEST ERR',e.message);}app.quit();},+process.env.BAYSHORE_SELFTEST);}win.once('ready-to-show',()=>win.show());
  win.webContents.setWindowOpenHandler(({url})=>{shell.openExternal(url);return {action:'deny'};});
  win.webContents.on('before-input-event',(e,i)=>{if(i.type==='keyDown'&&i.key==='F11'){win.setFullScreen(!win.isFullScreen());e.preventDefault();}});
  // while playing: look again every 20 minutes; a new build is used the next time the game starts
  setInterval(async()=>{const v=await checkUpdate(null);if(v)win.webContents.executeJavaScript(`window.BAYSHORE_UPDATE&&BAYSHORE_UPDATE('Update ${v} downloaded: it loads next time you start Bayshore')`).catch(()=>{});},20*60*1000);}

app.whenReady().then(start);
app.on('window-all-closed',()=>app.quit());
