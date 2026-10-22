const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing PDF Password Protection & Permissions Bypass');
  console.log('====================================================');

  const PORT = 29600 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-password-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
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
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      try {
        const res = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true
        });
        if (res.exceptionDetails) {
          console.error('ExceptionDetails:', JSON.stringify(res.exceptionDetails, null, 2));
          throw new Error('Evaluation failed: ' + (res.exceptionDetails.exception ? res.exceptionDetails.exception.description : JSON.stringify(res.exceptionDetails)));
        }
        return res.result ? res.result.value : undefined;
      } catch (err) {
        console.error('evaluate error for:', expression.slice(0, 100), err);
        throw err;
      }
    };

    console.log('Waiting for pdfgod.html application initialization...');
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        if (window.uiController && window.pdfEngine && window.PDFLib && window.PDFLibEncrypt) {
          resolve(true);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    })`);
    console.log('✅ Application loaded with PDFLib and PDFLibEncrypt ready.');

    // Step 1: Create a password-protected PDF in memory with password "secret123"
    console.log('\n--- Test 1: Create & Load Encrypted PDF (password prompt, retry wrong pw, unlock) ---');
    await evaluate(`(async () => {
      const doc = await PDFLib.PDFDocument.create();
      const page = doc.addPage([400, 400]);
      page.drawText('Confidential Document Content', { x: 50, y: 350, size: 18 });
      const plainBytes = await doc.save();
      const encryptedBytes = await PDFLibEncrypt.lock(plainBytes, 'secret123');
      window._testEncryptedBytes = encryptedBytes;
    })()`);

    // Start loading the encrypted PDF asynchronously (it will prompt for password)
    evaluate(`window._loadPromise = window.uiController.loadPdfBuffer(window._testEncryptedBytes, 'confidential.pdf')`);

    // Wait for password prompt dialog to open
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        const dialog = document.querySelector('#dialog-pdf-password');
        if (dialog && dialog.open) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Password dialog opened automatically upon loading encrypted PDF.');

    // Test entering wrong password
    await evaluate(`(() => {
      const input = document.querySelector('#input-pdf-password');
      input.value = 'wrongpassword';
      const form = document.querySelector('#form-pdf-password');
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);

    // Wait for error message to show up
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        const errorEl = document.querySelector('#pdf-password-error');
        if (errorEl && errorEl.style.display !== 'none') resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Incorrect password displayed error message and kept dialog open.');

    // Test entering correct password "secret123"
    await evaluate(`(() => {
      const input = document.querySelector('#input-pdf-password');
      input.value = 'secret123';
      const form = document.querySelector('#form-pdf-password');
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);

    // Wait for loading to finish and document to render
    await evaluate(`window._loadPromise`);
    const pageCount = await evaluate(`window.pdfEngine.getPageCount()`);
    const activePassword = await evaluate(`window.pdfEngine.documentPassword`);
    const isProtectedClass = await evaluate(`document.querySelector('#btn-toggle-password').classList.contains('is-protected')`);

    console.log(`✅ Loaded ${pageCount} page(s). Active password: "${activePassword}".`);
    console.log(`✅ Toolbar toggle icon has class 'is-protected': ${isProtectedClass}`);
    if (pageCount !== 1 || activePassword !== 'secret123' || !isProtectedClass) {
      throw new Error('Test 1 failed: Expected 1 page, password "secret123", and is-protected class.');
    }

    // Step 2: Normal Save should retain the password automatically
    console.log('\n--- Test 2: Normal Save retains password automatically ---');
    const saveResult = await evaluate(`(async () => {
      const res = await window.pdfEngine.exportPDF(window.annotationManager, 'saved.pdf');
      // Verify saved bytes require password "secret123"
      let requiresPw = false;
      try {
        const testDoc = await PDFLib.PDFDocument.load(res.bytes);
      } catch (e) {
        requiresPw = true;
      }
      const unlockDoc = await PDFLib.PDFDocument.load(res.bytes, { ignoreEncryption: true });
      const unlocked = await PDFLibEncrypt.unlockInPlace(unlockDoc, 'secret123');
      return { requiresPw, unlocked, size: res.size };
    })()`);

    console.log(`✅ Exported PDF is encrypted: requiresPw=${saveResult.requiresPw}, unlockedWithSecret123=${saveResult.unlocked}`);
    if (!saveResult.requiresPw || !saveResult.unlocked) {
      throw new Error('Test 2 failed: Saved PDF was not encrypted with secret123.');
    }

    // Step 3: Save As dialog prefills password and allows changing it
    console.log('\n--- Test 3: Save As prefills password and updates encryption ---');
    // Call saveAsDocument() which opens #dialog-save-as
    await evaluate(`(() => {
      window._saveAsPromise = window.uiController.saveAsDocument();
      return true;
    })()`);

    await evaluate(`new Promise((resolve) => {
      const check = () => {
        const dialog = document.querySelector('#dialog-save-as');
        if (dialog && dialog.open) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);

    const prefilledPw = await evaluate(`document.querySelector('#input-save-as-password').value`);
    console.log(`✅ Save As prefilled password: "${prefilledPw}"`);
    if (prefilledPw !== 'secret123') {
      throw new Error(`Expected prefilled password 'secret123', got '${prefilledPw}'`);
    }

    // Change filename to copy.pdf and password to newpass789
    await evaluate(`(() => {
      document.querySelector('#input-save-as-name').value = 'copy.pdf';
      document.querySelector('#input-save-as-password').value = 'newpass789';
      document.querySelector('#form-save-as').dispatchEvent(new Event('submit', { cancelable: true }));
      return true;
    })()`);

    const saveAsRes = await evaluate(`(async () => {
      const res = await window._saveAsPromise;
      window._lastSavedBytes = res.bytes;
      return { saved: res.saved, filename: res.filename, password: res.password, byteLength: res.bytes ? res.bytes.byteLength : 0 };
    })()`);
    const newActivePassword = await evaluate(`window.pdfEngine.documentPassword`);
    console.log(`✅ Saved as: ${saveAsRes.filename}, new active password: "${newActivePassword}", bytes: ${saveAsRes.byteLength}`);

    // Verify saved bytes can be unlocked with newpass789
    const verifyNewPass = await evaluate(`(async () => {
      const unlockDoc = await PDFLib.PDFDocument.load(window._lastSavedBytes, { ignoreEncryption: true });
      return await PDFLibEncrypt.unlockInPlace(unlockDoc, 'newpass789');
    })()`);
    console.log(`✅ Saved PDF unlocked successfully with 'newpass789': ${verifyNewPass}`);

    // Step 4: Remove password via Save As (clearing password input)
    console.log('\n--- Test 4: Clear password in Save As -> saves unencrypted ---');
    await evaluate(`(() => {
      window._saveAsPromise2 = window.uiController.saveAsDocument();
      return true;
    })()`);
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        const dialog = document.querySelector('#dialog-save-as');
        if (dialog && dialog.open) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);

    // Clear password input
    await evaluate(`(() => {
      document.querySelector('#input-save-as-name').value = 'unprotected_copy.pdf';
      document.querySelector('#input-save-as-password').value = '';
      document.querySelector('#form-save-as').dispatchEvent(new Event('submit', { cancelable: true }));
      return true;
    })()`);

    const saveAsRes2 = await evaluate(`(async () => {
      const res = await window._saveAsPromise2;
      window._lastSavedBytes2 = res.bytes;
      return { saved: res.saved, filename: res.filename, password: res.password };
    })()`);
    const passwordAfterClear = await evaluate(`window.pdfEngine.documentPassword`);
    const isProtectedAfterClear = await evaluate(`document.querySelector('#btn-toggle-password').classList.contains('is-protected')`);
    console.log(`✅ Password after clearing in Save As: ${passwordAfterClear}, isProtected: ${isProtectedAfterClear}`);
    if (passwordAfterClear !== null || isProtectedAfterClear) {
      throw new Error('Test 4 failed: Document password should be null and is-protected should be false.');
    }

    // Verify that the exported PDF from Test 4 can be loaded without ignoreEncryption / password
    const verifyUnencrypted = await evaluate(`(async () => {
      try {
        const doc = await PDFLib.PDFDocument.load(window._lastSavedBytes2);
        return doc.getPageCount() === 1;
      } catch (e) {
        return false;
      }
    })()`);
    console.log(`✅ Saved PDF is completely unencrypted: ${verifyUnencrypted}`);
    if (!verifyUnencrypted) {
      throw new Error('Test 4 failed: PDF saved after clearing password is not unencrypted.');
    }

    // Step 5: Toggle password protection on an unencrypted document via Toolbar Icon
    console.log('\n--- Test 5: Protect document via Toolbar Lock Toggle button ---');
    // Click #btn-toggle-password
    await evaluate(`document.querySelector('#btn-toggle-password').click()`);
    const isManageModalOpen = await evaluate(`document.querySelector('#dialog-manage-password').open`);
    console.log(`✅ Manage password dialog opened: ${isManageModalOpen}`);

    // Enter a new password "togglepass123" and submit
    await evaluate(`(() => {
      document.querySelector('#input-manage-password').value = 'togglepass123';
      document.querySelector('#form-manage-password').dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);

    const activePwFromToggle = await evaluate(`window.pdfEngine.documentPassword`);
    const isProtectedFromToggle = await evaluate(`document.querySelector('#btn-toggle-password').classList.contains('is-protected')`);
    console.log(`✅ Active password set via toggle: "${activePwFromToggle}", isProtected: ${isProtectedFromToggle}`);
    if (activePwFromToggle !== 'togglepass123' || !isProtectedFromToggle) {
      throw new Error('Test 5 failed: Password should be togglepass123 and is-protected should be true.');
    }

    // Normal save should now encrypt with togglepass123
    const toggleSave = await evaluate(`(async () => {
      const res = await window.pdfEngine.exportPDF(window.annotationManager, 'toggle_saved.pdf');
      const unlockDoc = await PDFLib.PDFDocument.load(res.bytes, { ignoreEncryption: true });
      return await PDFLibEncrypt.unlockInPlace(unlockDoc, 'togglepass123');
    })()`);
    console.log(`✅ Saved PDF was successfully encrypted with togglepass123: ${toggleSave}`);
    if (!toggleSave) {
      throw new Error('Test 5 failed: Normal save was not encrypted with togglepass123');
    }

    // Step 6: Remove password via Toolbar Lock Toggle button
    console.log('\n--- Test 6: Remove password via Toolbar Lock Toggle dialog ---');
    await evaluate(`document.querySelector('#btn-toggle-password').click()`);
    await evaluate(`document.querySelector('#btn-remove-manage-password').click()`);

    const pwAfterRemove = await evaluate(`window.pdfEngine.documentPassword`);
    const isProtectedAfterRemove = await evaluate(`document.querySelector('#btn-toggle-password').classList.contains('is-protected')`);
    console.log(`✅ Password after removal: ${pwAfterRemove}, isProtected: ${isProtectedAfterRemove}`);
    if (pwAfterRemove !== null || isProtectedAfterRemove) {
      throw new Error('Test 6 failed: Password should be null and is-protected should be false.');
    }

    // Step 7: Permissions-only (Owner-password encrypted) PDF bypass
    console.log('\n--- Test 7: Permissions-only (Owner password) PDF bypass without prompt ---');
    await evaluate(`(async () => {
      const doc = await PDFLib.PDFDocument.create();
      const page = doc.addPage([400, 400]);
      page.drawText('Restricted permissions PDF', { x: 50, y: 350, size: 18 });
      const plainBytes = await doc.save();
      // Lock with userPassword="" and ownerPassword="ownerOnlyPassword"
      const encryptedBytes = await PDFLibEncrypt.lock(plainBytes, '', { ownerPassword: 'ownerOnlyPassword', permissions: { modifying: false, annotating: false } });
      window._ownerEncryptedBytes = encryptedBytes;
    })()`);

    // Load owner-only encrypted PDF: should NOT prompt for password and should load immediately
    await evaluate(`window.uiController.loadPdfBuffer(window._ownerEncryptedBytes, 'restricted.pdf')`);
    const ownerPageCount = await evaluate(`window.pdfEngine.getPageCount()`);
    const ownerPw = await evaluate(`window.pdfEngine.documentPassword`);
    console.log(`✅ Permissions-only PDF loaded without prompt: ${ownerPageCount} page(s), documentPassword: ${ownerPw}`);
    if (ownerPageCount !== 1) {
      throw new Error('Test 7 failed: Permissions-only PDF should load without password prompt.');
    }

    console.log('\n====================================================');
    console.log('🎉 ALL 7 PASSWORD PROTECTION & PERMISSIONS TESTS PASSED!');
    console.log('====================================================');

    ws.close();
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  }
}

runTests();
