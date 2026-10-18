const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8156;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

async function runTests() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Server listening on http://localhost:${PORT}`);

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const debugPort = 9366;
  const userDataDir = `/tmp/chrome-test-shift-select-${Date.now()}`;

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1440,900',
    `http://localhost:${PORT}/pdfgod.html`
  ]);

  await new Promise(r => setTimeout(r, 2500));

  try {
    const targetsRes = await fetch(`http://localhost:${debugPort}/json`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (event) => {
          const res = JSON.parse(event.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            if (res.error) reject(res.error);
            else resolve(res.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');

    async function evaluate(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception.description);
      }
      return res.result.value;
    }

    async function captureScreenshot(filepath) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
      console.log(`📸 Saved screenshot to: ${filepath}`);
    }

    console.log('--- Step 1: Load test_case1.pdf and expand to 5 pages ---');
    const pdfPath = '/Users/pumisake/Downloads/test_case1.pdf';
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfBase64 = pdfBytes.toString('base64');

    await evaluate(`
      (async () => {
        const binary = atob("${pdfBase64}");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await window.uiController.loadPdfBuffer(bytes.buffer, "test_multipage.pdf");
      })()
    `);

    // Let's add 3 pages so we have 5 total pages for thorough multi-page testing
    await evaluate(`
      (async () => {
        window.uiController.pdfEngine.addBlankPage(1); // Page 3
        window.uiController.pdfEngine.addBlankPage(2); // Page 4
        window.uiController.pdfEngine.addBlankPage(3); // Page 5
        await window.uiController.renderDocument();
        await window.uiController.renderThumbnails();
      })()
    `);

    const pageCount = await evaluate(`window.uiController.pdfEngine.getPageCount()`);
    console.log(`Document initialized with ${pageCount} pages.`);
    if (pageCount !== 5) throw new Error(`Expected 5 pages, got ${pageCount}`);

    console.log('--- Step 2: Switch to 3-page layout view ---');
    await evaluate(`
      (async () => {
        await window.uiController.setLayoutColumns(3);
      })()
    `);
    const layoutCols = await evaluate(`window.uiController.layoutColumns`);
    console.log(`Layout columns set to: ${layoutCols}`);

    console.log('--- Step 3: Test single click selection ---');
    await evaluate(`
      (() => {
        // Click Page 1 header bar (index 0)
        const header0 = document.querySelectorAll('.page-header-bar')[0];
        header0.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: false, ctrlKey: false }));
      })()
    `);
    let sel = await evaluate(`Array.from(window.uiController.selectedPages)`);
    console.log('Selected pages after single click on Page 1:', sel);
    if (sel.length !== 1 || sel[0] !== 0) throw new Error(`Expected [0], got ${JSON.stringify(sel)}`);

    console.log('--- Step 4: Test Shift-click range selection (Pages 1 to 3) ---');
    await evaluate(`
      (() => {
        // Shift-click Page 3 header bar (index 2)
        const header2 = document.querySelectorAll('.page-header-bar')[2];
        header2.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, ctrlKey: false }));
      })()
    `);
    sel = await evaluate(`Array.from(window.uiController.selectedPages).sort((a,b)=>a-b)`);
    console.log('Selected pages after Shift-click on Page 3:', sel);
    if (JSON.stringify(sel) !== JSON.stringify([0, 1, 2])) {
      throw new Error(`Expected [0, 1, 2], got ${JSON.stringify(sel)}`);
    }

    // Check UI selection classes
    const uiState = await evaluate(`
      (() => {
        const wrappers = Array.from(document.querySelectorAll('.page-wrapper')).map(w => w.classList.contains('page-selected'));
        const headers = Array.from(document.querySelectorAll('.page-header-bar')).map(h => h.classList.contains('page-header-selected'));
        const checks = Array.from(document.querySelectorAll('.page-select-checkbox')).map(c => c.classList.contains('checked'));
        const thumbs = Array.from(document.querySelectorAll('.thumbnail-card')).map(t => t.classList.contains('page-selected'));
        return { wrappers, headers, checks, thumbs };
      })()
    `);
    console.log('UI selection classes for first 3 pages:', {
      wrappers: uiState.wrappers.slice(0, 3),
      headers: uiState.headers.slice(0, 3),
      checks: uiState.checks.slice(0, 3),
      thumbs: uiState.thumbs.slice(0, 3),
    });
    if (!uiState.wrappers[0] || !uiState.wrappers[1] || !uiState.wrappers[2]) {
      throw new Error('Wrappers 0, 1, 2 should be marked page-selected');
    }
    if (!uiState.checks[0] || !uiState.checks[1] || !uiState.checks[2]) {
      throw new Error('Checkboxes 0, 1, 2 should be marked checked');
    }
    if (!uiState.thumbs[0] || !uiState.thumbs[1] || !uiState.thumbs[2]) {
      throw new Error('Thumbnails 0, 1, 2 should be marked page-selected');
    }
    if (uiState.wrappers[3] || uiState.wrappers[4]) {
      throw new Error('Wrappers 3, 4 should NOT be marked page-selected');
    }

    await evaluate(`
      (async () => {
        await window.uiController.fitToWidth();
        window.uiController.viewport.scrollTop = 0;
      })()
    `);
    await captureScreenshot('/Users/pumisake/Documents/antigravity/keen-brahmagupta/screenshot-range-selected-3cols.png');

    console.log('--- Step 5: Test Drag & Drop Rearranging of Selected Range [Pages 1, 2, 3] to after Page 5 ---');
    // We move range [0, 1, 2] to insertAfterIndex = 4 (after Page 5)
    // Resulting original page order should be: [3, 4, 0, 1, 2]
    await evaluate(`
      (async () => {
        const res = await window.uiController.reorderPages([0, 1, 2], 4);
        await window.uiController.fitToWidth();
        window.uiController.viewport.scrollTop = 0;
        return res;
      })()
    `);

    const newOrder = await evaluate(`
      window.uiController.pdfEngine.pageOrder.map(p => p.srcIndex !== undefined ? p.srcIndex : 'blank')
    `);
    console.log('Page order after moving [0, 1, 2] after Page 5:', newOrder);

    // After reorder, selected pages should now be the new indices [2, 3, 4]
    const updatedSel = await evaluate(`Array.from(window.uiController.selectedPages).sort((a,b)=>a-b)`);
    console.log('Selected pages after reordering:', updatedSel);
    if (JSON.stringify(updatedSel) !== JSON.stringify([2, 3, 4])) {
      throw new Error(`Expected selected pages [2, 3, 4], got ${JSON.stringify(updatedSel)}`);
    }

    await captureScreenshot('/Users/pumisake/Documents/antigravity/keen-brahmagupta/screenshot-after-range-rearrange.png');

    console.log('--- Step 6: Test Shift-click range in Sidebar Thumbnails ---');
    // Click thumbnail 0, Shift-click thumbnail 1 -> selects [0, 1]
    await evaluate(`
      (() => {
        const thumbs = document.querySelectorAll('.thumbnail-card');
        thumbs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: false, ctrlKey: false }));
        thumbs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, ctrlKey: false }));
      })()
    `);
    sel = await evaluate(`Array.from(window.uiController.selectedPages).sort((a,b)=>a-b)`);
    console.log('Selected pages from thumbnail Shift-click:', sel);
    if (JSON.stringify(sel) !== JSON.stringify([0, 1])) {
      throw new Error(`Expected [0, 1], got ${JSON.stringify(sel)}`);
    }

    console.log('--- Step 7: Test Thumbnail Drag-and-drop Rearrange ---');
    // Move [0, 1] to after page index 3 (which is Page 4) -> insertAfterIndex = 3
    await evaluate(`
      (async () => {
        await window.uiController.reorderPages([0, 1], 3);
      })()
    `);
    const finalSel = await evaluate(`Array.from(window.uiController.selectedPages).sort((a,b)=>a-b)`);
    console.log('Selected pages after thumbnail reorder:', finalSel);
    if (JSON.stringify(finalSel) !== JSON.stringify([2, 3])) {
      throw new Error(`Expected [2, 3], got ${JSON.stringify(finalSel)}`);
    }

    console.log('--- Step 8: Test Quick action buttons move left/right for selected group ---');
    // Pages [2, 3] are selected. Move left via `<` button on header of page 2
    await evaluate(`
      (async () => {
        const header2 = document.querySelectorAll('.page-header-bar')[2];
        const leftBtn = header2.querySelector('[data-action="move-left"]');
        leftBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()
    `);
    // Wait for async render
    await new Promise(r => setTimeout(r, 600));

    sel = await evaluate(`Array.from(window.uiController.selectedPages).sort((a,b)=>a-b)`);
    console.log('Selected pages after moving group left with < button:', sel);
    if (JSON.stringify(sel) !== JSON.stringify([1, 2])) {
      throw new Error(`Expected [1, 2], got ${JSON.stringify(sel)}`);
    }

    console.log('--- Step 9: Verify Annotations and Text remain intact after reordering ---');
    // Add text annotation on page 1 (which was moved)
    await evaluate(`
      (() => {
        window.uiController.annotationManager.addAnnotation({
          pageIndex: 1,
          type: 'text',
          x: 100,
          y: 100,
          text: 'Verified Multipage Shift Rearrange'
        });
      })()
    `);
    // Move page 1 to 0
    await evaluate(`
      (async () => {
        await window.uiController.reorderPages([1], -1); // top
      })()
    `);
    const annotsPage0 = await evaluate(`
      window.uiController.annotationManager.getPageAnnotations(0).map(a => a.text)
    `);
    console.log('Annotations on Page 0 after moving to top:', annotsPage0);
    if (!annotsPage0.includes('Verified Multipage Shift Rearrange')) {
      throw new Error('Annotation failed to follow reordered page!');
    }

    console.log('✅ ALL RANGE SELECTION & MULTI-PAGE REARRANGE TESTS PASSED PERFECTLY!');

  } finally {
    chrome.kill();
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
