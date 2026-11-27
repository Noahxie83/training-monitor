import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
import os from 'node:os';

let app: ElectronApplication;
let page: Page;
let testData: string;

test.beforeAll(async () => {
  testData = await mkdtemp(path.join(os.tmpdir(), 'TrainingMonitor-ui-desktop-'));
  app = await electron.launch({
    args: [path.resolve('dist/main.cjs'), '--demo', `--user-data-dir=${path.join(testData, 'profile')}`],
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  if (testData) await rm(testData, { recursive: true, force: true });
});

test('renders Layout A at 1200x800 in dark mode and captures screenshot', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1200, 800);
  });
  await page.setViewportSize({ width: 1200, height: 800 });

  // Select dark mode explicitly for dark theme screenshot
  await page.getByRole('button', { name: '系统设置' }).click();
  await page.getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '关闭设置' }).click();

  // Verify header and demo badge
  await expect(page.getByText('DEMO', { exact: true })).toBeVisible();
  await expect(page.getByTitle('模拟数据')).toBeVisible();

  // Verify initial task cockpit
  await expect(page.getByRole('heading', { name: 'demo-task' })).toBeVisible();
  await expect(page.getByText('累计进度')).toBeVisible();

  // Verify progress bar geometry (I17)
  const rails = page.locator('.progress-bar-rail');
  await expect(rails.first()).toBeVisible();
  const railBox = await rails.first().boundingBox();
  expect(railBox).not.toBeNull();
  expect(railBox!.height).toBeGreaterThanOrEqual(6);
  expect(railBox!.width).toBeGreaterThan(100);

  const fillGlobal = page.locator('.progress-fill-global');
  await expect(fillGlobal).toBeAttached();

  // Boundary verification for unknown/null fraction: renders 0% and .fill-empty (I6, I15)
  await expect(fillGlobal).toHaveClass(/fill-empty/);
  const globalStyleWidth = await fillGlobal.evaluate((el) => el.style.width);
  expect(globalStyleWidth).toBe('0%');

  // Verify Checkpoint & Resource panels
  await expect(page.getByLabel('最新检查点')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前任务 GPU' })).toBeVisible();

  // Capture 1200x800 dark screenshot
  const darkScreenshotPath = path.resolve('test-results/ui-1200x800-dark.png');
  await page.screenshot({ path: darkScreenshotPath });
  expect(darkScreenshotPath).toBeTruthy();
});

test('toggles light mode via settings modal and captures 1200x800 light screenshot', async () => {
  // Open settings
  await page.getByRole('button', { name: '系统设置' }).click();
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

  // Switch to light theme
  await page.getByRole('radio', { name: '浅色' }).click();

  // Verify app-shell theme data attribute changed
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light');

  // Close settings
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByRole('heading', { name: '系统设置' })).not.toBeVisible();

  // Capture 1200x800 light screenshot
  const lightScreenshotPath = path.resolve('test-results/ui-1200x800-light.png');
  await page.screenshot({ path: lightScreenshotPath });
  expect(lightScreenshotPath).toBeTruthy();
});

test('adapts to small window 960x650 and captures both theme screenshots', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(960, 650);
  });
  await page.setViewportSize({ width: 960, height: 650 });

  // The full task list stays available at small widths.
  await expect(page.locator('.task-fleet-panel')).not.toHaveClass(/is-collapsed/);
  await expect(page.locator('.fleet-task-item').first()).toBeVisible();
  await expect(page.locator('.collapsed-task-dropdown')).toHaveCount(0);

  // Verify log viewport has ample visible area (>= 180px) and footer is within window (I13)
  const logBox = await page.locator('.log-viewport').boundingBox();
  expect(logBox).not.toBeNull();
  expect(logBox!.height).toBeGreaterThanOrEqual(180);

  const footerBox = await page.locator('.log-console-footer').boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(650);

  // Still in light mode from previous test, capture 960x650 light screenshot
  const lightSmallPath = path.resolve('test-results/ui-960x650-light.png');
  await page.screenshot({ path: lightSmallPath });
  expect(lightSmallPath).toBeTruthy();

  // Switch back to dark mode
  await page.getByRole('button', { name: '系统设置' }).click();
  await page.getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '关闭设置' }).click();

  // Capture 960x650 dark screenshot
  const darkSmallPath = path.resolve('test-results/ui-960x650-dark.png');
  await page.screenshot({ path: darkSmallPath });
  expect(darkSmallPath).toBeTruthy();
});

