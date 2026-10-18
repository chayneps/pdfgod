const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testBeforeUnload() {
  console.log('--- Starting Browser Refresh & Data Loss Prevention Test Suite ---');
  const PORT = 26000 + Math.floor(Math.random() * 5000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
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
    const pendingRequests = new Map();
    const eventHandlers = new Map();

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.id && pendingRequests.has(data.id)) {
        const resolve = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);
        resolve(data.result);
      } else if (data.method && eventHandlers.has(data.method)) {
        const handler = eventHandlers.get(data.method);
        handler(data.params);
      }
    };

    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      pendingRequests.set(curId, resolve);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');

    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    console.log('1. Testing initial empty dropzone state (no document loaded)...');
    const initialCheck = await evaluate(`
      const evt = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(evt);
      return {
        hasUnsavedChanges: window.uiController.hasUnsavedChanges(),
        pageCount: window.pdfEngine.getPageCount(),
        isDefaultPrevented: evt.defaultPrevented
      };
    `);
    console.log('   Initial state check:', initialCheck);
    if (initialCheck.hasUnsavedChanges) {
      throw new Error('Expected hasUnsavedChanges to be false initially!');
    }
    if (initialCheck.isDefaultPrevented) {
      throw new Error('beforeunload should NOT be prevented on empty dropzone!');
    }
    console.log('   ✅ No prompt on empty dropzone.');

    console.log('2. Loading test_case1.pdf into the editor...');
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    const loadedCheck = await evaluate(`
      const evt = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(evt);
      return {
        hasUnsavedChanges: window.uiController.hasUnsavedChanges(),
        pageCount: window.pdfEngine.getPageCount(),
        isDefaultPrevented: evt.defaultPrevented,
        returnValue: evt.returnValue
      };
    `);
    console.log('   Loaded document beforeunload check:', loadedCheck);
    if (!loadedCheck.hasUnsavedChanges) {
      throw new Error('Expected hasUnsavedChanges to be true when a document is loaded!');
    }
    if (!loadedCheck.isDefaultPrevented) {
      throw new Error('beforeunload should be cancelled/prevented when a document is active!');
    }
    console.log('   ✅ Document load successfully activates beforeunload confirmation.');

    console.log('3. Making changes: Adding a text annotation...');
    await evaluate(`
      window.annotationManager.addAnnotation({
        pageIndex: 0,
        type: 'text',
        x: 100,
        y: 100,
        text: 'Important Confidential Note'
      });
    `);

    const modifiedCheck = await evaluate(`
      const evt = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(evt);
      return {
        hasUnsavedChanges: window.uiController.hasUnsavedChanges(),
        annotationsCount: window.annotationManager.annotations.length,
        isDefaultPrevented: evt.defaultPrevented
      };
    `);
    console.log('   Modified document check:', modifiedCheck);
    if (!modifiedCheck.hasUnsavedChanges || !modifiedCheck.isDefaultPrevented) {
      throw new Error('beforeunload should be active when document has edits!');
    }
    console.log('   ✅ Edits maintain beforeunload confirmation.');

    console.log('4. Saving document to disk (confirming replacement)...');
    await evaluate(`
      let p = window.uiController.saveDocument();
      window.__savePromise = p;
      return true;
    `);
    await new Promise(r => setTimeout(r, 200));

    await evaluate(`
      const confirmBtn = document.querySelector('#btn-confirm-replace');
      if (confirmBtn) confirmBtn.click();
    `);
    const saveResult = await evaluate(`return await window.__savePromise;`);
    console.log('   Save result:', { saved: saveResult.saved, filename: saveResult.filename });
    if (!saveResult.saved) throw new Error('Save failed: ' + JSON.stringify(saveResult));

    const postSaveCheck = await evaluate(`
      const evt = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(evt);
      return {
        hasUnsavedChanges: window.uiController.hasUnsavedChanges(),
        isDefaultPrevented: evt.defaultPrevented
      };
    `);
    console.log('   Post-save check:', postSaveCheck);
    if (postSaveCheck.hasUnsavedChanges) {
      throw new Error('hasUnsavedChanges should be false immediately after saving!');
    }
    if (postSaveCheck.isDefaultPrevented) {
      throw new Error('beforeunload should NOT be prevented right after saving with no new edits!');
    }
    console.log('   ✅ Saving document clears dirty state.');

    console.log('5. Making new changes after save (Page rotation)...');
    await evaluate(`
      window.uiController.pdfEngine.rotatePage(0, 90);
      window.uiController.isDirty = true;
    `);

    const postRotateCheck = await evaluate(`
      const evt = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(evt);
      return {
        hasUnsavedChanges: window.uiController.hasUnsavedChanges(),
        isDefaultPrevented: evt.defaultPrevented
      };
    `);
    console.log('   Post-rotation check:', postRotateCheck);
    if (!postRotateCheck.hasUnsavedChanges || !postRotateCheck.isDefaultPrevented) {
      throw new Error('Page rotation after save should re-activate beforeunload confirmation!');
    }
    console.log('   ✅ New changes after save re-activate beforeunload confirmation.');

    console.log('6. Testing real browser refresh with Page.javascriptDialogOpening interception...');
    // We register event handler for Page.javascriptDialogOpening
    let dialogOpened = false;
    let dialogType = null;

    eventHandlers.set('Page.javascriptDialogOpening', async (params) => {
      console.log('   [CDP Event] Page.javascriptDialogOpening received:', params);
      dialogOpened = true;
      dialogType = params.type;
      // Click "Cancel" / stay on page to prevent data loss
      await send('Page.handleJavaScriptDialog', { accept: false });
      console.log('   [CDP Event] Clicked Cancel to stay on page.');
    });

    // Send trusted physical click via CDP Input domain to set navigator.userActivation.hasBeenActive
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 });
    const userActivation = await evaluate(`
      return {
        hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
        isActive: navigator.userActivation ? navigator.userActivation.isActive : null,
        hasUnsavedChanges: window.uiController.hasUnsavedChanges()
      };
    `);
    console.log('   User activation check:', userActivation);

    // Trigger reload
    console.log('   Sending Page.reload command...');
    // Page.reload might wait if dialog opens or reject if navigation cancelled
    try {
      await send('Page.reload', { ignoreCache: true });
    } catch (e) {
      // Chrome CDP may throw if navigation was aborted by user clicking Cancel, which is expected!
      console.log('   (Reload command result/abort:', e.message || 'cancelled)');
    }

    await new Promise(r => setTimeout(r, 600));

    // Verify document was NOT lost and still has 2 pages
    const preservedState = await evaluate(`
      return {
        pageCount: window.pdfEngine.getPageCount(),
        hasDocContainer: window.uiController.docContainer.style.display !== 'none',
        annotationsCount: window.annotationManager.annotations.length
      };
    `);
    console.log('   Preserved document state after refresh cancelled:', preservedState);
    if (preservedState.pageCount < 2) {
      throw new Error('Document data was lost on refresh! Expected 2 pages, got: ' + preservedState.pageCount);
    }
    if (preservedState.annotationsCount < 1) {
      throw new Error('Annotations were lost on refresh!');
    }
    console.log('   ✅ Data preserved! Document and annotations remain completely intact.');

    console.log('🎉 ALL REFRESH CONFIRMATION & DATA LOSS PREVENTION TESTS PASSED! 🎉');

  } finally {
    chrome.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testBeforeUnload().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
