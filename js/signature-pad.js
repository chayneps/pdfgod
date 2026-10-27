/**
 * Signature Pad Controller
 * Manages the Digital Signature Dialog (Draw, Type, Upload) and inserts signatures as annotations.
 * Persists multiple Draw signatures (with thumbnail selector and delete 'x') & Type signatures in localStorage.
 * Does NOT persist uploaded image signatures.
 */

class SignaturePadController {
  constructor(dialogElement, annotationManager, canvasController) {
    this.dialog = dialogElement;
    this.annotationManager = annotationManager;
    this.canvasController = canvasController;

    this.activeTab = 'draw'; // 'draw', 'type', 'upload'
    this.drawColor = '#0f172a';
    this.isDrawing = false;
    this.hasDrawn = false;
    this.strokes = [];
    this.currentStroke = null;

    // Multi-signature Draw Slots
    this.savedSignatures = [];
    this.activeSlotId = null;

    // Multi-signature Type Slots
    this.savedTypeSignatures = [];
    this.activeTypeSlotId = null;

    this.typedFontIndex = 1;
    this.uploadedDataUrl = null;

    // Elements
    this.canvas = this.dialog.querySelector('.sig-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.typeInput = this.dialog.querySelector('#sig-type-input') || this.dialog.querySelector('.sig-type-input');
    this.fontSelect = this.dialog.querySelector('#sig-type-font-select');
    this.slotsContainer = this.dialog.querySelector('#sig-saved-slots-list');
    this.newSlotBtn = this.dialog.querySelector('#btn-sig-new-slot');
    this.typeSlotsContainer = this.dialog.querySelector('#sig-type-saved-slots-list');
    this.newTypeSlotBtn = this.dialog.querySelector('#btn-sig-type-new-slot');
    this.typeClearBtn = this.dialog.querySelector('#btn-sig-type-clear');
    this.typePreviewText = this.dialog.querySelector('#sig-type-preview-text');

    this.init();
  }

  init() {
    if (!this.dialog) return;

    // Tabs
    const tabBtns = this.dialog.querySelectorAll('.sig-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.switchTab(btn.dataset.tab);
      });
    });

    // Draw canvas events
    if (this.canvas) {
      this.resizeCanvas();
      this.canvas.addEventListener('pointerdown', (e) => this.startDrawing(e));
      this.canvas.addEventListener('pointermove', (e) => this.drawMove(e));
      this.canvas.addEventListener('pointerup', () => this.stopDrawing());
      this.canvas.addEventListener('pointercancel', () => this.stopDrawing());
    }

    // New Slot Buttons
    if (this.newSlotBtn) {
      this.newSlotBtn.addEventListener('click', () => this.selectNewSlot());
    }
    if (this.newTypeSlotBtn) {
      this.newTypeSlotBtn.addEventListener('click', () => this.selectNewTypeSlot());
    }

    // Color buttons (both Draw and Type)
    const colorBtns = this.dialog.querySelectorAll('.sig-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.drawColor = btn.dataset.color || '#0f172a';
        this.updateColorButtons();
        if (this.activeTab === 'draw') {
          if (this.hasDrawn) {
            this.saveDrawToStorage();
          }
        } else if (this.activeTab === 'type') {
          this.updateTypePreviews();
          this.saveTypeToStorage();
        }
      });
    });

    // Clear buttons
    const clearBtn = this.dialog.querySelector('#btn-sig-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearDraw());
    }
    if (this.typeClearBtn) {
      this.typeClearBtn.addEventListener('click', () => this.clearType());
    }

    // Type input
    if (this.typeInput) {
      this.typeInput.addEventListener('input', () => {
        this.updateTypePreviews();
        this.saveTypeToStorage();
      });
    }

    // Font Select Dropdown
    if (this.fontSelect) {
      this.fontSelect.addEventListener('change', () => {
        this.typedFontIndex = parseInt(this.fontSelect.value, 10) || 1;
        this.updateTypePreviews();
        this.saveTypeToStorage();
      });
    }

    // Upload zone (NO localStorage saving per user instructions)
    const uploadZone = this.dialog.querySelector('.sig-upload-container');
    const uploadInput = this.dialog.querySelector('#sig-file-input');
    if (uploadZone && uploadInput) {
      uploadZone.addEventListener('click', () => uploadInput.click());
      uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.handleUploadedFile(file);
      });

      uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
      });
      uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
      uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) this.handleUploadedFile(file);
      });
    }

    // Cancel / Close
    const closeBtns = this.dialog.querySelectorAll('[data-action="close-dialog"]');
    closeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.cleanupEmptySlots();
        this.cleanupEmptyTypeSlots();
        this.dialog.close();
      });
    });

    this.dialog.addEventListener('close', () => {
      this.cleanupEmptySlots();
      this.cleanupEmptyTypeSlots();
    });

    // Insert Signature button
    const insertBtn = this.dialog.querySelector('#btn-insert-signature');
    if (insertBtn) {
      insertBtn.addEventListener('click', () => this.insertSignature());
    }

    // Initial restoration of saved data
    this.loadSavedSignaturesFromStorage();
    this.loadSavedTypeSignaturesFromStorage();
  }

  // Open modal
  open() {
    this.dialog.showModal();
    this.resizeCanvas();
    this.loadSavedSignaturesFromStorage();
    this.loadSavedTypeSignaturesFromStorage();

    if (this.activeTab === 'draw') {
      if (this.savedSignatures.length > 0) {
        // Select either the active slot or the first saved signature
        const targetId = this.activeSlotId && this.savedSignatures.some(s => s.id === this.activeSlotId)
          ? this.activeSlotId
          : this.savedSignatures[0].id;
        this.selectSlot(targetId);
      } else {
        this.selectNewSlot();
      }
    } else if (this.activeTab === 'type') {
      if (this.savedTypeSignatures.length > 0) {
        const targetId = this.activeTypeSlotId && this.savedTypeSignatures.some(s => s.id === this.activeTypeSlotId)
          ? this.activeTypeSlotId
          : this.savedTypeSignatures[0].id;
        this.selectTypeSlot(targetId);
      } else {
        this.selectNewTypeSlot();
      }
      this.updateTypePreviews();
      if (this.typeInput) this.typeInput.focus();
    }
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    if (this.ctx) {
      this.ctx.scale(dpr, dpr);
    }
  }

  switchTab(tab) {
    this.activeTab = tab;
    this.dialog.querySelectorAll('.sig-tab-content').forEach(el => el.style.display = 'none');
    const target = this.dialog.querySelector(`.sig-tab-content[data-tab="${tab}"]`);
    if (target) target.style.display = 'block';

    if (tab === 'draw') {
      setTimeout(() => {
        this.resizeCanvas();
        if (this.activeSlotId && this.savedSignatures.some(s => s.id === this.activeSlotId)) {
          this.selectSlot(this.activeSlotId);
        } else if (this.savedSignatures.length > 0) {
          this.selectSlot(this.savedSignatures[0].id);
        } else {
          this.selectNewSlot();
        }
      }, 50);
    } else if (tab === 'type') {
      if (this.savedTypeSignatures.length > 0) {
        const targetId = this.activeTypeSlotId && this.savedTypeSignatures.some(s => s.id === this.activeTypeSlotId)
          ? this.activeTypeSlotId
          : this.savedTypeSignatures[0].id;
        this.selectTypeSlot(targetId);
      } else {
        this.selectNewTypeSlot();
      }
      this.updateTypePreviews();
      if (this.typeInput) this.typeInput.focus();
    }
  }

  // --- Multi-Signature Slots Management ---
  cleanupEmptySlots() {
    this.savedSignatures = this.savedSignatures.filter(s => (s.strokes && s.strokes.length > 0) || s.pngData);
    if (this.activeSlotId && !this.savedSignatures.some(s => s.id === this.activeSlotId)) {
      this.activeSlotId = this.savedSignatures[0]?.id || null;
    }
    this.saveDrawListToStorage();
    this.renderSavedSlots();
  }

  loadSavedSignaturesFromStorage() {
    try {
      const raw = localStorage.getItem('pdfgod_saved_draw_signatures_v1');
      if (raw) {
        this.savedSignatures = JSON.parse(raw);
        if (!Array.isArray(this.savedSignatures)) this.savedSignatures = [];
        this.savedSignatures = this.savedSignatures.filter(s => s && ((s.strokes && s.strokes.length > 0) || s.pngData));
      } else {
        // Check legacy single-signature key
        const legacyRaw = localStorage.getItem('pdfgod_saved_signature_draw_v1');
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw);
          if (legacy && (legacy.strokes || legacy.pngData)) {
            this.savedSignatures = [{
              id: 'sig_' + Date.now(),
              color: legacy.color || '#0f172a',
              strokes: legacy.strokes || [],
              pngData: legacy.pngData || null,
              createdAt: Date.now()
            }];
            this.saveDrawListToStorage();
          }
        }
      }
    } catch (e) {
      console.warn('Could not load saved signatures from localStorage:', e);
      this.savedSignatures = [];
    }
    this.renderSavedSlots();
  }

  saveDrawListToStorage() {
    try {
      const toSave = this.savedSignatures.filter(s => (s.strokes && s.strokes.length > 0) || s.pngData);
      localStorage.setItem('pdfgod_saved_draw_signatures_v1', JSON.stringify(toSave));

      // Sync active signature to single-key for full backwards compatibility
      const activeSig = this.savedSignatures.find(s => s.id === this.activeSlotId);
      if (activeSig && ((activeSig.strokes && activeSig.strokes.length > 0) || activeSig.pngData)) {
        localStorage.setItem('pdfgod_saved_signature_draw_v1', JSON.stringify({
          color: activeSig.color,
          strokes: activeSig.strokes,
          pngData: activeSig.pngData
        }));
      } else if (toSave.length > 0) {
        localStorage.setItem('pdfgod_saved_signature_draw_v1', JSON.stringify({
          color: toSave[0].color,
          strokes: toSave[0].strokes,
          pngData: toSave[0].pngData
        }));
      } else {
        localStorage.removeItem('pdfgod_saved_signature_draw_v1');
      }
    } catch (e) {
      console.warn('Could not save signatures list to localStorage:', e);
    }
  }

  renderSavedSlots() {
    if (!this.slotsContainer) return;
    this.slotsContainer.innerHTML = '';

    this.savedSignatures.forEach(sig => {
      const slotEl = document.createElement('div');
      slotEl.className = `sig-saved-slot ${sig.id === this.activeSlotId ? 'active' : ''}`;
      slotEl.dataset.slotId = sig.id;
      slotEl.title = (sig.strokes?.length > 0 || sig.pngData) ? 'Use saved signature' : 'New blank signature';

      if (sig.pngData) {
        const thumb = document.createElement('img');
        thumb.className = 'sig-slot-thumbnail';
        thumb.src = sig.pngData;
        thumb.alt = 'Signature';
        slotEl.appendChild(thumb);
      } else {
        const blank = document.createElement('div');
        blank.className = 'sig-slot-blank';
        slotEl.appendChild(blank);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'sig-slot-delete-btn';
      delBtn.dataset.action = 'delete-slot';
      delBtn.title = 'Delete this signature';
      delBtn.innerHTML = '&times;';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSlot(sig.id);
      });
      slotEl.appendChild(delBtn);

      slotEl.addEventListener('click', () => {
        this.selectSlot(sig.id);
      });

      this.slotsContainer.appendChild(slotEl);
    });

    if (this.newSlotBtn) {
      const isBlankNew = this.activeSlotId && this.savedSignatures.find(s => s.id === this.activeSlotId && (!s.strokes || s.strokes.length === 0) && !s.pngData);
      this.newSlotBtn.classList.toggle('active', !!isBlankNew);
    }
  }

  selectSlot(id) {
    // If leaving an un-drawn blank slot without drawing anything, discard that empty slot
    if (this.activeSlotId && this.activeSlotId !== id) {
      const activeSig = this.savedSignatures.find(s => s.id === this.activeSlotId);
      if (activeSig && (!activeSig.strokes || activeSig.strokes.length === 0) && !activeSig.pngData) {
        this.savedSignatures = this.savedSignatures.filter(s => s.id !== this.activeSlotId);
      }
    }

    const sig = this.savedSignatures.find(s => s.id === id);
    if (!sig) return;

    this.activeSlotId = id;
    this.strokes = JSON.parse(JSON.stringify(sig.strokes || []));
    this.drawColor = sig.color || '#0f172a';
    this.hasDrawn = (this.strokes.length > 0) || !!sig.pngData;
    this.updateColorButtons();

    this.resizeCanvas();
    if (this.strokes.length > 0) {
      this.redrawStrokes();
    } else if (sig.pngData) {
      this.drawPngOntoCanvas(sig.pngData);
    }

    this.renderSavedSlots();
  }

  selectNewSlot() {
    // If the currently active slot is already blank, stay on it
    if (this.activeSlotId) {
      const active = this.savedSignatures.find(s => s.id === this.activeSlotId);
      if (active && (!active.strokes || active.strokes.length === 0) && !active.pngData) {
        this.clearDraw(false);
        this.renderSavedSlots();
        return;
      }
    }

    // Clean up any empty/un-drawn slots before creating a new one
    this.savedSignatures = this.savedSignatures.filter(s =>
      (s.strokes && s.strokes.length > 0) || s.pngData
    );

    // Immediately insert a new blank slot on the LEFT of existing ones
    const newId = 'sig_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const blankSig = {
      id: newId,
      color: this.drawColor || '#0f172a',
      strokes: [],
      pngData: null,
      createdAt: Date.now()
    };
    this.savedSignatures.unshift(blankSig);
    this.activeSlotId = newId;

    this.clearDraw(false);
    this.renderSavedSlots();
  }

  deleteSlot(id) {
    this.savedSignatures = this.savedSignatures.filter(s => s.id !== id);
    this.saveDrawListToStorage();

    if (this.activeSlotId === id) {
      if (this.savedSignatures.length > 0) {
        this.selectSlot(this.savedSignatures[0].id);
      } else {
        this.selectNewSlot();
      }
    } else {
      this.renderSavedSlots();
    }
  }

  drawPngOntoCanvas(pngData) {
    if (!this.ctx || !this.canvas || !pngData) return;
    const img = new Image();
    img.onload = () => {
      const rect = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, rect.width, rect.height);
      this.ctx.drawImage(img, 0, 0, rect.width, rect.height);
    };
    img.src = pngData;
  }

  // Draw interactions
  startDrawing(e) {
    this.isDrawing = true;
    this.hasDrawn = true;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.currentStroke = { color: this.drawColor, points: [pt] };
    if (!this.strokes) this.strokes = [];
    this.strokes.push(this.currentStroke);
    this.canvas.setPointerCapture(e.pointerId);
  }

  drawMove(e) {
    if (!this.isDrawing || !this.currentStroke) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.currentStroke.points.push(pt);

    const ctx = this.ctx;
    ctx.strokeStyle = this.drawColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pts = this.currentStroke.points;
    if (pts.length > 1) {
      const p1 = pts[pts.length - 2];
      const p2 = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  stopDrawing() {
    if (this.isDrawing) {
      this.isDrawing = false;
      this.currentStroke = null;
      this.saveDrawToStorage();
    }
  }

  clearDraw(updateSlot = true) {
    if (!this.ctx || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.hasDrawn = false;
    this.strokes = [];
    this.currentStroke = null;

    // If clearing on an active slot, update that slot's preview
    if (updateSlot && this.activeSlotId) {
      const slot = this.savedSignatures.find(s => s.id === this.activeSlotId);
      if (slot) {
        slot.strokes = [];
        slot.pngData = null;
        this.saveDrawListToStorage();
        this.renderSavedSlots();
      }
    }
  }

  // Generate crisp, centered thumbnail matching the user's drawing
  generateSlotThumbnail(strokes, color) {
    if (!strokes || strokes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      for (const p of (s.points || [])) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX) || minX >= maxX || minY >= maxY) {
      return this.canvas ? this.canvas.toDataURL('image/png') : null;
    }

    const pad = 10;
    const cropW = (maxX - minX) + pad * 2;
    const cropH = (maxY - minY) + pad * 2;
    const cropX = minX - pad;
    const cropY = minY - pad;

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 152;
    thumbCanvas.height = 76;
    const tCtx = thumbCanvas.getContext('2d');

    // Fill pure white background
    tCtx.fillStyle = '#ffffff';
    tCtx.fillRect(0, 0, 152, 76);

    const scale = Math.min((152 - 12) / cropW, (76 - 12) / cropH);
    const offsetX = (152 - cropW * scale) / 2;
    const offsetY = (76 - cropH * scale) / 2;

    tCtx.save();
    tCtx.translate(offsetX, offsetY);
    tCtx.scale(scale, scale);
    tCtx.translate(-cropX, -cropY);

    for (const s of strokes) {
      if (!s.points || s.points.length < 2) continue;
      tCtx.beginPath();
      tCtx.strokeStyle = s.color || color || this.drawColor;
      tCtx.lineWidth = 2.5;
      tCtx.lineCap = 'round';
      tCtx.lineJoin = 'round';
      tCtx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        tCtx.lineTo(s.points[i].x, s.points[i].y);
      }
      tCtx.stroke();
    }
    tCtx.restore();

    return thumbCanvas.toDataURL('image/png');
  }

  // Save current drawing to storage
  saveDrawToStorage() {
    if (!this.canvas) return;
    const thumbData = this.generateSlotThumbnail(this.strokes, this.drawColor) || (this.hasDrawn ? this.canvas.toDataURL('image/png') : null);

    if (this.activeSlotId) {
      // User selected from icon, so update and save in the SAME slot!
      const existing = this.savedSignatures.find(s => s.id === this.activeSlotId);
      if (existing) {
        existing.strokes = this.strokes;
        existing.color = this.drawColor;
        existing.pngData = thumbData;
        existing.updatedAt = Date.now();
        this.saveDrawListToStorage();
        this.renderSavedSlots();
        return;
      }
    }

    // In New slot mode: create a new slot and insert on the LEFT of the old ones!
    if (this.hasDrawn && this.strokes && this.strokes.length > 0) {
      const newId = 'sig_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      const newSig = {
        id: newId,
        color: this.drawColor,
        strokes: this.strokes,
        pngData: thumbData,
        createdAt: Date.now()
      };
      this.savedSignatures.unshift(newSig); // Add on the left of older ones!
      this.activeSlotId = newId;
      this.saveDrawListToStorage();
      this.renderSavedSlots();
    }
  }

  redrawStrokes() {
    if (!this.ctx || !this.canvas || !this.strokes || this.strokes.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);

    for (const stroke of this.strokes) {
      if (!stroke.points || stroke.points.length === 0) continue;
      this.ctx.save();
      this.ctx.strokeStyle = stroke.color || this.drawColor;
      this.ctx.lineWidth = 2.5;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      this.ctx.beginPath();
      this.ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        this.ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  // --- Multi-Signature Type Slots Management ---
  generateTypeThumbnail(text, fontIndex = 1, color = '#0f172a') {
    if (!text || text.trim() === '') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 152;
    canvas.height = 76;
    const ctx = canvas.getContext('2d');

    // Pure white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 152, 76);

    const hasThai = (window.ThaiSupport && window.ThaiSupport.containsThai)
      ? window.ThaiSupport.containsThai(text)
      : /[\u0E00-\u0E7F]/.test(text);

    let fontFamily = 'Brush Script MT, cursive';
    let fontStyle = 'italic';
    if (fontIndex === 2) {
      fontFamily = 'Lucida Handwriting, Segoe Script, cursive';
    } else if (fontIndex === 3) {
      fontFamily = 'Apple Chancery, cursive';
    } else if (fontIndex === 4) {
      fontFamily = 'Caveat, cursive';
    } else if (fontIndex === 5) {
      fontFamily = 'Great Vibes, Snell Roundhand, cursive';
    }

    if (hasThai) {
      ctx.font = `${fontStyle} 600 24px "Sarabun", ${fontFamily}, sans-serif`;
    } else {
      ctx.font = `${fontStyle} 26px ${fontFamily}`;
    }

    ctx.fillStyle = color || '#0f172a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const metrics = ctx.measureText(text);
    if (metrics.width > 136) {
      const scale = 136 / metrics.width;
      ctx.save();
      ctx.translate(76, 38);
      ctx.scale(scale, scale);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(text, 76, 38);
    }

    return canvas.toDataURL('image/png');
  }

  loadSavedTypeSignaturesFromStorage() {
    try {
      const raw = localStorage.getItem('pdfgod_saved_type_signatures_v1');
      if (raw) {
        this.savedTypeSignatures = JSON.parse(raw);
        if (!Array.isArray(this.savedTypeSignatures)) this.savedTypeSignatures = [];
        this.savedTypeSignatures = this.savedTypeSignatures.filter(s => s && s.text && s.text.trim().length > 0);
      } else {
        // Check legacy single-signature key
        const legacyRaw = localStorage.getItem('pdfgod_saved_signature_type_v1');
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw);
          if (legacy && legacy.text && legacy.text.trim().length > 0) {
            const fontIdx = parseInt(legacy.fontIndex, 10) || 1;
            const col = legacy.color || '#0f172a';
            this.savedTypeSignatures = [{
              id: 'sig_type_' + Date.now(),
              text: legacy.text,
              fontIndex: fontIdx,
              color: col,
              pngData: this.generateTypeThumbnail(legacy.text, fontIdx, col),
              createdAt: Date.now()
            }];
            this.saveTypeSignaturesListToStorage();
          }
        }
      }
    } catch (e) {
      console.warn('Could not load saved type signatures from localStorage:', e);
      this.savedTypeSignatures = [];
    }
    this.renderSavedTypeSlots();
  }

  saveTypeSignaturesListToStorage() {
    try {
      const toSave = this.savedTypeSignatures.filter(s => s.text && s.text.trim().length > 0);
      localStorage.setItem('pdfgod_saved_type_signatures_v1', JSON.stringify(toSave));

      const activeSig = this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId) || toSave[0];
      if (activeSig && activeSig.text && activeSig.text.trim().length > 0) {
        localStorage.setItem('pdfgod_saved_signature_type_v1', JSON.stringify({
          text: activeSig.text,
          fontIndex: activeSig.fontIndex || 1,
          color: activeSig.color || '#0f172a'
        }));
      } else {
        localStorage.removeItem('pdfgod_saved_signature_type_v1');
      }
    } catch (e) {
      console.warn('Could not save type signatures list to localStorage:', e);
    }
  }

  renderSavedTypeSlots() {
    if (!this.typeSlotsContainer) return;
    this.typeSlotsContainer.innerHTML = '';

    this.savedTypeSignatures.forEach(sig => {
      const slotEl = document.createElement('div');
      slotEl.className = `sig-saved-slot ${sig.id === this.activeTypeSlotId ? 'active' : ''}`;
      slotEl.dataset.slotId = sig.id;
      slotEl.title = sig.text ? `Use saved signature: "${sig.text}"` : 'New blank text signature';

      if (sig.pngData) {
        const thumb = document.createElement('img');
        thumb.className = 'sig-slot-thumbnail';
        thumb.src = sig.pngData;
        thumb.alt = sig.text || 'Signature';
        slotEl.appendChild(thumb);
      } else {
        const blank = document.createElement('div');
        blank.className = 'sig-slot-blank';
        slotEl.appendChild(blank);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'sig-slot-delete-btn';
      delBtn.dataset.action = 'delete-type-slot';
      delBtn.title = 'Delete this signature';
      delBtn.innerHTML = '&times;';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteTypeSlot(sig.id);
      });
      slotEl.appendChild(delBtn);

      slotEl.addEventListener('click', () => {
        this.selectTypeSlot(sig.id);
      });

      this.typeSlotsContainer.appendChild(slotEl);
    });

    if (this.newTypeSlotBtn) {
      const isBlankNew = this.activeTypeSlotId && this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId && (!s.text || s.text.trim().length === 0));
      this.newTypeSlotBtn.classList.toggle('active', !!isBlankNew);
    }
  }

  selectTypeSlot(id) {
    if (this.activeTypeSlotId && this.activeTypeSlotId !== id) {
      const activeSig = this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId);
      if (activeSig && (!activeSig.text || activeSig.text.trim().length === 0)) {
        this.savedTypeSignatures = this.savedTypeSignatures.filter(s => s.id !== this.activeTypeSlotId);
      }
    }

    const sig = this.savedTypeSignatures.find(s => s.id === id);
    if (!sig) return;

    this.activeTypeSlotId = id;
    if (this.typeInput) this.typeInput.value = sig.text || '';
    this.typedFontIndex = sig.fontIndex || 1;
    if (this.fontSelect) this.fontSelect.value = String(this.typedFontIndex);
    this.drawColor = sig.color || '#0f172a';

    this.updateColorButtons();
    this.updateTypePreviews();
    this.renderSavedTypeSlots();
  }

  selectNewTypeSlot() {
    if (this.activeTypeSlotId) {
      const active = this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId);
      if (active && (!active.text || active.text.trim().length === 0)) {
        if (this.typeInput) {
          this.typeInput.value = '';
          this.typeInput.focus();
        }
        this.updateTypePreviews();
        this.renderSavedTypeSlots();
        return;
      }
    }

    this.savedTypeSignatures = this.savedTypeSignatures.filter(s =>
      s.text && s.text.trim().length > 0
    );

    const newId = 'sig_type_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const blankSig = {
      id: newId,
      text: '',
      fontIndex: this.typedFontIndex || 1,
      color: this.drawColor || '#0f172a',
      pngData: null,
      createdAt: Date.now()
    };
    this.savedTypeSignatures.unshift(blankSig);
    this.activeTypeSlotId = newId;

    if (this.typeInput) {
      this.typeInput.value = '';
      this.typeInput.focus();
    }
    this.updateTypePreviews();
    this.renderSavedTypeSlots();
  }

  deleteTypeSlot(id) {
    this.savedTypeSignatures = this.savedTypeSignatures.filter(s => s.id !== id);
    this.saveTypeSignaturesListToStorage();

    if (this.activeTypeSlotId === id) {
      if (this.savedTypeSignatures.length > 0) {
        this.selectTypeSlot(this.savedTypeSignatures[0].id);
      } else {
        this.selectNewTypeSlot();
      }
    } else {
      this.renderSavedTypeSlots();
    }
  }

  cleanupEmptyTypeSlots() {
    this.savedTypeSignatures = this.savedTypeSignatures.filter(s => s.text && s.text.trim().length > 0);
    if (this.activeTypeSlotId && !this.savedTypeSignatures.some(s => s.id === this.activeTypeSlotId)) {
      this.activeTypeSlotId = this.savedTypeSignatures[0]?.id || null;
    }
    this.saveTypeSignaturesListToStorage();
    this.renderSavedTypeSlots();
  }

  clearType() {
    if (this.typeInput) {
      this.typeInput.value = '';
      this.typeInput.focus();
    }
    if (this.activeTypeSlotId) {
      const slot = this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId);
      if (slot) {
        slot.text = '';
        slot.pngData = null;
        this.saveTypeSignaturesListToStorage();
        this.renderSavedTypeSlots();
      }
    }
    this.updateTypePreviews();
  }

  // --- Save / Restore Type Signature ---
  saveTypeToStorage() {
    try {
      const text = (this.typeInput ? this.typeInput.value : '').trim();
      const fontIndex = this.typedFontIndex || (this.fontSelect ? parseInt(this.fontSelect.value, 10) : 1) || 1;
      const color = this.drawColor || '#0f172a';
      const thumbData = text ? this.generateTypeThumbnail(text, fontIndex, color) : null;

      if (this.activeTypeSlotId) {
        const existing = this.savedTypeSignatures.find(s => s.id === this.activeTypeSlotId);
        if (existing) {
          existing.text = text;
          existing.fontIndex = fontIndex;
          existing.color = color;
          existing.pngData = thumbData;
          existing.updatedAt = Date.now();
          this.saveTypeSignaturesListToStorage();
          this.renderSavedTypeSlots();
          return;
        }
      }

      if (text) {
        const newId = 'sig_type_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        const newSig = {
          id: newId,
          text: text,
          fontIndex: fontIndex,
          color: color,
          pngData: thumbData,
          createdAt: Date.now()
        };
        this.savedTypeSignatures.unshift(newSig);
        this.activeTypeSlotId = newId;
        this.saveTypeSignaturesListToStorage();
        this.renderSavedTypeSlots();
      }
    } catch (e) {
      console.warn('Could not save type signature to localStorage:', e);
    }
  }

  restoreSavedType() {
    this.loadSavedTypeSignaturesFromStorage();
    if (this.savedTypeSignatures.length > 0) {
      const target = this.activeTypeSlotId && this.savedTypeSignatures.some(s => s.id === this.activeTypeSlotId)
        ? this.activeTypeSlotId
        : this.savedTypeSignatures[0].id;
      this.selectTypeSlot(target);
    }
  }

  updateColorButtons() {
    const colorBtns = this.dialog.querySelectorAll('.sig-color-btn');
    colorBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === this.drawColor);
    });
  }

  // Type Signature Previews
  updateTypePreviews() {
    const rawText = (this.typeInput ? this.typeInput.value : '').trim();
    const text = rawText || 'Your Name';
    const hasThai = (window.ThaiSupport && window.ThaiSupport.containsThai)
      ? window.ThaiSupport.containsThai(text)
      : /[\u0E00-\u0E7F]/.test(text);

    const previews = this.dialog.querySelectorAll('.sig-text-preview');
    previews.forEach(p => {
      p.textContent = text;
      p.style.color = rawText ? (this.drawColor || '#0f172a') : '#94a3b8';

      if (text.length > 25) {
        p.style.fontSize = '1.4rem';
      } else if (text.length > 18) {
        p.style.fontSize = '1.7rem';
      } else {
        p.style.fontSize = '2.2rem';
      }

      if (hasThai) {
        p.style.fontFamily = '"Sarabun", cursive, sans-serif';
      } else {
        const fontMap = {
          1: "'Brush Script MT', 'Dancing Script', 'Caveat', cursive",
          2: "'Lucida Handwriting', 'Segoe Script', 'Great Vibes', cursive",
          3: "'Apple Chancery', 'Bradley Hand', 'Comic Sans MS', cursive",
          4: "'Caveat', 'Segoe Print', cursive",
          5: "'Great Vibes', 'Snell Roundhand', 'Brush Script MT', cursive"
        };
        p.style.fontFamily = fontMap[this.typedFontIndex] || fontMap[1];
      }
    });
  }

  // Handle uploaded file (NO localStorage saving per user instructions)
  handleUploadedFile(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.uploadedDataUrl = e.target.result;
      const preview = this.dialog.querySelector('.sig-upload-preview');
      const placeholder = this.dialog.querySelector('.sig-upload-placeholder');
      if (preview && placeholder) {
        preview.src = this.uploadedDataUrl;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
      }
    };
    reader.readAsDataURL(file);
  }

  // Generate PNG data URL for insertion
  generateSignaturePng() {
    if (this.activeTab === 'draw') {
      if (!this.hasDrawn) return null;
      this.saveDrawToStorage();

      if (!this.strokes || this.strokes.length === 0) {
        return this.canvas.toDataURL('image/png');
      }

      // Trim transparent padding so inserted signature fills bounding box cleanly
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of this.strokes) {
        for (const p of (s.points || [])) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }

      if (!isFinite(minX) || minX >= maxX || minY >= maxY) {
        return this.canvas.toDataURL('image/png');
      }

      const pad = 8;
      const cropW = (maxX - minX) + pad * 2;
      const cropH = (maxY - minY) + pad * 2;
      const cropX = minX - pad;
      const cropY = minY - pad;

      const outCanvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      outCanvas.width = Math.ceil(cropW * dpr);
      outCanvas.height = Math.ceil(cropH * dpr);
      const outCtx = outCanvas.getContext('2d');
      outCtx.scale(dpr, dpr);
      outCtx.translate(-cropX, -cropY);

      for (const s of this.strokes) {
        if (!s.points || s.points.length < 2) continue;
        outCtx.beginPath();
        outCtx.strokeStyle = s.color || this.drawColor;
        outCtx.lineWidth = 2.5;
        outCtx.lineCap = 'round';
        outCtx.lineJoin = 'round';
        outCtx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          outCtx.lineTo(s.points[i].x, s.points[i].y);
        }
        outCtx.stroke();
      }

      return outCanvas.toDataURL('image/png');
    }

    if (this.activeTab === 'type') {
      const text = (this.typeInput ? this.typeInput.value : '').trim();
      if (!text) return null;

      this.saveTypeToStorage();

      const offscreen = document.createElement('canvas');
      offscreen.width = 400;
      offscreen.height = 120;
      const ctx = offscreen.getContext('2d');

      const hasThai = (window.ThaiSupport && window.ThaiSupport.containsThai)
        ? window.ThaiSupport.containsThai(text)
        : /[\u0E00-\u0E7F]/.test(text);

      let fontFamily = 'Brush Script MT, cursive';
      let fontStyle = 'italic';
      if (this.typedFontIndex === 2) {
        fontFamily = 'Lucida Handwriting, Segoe Script, cursive';
      } else if (this.typedFontIndex === 3) {
        fontFamily = 'Apple Chancery, cursive';
      } else if (this.typedFontIndex === 4) {
        fontFamily = 'Caveat, cursive';
      } else if (this.typedFontIndex === 5) {
        fontFamily = 'Great Vibes, Snell Roundhand, cursive';
      }

      if (hasThai) {
        ctx.font = `${fontStyle} 600 42px "Sarabun", ${fontFamily}, sans-serif`;
      } else {
        ctx.font = `${fontStyle} 42px ${fontFamily}`;
      }

      ctx.fillStyle = this.drawColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 200, 60);

      // Find non-transparent pixel bounds to trim
      const imgData = ctx.getImageData(0, 0, 400, 120).data;
      let minX = 400, minY = 120, maxX = 0, maxY = 0;
      let hasPixels = false;
      for (let y = 0; y < 120; y++) {
        for (let x = 0; x < 400; x++) {
          const alpha = imgData[(y * 400 + x) * 4 + 3];
          if (alpha > 10) {
            hasPixels = true;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (!hasPixels || minX >= maxX || minY >= maxY) {
        return offscreen.toDataURL('image/png');
      }
      const pad = 8;
      const cropW = (maxX - minX) + pad * 2;
      const cropH = (maxY - minY) + pad * 2;
      const cropX = Math.max(0, minX - pad);
      const cropY = Math.max(0, minY - pad);

      const trimmed = document.createElement('canvas');
      trimmed.width = cropW;
      trimmed.height = cropH;
      const tCtx = trimmed.getContext('2d');
      tCtx.drawImage(offscreen, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      return trimmed.toDataURL('image/png');
    }

    if (this.activeTab === 'upload') {
      return this.uploadedDataUrl;
    }

    return null;
  }

  // Insert signature onto current active page
  insertSignature() {
    const pngData = this.generateSignaturePng();
    if (!pngData) {
      alert('Please provide or draw a signature first.');
      return;
    }

    const pageIndex = this.canvasController.activePageIndex;
    const pageSize = this.canvasController.pdfEngine.getPageSize(pageIndex);

    // Initial signature dimensions
    const width = 160;
    const height = 65;

    // Center in visible page area
    const x = Math.round((pageSize.width - width) / 2);
    const y = Math.round((pageSize.height - height) / 2);

    const newAnn = this.annotationManager.addAnnotation({
      pageIndex,
      type: 'signature',
      x,
      y,
      width,
      height,
      imgDataUrl: pngData,
    });

    if (window.uiController && typeof window.uiController.selectTool === 'function') {
      window.uiController.selectTool('select');
    } else {
      this.canvasController.setTool('select');
    }
    if (newAnn && newAnn.id) {
      this.annotationManager.selectAnnotation(newAnn.id, false);
    }
    this.dialog.close();
  }
}

window.SignaturePadController = SignaturePadController;