test('verifies keyboard navigation: Ctrl+1, Ctrl+F, Esc and Space isolation', async () => {
  // Reset window size to 1200x800
  await page.setViewportSize({ width: 1200, height: 800 });

  // Press Ctrl+1 to select task
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('heading', { name: 'demo-task' })).toBeVisible();

  // Ctrl+F focuses search input
  await page.keyboard.press('Control+f');
  const searchInput = page.getByPlaceholder(/搜索日志 \(Ctrl\+F\)/);
  await expect(searchInput).toBeFocused();

  // Space key isolation inside search input (I14): types space, does NOT toggle scroll lock
  await page.keyboard.type('loss eval');
  await expect(searchInput).toHaveValue('loss eval');
  await expect(page.getByRole('button', { name: '锁定自动滚动' })).toBeVisible();

  // Esc clears search input (I2, I14)
  await page.keyboard.press('Escape');
  await expect(searchInput).toHaveValue('');

  // Space key on buttons triggers button click, does NOT toggle log scroll lock (I14)
  const wrapBtn = page.getByRole('button', { name: '换行' });
  await wrapBtn.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '不换行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '锁定自动滚动' })).toBeVisible();
  // Toggle back
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '换行' })).toBeVisible();

  // Open details drawer, focus trap, and Escape to close (I14)
  await page.getByRole('button', { name: '任务详情' }).click();
  await expect(page.getByRole('heading', { name: '任务技术详情' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '任务技术详情' })).not.toBeVisible();
});

test('copies registered path with visual feedback in real Electron window', async () => {
  // Register demo-task so copyRegisteredPath can find its whitelisted path
  await page.evaluate(async () => {
    const reg = await window.monitor.getRegistry();
    await window.monitor.saveRegistry({
      version: 2,
      revision: reg.revision,
      hosts: [
        {
          hostId: 'demo-host',
          label: 'Demo Host',
          enabled: true,
          allowedRoots: ['/data'],
          target: { kind: 'ssh', alias: 'gpu-server-01' },
        },
      ],
      tasks: [
        {
          taskId: 'demo-task',
          hostId: 'demo-host',
          label: 'Demo Task',
          enabled: true,
          algorithm: 'unknown',
          allowedDirectories: ['/data/demo'],
          entryPaths: ['/data/demo/run.py'],
          sources: [{ sourceId: 'demo-log', path: '/data/demo/train.log', kind: 'log' }],
          checkpointDirectories: [],
        },
      ],
    });
  });

  const copyBtn = page.getByRole('button', { name: /复制路径/ });
  await copyBtn.click();
  await expect(page.getByRole('button', { name: /已复制/ })).toBeVisible();
});

