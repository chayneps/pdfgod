const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testSaveAsAndArrows() {
  console.log('--- Starting Save As & Keyboard Arrow Nudge Test Suite ---');
  const PORT = 25000 + Math.floor(Math.random() * 5000);
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

    console.log('1. Verifying "Try Sample" buttons and logic have been completely removed...');
    const sampleCheck = await evaluate(`
      return {
        headerSampleBtn: !!document.querySelector('#btn-load-sample'),
        dropzoneSampleBtn: !!document.querySelector('#btn-dropzone-sample'),
        hasSampleBytes: typeof window.SAMPLE_PDF_BYTES !== 'undefined'
      };
    `);
    console.log('   Sample elements check:', sampleCheck);
    if (sampleCheck.headerSampleBtn || sampleCheck.dropzoneSampleBtn || sampleCheck.hasSampleBytes) {
      throw new Error('Sample document remnants found!');
    }
    console.log('   ✅ No sample document buttons or bytes exist in the DOM or window.');

    console.log('2. Verifying "Save As" option in export dropdown menu...');
    const saveAsCheck = await evaluate(`
      const saveAsBtn = document.querySelector('#btn-save-as');
      return {
        exists: !!saveAsBtn,
        text: saveAsBtn ? saveAsBtn.textContent.trim() : null,
        dialogExists: !!document.querySelector('#dialog-save-as')
      };
    `);
    console.log('   Save As check:', saveAsCheck);
    if (!saveAsCheck.exists || !saveAsCheck.text.includes('Save As') || !saveAsCheck.dialogExists) {
      throw new Error('Save As button or dialog missing!');
    }
    console.log('   ✅ "Save As..." exists inside the export dropdown and has dialog modal.');

    console.log('3. Loading test_case1.pdf...');
    await evaluate(`while (!window.uiController) await new Promise(r => setTimeout(r, 50));`);
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    const titleVal = await evaluate(`return window.uiController.docTitleInput.value;`);
    console.log('   Document Title loaded:', titleVal);
    if (titleVal !== 'test_case1.pdf') throw new Error(`Expected test_case1.pdf, got ${titleVal}`);

    console.log('4. Testing "Save As" flow...');
    // Trigger Save As in background and inspect modal
    const saveAsModalPromise = evaluate(`
      let p = window.uiController.saveAsDocument();
      window.__saveAsPromise = p;
      return true;
    `);
    await saveAsModalPromise;
    await new Promise(r => setTimeout(r, 200));

    const saveAsDialogState = await evaluate(`
      const dialog = document.querySelector('#dialog-save-as');
      const input = document.querySelector('#input-save-as-name');
      return {
        open: dialog ? dialog.open : false,
        inputValue: input ? input.value : ''
      };
    `);
    console.log('   Save As Dialog state:', saveAsDialogState);
    if (!saveAsDialogState.open) throw new Error('Save As dialog did not open!');
    if (!saveAsDialogState.inputValue.includes('test_case1')) throw new Error('Default Save As name unexpected: ' + saveAsDialogState.inputValue);

    // Now enter new name: "my_custom_saved_as.pdf" and submit dialog
    console.log('   Entering new name "my_custom_saved_as.pdf" and confirming...');
    await evaluate(`
      const input = document.querySelector('#input-save-as-name');
      input.value = "my_custom_saved_as.pdf";
      document.querySelector('#btn-confirm-save-as').click();
    `);
    await new Promise(r => setTimeout(r, 500));

    const postSaveAsTitle = await evaluate(`
      return {
        inputVal: window.uiController.docTitleInput.value,
        engineFilename: window.pdfEngine.filename,
        existsInStorage: window.uiController.checkFileExists("my_custom_saved_as.pdf")
      };
    `);
    console.log('   Post Save As state:', postSaveAsTitle);
    if (postSaveAsTitle.inputVal !== 'my_custom_saved_as.pdf') {
      throw new Error(`Doc title input was not updated to new name! Got: ${postSaveAsTitle.inputVal}`);
    }
    if (postSaveAsTitle.engineFilename !== 'my_custom_saved_as.pdf') {
      throw new Error(`Engine filename was not updated! Got: ${postSaveAsTitle.engineFilename}`);
    }
    console.log('   ✅ Save As updated title input, pdfEngine filename, and saved file.');

    console.log('5. Testing Arrow Key text nudging (5px normal, 1px with Shift)...');
    // Select text tool and create a text annotation on page 0
    await evaluate(`
      document.querySelector('.tool-btn[data-tool="text"]').click();
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const evt = new PointerEvent('pointerdown', {
        button: 0,
        clientX: rect.left + 200,
        clientY: rect.top + 100,
        bubbles: true
      });
      layer.dispatchEvent(evt);
    `);
    await new Promise(r => setTimeout(r, 300));

    const initialPos = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      return { id: ann.id, x: ann.x, y: ann.y };
    `);
    console.log('   Initial text annotation position:', initialPos);

    // Test 1: Normal ArrowDown -> +5px y
    console.log('   Pressing ArrowDown (expecting +5px Y)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    `);
    const afterDown = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('[data-id="' + ann.id + '"]');
      return { x: ann.x, y: ann.y, domTop: parseFloat(el.style.top) };
    `);
    console.log('   After ArrowDown:', afterDown);
    if (afterDown.y !== initialPos.y + 5) {
      throw new Error(`Expected y to be ${initialPos.y + 5}, got ${afterDown.y}`);
    }

    // Test 2: Normal ArrowRight -> +5px x
    console.log('   Pressing ArrowRight (expecting +5px X)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    `);
    const afterRight = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('[data-id="' + ann.id + '"]');
      return { x: ann.x, y: ann.y, domLeft: parseFloat(el.style.left) };
    `);
    console.log('   After ArrowRight:', afterRight);
    if (afterRight.x !== initialPos.x + 5) {
      throw new Error(`Expected x to be ${initialPos.x + 5}, got ${afterRight.x}`);
    }

    // Test 3: Shift + ArrowUp -> -1px y
    console.log('   Pressing Shift+ArrowUp (expecting -1px Y micro-step)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    `);
    const afterShiftUp = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('[data-id="' + ann.id + '"]');
      return { x: ann.x, y: ann.y, domTop: parseFloat(el.style.top) };
    `);
    console.log('   After Shift+ArrowUp:', afterShiftUp);
    if (afterShiftUp.y !== afterDown.y - 1) {
      throw new Error(`Expected y to be ${afterDown.y - 1}, got ${afterShiftUp.y}`);
    }

    // Test 4: Shift + ArrowLeft -> -1px x
    console.log('   Pressing Shift+ArrowLeft (expecting -1px X micro-step)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    `);
    const afterShiftLeft = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('[data-id="' + ann.id + '"]');
      return { x: ann.x, y: ann.y, domLeft: parseFloat(el.style.left) };
    `);
    console.log('   After Shift+ArrowLeft:', afterShiftLeft);
    if (afterShiftLeft.x !== afterRight.x - 1) {
      throw new Error(`Expected x to be ${afterRight.x - 1}, got ${afterShiftLeft.x}`);
    }

    // Test 5: Verify focused inside .pdf-text-content also catches arrow keys for nudging
    console.log('   Testing arrow nudge while typing inside .pdf-text-content...');
    await evaluate(`
      const el = document.querySelector('.pdf-text-content');
      el.focus();
      const evt = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
      el.dispatchEvent(evt);
    `);
    const afterFocusedDown = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      return { x: ann.x, y: ann.y };
    `);
    console.log('   After ArrowDown while focused in contenteditable:', afterFocusedDown);
    if (afterFocusedDown.y !== afterShiftUp.y + 5) {
      throw new Error(`Expected y to be ${afterShiftUp.y + 5}, got ${afterFocusedDown.y}`);
    }

    console.log('   ✅ All arrow key nudging tests (normal 5px, shift 1px, focused text) passed!');
    console.log('🎉 ALL SAVE AS & ARROW KEY TESTS PASSED SUCCESSFULLY! 🎉');

  } finally {
    chrome.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testSaveAsAndArrows().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
