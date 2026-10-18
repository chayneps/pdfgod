const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testSaveFlow() {
  console.log('--- Starting Save & Replace Confirmation Test Suite ---');
  const PORT = 24000 + Math.floor(Math.random() * 5000);
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
    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
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

    console.log('1. Checking Save button text, icon, and tooltip in top header...');
    const btnCheck = await evaluate(`
      const saveBtn = document.querySelector('#btn-export-pdf');
      const text = saveBtn.querySelector('span')?.textContent?.trim();
      const title = saveBtn.getAttribute('title');
      const hasSvg = !!saveBtn.querySelector('svg');
      return { text, title, hasSvg };
    `);

    console.log('Save button details:', btnCheck);
    if (btnCheck.text !== 'Save') throw new Error(`Expected button text 'Save', got '${btnCheck.text}'`);
    if (!btnCheck.title.includes('Save')) throw new Error(`Expected button tooltip to contain 'Save', got '${btnCheck.title}'`);
    console.log('✅ Button successfully changed to "Save" with disk icon.');

    console.log('2. Loading test_case1.pdf into the app...');
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');

    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    const loadedState = await evaluate(`
      return {
        docTitle: window.uiController.docTitleInput.value,
        exists: window.uiController.checkFileExists("test_case1.pdf")
      };
    `);
    console.log('Loaded file state:', loadedState);
    if (loadedState.docTitle !== 'test_case1.pdf') throw new Error(`Unexpected docTitle: ${loadedState.docTitle}`);
    if (!loadedState.exists) throw new Error('Loaded file should be marked as existing!');
    console.log('✅ Document loaded with title test_case1.pdf and marked as existing.');

    console.log('3. Clicking Save button when file exists (expecting confirmation modal)...');
    // We trigger saveDocument asynchronously and inspect the dialog
    const modalCheck = await evaluate(`
      // Start save in background
      let savePromise = window.uiController.saveDocument();
      window.__activeSavePromise = savePromise;
      
      // Allow dialog to open
      await new Promise(r => setTimeout(r, 100));

      const dialog = document.querySelector('#dialog-confirm-replace');
      const isOpen = dialog.hasAttribute('open');
      const filenameLabel = document.querySelector('#confirm-replace-filename')?.textContent;
      const noBtn = document.querySelector('#btn-cancel-replace');
      const yesBtn = document.querySelector('#btn-confirm-replace');

      return {
        isOpen,
        filenameLabel,
        hasNoBtn: !!noBtn,
        hasYesBtn: !!yesBtn
      };
    `);

    console.log('Modal status check:', modalCheck);
    if (!modalCheck.isOpen) throw new Error('Replace confirmation modal did NOT open!');
    if (modalCheck.filenameLabel !== 'test_case1.pdf') throw new Error(`Modal label expected 'test_case1.pdf', got '${modalCheck.filenameLabel}'`);
    console.log('✅ Replace confirmation modal opened with correct filename.');

    console.log('3b. Capturing screenshot of confirmation modal...');
    await send('Page.enable');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve(__dirname, 'test-save-modal.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Modal screenshot saved to test-save-modal.png');

    console.log('4. Clicking "No" button on the modal...');
    const noClickResult = await evaluate(`
      const noBtn = document.querySelector('#btn-cancel-replace');
      noBtn.click();
      const res = await window.__activeSavePromise;

      const dialog = document.querySelector('#dialog-confirm-replace');
      const isClosed = !dialog.hasAttribute('open');
      const isInputFocused = document.activeElement === window.uiController.docTitleInput;
      const selectionStart = window.uiController.docTitleInput.selectionStart;
      const selectionEnd = window.uiController.docTitleInput.selectionEnd;
      const valueLength = window.uiController.docTitleInput.value.length;

      return {
        res,
        isClosed,
        isInputFocused,
        isTextSelected: selectionStart === 0 && selectionEnd === valueLength
      };
    `);

    console.log('Result after clicking No:', noClickResult);
    if (!noClickResult.isClosed) throw new Error('Modal did not close after clicking No!');
    if (!noClickResult.isInputFocused) throw new Error('Doc title input is NOT focused after clicking No!');
    if (!noClickResult.isTextSelected) throw new Error('Doc title text was NOT selected for easy renaming!');
    if (noClickResult.res.saved !== false) throw new Error('Document should not have been saved when No was clicked!');
    console.log('✅ Clicking "No" successfully closed modal, aborted save, and focused/selected the name input.');

    console.log('5. Renaming document to "test_case1_renamed.pdf" and clicking Save...');
    const renameAndSaveResult = await evaluate(`
      window.uiController.docTitleInput.value = 'test_case1_renamed.pdf';
      const res = await window.uiController.saveDocument();
      const dialog = document.querySelector('#dialog-confirm-replace');
      const isOpen = dialog.hasAttribute('open');
      const existsNow = window.uiController.checkFileExists('test_case1_renamed.pdf');

      return {
        res,
        modalOpened: isOpen,
        existsNow
      };
    `);

    console.log('Rename and Save result:', renameAndSaveResult);
    if (renameAndSaveResult.modalOpened) throw new Error('Modal should NOT open for a new file name!');
    if (renameAndSaveResult.res.saved !== true) throw new Error('Save failed for new file name!');
    if (renameAndSaveResult.res.filename !== 'test_case1_renamed.pdf') {
      throw new Error(`Expected saved filename 'test_case1_renamed.pdf', got '${renameAndSaveResult.res.filename}'`);
    }
    if (!renameAndSaveResult.existsNow) throw new Error('Newly saved file should now be tracked as existing!');
    console.log('✅ New file name saved directly without modal prompt, and is now tracked as existing.');

    console.log('6. Saving again with "test_case1_renamed.pdf" and clicking "Yes, Replace"...');
    const replaceResult = await evaluate(`
      let savePromise = window.uiController.saveDocument();
      window.__activeSavePromise = savePromise;
      await new Promise(r => setTimeout(r, 100));

      const dialog = document.querySelector('#dialog-confirm-replace');
      const isOpen = dialog.hasAttribute('open');
      
      // Click Yes
      const yesBtn = document.querySelector('#btn-confirm-replace');
      yesBtn.click();
      const res = await savePromise;
      const isClosed = !dialog.hasAttribute('open');

      return {
        modalOpened: isOpen,
        isClosed,
        res
      };
    `);

    console.log('Replace result:', replaceResult);
    if (!replaceResult.modalOpened) throw new Error('Modal did NOT open for existing file on second save!');
    if (!replaceResult.isClosed) throw new Error('Modal did NOT close after clicking Yes!');
    if (replaceResult.res.saved !== true) throw new Error('File did not save after confirming Yes!');
    if (replaceResult.res.filename !== 'test_case1_renamed.pdf') {
      throw new Error(`Expected saved filename 'test_case1_renamed.pdf', got '${replaceResult.res.filename}'`);
    }
    console.log('✅ Clicking "Yes, Replace" successfully confirmed and saved over the existing file.');

    console.log('\n🎉 ALL SAVE & REPLACE CONFIRMATION TESTS PASSED 100%!');
  } finally {
    chrome.kill('SIGKILL');
  }
}

testSaveFlow().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
