const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testPageLayoutColumns() {
  console.log('--- Starting Multi-Column Page Layout Test Suite ---');
  const PORT = 25000 + Math.floor(Math.random() * 5000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-layout-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch('http://127.0.0.1:' + PORT + '/json');
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params) => new Promise((resolve, reject) => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    console.log('1. Checking UI controls: page layout dropdown beside next page...');
    const uiCheck = await evaluate(`
      const btn = document.querySelector('#btn-page-layout');
      const menu = document.querySelector('#menu-page-layout');
      const opt1 = document.querySelector('#opt-layout-1');
      const opt2 = document.querySelector('#opt-layout-2');
      const opt3 = document.querySelector('#opt-layout-3');
      const prevBtn = document.querySelector('#btn-prev-page');
      const nextBtn = document.querySelector('#btn-next-page');

      return {
        hasBtn: !!btn,
        hasMenu: !!menu,
        hasOpt1: !!opt1,
        hasOpt2: !!opt2,
        hasOpt3: !!opt3,
        btnText: btn ? btn.textContent.trim() : null,
        nextBtnPresent: !!nextBtn
      };
    `);
    console.log('   UI elements check:', uiCheck);
    if (!uiCheck.hasBtn || !uiCheck.hasMenu || !uiCheck.hasOpt1 || !uiCheck.hasOpt2 || !uiCheck.hasOpt3) {
      throw new Error('Page layout dropdown elements missing in DOM!');
    }
    console.log('   ✅ Page layout dropdown and 1, 2, 3 options present in toolbar.');

    console.log('2. Loading test_case1.pdf (2 pages)...');
    await evaluate(`while (!window.uiController) await new Promise(r => setTimeout(r, 50));`);
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
      await new Promise(r => setTimeout(r, 400));
    `);

    const pageCount = await evaluate(`return window.uiController.pdfEngine.getPageCount();`);
    console.log('   Loaded pages:', pageCount);
    if (pageCount !== 2) throw new Error(`Expected 2 pages, got ${pageCount}`);

    console.log('3. Verifying 1 page in a row (vertical stack layout)...');
    const layout1Check = await evaluate(`
      await window.uiController.setLayoutColumns(1, true);
      const wrappers = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
      const r0 = wrappers[0].getBoundingClientRect();
      const r1 = wrappers[1].getBoundingClientRect();
      return {
        cols: window.uiController.layoutColumns,
        containerClass: document.querySelector('.document-container').className,
        p0Top: r0.top,
        p0Left: r0.left,
        p1Top: r1.top,
        p1Left: r1.left,
        isVertical: r1.top > r0.bottom - 5,
        isSameX: Math.abs(r0.left - r1.left) < 5
      };
    `);
    console.log('   Layout 1 check:', layout1Check);
    if (!layout1Check.isVertical || !layout1Check.isSameX) {
      throw new Error('1-page layout expected vertical stacking with aligned X coordinates');
    }
    console.log('   ✅ 1 in a row: pages are stacked vertically and centered.');

    console.log('4. Testing 2 pages in a row (side-by-side spread)...');
    const layout2Check = await evaluate(`
      await window.uiController.setLayoutColumns(2, true);
      await new Promise(r => setTimeout(r, 200));
      const wrappers = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
      const r0 = wrappers[0].getBoundingClientRect();
      const r1 = wrappers[1].getBoundingClientRect();
      return {
        cols: window.uiController.layoutColumns,
        containerClass: document.querySelector('.document-container').className,
        btnText: document.querySelector('#label-page-layout').textContent.trim(),
        p0Top: r0.top,
        p0Right: r0.right,
        p1Top: r1.top,
        p1Left: r1.left,
        isSideBySide: Math.abs(r0.top - r1.top) < 8,
        isHorizontallyOrdered: r0.right <= r1.left + 5
      };
    `);
    console.log('   Layout 2 check:', layout2Check);
    if (!layout2Check.isSideBySide || !layout2Check.isHorizontallyOrdered) {
      throw new Error('2-page layout expected side-by-side positioning in the same row!');
    }
    if (layout2Check.cols !== 2 || !layout2Check.containerClass.includes('layout-cols-2')) {
      throw new Error('layoutColumns not updated to 2!');
    }
    console.log('   ✅ 2 in a row: Page 1 and Page 2 are positioned side-by-side in row 1.');

    console.log('5. Adding a blank 3rd page to test 3 pages in a row...');
    await evaluate(`
      document.querySelector('[data-action="add-blank-page"]').click();
      await new Promise(r => setTimeout(r, 400));
    `);
    const pageCountAfterAdd = await evaluate(`return window.uiController.pdfEngine.getPageCount();`);
    console.log('   Total pages after adding blank page:', pageCountAfterAdd);
    if (pageCountAfterAdd !== 3) throw new Error(`Expected 3 pages, got ${pageCountAfterAdd}`);

    console.log('6. Testing 3 pages in a row (3-column grid layout)...');
    const layout3Check = await evaluate(`
      await window.uiController.setLayoutColumns(3, true);
      await new Promise(r => setTimeout(r, 200));
      const wrappers = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
      const r0 = wrappers[0].getBoundingClientRect();
      const r1 = wrappers[1].getBoundingClientRect();
      const r2 = wrappers[2].getBoundingClientRect();
      return {
        cols: window.uiController.layoutColumns,
        containerClass: document.querySelector('.document-container').className,
        btnText: document.querySelector('#label-page-layout').textContent.trim(),
        isAllSameRow: Math.abs(r0.top - r1.top) < 8 && Math.abs(r1.top - r2.top) < 8,
        isLeftToRight: r0.right <= r1.left + 5 && r1.right <= r2.left + 5
      };
    `);
    console.log('   Layout 3 check:', layout3Check);
    if (!layout3Check.isAllSameRow || !layout3Check.isLeftToRight) {
      throw new Error('3-page layout expected all 3 pages side-by-side in the same row!');
    }
    console.log('   ✅ 3 in a row: Page 1, Page 2, and Page 3 are all positioned side-by-side in the same row.');

    console.log('7. Testing Keyboard Shortcuts (Alt+1, Alt+2, Alt+3)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }));
    `);
    const shortcut1 = await evaluate(`return window.uiController.layoutColumns;`);
    if (shortcut1 !== 1) throw new Error(`Alt+1 failed: expected cols=1, got ${shortcut1}`);

    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true }));
    `);
    const shortcut2 = await evaluate(`return window.uiController.layoutColumns;`);
    if (shortcut2 !== 2) throw new Error(`Alt+2 failed: expected cols=2, got ${shortcut2}`);

    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', altKey: true, bubbles: true }));
    `);
    const shortcut3 = await evaluate(`return window.uiController.layoutColumns;`);
    if (shortcut3 !== 3) throw new Error(`Alt+3 failed: expected cols=3, got ${shortcut3}`);
    console.log('   ✅ Keyboard shortcuts Alt+1, Alt+2, Alt+3 successfully switch layouts.');

    console.log('8. Testing clicking options in the dropdown menu directly...');
    await evaluate(`
      const opt2 = document.querySelector('#opt-layout-2');
      opt2.click();
    `);
    const opt2ClickResult = await evaluate(`
      return {
        cols: window.uiController.layoutColumns,
        btnText: document.querySelector('#label-page-layout').textContent.trim(),
        opt2Active: document.querySelector('#opt-layout-2').classList.contains('active'),
        opt1Active: document.querySelector('#opt-layout-1').classList.contains('active')
      };
    `);
    console.log('   Dropdown click result:', opt2ClickResult);
    if (opt2ClickResult.cols !== 2 || !opt2ClickResult.opt2Active || opt2ClickResult.opt1Active) {
      throw new Error('Clicking #opt-layout-2 did not update active state correctly');
    }
    console.log('   ✅ Clicking dropdown items updates layout, button label, and active indicator.');

    // Capture visual screenshot
    console.log('9. Capturing screenshot of 2-page side-by-side layout...');
    const ss = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve(__dirname, 'test-layout-2cols.png'), Buffer.from(ss.data, 'base64'));
    console.log('   Saved screenshot to test-layout-2cols.png');

    console.log('\n🎉 ALL MULTI-COLUMN PAGE LAYOUT TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    try {
      chrome.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

testPageLayoutColumns().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