test('verifies virtualized log console, scroll lock and unread banner in real Electron', async () => {
  const logViewport = page.getByRole('region', { name: '日志流视窗' });
  await expect(logViewport).toBeVisible();

  // Verify virtualized rows rendering and non-overlapping (I5)
  const rows = page.locator('.log-event-row');
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);
  const box0 = await rows.nth(0).boundingBox();
  const box1 = await rows.nth(1).boundingBox();
  expect(box0).not.toBeNull();
  expect(box1).not.toBeNull();
  expect(box1!.y).toBeGreaterThanOrEqual(box0!.y + box0!.height - 1);

  // 1. Check scroll geometry: scrollHeight > clientHeight
  const initialScroll = await logViewport.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(initialScroll.scrollHeight).toBeGreaterThan(initialScroll.clientHeight);

  // 2. Scroll up to engage manual reading lock (I6, I15)
  await logViewport.evaluate((el) => {
    el.scrollTop = 20;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '恢复自动滚动' })).toBeVisible();

  // 3. While locked, refresh/redraw arrives; verify real floating unread banner appears (I6, I15)
  await page.getByRole('button', { name: '刷新全部宿主与任务数据 (Ctrl+R)' }).click();
  const banner = page.locator('.log-unread-floating-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/新行/);

  // Assert floating unread banner geometry & positioning (I6, I15):
  // - Real CSS position is 'absolute'
  // - Does NOT displace virtual scroll flow (sits as an overlay inside .log-viewport-wrapper)
  const bannerPos = await banner.evaluate((el) => window.getComputedStyle(el).position);
  expect(bannerPos).toBe('absolute');
  const bannerBox = await banner.boundingBox();
  const wrapperBox = await page.locator('.log-viewport-wrapper').boundingBox();
  expect(bannerBox).not.toBeNull();
  expect(wrapperBox).not.toBeNull();
  expect(bannerBox!.y).toBeGreaterThanOrEqual(wrapperBox!.y);

  // 4. Click resume button inside the floating banner: auto-scroll resumes, banner disappears, scrolls to bottom
  const resumeInBanner = banner.locator('button');
  await resumeInBanner.click();
  await expect(banner).toBeHidden();
  await expect(page.getByRole('button', { name: '锁定自动滚动' })).toBeVisible();

  const resumedScroll = await logViewport.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(resumedScroll.scrollTop + resumedScroll.clientHeight).toBeGreaterThanOrEqual(resumedScroll.scrollHeight - 5);

  // 5. Selection & selectionchange synchronization without unlocking reading lock (I6, I15)
  await logViewport.evaluate((el) => {
    el.scrollTop = 50;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: '恢复自动滚动' })).toBeVisible();

  await logViewport.evaluate((el) => {
    const textNode = el.querySelector('.log-event-row .log-col-text')?.firstChild;
    if (!textNode) throw new Error('Expected production log text node for real selection');
    {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      if (!sel || sel.toString().length !== 5) throw new Error('Real log selection was not created');
      document.dispatchEvent(new Event('selectionchange'));
    }
  });
  await expect(page.getByRole('button', { name: '恢复自动滚动' })).toBeVisible();

  await logViewport.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('button', { name: '恢复自动滚动' })).toBeVisible();

  await page.getByRole('button', { name: '恢复自动滚动' }).click();
  await expect(page.getByRole('button', { name: '锁定自动滚动' })).toBeVisible();

  // 6. Keyboard Space toggling when focused
  await logViewport.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '恢复自动滚动' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '锁定自动滚动' })).toBeVisible();

  // 7. Line wrapping toggle
  const initialWrap = await page.locator('.log-viewport').evaluate((el) => el.classList.contains('wrap-lines') && !el.classList.contains('nowrap-lines'));
  const wrapBtn = page.locator('button[title="切换日志换行"]');
  await wrapBtn.click();
  if (initialWrap) {
    await expect(page.locator('.log-viewport')).toHaveClass(/nowrap-lines/);
    await wrapBtn.click();
    await expect(page.locator('.log-viewport')).toHaveClass(/\bwrap-lines\b/);
  } else {
    await expect(page.locator('.log-viewport')).toHaveClass(/\bwrap-lines\b/);
    await wrapBtn.click();
    await expect(page.locator('.log-viewport')).toHaveClass(/nowrap-lines/);
  }
});

test('NB6/I14: production settings and drawer restore opener after Escape and close; inert isolates focus and snapshots retain focus', async()=>{
  for (const kind of ['settings','drawer']) {
    const opener=kind==='settings'?page.getByRole('button',{name:'系统设置'}):page.getByRole('button',{name:'任务详情'});
    const close=kind==='settings'?'关闭设置':'关闭抽屉';
    for (const mode of ['escape','button']) {
      await opener.focus();await opener.click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
      await expect(page.locator('.app-header')).toHaveAttribute('inert','');await expect(page.locator('.app-body')).toHaveAttribute('inert','');
      const focused=await page.evaluate(()=>document.activeElement?.outerHTML);
      await page.evaluate(()=>window.monitor.requestRefresh({}));
      expect(await page.evaluate(()=>document.activeElement?.outerHTML)).toBe(focused);
      await page.evaluate(()=>{(document.querySelector('.app-header button') as HTMLButtonElement).focus();});
      expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
      const buttons=dialog.locator('button:visible');await buttons.last().focus();await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
      if(mode==='escape')await page.keyboard.press('Escape');else await page.getByRole('button',{name:close}).click();
      await expect(dialog).toBeHidden();await expect(opener).toBeFocused();expect(await page.locator('[inert]').count()).toBe(0);
    }
  }
});

