const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Multi-Slot Text Signatures & Font Dropdown');
  console.log('====================================================');

  const PORT = 29960 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-type-sig-slots-');
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
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error('Evaluation failed: ' + (res.exceptionDetails.exception ? res.exceptionDetails.exception.description : JSON.stringify(res.exceptionDetails)));
      }
      return res.result ? res.result.value : undefined;
    };

    console.log('Waiting for application initialization...');
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        if (window.uiController && window.sigPadController) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Application loaded.');

    // Step 1: Open modal, switch to Type tab, type Signature 1 (Brush Script, Dark Slate)
    console.log('\n--- Step 1: Create Typed Signature 1 (Older) ---');
    const step1Result = await evaluate(`(() => {
      localStorage.clear();
      const sp = window.sigPadController;
      sp.open();
      sp.switchTab('type');

      // Verify font dropdown exists
      const fontSelect = sp.dialog.querySelector('#sig-type-font-select');
      const previewText = sp.dialog.querySelector('#sig-type-preview-text');

      sp.typeInput.value = 'John Smith';
      sp.typeInput.dispatchEvent(new Event('input'));
      fontSelect.value = '1'; // Brush Script
      fontSelect.dispatchEvent(new Event('change'));

      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      const slot1 = slots[0];

      return {
        hasFontSelect: !!fontSelect,
        fontOptionsCount: fontSelect ? fontSelect.options.length : 0,
        previewTextContent: previewText ? previewText.textContent : '',
        savedCount: sp.savedTypeSignatures.length,
        hasSlotInDom: !!slot1,
        slotHasThumbnail: !!(slot1 && slot1.querySelector('img.sig-slot-thumbnail')),
        slotBg: slot1 ? window.getComputedStyle(slot1).backgroundColor : null
      };
    })()`);
    console.log('Step 1 result:', step1Result);

    if (!step1Result.hasFontSelect || step1Result.fontOptionsCount < 3) {
      throw new Error('Step 1 failed: Font select dropdown missing or insufficient options');
    }
    if (step1Result.previewTextContent !== 'John Smith' || step1Result.savedCount !== 1) {
      throw new Error('Step 1 failed: Typed signature 1 not saved or preview mismatch');
    }
    if (!step1Result.slotHasThumbnail || step1Result.slotBg !== 'rgb(255, 255, 255)') {
      throw new Error('Step 1 failed: Slot 1 thumbnail not created or background not pure white');
    }
    console.log('✅ Typed signature 1 created with font dropdown and pure white slot thumbnail.');

    // Step 2: Click "+ New" in Type tab -> Verify blank slot appears on LEFT immediately
    console.log('\n--- Step 2: Click "+ New" in Type Tab -> Immediate Blank Slot on LEFT ---');
    const step2Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      const olderSigId = sp.savedTypeSignatures[0].id;

      // Click + New
      sp.newTypeSlotBtn.click();

      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      const firstSlot = slots[0];
      const secondSlot = slots[1];

      return {
        totalSlots: slots.length,
        firstSlotId: firstSlot ? firstSlot.dataset.slotId : null,
        secondSlotId: secondSlot ? secondSlot.dataset.slotId : null,
        olderSigId,
        firstSlotActive: firstSlot ? firstSlot.classList.contains('active') : false,
        secondSlotActive: secondSlot ? secondSlot.classList.contains('active') : false,
        firstSlotIsBlank: !!(firstSlot && firstSlot.querySelector('.sig-slot-blank')),
        hasDeleteBtn: !!(firstSlot && firstSlot.querySelector('.sig-slot-delete-btn')),
        inputCleared: sp.typeInput.value === ''
      };
    })()`);
    console.log('Step 2 result:', step2Result);

    if (step2Result.totalSlots !== 2 || !step2Result.firstSlotActive || !step2Result.firstSlotIsBlank) {
      throw new Error('Step 2 failed: Blank slot was not inserted on left immediately on + New click');
    }
    if (step2Result.secondSlotId !== step2Result.olderSigId) {
      throw new Error('Step 2 failed: Older signature is not to the right of new slot');
    }
    console.log('✅ Blank slot inserted on the left of existing text signature immediately on + New.');

    // Step 3: Type Signature 2 (Newer, Handwriting, Navy Blue)
    console.log('\n--- Step 3: Type Signature 2 (Newer, Handwriting, Navy Blue) ---');
    const step3Result = await evaluate(`(() => {
      const sp = window.sigPadController;

      sp.typeInput.value = 'Alice Cooper';
      sp.typeInput.dispatchEvent(new Event('input'));

      // Select Font 2 (Lucida Handwriting)
      sp.fontSelect.value = '2';
      sp.fontSelect.dispatchEvent(new Event('change'));

      // Select Blue ink
      const blueBtn = sp.dialog.querySelector('.sig-type-container .sig-color-btn[data-color="#1e40af"]');
      if (blueBtn) blueBtn.click();

      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      const firstSlot = slots[0];
      const previewText = sp.dialog.querySelector('#sig-type-preview-text');

      return {
        totalSlots: slots.length,
        firstSlotThumbnail: !!(firstSlot && firstSlot.querySelector('img.sig-slot-thumbnail')),
        previewColor: previewText ? previewText.style.color : '',
        activeSlotText: sp.savedTypeSignatures[0].text,
        activeSlotFontIndex: sp.savedTypeSignatures[0].fontIndex,
        activeSlotColor: sp.savedTypeSignatures[0].color
      };
    })()`);
    console.log('Step 3 result:', step3Result);

    if (step3Result.totalSlots !== 2 || !step3Result.firstSlotThumbnail || step3Result.activeSlotText !== 'Alice Cooper') {
      throw new Error('Step 3 failed: Signature 2 not updated in left slot');
    }
    if (step3Result.activeSlotFontIndex !== 2 || step3Result.activeSlotColor !== '#1e40af') {
      throw new Error('Step 3 failed: Font or color not properly saved in slot');
    }
    console.log('✅ Signature 2 saved in leftmost slot with Handwriting font and Navy Blue ink.');

    // Take visual screenshot of Type tab with multi-slots & font dropdown
    const screenshotRes = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = '/Users/pumisake/.gemini/antigravity/brain/8d574bde-c467-4266-b89b-4291ddbe427a/sig-type-slots-preview.png';
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'));
    console.log('📸 Screenshot saved to:', screenshotPath);

    // Step 4: Click older signature slot (Slot 1) -> Verify restores text, font, color
    console.log('\n--- Step 4: Click Older Slot -> Verify Restores Inputs & Preview ---');
    const step4Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      const olderSlot = slots[1]; // John Smith

      olderSlot.click();

      const previewText = sp.dialog.querySelector('#sig-type-preview-text');

      return {
        inputValue: sp.typeInput.value,
        fontSelectValue: sp.fontSelect.value,
        typedFontIndex: sp.typedFontIndex,
        currentColor: sp.drawColor,
        previewText: previewText ? previewText.textContent : '',
        previewColor: previewText ? previewText.style.color : ''
      };
    })()`);
    console.log('Step 4 result:', step4Result);

    if (step4Result.inputValue !== 'John Smith' || step4Result.fontSelectValue !== '1' || step4Result.currentColor !== '#0f172a') {
      throw new Error('Step 4 failed: Older signature state not correctly restored on click');
    }
    console.log('✅ Clicking older signature card restored text ("John Smith"), font (1), and ink color.');

    // Step 5: Test Delete button on slot
    console.log('\n--- Step 5: Delete Slot via "x" Button ---');
    const step5Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      const delBtn = slots[0].querySelector('.sig-slot-delete-btn');

      delBtn.click();

      const slotsAfter = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');

      return {
        remainingCount: slotsAfter.length,
        savedCount: sp.savedTypeSignatures.length,
        activeSlotId: sp.activeTypeSlotId
      };
    })()`);
    console.log('Step 5 result:', step5Result);

    if (step5Result.remainingCount !== 1 || step5Result.savedCount !== 1) {
      throw new Error('Step 5 failed: Slot delete button failed to remove slot');
    }
    console.log('✅ Slot delete button successfully deleted signature.');

    // Step 6: Close and Reopen -> Check Persistence
    console.log('\n--- Step 6: Close & Reopen Dialog -> Check Multi-Slot Persistence ---');
    const step6Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.dialog.close();

      // Reset in-memory state
      sp.savedTypeSignatures = [];
      sp.activeTypeSlotId = null;

      // Reopen
      sp.open();
      sp.switchTab('type');

      const slots = sp.dialog.querySelectorAll('#sig-type-saved-slots-list .sig-saved-slot');
      return {
        savedCount: sp.savedTypeSignatures.length,
        slotsInDom: slots.length,
        restoredText: sp.typeInput.value,
        restoredFont: sp.fontSelect.value
      };
    })()`);
    console.log('Step 6 result:', step6Result);

    if (step6Result.savedCount !== 1 || step6Result.restoredText !== 'John Smith') {
      throw new Error('Step 6 failed: Saved type signature was not restored after modal reopen');
    }
    console.log('✅ Saved text signatures persist across modal closes and sessions.');

    console.log('\n====================================================');
    console.log('🎉 ALL TEXT SIGNATURE MULTI-SLOT & FONT DROPDOWN TESTS PASSED!');
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
