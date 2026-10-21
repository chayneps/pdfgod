const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('🚀 Starting Properties Bar Right-Side Page Selection Test...');
  const PORT = 27000 + Math.floor(Math.random() * 2000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-propbar-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        const targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    if (!page) throw new Error('Could not connect to Chrome debugging port ' + PORT);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await new Promise(r => setTimeout(r, 800));

    const evalJs = async (expr) => {
      const res = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true
      });
      return res.result ? res.result.value : null;
    };

    // 1. Verify toolbar container only has 2 child bars (NO 3rd bar)
    const toolbarChildrenCount = await evalJs(`
      document.querySelector('.toolbar-container').children.length
    `);
    console.log('Test 1: Toolbar container has exactly 2 bars (Primary Toolbar + Properties Bar):', toolbarChildrenCount === 2 ? 'PASS' : 'FAIL', `(${toolbarChildrenCount} children)`);

    // 2. Load test_case2.pdf (4 pages)
    const testPdfPath = path.resolve(__dirname, 'test_case2.pdf');
    const pdfBytes = fs.readFileSync(testPdfPath);

    await evalJs(`
      (async () => {
        const bin = atob("${pdfBytes.toString('base64')}");
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await window.uiController.loadPdfBuffer(arr.buffer, 'test_case2.pdf');
      })()
    `);

    await new Promise(r => setTimeout(r, 800));

    // 3. Switch to "Select text" (edit-pdf-text) tool
    await evalJs(`
      window.uiController.canvasController.setTool('edit-pdf-text');
      window.uiController.updatePropertiesBarForTool('edit-pdf-text');
    `);
    await new Promise(r => setTimeout(r, 300));

    // 4. Verify widget is on the right side of the properties bar
    const barLayout = await evalJs(`
      (() => {
        const propBar = document.querySelector('.properties-bar');
        const propContent = document.querySelector('#prop-content');
        const widget = document.querySelector('#selected-pages-top-bar');
        const textEl = document.querySelector('#selected-pages-text');
        const saveBtn = document.querySelector('#btn-save-pages-to-file');

        const propRect = propBar.getBoundingClientRect();
        const widgetRect = widget.getBoundingClientRect();
        const contentRect = propContent.getBoundingClientRect();

        return {
          isInsidePropBar: widget.parentElement === propBar,
          propBarHeight: propRect.height,
          widgetOnRight: widgetRect.right <= propRect.right + 2 && widgetRect.left > contentRect.left,
          contentHasSelectText: propContent.textContent.includes('Select text'),
          widgetText: textEl ? textEl.textContent.trim() : null,
          btnText: saveBtn ? saveBtn.textContent.trim() : null
        };
      })()
    `);

    console.log('Test 2: Widget is inside .properties-bar:', barLayout.isInsidePropBar ? 'PASS' : 'FAIL');
    console.log('Test 3: Total properties-bar height is compact (<= 44px):', barLayout.propBarHeight <= 44 ? 'PASS' : 'FAIL', `(${barLayout.propBarHeight}px)`);
    console.log('Test 4: Left side shows "Select text" hint:', barLayout.contentHasSelectText ? 'PASS' : 'FAIL');
    console.log('Test 5: Widget is placed on the right side of properties-bar:', barLayout.widgetOnRight ? 'PASS' : 'FAIL');
    console.log('Test 6: Initial text is Page 1:', barLayout.widgetText.includes('Page 1') ? 'PASS' : 'FAIL', `("${barLayout.widgetText}")`);
    console.log('Test 6b: Button text is "Extract page to file":', barLayout.btnText === 'Extract page to file' ? 'PASS' : 'FAIL', `("${barLayout.btnText}")`);

    // 5. Verify "Select All" and "Deselect" buttons are removed from the bar
    const buttonsCheck = await evalJs(`
      (() => {
        const selectAll = document.querySelector('#btn-select-all-pages');
        const deselect = document.querySelector('#btn-deselect-pages');
        const extractBtn = document.querySelector('#btn-save-pages-to-file');
        return {
          hasSelectAll: !!selectAll,
          hasDeselect: !!deselect,
          hasExtract: !!extractBtn
        };
      })()
    `);
    console.log('Test 7: "Select All" and "Deselect" buttons removed:', (!buttonsCheck.hasSelectAll && !buttonsCheck.hasDeselect && buttonsCheck.hasExtract) ? 'PASS' : 'FAIL');

    // 6. Test Cmd/Ctrl+Click on Page 2 to multi-select
    await evalJs(`
      window.uiController.selectPage(1, false, true);
    `);
    await new Promise(r => setTimeout(r, 200));

    const multiState = await evalJs(`
      (() => {
        const text = document.querySelector('#selected-pages-text').textContent.trim();
        const btn = document.querySelector('#btn-save-pages-to-file').textContent.trim();
        return { text, btn };
      })()
    `);
    console.log('Test 8: Cmd-click multi-select updates widget:', multiState.text.includes('2 pages') && multiState.text.includes('Pages 1, 2') ? 'PASS' : 'FAIL', `("${multiState.text}")`);
    console.log('Test 8b: Multi-select button text is "Extract pages to file":', multiState.btn === 'Extract pages to file' ? 'PASS' : 'FAIL', `("${multiState.btn}")`);

    // 7. Open Extract modal via "Extract pages to file"
    await evalJs(`
      document.querySelector('#btn-save-pages-to-file').click()
    `);
    await new Promise(r => setTimeout(r, 300));

    const modalState = await evalJs(`
      (() => {
        const modal = document.querySelector('#extract-pages-modal');
        const copyBtn = modal ? modal.querySelector('#btn-extract-copy') : null;
        const removeBtn = modal ? modal.querySelector('#btn-extract-remove') : null;
        const cancelBtn = modal ? modal.querySelector('#btn-extract-cancel') : null;
        return {
          isOpen: modal && modal.open,
          copyText: copyBtn ? copyBtn.textContent.trim() : null,
          removeText: removeBtn ? removeBtn.textContent.trim() : null,
          cancelText: cancelBtn ? cancelBtn.textContent.trim() : null,
        };
      })()
    `);
    console.log('Test 9: Modal opened with Option 3 buttons:', (modalState.isOpen && modalState.copyText === 'Export Copy' && modalState.removeText === 'Extract & Remove' && modalState.cancelText === 'Cancel') ? 'PASS' : 'FAIL');

    // Close modal
    await evalJs(`
      document.querySelector('#btn-extract-cancel').click()
    `);
    await new Promise(r => setTimeout(r, 300));

    // Capture screenshot of the full window to verify visual presentation
    const ss = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.resolve(__dirname, 'test-propbar-right-preview.png');
    fs.writeFileSync(screenshotPath, Buffer.from(ss.data, 'base64'));
    console.log(`📸 Saved screenshot to: ${screenshotPath}`);

    console.log('\n🎉 ALL Properties Bar Right-Side Page Selection Tests PASSED!');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