// Deliberately separate from production IPC tests above. This window renders the
// production App/components/CSS against complete public simulated MonitorApi data.
test.describe('isolated simulated renderer fixture geometry',()=>{
  let fixturePage:Page;
  let fixtureDirectory:string;
  test.beforeAll(async()=>{
    fixtureDirectory=await mkdtemp(path.join(testData,'renderer-fixture-'));
    await build({entryPoints:[path.resolve('tests/ui/electron-fixture.tsx')],bundle:true,outfile:path.join(fixtureDirectory,'fixture.js'),platform:'browser',format:'iife',loader:{'.woff2':'file'},define:{'process.env.NODE_ENV':'"production"'}});
    await copyFile(path.resolve('tests/ui/electron-fixture.html'),path.join(fixtureDirectory,'index.html'));
  });
  test.beforeEach(async()=>{
    const fixturePath = path.join(fixtureDirectory, 'index.html');
    const fixtureUrl = await app.evaluate(async({BrowserWindow,session},file)=>{
      const isolated=session.fromPartition('fix4-renderer-fixture');isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')}));isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
      const window=new BrowserWindow({width:1200,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,session:isolated}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
      await window.loadFile(file);
      return window.webContents.getURL();
    }, fixturePath);
    await expect.poll(() => app.windows().map(window => window.url())).toContain(fixtureUrl);
    fixturePage = app.windows().find(window => window.url() === fixtureUrl)!;
    await expect(fixturePage.locator('.log-console-footer')).toContainText('500');
  });
  test.afterEach(async()=>{await fixturePage?.close();});

  async function command(name:string,...args:unknown[]){await fixturePage.evaluate(({name,args})=>(window as any).simulatedRendererFixture[name](...args),{name,args});}
  async function bottom(){const v=fixturePage.locator('.log-viewport');await expect.poll(()=>v.evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop))).toBeLessThan(5);}
  async function anchor(){return fixturePage.locator('.log-viewport').evaluate(el=>{
    const box=el.getBoundingClientRect();const rows=Array.from(el.querySelectorAll<HTMLElement>('.log-event-row'));const row=rows.find(row=>row.getBoundingClientRect().bottom>box.top+2);
    if(!row)throw new Error('No visible production anchor row');return {id:row.getAttribute('data-event-id'),top:row.getBoundingClientRect().top-box.top};
  });}
  async function assertAnchor(want:{id:string|null;top:number}){await expect.poll(async()=>(await anchor()).id).toBe(want.id);await expect.poll(async()=>Math.abs((await anchor()).top-want.top)).toBeLessThan(2);console.log('SIMULATED renderer anchor:',JSON.stringify({expected:want,actual:await anchor()}));}

  test('I6/I15: selected loaded text locks current anchor across append, full 10000 buffer, prepend and head eviction; explicit recovery on actual eviction',async()=>{
    await bottom();
    // Select actual rendered text directly after asynchronous page load. No prior
    // scroll event establishes an anchor; this catches the stale selection closure.
    const viewport=fixturePage.locator('.log-viewport');
    await viewport.evaluate(el=>{
      const box=el.getBoundingClientRect();const row=Array.from(el.querySelectorAll('.log-event-row')).find(row=>row.getBoundingClientRect().bottom>box.top+2);const text=row?.querySelector('.log-col-text')?.firstChild;
      if(!text)throw new Error('Expected visible selected production text');const range=document.createRange();range.setStart(text,0);range.setEnd(text,9);const selection=window.getSelection();if(!selection)throw new Error('No selection');selection.removeAllRanges();selection.addRange(range);if(selection.toString().length!==9)throw new Error('Selection failed');document.dispatchEvent(new Event('selectionchange'));
    });
    await expect(fixturePage.getByRole('button',{name:'恢复自动滚动',exact:true}).first()).toBeVisible();const selectedAnchor=await anchor();
    console.log('SIMULATED renderer selected anchor:',JSON.stringify(selectedAnchor));const beforeBox=await viewport.boundingBox();await command('push',500,9500);await expect(fixturePage.locator('.log-console-footer')).toContainText('10,000');await assertAnchor(selectedAnchor);
    const afterBox=await viewport.boundingBox();console.log('SIMULATED renderer unread layout:',JSON.stringify({beforeBox,afterBox}));expect(afterBox).toEqual(beforeBox);expect(await fixturePage.evaluate(()=>window.getSelection()?.toString())).toHaveLength(9);
    await fixturePage.evaluate(()=>{window.getSelection()!.removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});await assertAnchor(selectedAnchor);
    // Establish a real nonzero intra-row reading offset after proving that the
    // async-load selection itself captured an anchor without any prior scroll.
    await viewport.evaluate(el=>{el.scrollTop+=9;el.dispatchEvent(new Event('scroll'));});
    const readingAnchor=await anchor();expect(readingAnchor.top).toBeLessThan(-2);
    await fixturePage.getByRole('button',{name:/加载更早日志/}).click();await assertAnchor(readingAnchor);
    await command('push',10000,25);await assertAnchor(readingAnchor);await expect(fixturePage.getByText('当前阅读位置已被缓冲区淘汰')).toBeHidden();
    await command('push',10025,10000);await expect(fixturePage.getByText('当前阅读位置已被缓冲区淘汰')).toBeVisible();
    await fixturePage.getByRole('button',{name:'重新从最新加载',exact:true}).click();await expect(fixturePage.getByText('当前阅读位置已被缓冲区淘汰')).toBeHidden();
    await fixturePage.getByRole('button',{name:'恢复自动滚动',exact:true}).first().click();await bottom();
  });

  test('I6/I15: full capacity follows append and same-ID growing redraw; long wrap and resize preserve non-overlapping measured rows',async()=>{
    await command('push',500,9500);await bottom();await command('push',10000,1);await bottom();
    const long='SIMULATED long wrapped text '.repeat(60);await command('redraw',10000,long);await bottom();
    const tail=fixturePage.locator('[data-event-id="fixture-10000"]');await expect(tail).toContainText(long);
    const wrappedBox=await tail.boundingBox();expect(wrappedBox!.height).toBeGreaterThan(52);
    await fixturePage.setViewportSize({width:1120,height:800});await bottom();const resizedBox=await tail.boundingBox();console.log('SIMULATED renderer wrap resize:',JSON.stringify({wrappedBox,resizedBox}));expect(resizedBox!.width).toBeLessThan(wrappedBox!.width);expect(resizedBox!.height).toBeGreaterThan(wrappedBox!.height);
    await fixturePage.setViewportSize({width:960,height:650});await bottom();
    const rows=fixturePage.locator('.log-event-row');const boxes=await rows.evaluateAll(rows=>rows.map(r=>{const b=r.getBoundingClientRect();return {y:b.y,bottom:b.bottom};}));expect(boxes.length).toBeGreaterThan(1);for(let i=1;i<boxes.length;i++)expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i-1].bottom-1);
    await fixturePage.getByTitle('切换日志换行').click();await bottom();expect((await tail.boundingBox())!.height).toBeLessThan(resizedBox!.height);
    await fixturePage.locator('.log-viewport').focus();const prevented=await viewportSpace229(fixturePage);expect(prevented).toBe(false);await expect(fixturePage.getByRole('button',{name:'锁定自动滚动'})).toBeVisible();
  });

  test('I15: actual fill bounding boxes track unknown, zero, 52.3 percent and 100 percent',async()=>{
    for(const fraction of [null,0,0.523,1]){
      await command('progress',fraction);
      for(const suffix of ['global','session']){
        const fill=fixturePage.locator(`.progress-fill-${suffix}`);const rail=fill.locator('..');
        await expect.poll(async()=>{const f=await fill.boundingBox();const r=await rail.boundingBox();if(!f||!r)throw new Error('Missing real progress geometry');return Math.abs(f.width-r.width*(fraction??0));}).toBeLessThan(2);console.log('SIMULATED renderer progress:',JSON.stringify({fraction,suffix,fill:await fill.boundingBox(),rail:await rail.boundingBox()}));
      }
    }
  });
});

async function viewportSpace229(target:Page){return target.locator('.log-viewport').evaluate(el=>{const event=new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:229,isComposing:false,bubbles:true,cancelable:true});el.dispatchEvent(event);return event.defaultPrevented;});}
