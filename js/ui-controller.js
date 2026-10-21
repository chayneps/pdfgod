/**
 * UI Controller
 * Binds all user interface events, toolbars, sidebars, zoom, properties bar, and notifications.
 */

class UIController {
  constructor(pdfEngine, annotationManager, canvasController) {
    this.pdfEngine = pdfEngine;
    this.annotationManager = annotationManager;
    this.canvasController = canvasController;

    this.zoom = 1.0;
    this.currentPage = 0;
    this.isSidebarCollapsed = false;

    // Dom elements
    this.viewport = document.querySelector('.app-viewport');
    this.docContainer = document.querySelector('.document-container');
    this.emptyDropzone = document.querySelector('.empty-dropzone');
    this.sidebar = document.querySelector('.app-sidebar');
    this.thumbnailList = document.querySelector('.thumbnail-list');
    this.annotationsList = document.querySelector('.annotations-list-container');
    this.propBar = document.querySelector('.properties-bar');
    this.docTitleInput = document.querySelector('.doc-title-input');
    this.pageNumInput = document.querySelector('.page-num-input');
    this.totalPagesLabel = document.querySelector('.total-pages-label');
    this.zoomLabel = document.querySelector('.zoom-label');

    this.undoBtn = document.querySelector('#btn-undo');
    this.redoBtn = document.querySelector('#btn-redo');

    // Page Layout Columns (1, 2, or 3 pages in a row)
    let savedCols = 1;
    try {
      savedCols = parseInt(localStorage.getItem('pdfgod_layout_columns')) || 1;
    } catch (e) {}
    this.layoutColumns = Math.max(1, Math.min(3, savedCols));

    // Drag and drop state tracking
    this.isInternalThumbnailDrag = false;
    this.isInternalPageDrag = false;
    this.draggedPageIndex = null;
    this.draggedPageIndices = null;
    this.selectedPages = new Set([0]);
    this.selectionAnchorPage = 0;

    // Existing files tracking for Save replace confirmation
    this.existingFiles = new Set();
    this.originalFilename = null;
    this.isDirty = false;

    // Multi-page batch group editor state
    this.batchGroups = new Map();
    this.activeBatchState = null;
    if (this.annotationManager) {
      this.annotationManager.pdfEngine = this.pdfEngine;
    }

    this.init();
  }

  init() {
    this.bindFileEvents();
    this.bindToolbarEvents();
    this.bindPropertiesBar();
    this.bindSidebarEvents();
    this.bindZoomEvents();
    this.bindPageLayoutEvents();
    this.bindExportEvents();
    this.bindBeforeUnload();
    this.bindBatchGroupWidgetEvents();
    this.setLayoutColumns(this.layoutColumns, false);

    // Listen to annotations changes to update undo/redo buttons and annotations list
    this.annotationManager.onChange(async (annotations, actionType) => {
      this.isDirty = true;
      this.updateUndoRedoState();
      this.renderAnnotationsList();
      if (actionType === 'undo-pdf' || actionType === 'redo-pdf') {
        if (this.docContainer) {
          const wrappers = this.docContainer.querySelectorAll('.page-wrapper');
          for (const w of wrappers) {
            const p = parseInt(w.dataset.pageIndex, 10);
            const canvas = w.querySelector('.pdf-canvas');
            if (canvas && !isNaN(p)) {
              await this.pdfEngine.renderPage(p, canvas, this.zoom);
            }
          }
        }
        await this.canvasController.loadTextItemsForActivePage();
        this.canvasController.render();
        this.canvasController.syncTextElements();
      }
    });

    this.annotationManager.onSelectionChange((selected) => {
      this.updatePropertiesBarForSelection(selected);
    });
  }

  // Bind browser refresh/navigation confirmation to prevent data loss
  bindBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });
  }

  // Check if active document has unsaved edits
  hasUnsavedChanges() {
    if (!this.pdfEngine || this.pdfEngine.getPageCount() === 0) {
      return false;
    }
    return !!this.isDirty;
  }

  // Toast Notification
  showToast(message, type = 'info', duration = 3000) {
    let container = document.querySelector('#toast-container, .toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-12px, 8px) scale(0.95)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  // File Upload & Drag-and-Drop
  bindFileEvents() {
    const fileInput = document.querySelector('#pdf-file-input');
    const openBtn = document.querySelector('#btn-open-pdf');
    const dropzoneOpenBtn = document.querySelector('#btn-dropzone-open');
    const triggerFileInput = () => fileInput.click();
    if (openBtn) openBtn.addEventListener('click', triggerFileInput);
    if (dropzoneOpenBtn) dropzoneOpenBtn.addEventListener('click', triggerFileInput);

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.loadFile(file);
      });
    }

    // Drag and drop on viewport (handling both external PDF file drop AND internal page arrange drag)
    if (this.viewport) {
      let viewportDragCounter = 0;

      this.viewport.addEventListener('dragenter', (e) => {
        const isExternal = this.isExternalFileDrag(e);
        const isInternal = this.isInternalPageDrag || this.isInternalThumbnailDrag;
        if (!isExternal && !isInternal) return;
        viewportDragCounter++;
      });

      this.viewport.addEventListener('dragover', (e) => {
        const isExternal = this.isExternalFileDrag(e);
        const isInternal = this.isInternalPageDrag || this.isInternalThumbnailDrag;
        if (!isExternal && !isInternal) return;

        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move';
        }

        if (this.pdfEngine.getPageCount() === 0) {
          if (this.emptyDropzone) this.emptyDropzone.classList.add('drag-over');
          this.updateViewportDropHint(null, null, 'Drop PDF to open document');
        } else {
          this.updatePageWrapperDropIndicator(e.clientY, e.clientX);
          const insertAfter = this.getPageWrapperDropInsertAfterIndex(e.clientY, e.clientX);
          if (isExternal) {
            const hintText = insertAfter === -1
              ? 'Drop PDF to insert before Page 1'
              : `Drop PDF to insert after Page ${insertAfter + 1}`;
            this.updateViewportDropHint(e.clientY, e.clientX, hintText);
          } else {
            const fromIndices = (this.draggedPageIndices && this.draggedPageIndices.length > 0)
              ? this.draggedPageIndices
              : (this.draggedPageIndex !== null ? [this.draggedPageIndex] : []);
            const count = fromIndices.length;
            let hintText;
            if (count > 1) {
              const rangeStr = `${fromIndices[0] + 1}–${fromIndices[count - 1] + 1}`;
              hintText = insertAfter === -1
                ? `Move ${count} pages (Pages ${rangeStr}) to position 1`
                : `Move ${count} pages (Pages ${rangeStr}) to after Page ${insertAfter + 1}`;
            } else if (count === 1) {
              const fromIndex = fromIndices[0];
              let targetIndex;
              if (insertAfter === -1) {
                targetIndex = 0;
              } else if (fromIndex <= insertAfter) {
                targetIndex = insertAfter;
              } else {
                targetIndex = insertAfter + 1;
              }
              targetIndex = Math.max(0, Math.min(this.pdfEngine.getPageCount() - 1, targetIndex));
              hintText = `Move Page ${fromIndex + 1} to position ${targetIndex + 1}`;
            } else {
              hintText = 'Move pages';
            }
            this.updateViewportDropHint(e.clientY, e.clientX, hintText);
          }
        }
      });

      this.viewport.addEventListener('dragleave', (e) => {
        const isExternal = this.isExternalFileDrag(e);
        const isInternal = this.isInternalPageDrag || this.isInternalThumbnailDrag;
        if (!isExternal && !isInternal) return;

        viewportDragCounter--;
        if (viewportDragCounter <= 0) {
          viewportDragCounter = 0;
          this.clearAllDragOverStates();
        }
      });

      this.viewport.addEventListener('drop', async (e) => {
        viewportDragCounter = 0;
        this.hideViewportDropHint();

        const isExternal = this.isExternalFileDrag(e);
        const isInternal = this.isInternalPageDrag || this.isInternalThumbnailDrag;
        if (!isExternal && !isInternal) return;

        e.preventDefault();

        // 1. External file drop: Add PDF page(s)
        if (isExternal) {
          const files = e.dataTransfer ? e.dataTransfer.files : [];
          const pdfFiles = this.extractPdfFiles(files);

          if (this.pdfEngine.getPageCount() === 0) {
            this.clearAllDragOverStates();
            if (pdfFiles.length === 0) return;
            await this.loadFile(pdfFiles[0]);
            if (pdfFiles.length > 1) {
              await this.handleDroppedPdfFiles(pdfFiles.slice(1), null);
            }
          } else {
            const insertAfterIndex = this.getPageWrapperDropInsertAfterIndex(e.clientY, e.clientX);
            this.clearAllDragOverStates();
            if (pdfFiles.length === 0) return;
            await this.handleDroppedPdfFiles(pdfFiles, insertAfterIndex);
          }
          return;
        }

        // 2. Internal page arrange drop: Reorder single page or multi-page range
        if (isInternal) {
          let fromIndices = this.draggedPageIndices;
          if (!fromIndices || fromIndices.length === 0) {
            const rawText = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
            if (rawText) {
              fromIndices = rawText.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            }
          }
          if (!fromIndices || fromIndices.length === 0) {
            if (this.draggedPageIndex !== null) fromIndices = [this.draggedPageIndex];
          }

          const insertAfterIndex = this.getPageWrapperDropInsertAfterIndex(e.clientY, e.clientX);
          this.isInternalPageDrag = false;
          this.isInternalThumbnailDrag = false;
          this.draggedPageIndices = null;
          this.draggedPageIndex = null;
          this.clearAllDragOverStates();

          if (fromIndices && fromIndices.length > 0 && insertAfterIndex !== null) {
            const res = await this.reorderPages(fromIndices, insertAfterIndex);
            if (res) {
              const count = fromIndices.length;
              const msg = count > 1
                ? `Moved ${count} pages to position ${res.firstNewIndex + 1}`
                : `Moved Page ${fromIndices[0] + 1} to position ${res.firstNewIndex + 1}`;
              this.showToast(msg, 'success');
            }
          }
        }
      });
    }

    // Document title change
    if (this.docTitleInput) {
      this.docTitleInput.addEventListener('change', (e) => {
        let val = e.target.value.trim();
        if (!val.toLowerCase().endsWith('.pdf')) val += '.pdf';
        this.docTitleInput.value = val;
        this.pdfEngine.filename = val;
        this.isDirty = true;
      });
    }
  }

  // Check if a File object is a PDF file
  isPdfFile(file) {
    if (!file) return false;
    if (file.type === 'application/pdf') return true;
    if (file.name && /\.pdf$/i.test(file.name.trim())) return true;
    return false;
  }

  // Filter FileList or Array of files to only valid PDF files
  extractPdfFiles(fileList) {
    if (!fileList) return [];
    return Array.from(fileList).filter(f => this.isPdfFile(f));
  }

  // Check if drag event is an external file drag (not internal thumbnail reorder or page arrange)
  isExternalFileDrag(e) {
    if (this.isInternalThumbnailDrag || this.isInternalPageDrag) return false;
    if (!e || !e.dataTransfer) return true;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) return true;
    if (e.dataTransfer.types) {
      const types = Array.from(e.dataTransfer.types);
      if (types.includes('application/x-pdfgod-page-index')) return false;
      if (types.includes('Files') || types.includes('application/x-moz-file')) return true;
      if (types.includes('text/plain') && !types.includes('Files')) return false;
    }
    return true;
  }

  // Toggle visual drag-over state on "Add Page from PDF" button and its wrapper
  setAddPdfButtonDragState(isDragOver) {
    const addPdfBtns = document.querySelectorAll('[data-action="add-pdf-page"]');
    const wrappers = document.querySelectorAll('.add-page-wrapper');
    wrappers.forEach(w => w.classList.toggle('drag-over', !!isDragOver));
    addPdfBtns.forEach(btn => {
      btn.classList.toggle('drag-over', !!isDragOver);
      const span = btn.querySelector('span');
      if (span) {
        if (isDragOver) {
          if (!span.dataset.originalText) {
            span.dataset.originalText = span.textContent;
          }
          span.textContent = 'Drop PDF to Add Pages';
        } else if (span.dataset.originalText) {
          span.textContent = span.dataset.originalText;
        }
      }
    });
  }

  // Floating Drop Hint in Main Viewport
  updateViewportDropHint(clientY = null, clientX = null, text = null) {
    let hint = document.getElementById('viewport-drop-hint');
    if (!hint && this.viewport) {
      hint = document.createElement('div');
      hint.className = 'viewport-drop-hint';
      hint.id = 'viewport-drop-hint';
      hint.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="drop-hint-icon">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <polyline points="9 15 12 12 15 15"/>
        </svg>
        <span class="drop-hint-text"></span>
      `;
      this.viewport.appendChild(hint);
    }
    if (!hint) return;

    const span = hint.querySelector('.drop-hint-text');
    if (span && text) {
      span.textContent = text;
    }
    hint.classList.add('visible');
  }

  hideViewportDropHint() {
    const hint = document.getElementById('viewport-drop-hint');
    if (hint) {
      hint.classList.remove('visible');
    }
  }

  // Clear all drag-over visual indicators across sidebar and viewport
  clearAllDragOverStates() {
    this.setAddPdfButtonDragState(false);
    this.hideViewportDropHint();
    if (this.emptyDropzone) this.emptyDropzone.classList.remove('drag-over');
    if (this.thumbnailList) {
      this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
        c.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    }
    if (this.docContainer) {
      this.docContainer.querySelectorAll('.page-wrapper').forEach(w => {
        w.classList.remove('page-drop-top', 'page-drop-bottom', 'page-drop-left', 'page-drop-right', 'page-dragging');
      });
    }
  }

  // Determine insertion index (insertAfterIndex) from vertical coordinate in thumbnail list
  getThumbnailDropInsertAfterIndex(clientY) {
    if (!this.thumbnailList) return null;
    const cards = Array.from(this.thumbnailList.querySelectorAll('.thumbnail-card'));
    if (cards.length === 0) return null;

    if (clientY > 0) {
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (clientY < midY) {
          return i - 1;
        }
      }
      return cards.length - 1;
    }

    // Fallback if synthetic event had clientY === 0: check active indicator class
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].classList.contains('drag-over-top')) return i - 1;
      if (cards[i].classList.contains('drag-over-bottom')) return i;
    }
    return cards.length - 1;
  }

  // Highlight insertion slot between thumbnail cards
  updateThumbnailDropIndicator(clientY) {
    if (!this.thumbnailList) return;
    const cards = Array.from(this.thumbnailList.querySelectorAll('.thumbnail-card'));
    cards.forEach(c => c.classList.remove('drag-over-top', 'drag-over-bottom'));
    if (cards.length === 0) return;

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) {
        cards[i].classList.add('drag-over-top');
        return;
      }
    }
    cards[cards.length - 1].classList.add('drag-over-bottom');
  }

  // Unified Spatial Drop Target Calculator for Main Document Container (1, 2, or 3 column grid)
  getPageWrapperDropTarget(clientY, clientX = null) {
    if (!this.docContainer) return null;
    const wrappers = Array.from(this.docContainer.querySelectorAll('.page-wrapper'));
    if (wrappers.length === 0) return null;

    // Single column fallback or when clientX is not provided
    if (this.layoutColumns <= 1 || clientX === null) {
      if (clientY > 0) {
        for (let i = 0; i < wrappers.length; i++) {
          const rect = wrappers[i].getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (clientY < midY) {
            return {
              insertAfterIndex: i - 1,
              indicatorWrapper: wrappers[i],
              indicatorClass: 'page-drop-top',
            };
          }
        }
        return {
          insertAfterIndex: wrappers.length - 1,
          indicatorWrapper: wrappers[wrappers.length - 1],
          indicatorClass: 'page-drop-bottom',
        };
      }
      for (let i = 0; i < wrappers.length; i++) {
        if (wrappers[i].classList.contains('page-drop-top') || wrappers[i].classList.contains('page-drop-left')) {
          return { insertAfterIndex: i - 1, indicatorWrapper: wrappers[i], indicatorClass: 'page-drop-top' };
        }
        if (wrappers[i].classList.contains('page-drop-bottom') || wrappers[i].classList.contains('page-drop-right')) {
          return { insertAfterIndex: i, indicatorWrapper: wrappers[i], indicatorClass: 'page-drop-bottom' };
        }
      }
      return {
        insertAfterIndex: wrappers.length - 1,
        indicatorWrapper: wrappers[wrappers.length - 1],
        indicatorClass: 'page-drop-bottom',
      };
    }

    // Multi-column grid layout (2 or 3 pages in a row)
    // Group wrappers into rows by vertical position
    const rows = [];
    let currentRow = [];
    let currentTop = null;

    wrappers.forEach((w, idx) => {
      const rect = w.getBoundingClientRect();
      if (currentTop === null || Math.abs(rect.top - currentTop) < 30) {
        currentRow.push({ index: idx, wrapper: w, rect });
        currentTop = rect.top;
      } else {
        rows.push(currentRow);
        currentRow = [{ index: idx, wrapper: w, rect }];
        currentTop = rect.top;
      }
    });
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    if (rows.length === 0) return null;

    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];

    // If clientY is above the first row
    if (clientY < firstRow[0].rect.top - 20) {
      return {
        insertAfterIndex: -1,
        indicatorWrapper: firstRow[0].wrapper,
        indicatorClass: 'page-drop-top',
      };
    }

    // If clientY is below the last row
    const lastRowBottom = Math.max(...lastRow.map(item => item.rect.bottom));
    if (clientY > lastRowBottom + 20) {
      const lastItem = lastRow[lastRow.length - 1];
      return {
        insertAfterIndex: wrappers.length - 1,
        indicatorWrapper: lastItem.wrapper,
        indicatorClass: 'page-drop-bottom',
      };
    }

    // Find the matching row
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowTop = Math.min(...row.map(item => item.rect.top));
      const rowBottom = Math.max(...row.map(item => item.rect.bottom));

      // If between rows
      if (clientY < rowTop - 15) {
        return {
          insertAfterIndex: row[0].index - 1,
          indicatorWrapper: row[0].wrapper,
          indicatorClass: 'page-drop-top',
        };
      }

      if (clientY <= rowBottom + 20 || r === rows.length - 1) {
        // Within this row: find horizontal slot
        for (let c = 0; c < row.length; c++) {
          const item = row[c];
          const midX = item.rect.left + item.rect.width / 2;
          if (clientX < midX) {
            return {
              insertAfterIndex: item.index - 1,
              indicatorWrapper: item.wrapper,
              indicatorClass: 'page-drop-left',
            };
          } else if (c === row.length - 1 || clientX < row[c + 1].rect.left) {
            return {
              insertAfterIndex: item.index,
              indicatorWrapper: item.wrapper,
              indicatorClass: 'page-drop-right',
            };
          }
        }
        const lastItem = row[row.length - 1];
        return {
          insertAfterIndex: lastItem.index,
          indicatorWrapper: lastItem.wrapper,
          indicatorClass: 'page-drop-right',
        };
      }
    }

    const lastItem = wrappers[wrappers.length - 1];
    return {
      insertAfterIndex: wrappers.length - 1,
      indicatorWrapper: lastItem,
      indicatorClass: 'page-drop-bottom',
    };
  }

  // Determine insertion index (insertAfterIndex) from coordinate in main document container
  getPageWrapperDropInsertAfterIndex(clientY, clientX = null) {
    const target = this.getPageWrapperDropTarget(clientY, clientX);
    return target ? target.insertAfterIndex : null;
  }

  // Highlight insertion slot between pages in main document container
  updatePageWrapperDropIndicator(clientY, clientX = null) {
    if (!this.docContainer) return;
    const wrappers = Array.from(this.docContainer.querySelectorAll('.page-wrapper'));
    wrappers.forEach(w => w.classList.remove('page-drop-top', 'page-drop-bottom', 'page-drop-left', 'page-drop-right'));

    const target = this.getPageWrapperDropTarget(clientY, clientX);
    if (target && target.indicatorWrapper && target.indicatorClass) {
      target.indicatorWrapper.classList.add(target.indicatorClass);
    }
  }

  // Process dropped or selected files: ignore non-PDF files, add only PDF files
  async handleDroppedPdfFiles(fileListOrArray, insertAfterIndex = null) {
    const pdfFiles = this.extractPdfFiles(fileListOrArray);
    // If all files are not PDF files, just do nothing
    if (pdfFiles.length === 0) {
      return { addedFiles: 0, addedPages: 0, firstPageIndex: null };
    }

    let currentInsertAfter = insertAfterIndex;
    let totalAddedPages = 0;
    let firstInsertedPageIndex = null;
    let addedFilesCount = 0;

    for (const file of pdfFiles) {
      try {
        const buffer = await file.arrayBuffer();
        const res = await this.addPagesFromPdfBuffer(buffer, currentInsertAfter);
        if (res && res.addedCount > 0) {
          if (firstInsertedPageIndex === null) {
            firstInsertedPageIndex = res.firstPageIndex;
          }
          totalAddedPages += res.addedCount;
          addedFilesCount += 1;
          if (currentInsertAfter !== null) {
            currentInsertAfter = res.firstPageIndex + res.addedCount - 1;
          }
        }
      } catch (err) {
        console.error('Failed to add pages from dropped PDF:', file.name, err);
      }
    }

    if (firstInsertedPageIndex !== null && pdfFiles.length > 1) {
      this.switchActivePage(firstInsertedPageIndex);
    }

    return {
      addedFiles: addedFilesCount,
      addedPages: totalAddedPages,
      firstPageIndex: firstInsertedPageIndex,
    };
  }

  // Load a File object
  async loadFile(file) {
    try {
      this.showToast('Loading PDF document...', 'info', 2000);
      const arrayBuffer = await file.arrayBuffer();
      await this.loadPdfBuffer(arrayBuffer, file.name);
    } catch (err) {
      console.error('Failed to load PDF:', err);
      this.showToast('Failed to open PDF file.', 'error');
    }
  }

  // Base loader for PDF buffer
  async loadPdfBuffer(buffer, filename) {
    this.annotationManager.clear();
    const result = await this.pdfEngine.loadPDF(buffer, filename);

    if (this.docTitleInput) {
      this.docTitleInput.value = filename;
    }

    this.originalFilename = filename;
    this.markFileAsExisting(filename);
    this.isDirty = true;

    // Hide empty dropzone, show document container
    if (this.emptyDropzone) this.emptyDropzone.style.display = 'none';
    if (this.docContainer) this.docContainer.style.display = '';

    this.currentPage = 0;
    this.selectedPages = new Set([0]);
    this.selectionAnchorPage = 0;
    this.updatePageIndicator();
    await this.renderDocument();
    await this.renderThumbnails();
    this.showToast(`Loaded ${result.numPages} page${result.numPages > 1 ? 's' : ''}.`, 'success');
  }

  // Add pages from another PDF buffer (at the bottom by default, or after insertAfterIndex)
  async addPagesFromPdfBuffer(buffer, insertAfterIndex = null) {
    if (!this.pdfEngine.pdfDoc) {
      await this.loadPdfBuffer(buffer, 'imported.pdf');
      return { addedCount: this.pdfEngine.getPageCount(), firstPageIndex: 0, totalPageCount: this.pdfEngine.getPageCount() };
    }

    // Default to appending at the bottom of the document
    const targetAfterIndex = insertAfterIndex !== null ? insertAfterIndex : null;
    const res = await this.pdfEngine.addPagesFromPDF(buffer, targetAfterIndex);
    if (res && res.addedCount > 0) {
      this.isDirty = true;
      this.annotationManager.handlePagesInserted(res.firstPageIndex, res.addedCount);
      await this.renderDocument();
      await this.renderThumbnails();
      this.switchActivePage(res.firstPageIndex);
      this.updatePageIndicator();
      const locationMsg = targetAfterIndex === null
        ? 'at the bottom'
        : `at page ${res.firstPageIndex + 1}`;
      this.showToast(`Added ${res.addedCount} page${res.addedCount > 1 ? 's' : ''} ${locationMsg}`, 'success');
      return res;
    }
    return res;
  }

  // Rearrange / Reorder multiple pages to an insertion position
  async reorderPages(fromIndices, insertAfterIndex) {
    if (!Array.isArray(fromIndices) || fromIndices.length === 0 || insertAfterIndex === null) {
      return null;
    }

    const res = this.pdfEngine.movePages(fromIndices, insertAfterIndex);
    if (!res) return null;

    this.annotationManager.handlePagesReordered(res.oldIndexToNewIndex);
    this.isDirty = true;

    // Update selected pages to their new indices
    this.selectedPages = new Set(res.newMovedIndices);
    this.selectionAnchorPage = res.newMovedIndices[0];
    this.currentPage = res.firstNewIndex;

    this.updatePageIndicator();
    await this.renderDocument();
    await this.renderThumbnails();
    this.switchActivePage(res.firstNewIndex, false);
    this.updatePageSelectionUI();

    return res;
  }

  // Rearrange / Reorder single page
  async reorderPage(fromIndex, toIndex) {
    const numPages = this.pdfEngine.getPageCount();
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= numPages || toIndex >= numPages) {
      return;
    }
    const insertAfterIndex = fromIndex < toIndex ? toIndex : toIndex - 1;
    await this.reorderPages([fromIndex], insertAfterIndex);
    this.showToast(`Page ${fromIndex + 1} moved to position ${toIndex + 1}`, 'info');
  }

  // Render all pages in document container (alias for renderDocument)
  async renderAllPages() {
    return this.renderDocument();
  }

  // Render all pages in document container
  async renderDocument() {
    if (!this.docContainer) return;
    this.docContainer.innerHTML = '';

    const cols = this.layoutColumns || 1;
    this.docContainer.classList.remove('layout-cols-1', 'layout-cols-2', 'layout-cols-3');
    this.docContainer.classList.add(`layout-cols-${cols}`);

    const numPages = this.pdfEngine.getPageCount();

    for (let i = 0; i < numPages; i++) {
      const isSelected = this.selectedPages.has(i);
      const pageWrapper = document.createElement('div');
      pageWrapper.className = `page-wrapper ${i === this.currentPage ? 'active-page' : ''} ${isSelected ? 'page-selected' : ''}`;
      pageWrapper.dataset.pageIndex = i;

      // Page Header Bar with arrange drag handle, page number badge, selection checkbox, and quick actions
      const headerBar = document.createElement('div');
      headerBar.className = `page-header-bar ${isSelected ? 'page-header-selected' : ''}`;
      headerBar.setAttribute('draggable', 'true');
      headerBar.title = 'Drag to arrange page (Shift+click to select range)';
      headerBar.innerHTML = `
        <div class="page-header-left">
          <span class="page-select-checkbox ${isSelected ? 'checked' : ''}" title="Select page (Shift+click for range)"></span>
          <span class="page-drag-handle" title="Drag to arrange page">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 13px; height: 13px;">
              <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
              <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
              <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
            </svg>
          </span>
          <span class="page-number-badge">Page ${i + 1}</span>
        </div>
        <div class="page-header-actions">
          <button class="btn-page-action" data-action="move-left" title="Move page earlier" ${i === 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <button class="btn-page-action" data-action="move-right" title="Move page later" ${i === numPages - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          <button class="btn-page-action" data-action="rotate-page" title="Rotate 90°">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button class="btn-page-action btn-page-delete" data-action="delete-page" title="Delete page" ${numPages <= 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;

      // Drag event listeners on headerBar for arranging pages
      headerBar.addEventListener('dragstart', (e) => {
        if (e.target.closest('.page-header-actions')) {
          e.preventDefault();
          return;
        }
        // If dragged page is not part of selection, select it solely
        if (!this.selectedPages.has(i)) {
          this.selectPage(i, false, false);
        }
        this.isInternalPageDrag = true;
        this.draggedPageIndex = i;
        this.draggedPageIndices = Array.from(this.selectedPages).sort((a, b) => a - b);

        const indicesStr = this.draggedPageIndices.join(',');
        e.dataTransfer.setData('text/plain', indicesStr);
        e.dataTransfer.setData('application/x-pdfgod-page-index', indicesStr);
        e.dataTransfer.effectAllowed = 'move';

        // Add page-dragging class to all selected page wrappers
        if (this.docContainer) {
          this.draggedPageIndices.forEach(idx => {
            const w = this.docContainer.querySelector(`.page-wrapper[data-page-index="${idx}"]`);
            if (w) w.classList.add('page-dragging');
          });
        }
      });

      headerBar.addEventListener('dragend', () => {
        this.isInternalPageDrag = false;
        this.draggedPageIndex = null;
        this.draggedPageIndices = null;
        if (this.docContainer) {
          this.docContainer.querySelectorAll('.page-wrapper.page-dragging').forEach(w => {
            w.classList.remove('page-dragging');
          });
        }
        this.clearAllDragOverStates();
      });

      // Quick action button click listeners
      const moveLeftBtn = headerBar.querySelector('[data-action="move-left"]');
      if (moveLeftBtn && i > 0) {
        moveLeftBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
            const minSel = sortedSel[0];
            if (minSel > 0) {
              await this.reorderPages(sortedSel, minSel - 2);
            }
          } else {
            await this.reorderPage(i, i - 1);
          }
        });
      }

      const moveRightBtn = headerBar.querySelector('[data-action="move-right"]');
      if (moveRightBtn && i < numPages - 1) {
        moveRightBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
            const maxSel = sortedSel[sortedSel.length - 1];
            if (maxSel < numPages - 1) {
              await this.reorderPages(sortedSel, maxSel + 1);
            }
          } else {
            await this.reorderPage(i, i + 1);
          }
        });
      }

      const rotateBtn = headerBar.querySelector('[data-action="rotate-page"]');
      if (rotateBtn) {
        rotateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
            for (const p of sortedSel) {
              this.rotateSinglePage(p, 90);
            }
            this.isDirty = true;
            await this.renderDocument();
            await this.renderThumbnails();
            this.showToast(`${sortedSel.length} pages rotated 90°`, 'info');
          } else {
            this.rotateSinglePage(i, 90);
            this.isDirty = true;
            await this.refreshPage(i);
            this.showToast(`Page ${i + 1} rotated 90°`, 'info');
          }
        });
      }

      const deleteBtn = headerBar.querySelector('[data-action="delete-page"]');
      if (deleteBtn && numPages > 1) {
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => b - a);
            if (sortedSel.length >= numPages) {
              this.showToast('Document must have at least one page.', 'error');
              return;
            }
            if (confirm(`Delete ${sortedSel.length} selected pages?`)) {
              for (const p of sortedSel) {
                this.pdfEngine.deletePage(p);
                this.annotationManager.handlePageRemoved(p);
              }
              this.isDirty = true;
              this.selectedPages.clear();
              this.selectedPages.add(0);
              this.selectionAnchorPage = 0;
              this.currentPage = 0;
              await this.renderDocument();
              await this.renderThumbnails();
              this.switchActivePage(0);
              this.showToast(`Pages deleted`, 'info');
            }
          } else {
            if (confirm(`Delete Page ${i + 1}?`)) {
              this.pdfEngine.deletePage(i);
              this.annotationManager.handlePageRemoved(i);
              this.isDirty = true;
              const newCurrent = Math.min(this.currentPage, this.pdfEngine.getPageCount() - 1);
              this.selectedPages.clear();
              this.selectedPages.add(newCurrent);
              this.selectionAnchorPage = newCurrent;
              await this.renderDocument();
              await this.renderThumbnails();
              this.switchActivePage(newCurrent);
              this.showToast(`Page deleted`, 'info');
            }
          }
        });
      }

      // Checkbox click listener
      const chkBox = headerBar.querySelector('.page-select-checkbox');
      if (chkBox) {
        chkBox.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectPage(i, e.shiftKey, true);
        });
      }

      // Clicking header activates / selects page (supports Shift for range, Ctrl/Cmd for toggle)
      headerBar.addEventListener('click', (e) => {
        if (e.target.closest('.btn-page-action') || e.target.closest('.page-select-checkbox')) return;
        this.selectPage(i, e.shiftKey, e.metaKey || e.ctrlKey);
      });

      pageWrapper.appendChild(headerBar);

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      pageWrapper.appendChild(canvas);

      this.docContainer.appendChild(pageWrapper);

      // Render PDF page content
      await this.pdfEngine.renderPage(i, canvas, this.zoom);

      // Clicking or focusing an inactive page activates it immediately (Shift+click selects range)
      pageWrapper.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.page-header-bar')) return;
        if (this.currentPage !== i) {
          if (e.shiftKey) {
            e.preventDefault();
            this.selectPage(i, true, false);
          } else {
            this.switchActivePage(i);
          }
        }
      });
    }

    // Attach canvas controller to the active page
    this.attachActivePageOverlay();
  }

  // Rotate a single page and keep its annotations rotated in sync
  rotateSinglePage(pageIndex, degrees = 90) {
    const oldSize = this.pdfEngine.getPageSize(pageIndex);
    this.pdfEngine.rotatePage(pageIndex, degrees);
    this.annotationManager.rotatePageAnnotations(pageIndex, degrees, oldSize.width, oldSize.height);
  }

  // Re-render only current page (e.g. after rotation)
  async refreshPage(pageIndex) {
    const pageWrapper = this.docContainer.querySelector(`.page-wrapper[data-page-index="${pageIndex}"]`);
    if (!pageWrapper) return;

    const canvas = pageWrapper.querySelector('.pdf-canvas');
    await this.pdfEngine.renderPage(pageIndex, canvas, this.zoom);
    if (pageIndex === this.currentPage) {
      await this.canvasController.loadTextItemsForActivePage();
    }
    this.canvasController.render();
    this.canvasController.updateSelectionBox();
    await this.renderThumbnailItem(pageIndex);
  }

  // Switch active page
  switchActivePage(pageIndex, syncSelection = true) {
    if (pageIndex < 0 || pageIndex >= this.pdfEngine.getPageCount()) return;

    const pageChanged = (this.currentPage !== pageIndex);
    this.currentPage = pageIndex;
    if (syncSelection) {
      this.selectedPages.clear();
      this.selectedPages.add(pageIndex);
      this.selectionAnchorPage = pageIndex;
    }
    this.canvasController.setActivePage(pageIndex);

    this.updatePageIndicator();
    const activeWrapper = this.docContainer ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${pageIndex}"]`) : null;
    if (pageChanged || !activeWrapper || !activeWrapper.querySelector('.annotation-layer')) {
      this.attachActivePageOverlay();
    }
    this.updatePageSelectionUI();

    // Scroll page into view when switching pages
    if (pageChanged && activeWrapper) {
      activeWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Select page with Shift (range) and Ctrl/Cmd (toggle) support
  selectPage(pageIndex, isShift = false, isCtrlOrCmd = false) {
    const numPages = this.pdfEngine.getPageCount();
    if (pageIndex < 0 || pageIndex >= numPages) return;

    if (isShift && this.selectionAnchorPage !== null && this.selectionAnchorPage >= 0) {
      // Range selection between anchor and clicked page
      const start = Math.min(this.selectionAnchorPage, pageIndex);
      const end = Math.max(this.selectionAnchorPage, pageIndex);
      this.selectedPages.clear();
      for (let p = start; p <= end; p++) {
        this.selectedPages.add(p);
      }
    } else if (isCtrlOrCmd) {
      // Toggle individual page in selection
      if (this.selectedPages.has(pageIndex)) {
        if (this.selectedPages.size > 1) {
          this.selectedPages.delete(pageIndex);
        }
      } else {
        this.selectedPages.add(pageIndex);
        this.selectionAnchorPage = pageIndex;
      }
    } else {
      // Single selection
      this.selectedPages.clear();
      this.selectedPages.add(pageIndex);
      this.selectionAnchorPage = pageIndex;
    }

    this.currentPage = pageIndex;
    this.canvasController.setActivePage(pageIndex);
    this.updatePageIndicator();
    this.attachActivePageOverlay();
    this.updatePageSelectionUI();

    const activeWrapper = this.docContainer ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${pageIndex}"]`) : null;
    if (activeWrapper) {
      activeWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Update visual selection indicators on document pages and thumbnails
  updatePageSelectionUI() {
    if (this.docContainer) {
      const wrappers = this.docContainer.querySelectorAll('.page-wrapper');
      wrappers.forEach((w, idx) => {
        const isSel = this.selectedPages.has(idx);
        const isActive = (idx === this.currentPage);
        w.classList.toggle('page-selected', isSel);
        w.classList.toggle('active-page', isActive);

        const headerBar = w.querySelector('.page-header-bar');
        if (headerBar) {
          headerBar.classList.toggle('page-header-selected', isSel);
          const chk = headerBar.querySelector('.page-select-checkbox');
          if (chk) {
            chk.classList.toggle('checked', isSel);
          }
        }
      });
    }

    if (this.thumbnailList) {
      const thumbs = this.thumbnailList.querySelectorAll('.thumbnail-card');
      thumbs.forEach((t, idx) => {
        const isSel = this.selectedPages.has(idx);
        const isActive = (idx === this.currentPage);
        t.classList.toggle('page-selected', isSel);
        t.classList.toggle('active', isActive);
      });
    }
  }

  // Attach overlay to current page wrapper
  attachActivePageOverlay() {
    const activeWrapper = this.docContainer.querySelector(`.page-wrapper[data-page-index="${this.currentPage}"]`);
    if (activeWrapper) {
      this.canvasController.attachToPage(activeWrapper, this.currentPage);
    }
  }

  // Render thumbnails in sidebar
  async renderThumbnails() {
    if (!this.thumbnailList) return;
    this.thumbnailList.innerHTML = '';

    const numPages = this.pdfEngine.getPageCount();

    for (let i = 0; i < numPages; i++) {
      const isSelected = this.selectedPages.has(i);
      const card = document.createElement('div');
      card.className = `thumbnail-card ${i === this.currentPage ? 'active' : ''} ${isSelected ? 'page-selected' : ''}`;
      card.dataset.pageIndex = i;

      card.innerHTML = `
        <div class="thumbnail-preview-wrapper">
          <canvas class="thumbnail-canvas"></canvas>
        </div>
        <div class="thumbnail-footer">
          <span class="thumbnail-page-number">Page ${i + 1}</span>
          <div class="thumbnail-actions">
            <button class="thumb-action-btn" data-action="move-up" title="Move Page Up"${i === 0 ? ' disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button class="thumb-action-btn" data-action="move-down" title="Move Page Down"${i === numPages - 1 ? ' disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="thumb-action-btn" data-action="rotate" title="Rotate 90° Clockwise">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            </button>
            <button class="thumb-action-btn" data-action="duplicate" title="Duplicate Page">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="thumb-action-btn btn-delete" data-action="delete" title="Delete Page">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `;

      // Drag and Drop reordering & external PDF drop between pages on thumbnail cards
      card.setAttribute('draggable', 'true');

      card.addEventListener('dragstart', (e) => {
        if (e.target.closest('.thumbnail-actions')) {
          e.preventDefault();
          return;
        }
        // If dragged thumbnail is not in selection, select only this card
        if (!this.selectedPages.has(i)) {
          this.selectPage(i, false, false);
        }
        this.isInternalThumbnailDrag = true;
        this.draggedPageIndex = i;
        this.draggedPageIndices = Array.from(this.selectedPages).sort((a, b) => a - b);

        const indicesStr = this.draggedPageIndices.join(',');
        e.dataTransfer.setData('text/plain', indicesStr);
        e.dataTransfer.setData('application/x-pdfgod-page-index', indicesStr);
        e.dataTransfer.effectAllowed = 'move';

        // Add dragging class to all selected thumbnail cards
        if (this.thumbnailList) {
          this.draggedPageIndices.forEach(idx => {
            const c = this.thumbnailList.querySelector(`.thumbnail-card[data-page-index="${idx}"]`);
            if (c) c.classList.add('dragging');
          });
        }
      });

      card.addEventListener('dragend', () => {
        this.isInternalThumbnailDrag = false;
        this.draggedPageIndex = null;
        this.draggedPageIndices = null;
        if (this.thumbnailList) {
          this.thumbnailList.querySelectorAll('.thumbnail-card.dragging').forEach(c => {
            c.classList.remove('dragging');
          });
        }
        this.clearAllDragOverStates();
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isFileDrag = this.isExternalFileDrag(e);
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = isFileDrag ? 'copy' : 'move';
        }
        this.setAddPdfButtonDragState(false);
        this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
          if (c !== card) c.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          card.classList.add('drag-over-top');
          card.classList.remove('drag-over-bottom');
        } else {
          card.classList.add('drag-over-bottom');
          card.classList.remove('drag-over-top');
        }
      });

      card.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        card.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Check if dropping external files onto/between thumbnail cards
        if (this.isExternalFileDrag(e) && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          let isBelow = true;
          if (e.clientY > 0) {
            const rect = card.getBoundingClientRect();
            isBelow = e.clientY >= rect.top + rect.height / 2;
          } else if (card.classList.contains('drag-over-top')) {
            isBelow = false;
          } else if (card.classList.contains('drag-over-bottom')) {
            isBelow = true;
          }
          const insertAfterIndex = isBelow ? i : (i - 1);
          this.clearAllDragOverStates();
          await this.handleDroppedPdfFiles(e.dataTransfer.files, insertAfterIndex);
          return;
        }

        // Internal thumbnail or page reorder (single page or multi-page range)
        let fromIndices = this.draggedPageIndices;
        if (!fromIndices || fromIndices.length === 0) {
          const rawText = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
          if (rawText) {
            fromIndices = rawText.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
          }
        }
        if (!fromIndices || fromIndices.length === 0) {
          if (this.draggedPageIndex !== null) fromIndices = [this.draggedPageIndex];
        }

        this.isInternalThumbnailDrag = false;
        this.isInternalPageDrag = false;
        this.draggedPageIndex = null;
        this.draggedPageIndices = null;
        card.classList.remove('drag-over-top', 'drag-over-bottom');
        this.clearAllDragOverStates();

        if (!fromIndices || fromIndices.length === 0) return;

        const rect = card.getBoundingClientRect();
        const isBelow = e.clientY >= rect.top + rect.height / 2;
        const insertAfterIndex = isBelow ? i : (i - 1);

        const res = await this.reorderPages(fromIndices, insertAfterIndex);
        if (res) {
          const count = fromIndices.length;
          const msg = count > 1
            ? `Moved ${count} pages to position ${res.firstNewIndex + 1}`
            : `Moved Page ${fromIndices[0] + 1} to position ${res.firstNewIndex + 1}`;
          this.showToast(msg, 'info');
        }
      });

      // Click card to jump to page or select range with Shift / toggle with Ctrl/Cmd
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.thumbnail-actions')) {
          this.selectPage(i, e.shiftKey, e.metaKey || e.ctrlKey);
        }
      });

      // Move Up / Move Down buttons
      const moveUpBtn = card.querySelector('[data-action="move-up"]');
      if (moveUpBtn && i > 0) {
        moveUpBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
            const minSel = sortedSel[0];
            if (minSel > 0) {
              await this.reorderPages(sortedSel, minSel - 2);
            }
          } else {
            await this.reorderPage(i, i - 1);
          }
        });
      }

      const moveDownBtn = card.querySelector('[data-action="move-down"]');
      if (moveDownBtn && i < numPages - 1) {
        moveDownBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
            const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
            const maxSel = sortedSel[sortedSel.length - 1];
            if (maxSel < numPages - 1) {
              await this.reorderPages(sortedSel, maxSel + 1);
            }
          } else {
            await this.reorderPage(i, i + 1);
          }
        });
      }

      // Actions on thumbnail
      const rotateBtn = card.querySelector('[data-action="rotate"]');
      rotateBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
          const sortedSel = Array.from(this.selectedPages).sort((a, b) => a - b);
          for (const p of sortedSel) {
            this.rotateSinglePage(p, 90);
          }
          this.isDirty = true;
          await this.renderDocument();
          await this.renderThumbnails();
          this.showToast(`${sortedSel.length} pages rotated 90°`, 'info');
        } else {
          this.rotateSinglePage(i, 90);
          this.isDirty = true;
          await this.refreshPage(i);
          this.showToast(`Page ${i + 1} rotated 90°`, 'info');
        }
      });

      const dupBtn = card.querySelector('[data-action="duplicate"]');
      dupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.pdfEngine.duplicatePage(i);
        this.isDirty = true;
        await this.renderDocument();
        await this.renderThumbnails();
        this.switchActivePage(i + 1);
        this.showToast(`Page duplicated`, 'success');
      });

      const delBtn = card.querySelector('[data-action="delete"]');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (numPages <= 1) {
          this.showToast('Document must have at least one page.', 'error');
          return;
        }
        if (this.selectedPages.has(i) && this.selectedPages.size > 1) {
          const sortedSel = Array.from(this.selectedPages).sort((a, b) => b - a);
          if (sortedSel.length >= numPages) {
            this.showToast('Document must have at least one page.', 'error');
            return;
          }
          if (confirm(`Delete ${sortedSel.length} selected pages?`)) {
            for (const p of sortedSel) {
              this.pdfEngine.deletePage(p);
              this.annotationManager.handlePageRemoved(p);
            }
            this.isDirty = true;
            this.selectedPages.clear();
            this.selectedPages.add(0);
            this.selectionAnchorPage = 0;
            this.currentPage = 0;
            await this.renderDocument();
            await this.renderThumbnails();
            this.switchActivePage(0);
            this.showToast(`Pages deleted`, 'info');
          }
        } else {
          if (confirm(`Delete Page ${i + 1}?`)) {
            this.pdfEngine.deletePage(i);
            this.annotationManager.handlePageRemoved(i);
            this.isDirty = true;
            const newCurrent = Math.min(this.currentPage, this.pdfEngine.getPageCount() - 1);
            this.selectedPages.clear();
            this.selectedPages.add(newCurrent);
            this.selectionAnchorPage = newCurrent;
            await this.renderDocument();
            await this.renderThumbnails();
            this.switchActivePage(newCurrent);
            this.showToast(`Page deleted`, 'info');
          }
        }
      });

      this.thumbnailList.appendChild(card);

      // Render thumbnail preview canvas
      const canvas = card.querySelector('.thumbnail-canvas');
      this.pdfEngine.renderThumbnail(i, canvas, 140);
    }
  }

  // Render single thumbnail item
  async renderThumbnailItem(pageIndex) {
    const card = this.thumbnailList.querySelector(`.thumbnail-card[data-page-index="${pageIndex}"]`);
    if (!card) return;
    const canvas = card.querySelector('.thumbnail-canvas');
    await this.pdfEngine.renderThumbnail(pageIndex, canvas, 140);
  }

  // Update Page Indicator Input
  updatePageIndicator() {
    const total = this.pdfEngine.getPageCount();
    if (this.pageNumInput) this.pageNumInput.value = this.currentPage + 1;
    if (this.totalPagesLabel) this.totalPagesLabel.textContent = `/ ${total || 1}`;
  }

  // Bind Toolbar Buttons
  bindToolbarEvents() {
    // Tool buttons
    const toolBtns = document.querySelectorAll('.tool-btn[data-tool]');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tool = btn.dataset.tool;
        const subtype = btn.dataset.subtype || null;
        this.canvasController.setTool(tool, subtype);
        this.updatePropertiesBarForTool(tool, subtype);
      });
    });

    // Shapes Dropdown items
    const shapeItems = document.querySelectorAll('.shape-select-item');
    shapeItems.forEach(item => {
      item.addEventListener('click', () => {
        const shapeType = item.dataset.shape;
        const shapesBtn = document.querySelector('.tool-btn[data-tool="shapes"]');
        if (shapesBtn) {
          toolBtns.forEach(b => b.classList.remove('active'));
          shapesBtn.classList.add('active');
        }
        this.canvasController.setTool('shapes', shapeType);
        this.updatePropertiesBarForTool('shapes', shapeType);

        const dropdown = item.closest('.dropdown-menu');
        if (dropdown) dropdown.classList.remove('show');
      });
    });

    // Digital Signature Modal Trigger
    const sigBtn = document.querySelector('#btn-tool-signature');
    if (sigBtn) {
      sigBtn.addEventListener('click', () => {
        if (window.sigPadController) {
          window.sigPadController.open();
        }
      });
    }

    // Insert Image Trigger
    const imgBtn = document.querySelector('#btn-tool-image');
    const imgInput = document.querySelector('#image-file-input');
    if (imgBtn && imgInput) {
      imgBtn.addEventListener('click', () => imgInput.click());
      imgInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.handleImageInsert(file);
      });
    }

    // Page navigation prev / next
    const prevBtn = document.querySelector('#btn-prev-page');
    const nextBtn = document.querySelector('#btn-next-page');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.currentPage > 0) this.switchActivePage(this.currentPage - 1);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.currentPage < this.pdfEngine.getPageCount() - 1) {
          this.switchActivePage(this.currentPage + 1);
        }
      });
    }

    if (this.pageNumInput) {
      this.pageNumInput.addEventListener('change', (e) => {
        const p = parseInt(e.target.value, 10) - 1;
        if (!isNaN(p)) this.switchActivePage(p);
      });
    }

    // Undo / Redo
    if (this.undoBtn) {
      this.undoBtn.addEventListener('click', () => this.annotationManager.undo());
    }
    if (this.redoBtn) {
      this.redoBtn.addEventListener('click', () => this.annotationManager.redo());
    }

    // Add Blank Page
    const addBlankBtns = document.querySelectorAll('[data-action="add-blank-page"]');
    addBlankBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const newIdx = this.pdfEngine.addBlankPage(this.currentPage);
        this.annotationManager.handlePageInserted(newIdx);
        this.isDirty = true;
        await this.renderDocument();
        await this.renderThumbnails();
        this.switchActivePage(newIdx);
        this.showToast('Blank page added', 'success');
      });
    });

    // Add Page from PDF (click & drag-and-drop around the button or between pages)
    const addPdfBtns = document.querySelectorAll('[data-action="add-pdf-page"]');
    const addPageWrappers = document.querySelectorAll('.add-page-wrapper');
    const pagesPanel = document.querySelector('#sidebar-panel-pages');
    const addPdfInput = document.querySelector('#input-add-pdf-page');

    if (addPdfInput) {
      addPdfBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          addPdfInput.value = '';
          addPdfInput.click();
        });
      });

      addPdfInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        await this.handleDroppedPdfFiles(files, null);
      });
    }

    // Drag and drop on/around the "Add Page from PDF" button (.add-page-wrapper and button itself)
    const bindAddPdfDropTarget = (targetEl) => {
      if (!targetEl) return;
      targetEl.addEventListener('dragenter', (e) => {
        if (!this.isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (this.thumbnailList) {
          this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
            c.classList.remove('drag-over-top', 'drag-over-bottom');
          });
        }
        this.setAddPdfButtonDragState(true);
      });

      targetEl.addEventListener('dragover', (e) => {
        if (!this.isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (this.thumbnailList) {
          this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
            c.classList.remove('drag-over-top', 'drag-over-bottom');
          });
        }
        this.setAddPdfButtonDragState(true);
      });

      targetEl.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && targetEl.contains(e.relatedTarget)) return;
        this.setAddPdfButtonDragState(false);
      });

      targetEl.addEventListener('drop', async (e) => {
        if (!this.isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.clearAllDragOverStates();
        const files = e.dataTransfer ? e.dataTransfer.files : [];
        await this.handleDroppedPdfFiles(files, null);
      });
    };

    addPageWrappers.forEach(w => bindAddPdfDropTarget(w));
    addPdfBtns.forEach(btn => bindAddPdfDropTarget(btn));

    // Drag and drop in the gaps between thumbnail cards inside .thumbnail-list
    if (this.thumbnailList) {
      this.thumbnailList.addEventListener('dragover', (e) => {
        if (!this.isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        this.setAddPdfButtonDragState(false);
        this.updateThumbnailDropIndicator(e.clientY);
      });

      this.thumbnailList.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && this.thumbnailList.contains(e.relatedTarget)) return;
        this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
          c.classList.remove('drag-over-top', 'drag-over-bottom');
        });
      });

      this.thumbnailList.addEventListener('drop', async (e) => {
        if (!this.isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const insertAfterIndex = this.getThumbnailDropInsertAfterIndex(e.clientY);
        this.clearAllDragOverStates();
        const files = e.dataTransfer ? e.dataTransfer.files : [];
        await this.handleDroppedPdfFiles(files, insertAfterIndex);
      });
    }

    // Drag and drop in the area around "Add Page from PDF" inside #sidebar-panel-pages
    if (pagesPanel) {
      pagesPanel.addEventListener('dragenter', (e) => {
        if (!this.isExternalFileDrag(e)) return;
        if (this.thumbnailList && this.thumbnailList.contains(e.target)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (this.thumbnailList) {
          this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
            c.classList.remove('drag-over-top', 'drag-over-bottom');
          });
        }
        this.setAddPdfButtonDragState(true);
      });

      pagesPanel.addEventListener('dragover', (e) => {
        if (!this.isExternalFileDrag(e)) return;
        if (this.thumbnailList && this.thumbnailList.contains(e.target)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (this.thumbnailList) {
          this.thumbnailList.querySelectorAll('.thumbnail-card').forEach(c => {
            c.classList.remove('drag-over-top', 'drag-over-bottom');
          });
        }
        this.setAddPdfButtonDragState(true);
      });

      pagesPanel.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && pagesPanel.contains(e.relatedTarget)) return;
        this.clearAllDragOverStates();
      });

      pagesPanel.addEventListener('drop', async (e) => {
        if (!this.isExternalFileDrag(e)) return;
        if (this.thumbnailList && this.thumbnailList.contains(e.target)) return;
        e.preventDefault();
        this.clearAllDragOverStates();
        const files = e.dataTransfer ? e.dataTransfer.files : [];
        await this.handleDroppedPdfFiles(files, null);
      });
    }

    // Shortcuts Modal
    const shortcutsBtn = document.querySelector('#btn-shortcuts');
    const shortcutsDialog = document.querySelector('#dialog-shortcuts');
    if (shortcutsBtn && shortcutsDialog) {
      shortcutsBtn.addEventListener('click', () => shortcutsDialog.showModal());
    }
  }

  // Handle Image File Insert
  handleImageInsert(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const img = new Image();
      img.onload = () => {
        const pageSize = this.pdfEngine.getPageSize(this.currentPage);
        let w = img.width;
        let h = img.height;

        // Scale down if huge
        const maxDim = Math.min(pageSize.width * 0.6, 300);
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }

        const x = Math.round((pageSize.width - w) / 2);
        const y = Math.round((pageSize.height - h) / 2);

        this.annotationManager.addAnnotation({
          pageIndex: this.currentPage,
          type: 'image',
          x,
          y,
          width: w,
          height: h,
          imgDataUrl: dataUrl,
        });

        this.canvasController.setTool('select');
        this.showToast('Image inserted', 'success');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  // Update Undo / Redo button states
  updateUndoRedoState() {
    if (this.undoBtn) {
      this.undoBtn.disabled = !this.annotationManager.canUndo();
    }
    if (this.redoBtn) {
      this.redoBtn.disabled = !this.annotationManager.canRedo();
    }
  }

  // Zoom Handling
  bindZoomEvents() {
    const zoomInBtn = document.querySelector('#btn-zoom-in');
    const zoomOutBtn = document.querySelector('#btn-zoom-out');
    const fitWidthBtn = document.querySelector('#btn-fit-width');
    const fitPageBtn = document.querySelector('#btn-fit-page');

    const updateZoom = (newZoom) => {
      this.zoom = Math.max(0.3, Math.min(3.0, Math.round(newZoom * 100) / 100));
      if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
      this.canvasController.setZoom(this.zoom);
      this.renderDocument();
    };

    if (zoomInBtn) zoomInBtn.addEventListener('click', () => updateZoom(this.zoom + 0.15));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => updateZoom(this.zoom - 0.15));

    if (fitWidthBtn) {
      fitWidthBtn.addEventListener('click', () => {
        this.fitToWidth();
      });
    }

    if (fitPageBtn) {
      fitPageBtn.addEventListener('click', () => {
        this.fitWholePage();
      });
    }
  }

  // Fit active view to width (accounting for 1, 2, or 3 columns in a row)
  async fitToWidth() {
    if (!this.pdfEngine || this.pdfEngine.getPageCount() === 0) return;
    const pageSize = this.pdfEngine.getPageSize(this.currentPage);
    const cols = this.layoutColumns || 1;
    const totalGap = (cols - 1) * 28;
    const viewportW = this.viewport.clientWidth - 64 - totalGap;
    const targetZoom = Math.max(0.3, Math.min(3.0, Math.round((viewportW / (pageSize.width * cols)) * 100) / 100));
    this.zoom = targetZoom;
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.canvasController.setZoom(this.zoom);
    await this.renderDocument();
  }

  // Fit active view to whole page (accounting for columns in a row)
  async fitWholePage() {
    if (!this.pdfEngine || this.pdfEngine.getPageCount() === 0) return;
    const pageSize = this.pdfEngine.getPageSize(this.currentPage);
    const cols = this.layoutColumns || 1;
    const totalGap = (cols - 1) * 28;
    const viewportW = this.viewport.clientWidth - 64 - totalGap;
    const viewportH = this.viewport.clientHeight - 80;
    const targetZoom = Math.max(0.3, Math.min(3.0, Math.round(Math.min(viewportW / (pageSize.width * cols), viewportH / pageSize.height) * 100) / 100));
    this.zoom = targetZoom;
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.canvasController.setZoom(this.zoom);
    await this.renderDocument();
  }

  // Page Layout (1, 2, or 3 pages in a row)
  async setLayoutColumns(cols, autoFit = false) {
    const validCols = Math.max(1, Math.min(3, parseInt(cols) || 1));
    this.layoutColumns = validCols;

    try {
      localStorage.setItem('pdfgod_layout_columns', String(validCols));
    } catch (e) {}

    if (this.docContainer) {
      this.docContainer.classList.remove('layout-cols-1', 'layout-cols-2', 'layout-cols-3');
      this.docContainer.classList.add(`layout-cols-${validCols}`);
    }

    // Update button text and icon
    const label = document.querySelector('#label-page-layout');
    if (label) {
      label.textContent = `${validCols} in a row`;
    }

    const iconSvg = document.querySelector('#icon-page-layout');
    if (iconSvg) {
      if (validCols === 1) {
        iconSvg.innerHTML = '<rect x="5" y="3" width="14" height="18" rx="2"/>';
      } else if (validCols === 2) {
        iconSvg.innerHTML = '<rect x="2" y="3" width="9" height="18" rx="1.5"/><rect x="13" y="3" width="9" height="18" rx="1.5"/>';
      } else {
        iconSvg.innerHTML = '<rect x="2" y="3" width="5.5" height="18" rx="1"/><rect x="9.25" y="3" width="5.5" height="18" rx="1"/><rect x="16.5" y="3" width="5.5" height="18" rx="1"/>';
      }
    }

    // Update active dropdown items and checkmarks
    for (let c = 1; c <= 3; c++) {
      const opt = document.querySelector(`#opt-layout-${c}`);
      if (opt) {
        opt.classList.toggle('active', c === validCols);
        const check = opt.querySelector('.layout-check');
        if (check) {
          check.style.display = (c === validCols) ? 'inline' : 'none';
        }
      }
    }

    if (autoFit && this.pdfEngine && this.pdfEngine.getPageCount() > 0) {
      await this.fitToWidth();
    } else {
      const activeWrapper = this.docContainer ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${this.currentPage}"]`) : null;
      if (activeWrapper) {
        activeWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  // Bind page layout dropdown events
  bindPageLayoutEvents() {
    for (let c = 1; c <= 3; c++) {
      const opt = document.querySelector(`#opt-layout-${c}`);
      if (opt) {
        opt.addEventListener('click', async () => {
          const menu = document.querySelector('#menu-page-layout');
          if (menu) menu.classList.remove('show');
          await this.setLayoutColumns(c, true);
        });
      }
    }

    // Keyboard shortcuts: Alt+1, Alt+2, Alt+3
    window.addEventListener('keydown', async (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.target.isContentEditable) return;

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === '1') {
          e.preventDefault();
          await this.setLayoutColumns(1, true);
        } else if (e.key === '2') {
          e.preventDefault();
          await this.setLayoutColumns(2, true);
        } else if (e.key === '3') {
          e.preventDefault();
          await this.setLayoutColumns(3, true);
        }
      }
    });
  }

  // File Existence Tracking for Save Confirmation
  checkFileExists(filename) {
    if (!filename) return false;
    const lower = filename.trim().toLowerCase();
    return this.existingFiles.has(lower);
  }

  markFileAsExisting(filename) {
    if (!filename) return;
    this.existingFiles.add(filename.trim().toLowerCase());
  }

  // Confirm replacement modal when file exists
  promptConfirmReplace(filename) {
    const dialog = document.querySelector('#dialog-confirm-replace');
    if (!dialog) {
      return Promise.resolve(window.confirm(`A file named "${filename}" already exists. Do you want to replace it?`));
    }

    const label = dialog.querySelector('#confirm-replace-filename');
    if (label) label.textContent = filename;

    return new Promise((resolve) => {
      let resolved = false;

      const confirmBtn = dialog.querySelector('#btn-confirm-replace');
      const cancelBtn = dialog.querySelector('#btn-cancel-replace');
      const cancelXBtn = dialog.querySelector('#btn-cancel-replace-x');

      const cleanup = () => {
        if (confirmBtn) confirmBtn.removeEventListener('click', onConfirm);
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
        if (cancelXBtn) cancelXBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
      };

      const onConfirm = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          dialog.close();
          resolve(true);
        }
      };

      const onCancel = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          dialog.close();
          resolve(false);
        }
      };

      if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      if (cancelXBtn) cancelXBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);

      dialog.showModal();
    });
  }

  // Save Document to file by name of file
  async saveDocument() {
    try {
      if (this.canvasController.activeTextEditor) {
        this.canvasController.commitTextEditor();
      }

      let filename = (this.docTitleInput ? this.docTitleInput.value.trim() : '') || this.pdfEngine.filename || 'document.pdf';
      if (!filename.toLowerCase().endsWith('.pdf')) {
        filename += '.pdf';
        if (this.docTitleInput) this.docTitleInput.value = filename;
      }
      this.pdfEngine.filename = filename;

      // Check if file already exists
      if (this.checkFileExists(filename)) {
        const shouldReplace = await this.promptConfirmReplace(filename);
        if (!shouldReplace) {
          // User clicked No: focus on the name so user can change name!
          if (this.docTitleInput) {
            this.docTitleInput.focus();
            this.docTitleInput.select();
          }
          this.showToast('Please change the file name in the header to save as a new file.', 'info', 3500);
          return { saved: false, reason: 'cancelled_by_user' };
        }
      }

      // User confirmed Yes (or file is new): proceed to save
      this.showToast('Saving PDF document...', 'info', 3000);
      const result = await this.pdfEngine.exportPDF(this.annotationManager, filename);
      this.markFileAsExisting(filename);
      this.isDirty = false;
      this.showToast(`Saved: ${result.filename}`, 'success');
      return { saved: true, filename: result.filename, bytes: result.bytes, size: result.size };
    } catch (err) {
      console.error('Save failed:', err);
      this.showToast('Error saving PDF: ' + err.message, 'error');
      return { saved: false, error: err.message };
    }
  }

  // Prompt for new filename in Save As dialog (or custom save/export dialog)
  promptSaveAsName(defaultName, options = {}) {
    const dialog = document.querySelector('#dialog-save-as');
    if (!dialog) {
      const prompted = window.prompt((options.title || 'Save As') + ' - Enter new file name:', defaultName);
      return Promise.resolve(prompted);
    }

    const input = dialog.querySelector('#input-save-as-name');
    if (input) {
      input.value = defaultName;
    }

    const titleSpan = dialog.querySelector('.modal-title span');
    const submitBtn = dialog.querySelector('#btn-confirm-save-as');
    const hintP = dialog.querySelector('.modal-body p');

    const origTitle = titleSpan ? titleSpan.textContent : '';
    const origSubmit = submitBtn ? submitBtn.textContent : '';
    const origHint = hintP ? hintP.textContent : '';

    if (options.title && titleSpan) titleSpan.textContent = options.title;
    if (options.buttonText && submitBtn) submitBtn.textContent = options.buttonText;
    if (options.hintText && hintP) hintP.textContent = options.hintText;

    return new Promise((resolve) => {
      let resolved = false;

      const form = dialog.querySelector('#form-save-as');
      const cancelBtn = dialog.querySelector('#btn-cancel-save-as');
      const cancelXBtn = dialog.querySelector('#btn-cancel-save-as-x');

      const cleanup = () => {
        if (form) form.removeEventListener('submit', onSubmit);
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
        if (cancelXBtn) cancelXBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        if (titleSpan) titleSpan.textContent = origTitle;
        if (submitBtn) submitBtn.textContent = origSubmit;
        if (hintP) hintP.textContent = origHint;
      };

      const onSubmit = (e) => {
        e.preventDefault();
        if (!resolved) {
          resolved = true;
          const val = input ? input.value.trim() : '';
          cleanup();
          dialog.close();
          resolve(val || null);
        }
      };

      const onCancel = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          dialog.close();
          resolve(null);
        }
      };

      if (form) form.addEventListener('submit', onSubmit);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      if (cancelXBtn) cancelXBtn.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);

      dialog.showModal();
      if (input) {
        input.focus();
        const dotIdx = input.value.lastIndexOf('.');
        if (dotIdx > 0) {
          input.setSelectionRange(0, dotIdx);
        } else {
          input.select();
        }
      }
    });
  }

  // Save As: Ask for a new name, update the name field accordingly, and save
  async saveAsDocument() {
    try {
      if (this.canvasController.activeTextEditor) {
        this.canvasController.commitTextEditor();
      }

      const currentName = (this.docTitleInput ? this.docTitleInput.value.trim() : '') || this.pdfEngine.filename || 'document.pdf';
      const chosenName = await this.promptSaveAsName(currentName);
      if (!chosenName) {
        return { saved: false, reason: 'cancelled_by_user' };
      }

      let newFilename = chosenName.trim();
      if (!newFilename.toLowerCase().endsWith('.pdf')) {
        newFilename += '.pdf';
      }

      // Update name field in header accordingly
      if (this.docTitleInput) {
        this.docTitleInput.value = newFilename;
      }
      this.pdfEngine.filename = newFilename;

      // If file already exists, ask user if they want to replace it
      if (this.checkFileExists(newFilename)) {
        const shouldReplace = await this.promptConfirmReplace(newFilename);
        if (!shouldReplace) {
          if (this.docTitleInput) {
            this.docTitleInput.focus();
            this.docTitleInput.select();
          }
          this.showToast('Please change the file name in the header to save as a new file.', 'info', 3500);
          return { saved: false, reason: 'cancelled_by_user' };
        }
      }

      // Proceed to save
      this.showToast('Saving PDF document...', 'info', 3000);
      const result = await this.pdfEngine.exportPDF(this.annotationManager, newFilename);
      this.markFileAsExisting(newFilename);
      this.isDirty = false;
      this.showToast(`Saved as: ${result.filename}`, 'success');
      return { saved: true, filename: result.filename, bytes: result.bytes, size: result.size };
    } catch (err) {
      console.error('Save As failed:', err);
      this.showToast('Error saving PDF: ' + err.message, 'error');
      return { saved: false, error: err.message };
    }
  }

  // Export to Excel (.xlsx)
  async exportToExcel(customFilename = null) {
    try {
      if (this.canvasController && this.canvasController.activeTextEditor) {
        this.canvasController.commitTextEditor();
      }

      let baseName = (this.docTitleInput ? this.docTitleInput.value.trim() : '') || (this.pdfEngine ? this.pdfEngine.filename : '') || 'document';
      baseName = baseName.replace(/\.pdf$/i, '').replace(/\.xlsx$/i, '');
      const defaultExcelName = `${baseName}.xlsx`;

      let targetFilename = customFilename;
      let fileHandle = null;

      // When customFilename is not explicitly provided, always ask for filename!
      if (!targetFilename) {
        // Preferred: Native OS Save Dialog (showSaveFilePicker)
        // Prompts with defaultExcelName, lets user choose location & filename,
        // and directly overwrites/replaces the file on disk if it already exists!
        const canUseFilePicker = typeof window.showSaveFilePicker === 'function' && !navigator.webdriver;
        if (canUseFilePicker) {
          try {
            fileHandle = await window.showSaveFilePicker({
              suggestedName: defaultExcelName,
              types: [
                {
                  description: 'Excel Workbook (*.xlsx)',
                  accept: {
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                  },
                },
              ],
            });
            targetFilename = fileHandle.name;
          } catch (pickerErr) {
            if (pickerErr && pickerErr.name === 'AbortError') {
              // User pressed Cancel in the native OS dialog
              return { exported: false, reason: 'cancelled_by_user' };
            }
            console.warn('showSaveFilePicker failed or was not allowed, falling back to in-app dialog:', pickerErr);
          }
        }

        // Fallback: If showSaveFilePicker is not supported or was blocked
        if (!targetFilename && !fileHandle) {
          const chosenName = await this.promptSaveAsName(defaultExcelName, {
            title: 'Export to Excel',
            buttonText: 'Export',
            hintText: 'If a file with this name already exists, it will be replaced.',
          });
          if (!chosenName) {
            return { exported: false, reason: 'cancelled_by_user' };
          }
          targetFilename = chosenName.trim();
        }
      }

      if (!targetFilename.toLowerCase().endsWith('.xlsx')) {
        targetFilename += '.xlsx';
      }

      this.showToast('Exporting to Excel...', 'info');
      const exporter = (typeof ExcelExporter !== 'undefined') ? new ExcelExporter() : (window.ExcelExporter ? new window.ExcelExporter() : null);
      if (!exporter) {
        throw new Error('ExcelExporter module not found');
      }

      const result = await exporter.exportWorkbook(this.pdfEngine, this.annotationManager, targetFilename, {
        fileHandle,
      });

      this.markFileAsExisting(targetFilename);
      this.showToast(`Excel exported: ${result.filename}`, 'success');
      return result;
    } catch (err) {
      console.error('Export to Excel failed:', err);
      this.showToast('Error exporting to Excel: ' + err.message, 'error');
      return { exported: false, error: err.message };
    }
  }

  // Save & Export Events
  bindExportEvents() {
    const exportPdfBtn = document.querySelector('#btn-export-pdf');
    const saveAsBtn = document.querySelector('#btn-save-as');
    const exportPngBtn = document.querySelector('#btn-export-png');
    const exportExcelBtn = document.querySelector('#btn-export-excel');
    const printBtn = document.querySelector('#btn-print-doc');

    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', async () => {
        await this.saveDocument();
      });
    }

    if (saveAsBtn) {
      saveAsBtn.addEventListener('click', async () => {
        const dropdown = saveAsBtn.closest('.dropdown-menu');
        if (dropdown) dropdown.classList.remove('show');
        await this.saveAsDocument();
      });
    }

    if (exportPngBtn) {
      exportPngBtn.addEventListener('click', async () => {
        try {
          this.showToast('Exporting page image...', 'info');
          await this.pdfEngine.exportPageAsImage(this.currentPage, this.annotationManager);
          this.showToast('Image downloaded!', 'success');
        } catch (err) {
          console.error('Export image failed:', err);
          this.showToast('Error exporting image', 'error');
        }
      });
    }

    if (exportExcelBtn) {
      exportExcelBtn.addEventListener('click', async () => {
        const dropdown = exportExcelBtn.closest('.dropdown-menu');
        if (dropdown) dropdown.classList.remove('show');
        await this.exportToExcel();
      });
    }

    if (printBtn) {
      printBtn.addEventListener('click', () => window.print());
    }
  }

  // Sidebar Tabs & Toggle
  bindSidebarEvents() {
    const toggleBtn = document.querySelector('#btn-toggle-sidebar');
    if (toggleBtn && this.sidebar) {
      toggleBtn.addEventListener('click', () => {
        this.isSidebarCollapsed = !this.isSidebarCollapsed;
        this.sidebar.classList.toggle('collapsed', this.isSidebarCollapsed);
      });
    }

    const tabBtns = document.querySelectorAll('.sidebar-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tab = btn.dataset.tab;
        const pagesPanel = document.querySelector('#sidebar-panel-pages');
        const annPanel = document.querySelector('#sidebar-panel-annotations');

        if (tab === 'pages') {
          if (pagesPanel) pagesPanel.style.display = 'block';
          if (annPanel) annPanel.style.display = 'none';
        } else {
          if (pagesPanel) pagesPanel.style.display = 'none';
          if (annPanel) annPanel.style.display = 'block';
          this.renderAnnotationsList();
        }
      });
    });
  }

  // Render Annotations List Tab
  renderAnnotationsList() {
    if (!this.annotationsList) return;
    this.annotationsList.innerHTML = '';

    const allAnnotations = this.annotationManager.annotations;
    if (allAnnotations.length === 0) {
      this.annotationsList.innerHTML = `
        <div class="empty-annotations-state">
          No annotations yet.<br>Add text, drawings, shapes or signatures to see them here.
        </div>
      `;
      return;
    }

    allAnnotations.forEach(ann => {
      const item = document.createElement('div');
      item.className = `annotation-item ${this.annotationManager.selectedAnnotationId === ann.id ? 'active' : ''}`;
      item.innerHTML = `
        <div class="annotation-item-left">
          <div class="annotation-item-icon">
            ${this.getAnnotationIcon(ann.type)}
          </div>
          <div class="annotation-item-info">
            <span class="annotation-item-title">${this.getAnnotationTitle(ann)}</span>
            <span class="annotation-item-sub">Page ${ann.pageIndex + 1}</span>
          </div>
        </div>
        <button class="thumb-action-btn btn-delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      `;

      item.addEventListener('click', (e) => {
        if (!e.target.closest('.btn-delete')) {
          this.switchActivePage(ann.pageIndex);
          this.annotationManager.selectAnnotation(ann.id);
        }
      });

      item.querySelector('.btn-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this.annotationManager.deleteAnnotation(ann.id);
      });

      this.annotationsList.appendChild(item);
    });
  }

  getAnnotationIcon(type) {
    if (type === 'text') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
    if (type === 'signature') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l4 4L21 7"/></svg>';
    if (type === 'image') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    if (type === 'freehand') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>';
    if (type === 'highlighter') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l7 7-9 9-7-7 9-9z"/></svg>';
    if (type === 'whiteout' || type === 'blackout') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="1"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
  }

  getAnnotationTitle(ann) {
    if (ann.type === 'text') return ann.text ? (ann.text.substring(0, 24) + (ann.text.length > 24 ? '...' : '')) : 'Text Box';
    if (ann.type === 'signature') return 'Digital Signature';
    if (ann.type === 'image') return 'Inserted Image';
    if (ann.type === 'freehand') return 'Pen Drawing';
    if (ann.type === 'highlighter') return 'Highlight';
    if (ann.type === 'whiteout') return 'Whiteout';
    if (ann.type === 'blackout') return 'Blackout Redaction';
    if (ann.type === 'checkmark') return 'Checkmark ✓';
    if (ann.type === 'cross') return 'Cross ✗';
    return (ann.type.charAt(0).toUpperCase() + ann.type.slice(1));
  }

  // Properties Bar Management
  bindPropertiesBar() {
    if (!this.propBar) return;
    this.updatePropertiesBarForTool('select');
  }

  // Update properties bar based on active tool
  updatePropertiesBarForTool(tool, subtype = null) {
    if (!this.propBar) return;

    if (tool === 'edit-pdf-text') {
      this.propBar.innerHTML = `
        <span style="color: #60a5fa; font-weight: 500; font-size: 0.85rem; display: flex; align-items: center; gap: 8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <strong>Select text:</strong> Click any word or line in the PDF to replace it with new text.
        </span>
      `;
      return;
    }

    if (tool === 'text' || (this.annotationManager.getSelectedAnnotation() && this.annotationManager.getSelectedAnnotation().type === 'text')) {
      const selected = this.annotationManager.getSelectedAnnotation();
      const allSelectedTexts = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      const activeBatchGroupId = (selected && selected.batchGroupId) || (allSelectedTexts.find(a => a.batchGroupId)?.batchGroupId);
      const canRevertGroup = !!(activeBatchGroupId && this.batchGroups && this.batchGroups.has(activeBatchGroupId));

      const currentFamily = selected ? (selected.fontFamily || 'Helvetica') : this.canvasController.toolSettings.fontFamily;
      const currentSize = selected ? (selected.fontSize || 14) : this.canvasController.toolSettings.fontSize;
      const currentColor = selected ? (selected.fontColor || '#000000') : this.canvasController.toolSettings.fontColor;
      const isBold = selected ? (selected.fontWeight === 'bold') : (this.canvasController.toolSettings.fontWeight === 'bold');
      const isItalic = selected ? (selected.fontStyle === 'italic') : (this.canvasController.toolSettings.fontStyle === 'italic');

      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">Font</span>
          <select class="prop-select" id="prop-font-family">
            <option value="Helvetica" ${currentFamily === 'Helvetica' ? 'selected' : ''}>Helvetica</option>
            <option value="Arial" ${currentFamily === 'Arial' ? 'selected' : ''}>Arial</option>
            <option value="Times New Roman" ${currentFamily === 'Times New Roman' ? 'selected' : ''}>Times Roman</option>
            <option value="Courier New" ${currentFamily === 'Courier New' ? 'selected' : ''}>Courier</option>
            <option value="Georgia" ${currentFamily === 'Georgia' ? 'selected' : ''}>Georgia</option>
            <option value="Sarabun" ${currentFamily === 'Sarabun' ? 'selected' : ''}>Sarabun</option>
          </select>
        </div>
        <div class="prop-group">
          <span class="prop-label">Size</span>
          <input type="number" class="prop-input-number" id="prop-font-size" value="${currentSize}" min="8" max="72">
        </div>
        <div class="prop-group">
          <span class="prop-label">Color</span>
          <div class="color-picker-wrapper">
            ${['#000000', '#1e293b', '#3b82f6', '#ef4444', '#10b981'].map(c => `
              <button class="color-swatch-btn ${currentColor === c ? 'active' : ''}" style="background-color: ${c}" data-color="${c}"></button>
            `).join('')}
            <input type="color" class="custom-color-input" id="prop-custom-text-color" value="${currentColor}">
          </div>
        </div>
        <div class="prop-group">
          <button class="prop-toggle-btn ${isBold ? 'active' : ''}" id="prop-bold-btn" title="Bold">B</button>
          <button class="prop-toggle-btn ${isItalic ? 'active' : ''}" id="prop-italic-btn" title="Italic"><i>I</i></button>
          <button class="prop-toggle-btn" id="prop-center-page-btn" title="Center text in the middle of the page (using actual text width)" style="gap: 5px; padding: 0 10px;" ${selected ? '' : 'disabled'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
              <line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>
              <rect x="6" y="7" width="12" height="4" rx="1"/>
              <rect x="4" y="13" width="16" height="4" rx="1"/>
            </svg>
            Center on Page
          </button>
          <button class="prop-toggle-btn" id="prop-match-pages-btn" title="Find matching text blocks across all pages, highlight them, and edit as a group" style="gap: 5px; padding: 0 10px;" ${selected ? '' : 'disabled'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
              <rect x="3" y="3" width="7" height="7" rx="1"/>
              <rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="14" y="14" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/>
            </svg>
            Match Across Pages
          </button>
          <button class="prop-toggle-btn" id="prop-thai-date-btn" title="Insert Thai Buddhist Era Date (พ.ศ.)" style="gap: 4px; padding: 0 8px;">
            <span>📅 พ.ศ.</span>
          </button>
          ${canRevertGroup ? `
          <button class="prop-toggle-btn" id="prop-edit-group-btn" title="Re-open Batch Group Editor to adjust text or line positions across all pages" style="gap: 5px; padding: 0 10px; color: #60a5fa; border-color: rgba(59, 130, 246, 0.4);">
            Edit Group
          </button>
          <button class="prop-toggle-btn" id="prop-revert-group-btn" title="Revert this batch group across all pages back to original PDF text" style="gap: 5px; padding: 0 10px; color: #fca5a5; border-color: rgba(239, 68, 68, 0.4);">
            Revert Group
          </button>
          ` : ''}
        </div>
      `;

      const applyTextUpdate = (patch) => {
        Object.assign(this.canvasController.toolSettings, patch);
        const selList = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
        if (selList.length > 0) {
          selList.forEach(a => this.annotationManager.updateAnnotation(a.id, patch));
        }
      };

      // Event bindings
      this.propBar.querySelector('#prop-font-family').addEventListener('change', (e) => {
        applyTextUpdate({ fontFamily: e.target.value });
      });
      this.propBar.querySelector('#prop-font-size').addEventListener('change', (e) => {
        applyTextUpdate({ fontSize: parseInt(e.target.value, 10) || 14 });
      });
      this.propBar.querySelectorAll('.color-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.propBar.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          applyTextUpdate({ fontColor: btn.dataset.color });
        });
      });
      this.propBar.querySelector('#prop-custom-text-color').addEventListener('change', (e) => {
        this.propBar.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('active'));
        applyTextUpdate({ fontColor: e.target.value });
      });

      let currentBold = isBold;
      const boldBtn = this.propBar.querySelector('#prop-bold-btn');
      boldBtn.addEventListener('click', () => {
        currentBold = !currentBold;
        boldBtn.classList.toggle('active', currentBold);
        applyTextUpdate({ fontWeight: currentBold ? 'bold' : 'normal' });
      });

      let currentItalic = isItalic;
      const italicBtn = this.propBar.querySelector('#prop-italic-btn');
      italicBtn.addEventListener('click', () => {
        currentItalic = !currentItalic;
        italicBtn.classList.toggle('active', currentItalic);
        applyTextUpdate({ fontStyle: currentItalic ? 'italic' : 'normal' });
      });

      const centerPageBtn = this.propBar.querySelector('#prop-center-page-btn');
      if (centerPageBtn) {
        centerPageBtn.addEventListener('click', () => {
          this.canvasController.centerSelectedTextOnPage();
        });
      }

      const matchPagesBtn = this.propBar.querySelector('#prop-match-pages-btn');
      if (matchPagesBtn) {
        matchPagesBtn.addEventListener('click', () => {
          this.openBatchGroupEditor();
        });
      }

      const thaiDateBtn = this.propBar.querySelector('#prop-thai-date-btn');
      if (thaiDateBtn) {
        thaiDateBtn.addEventListener('click', () => {
          const dateStr = (window.ThaiSupport && window.ThaiSupport.formatThaiBuddhistDate)
            ? window.ThaiSupport.formatThaiBuddhistDate(new Date())
            : '20 ต.ค. 2569';
          const selList = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
          if (selList.length === 1) {
            const singleAnn = selList[0];
            if (!singleAnn.text || singleAnn.text.trim().length === 0) {
              this.annotationManager.updateAnnotation(singleAnn.id, {
                text: dateStr,
                fontFamily: 'Sarabun'
              });
              const el = this.canvasController.container ? this.canvasController.container.querySelector(`.pdf-text-element[data-id="${singleAnn.id}"] .pdf-text-content`) : null;
              if (el) {
                el.value = dateStr;
                el.style.fontFamily = 'Sarabun';
              }
              this.canvasController.render();
              return;
            } else {
              const targetX = singleAnn.x;
              const targetY = singleAnn.y + (singleAnn.height || 20) + 10;
              if (this.canvasController.activePageIndex !== this.currentPage) {
                this.canvasController.activePageIndex = this.currentPage;
              }
              this.canvasController.createTextAnnotationAt(targetX, targetY, dateStr, {
                fontFamily: 'Sarabun',
                fontSize: singleAnn.fontSize || 14
              });
              return;
            }
          }
          if (this.canvasController.activePageIndex !== this.currentPage) {
            this.canvasController.activePageIndex = this.currentPage;
          }
          this.canvasController.createTextAnnotationAt(100, 100, dateStr, {
            fontFamily: 'Sarabun',
            fontSize: 14
          });
        });
      }

      const editGroupBtn = this.propBar.querySelector('#prop-edit-group-btn');
      if (editGroupBtn && activeBatchGroupId) {
        editGroupBtn.addEventListener('click', () => {
          this.reopenBatchGroupEditor(activeBatchGroupId);
        });
      }

      const revertGroupBtn = this.propBar.querySelector('#prop-revert-group-btn');
      if (revertGroupBtn && activeBatchGroupId) {
        revertGroupBtn.addEventListener('click', () => {
          this.revertBatchGroup(activeBatchGroupId);
        });
      }
    }

    else if (tool === 'draw') {
      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">Ink Color</span>
          <div class="color-picker-wrapper">
            ${['#0f172a', '#2563eb', '#dc2626', '#16a34a', '#9333ea'].map(c => `
              <button class="color-swatch-btn ${this.canvasController.toolSettings.strokeColor === c ? 'active' : ''}" style="background-color: ${c}" data-color="${c}"></button>
            `).join('')}
            <input type="color" class="custom-color-input" id="prop-custom-draw-color" value="${this.canvasController.toolSettings.strokeColor}">
          </div>
        </div>
        <div class="prop-group">
          <span class="prop-label">Thickness</span>
          <input type="range" class="prop-slider" id="prop-draw-thickness" min="1" max="16" value="${this.canvasController.toolSettings.strokeWidth}">
          <span>${this.canvasController.toolSettings.strokeWidth}px</span>
        </div>
      `;

      this.propBar.querySelectorAll('.color-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.canvasController.toolSettings.strokeColor = btn.dataset.color;
          this.updatePropertiesBarForTool('draw');
        });
      });
      this.propBar.querySelector('#prop-custom-draw-color').addEventListener('change', (e) => {
        this.canvasController.toolSettings.strokeColor = e.target.value;
        this.updatePropertiesBarForTool('draw');
      });
      this.propBar.querySelector('#prop-draw-thickness').addEventListener('input', (e) => {
        this.canvasController.toolSettings.strokeWidth = parseInt(e.target.value, 10);
        this.updatePropertiesBarForTool('draw');
      });
    }

    else if (tool === 'highlighter') {
      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">Highlight Color</span>
          <div class="color-picker-wrapper">
            ${['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'].map(c => `
              <button class="color-swatch-btn ${this.canvasController.toolSettings.highlighterColor === c ? 'active' : ''}" style="background-color: ${c}" data-color="${c}"></button>
            `).join('')}
          </div>
        </div>
        <div class="prop-group">
          <span class="prop-label">Opacity</span>
          <input type="range" class="prop-slider" id="prop-highlighter-opacity" min="0.1" max="0.9" step="0.05" value="${this.canvasController.toolSettings.highlighterOpacity}">
          <span>${Math.round(this.canvasController.toolSettings.highlighterOpacity * 100)}%</span>
        </div>
      `;

      this.propBar.querySelectorAll('.color-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.canvasController.toolSettings.highlighterColor = btn.dataset.color;
          this.updatePropertiesBarForTool('highlighter');
        });
      });
      this.propBar.querySelector('#prop-highlighter-opacity').addEventListener('input', (e) => {
        this.canvasController.toolSettings.highlighterOpacity = parseFloat(e.target.value);
        this.updatePropertiesBarForTool('highlighter');
      });
    }

    else if (tool === 'shapes') {
      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">Border</span>
          <div class="color-picker-wrapper">
            ${['#3b82f6', '#ef4444', '#10b981', '#0f172a'].map(c => `
              <button class="color-swatch-btn ${this.canvasController.toolSettings.strokeColor === c ? 'active' : ''}" style="background-color: ${c}" data-color="${c}"></button>
            `).join('')}
            <input type="color" class="custom-color-input" id="prop-custom-shape-color" value="${this.canvasController.toolSettings.strokeColor}">
          </div>
        </div>
        <div class="prop-group">
          <span class="prop-label">Fill</span>
          <select class="prop-select" id="prop-shape-fill">
            <option value="transparent" ${this.canvasController.toolSettings.fillColor === 'transparent' ? 'selected' : ''}>Transparent</option>
            <option value="#ffffff" ${this.canvasController.toolSettings.fillColor === '#ffffff' ? 'selected' : ''}>White</option>
            <option value="#dbeafe" ${this.canvasController.toolSettings.fillColor === '#dbeafe' ? 'selected' : ''}>Light Blue</option>
            <option value="#fee2e2" ${this.canvasController.toolSettings.fillColor === '#fee2e2' ? 'selected' : ''}>Light Red</option>
            <option value="#dcfce7" ${this.canvasController.toolSettings.fillColor === '#dcfce7' ? 'selected' : ''}>Light Green</option>
          </select>
        </div>
        <div class="prop-group">
          <span class="prop-label">Thickness</span>
          <input type="range" class="prop-slider" id="prop-shape-thickness" min="1" max="10" value="${this.canvasController.toolSettings.strokeWidth}">
          <span>${this.canvasController.toolSettings.strokeWidth}px</span>
        </div>
      `;

      this.propBar.querySelectorAll('.color-swatch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.canvasController.toolSettings.strokeColor = btn.dataset.color;
          this.updatePropertiesBarForTool('shapes', subtype);
        });
      });
      this.propBar.querySelector('#prop-shape-fill').addEventListener('change', (e) => {
        this.canvasController.toolSettings.fillColor = e.target.value;
      });
      this.propBar.querySelector('#prop-shape-thickness').addEventListener('input', (e) => {
        this.canvasController.toolSettings.strokeWidth = parseInt(e.target.value, 10);
        this.updatePropertiesBarForTool('shapes', subtype);
      });
    }

    else {
      // Default hint bar
      this.propBar.innerHTML = `
        <span style="color: var(--text-muted); font-size: 0.8rem;">
          Click any element to move or resize it, or choose a tool above to start annotating.
        </span>
      `;
    }
  }

  // Convenience method to refresh properties bar based on current selection or active tool
  updatePropertiesBar() {
    if (!this.propBar) return;
    const sel = this.annotationManager ? this.annotationManager.getSelectedAnnotations() : [];
    if (sel.length === 1) {
      this.updatePropertiesBarForSelection(sel[0]);
    } else {
      this.updatePropertiesBarForTool(this.canvasController ? this.canvasController.activeTool : 'select');
    }
  }

  // Update properties bar when an element is selected
  updatePropertiesBarForSelection(selected) {
    if (!this.propBar) return;
    if (!selected) {
      this.updatePropertiesBarForTool(this.canvasController.activeTool);
      return;
    }

    if (selected.type === 'text') {
      this.updatePropertiesBarForTool('text');
      return;
    }

    else if (selected.type === 'image' || selected.type === 'signature') {
      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">${selected.type === 'signature' ? 'Signature' : 'Image'}</span>
          <span class="prop-label">Opacity</span>
          <input type="range" class="prop-slider" id="sel-opacity" min="0.1" max="1.0" step="0.05" value="${selected.opacity !== undefined ? selected.opacity : 1.0}">
        </div>
        <div class="prop-group" style="margin-left: auto;">
          <button class="btn btn-secondary" id="sel-front-btn">Bring Forward</button>
          <button class="btn btn-secondary" id="sel-dup-btn">Duplicate</button>
          <button class="btn btn-danger-ghost" id="sel-del-btn">Delete</button>
        </div>
      `;

      this.propBar.querySelector('#sel-opacity').addEventListener('input', (e) => {
        this.annotationManager.updateAnnotation(selected.id, { opacity: parseFloat(e.target.value) }, false);
      });
      this.propBar.querySelector('#sel-front-btn').addEventListener('click', () => {
        this.annotationManager.bringToFront(selected.id);
      });
      this.propBar.querySelector('#sel-dup-btn').addEventListener('click', () => {
        this.annotationManager.duplicateAnnotation(selected.id);
      });
      this.propBar.querySelector('#sel-del-btn').addEventListener('click', () => {
        this.annotationManager.deleteAnnotation(selected.id);
      });
    }

    else {
      this.propBar.innerHTML = `
        <div class="prop-group">
          <span class="prop-label">Selected: ${selected.type}</span>
        </div>
        <div class="prop-group" style="margin-left: auto;">
          <button class="btn btn-secondary" id="sel-dup-btn">Duplicate</button>
          <button class="btn btn-danger-ghost" id="sel-del-btn">Delete</button>
        </div>
      `;

      this.propBar.querySelector('#sel-dup-btn').addEventListener('click', () => {
        this.annotationManager.duplicateAnnotation(selected.id);
      });
      this.propBar.querySelector('#sel-del-btn').addEventListener('click', () => {
        this.annotationManager.deleteAnnotation(selected.id);
      });
    }
  }

  // --- Batch Group Editor & Spatial Pattern Matching ---

  bindBatchGroupWidgetEvents() {
    const widget = document.getElementById('batch-group-widget');
    if (!widget) return;

    const closeBtn = document.getElementById('btn-batch-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeBatchGroupEditor());

    const cancelBtn = document.getElementById('btn-batch-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeBatchGroupEditor());

    const applyBtn = document.getElementById('btn-batch-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => this.applyBatchGroupEdit());

    const revertBtn = document.getElementById('btn-batch-revert');
    if (revertBtn) {
      revertBtn.addEventListener('click', () => {
        const gid = this.activeBatchState?.existingBatchGroupId;
        if (gid) this.revertBatchGroup(gid);
      });
    }

    const addLineBtn = document.getElementById('btn-batch-add-line');
    if (addLineBtn) {
      addLineBtn.addEventListener('click', () => {
        if (!this.activeBatchState) return;
        const lines = this.activeBatchState.lines || [];
        const fontSize = parseInt(document.getElementById('batch-font-size')?.value, 10) || 14;
        let newDy = 0;
        if (lines.length >= 2) {
          const step = (lines[lines.length - 1].dy - lines[lines.length - 2].dy) || Math.round(fontSize * 1.2);
          newDy = lines[lines.length - 1].dy + step;
        } else if (lines.length === 1) {
          newDy = lines[0].dy + Math.round(fontSize * 1.2);
        }
        lines.push({
          idx: lines.length,
          text: '',
          currentText: '',
          originalText: '',
          dx: 0,
          dy: newDy,
          fontFamily: document.getElementById('batch-font-family')?.value || 'Helvetica',
          fontSize,
          fontWeight: document.getElementById('batch-bold-btn')?.classList.contains('active') ? 'bold' : 'normal',
          fontStyle: document.getElementById('batch-italic-btn')?.classList.contains('active') ? 'italic' : 'normal',
          fontColor: document.getElementById('batch-font-color')?.value || '#000000',
        });
        this.renderBatchLinesEditor();
        this.renderBatchPreviewStage();
        this.renderBatchMatchHighlights();
      });
    }

    // Per-line or multi-line styling toolbar controls
    const fontFamilySelect = document.getElementById('batch-font-family');
    if (fontFamilySelect) {
      fontFamilySelect.addEventListener('change', (e) => {
        this.updateActiveLinesStyle({ fontFamily: e.target.value });
      });
    }

    const fontSizeInput = document.getElementById('batch-font-size');
    if (fontSizeInput) {
      fontSizeInput.addEventListener('input', (e) => {
        this.updateActiveLinesStyle({ fontSize: parseInt(e.target.value, 10) || 14 });
      });
    }

    const boldBtn = document.getElementById('batch-bold-btn');
    if (boldBtn) {
      boldBtn.addEventListener('click', () => {
        const isBold = !boldBtn.classList.contains('active');
        boldBtn.classList.toggle('active', isBold);
        this.updateActiveLinesStyle({ fontWeight: isBold ? 'bold' : 'normal' });
      });
    }

    const italicBtn = document.getElementById('batch-italic-btn');
    if (italicBtn) {
      italicBtn.addEventListener('click', () => {
        const isItalic = !italicBtn.classList.contains('active');
        italicBtn.classList.toggle('active', isItalic);
        this.updateActiveLinesStyle({ fontStyle: isItalic ? 'italic' : 'normal' });
      });
    }

    const fontColorInput = document.getElementById('batch-font-color');
    if (fontColorInput) {
      fontColorInput.addEventListener('input', (e) => {
        this.updateActiveLinesStyle({ fontColor: e.target.value });
      });
      fontColorInput.addEventListener('change', (e) => {
        this.updateActiveLinesStyle({ fontColor: e.target.value });
      });
    }

    // Snap helper buttons
    const snapCenterBtn = document.getElementById('btn-batch-snap-center');
    if (snapCenterBtn) snapCenterBtn.addEventListener('click', () => this.snapBatchCenter());

    const snapLeftBtn = document.getElementById('btn-batch-snap-left');
    if (snapLeftBtn) snapLeftBtn.addEventListener('click', () => this.snapBatchLeft());

    const snapDistributeBtn = document.getElementById('btn-batch-snap-distribute');
    if (snapDistributeBtn) snapDistributeBtn.addEventListener('click', () => this.snapBatchDistribute());

    const selectAllLinesBtn = document.getElementById('btn-batch-select-all-lines');
    if (selectAllLinesBtn) {
      selectAllLinesBtn.addEventListener('click', () => {
        if (!this.activeBatchState || !this.activeBatchState.lines) return;
        this.activeBatchState.selectedLineIndices = new Set(this.activeBatchState.lines.map((_, i) => i));
        this.renderBatchPreviewStage();
        this.updateBatchCoordsLabel();
      });
    }

    const alignSelect = document.getElementById('batch-align-select');
    if (alignSelect) {
      alignSelect.addEventListener('change', (e) => {
        if (e.target.value === 'center-page') {
          this.snapBatchCenter();
        } else if (e.target.value === 'left') {
          this.snapBatchLeft();
        } else {
          this.renderBatchPreviewStage();
          this.renderBatchMatchHighlights();
          this.updateBatchCoordsLabel();
        }
      });
    }

    const batchPreviewStage = document.getElementById('batch-preview-stage');
    if (batchPreviewStage) {
      batchPreviewStage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.batch-preview-item')) return;
        if (!this.activeBatchState || !this.activeBatchState.selectedLineIndices) return;
        this.activeBatchState.selectedLineIndices.clear();
        batchPreviewStage.querySelectorAll('.batch-preview-item').forEach(it => it.classList.remove('selected'));
        this.updateBatchCoordsLabel();
      });
    }

    // Snippets storage
    const saveSnippetBtn = document.getElementById('btn-batch-save-snippet');
    if (saveSnippetBtn) {
      saveSnippetBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('batch-snippet-name');
        const name = (nameInput?.value || '').trim() || `Snippet ${this.getSavedSnippets().length + 1}`;
        const domFamily = document.getElementById('batch-font-family')?.value || 'Helvetica';
        const domSize = parseFloat(document.getElementById('batch-font-size')?.value) || 14;
        const domBold = document.getElementById('batch-bold-btn')?.classList.contains('active') ? 'bold' : 'normal';
        const domItalic = document.getElementById('batch-italic-btn')?.classList.contains('active') ? 'italic' : 'normal';
        const domColor = document.getElementById('batch-font-color')?.value || '#000000';
        const domAlign = document.getElementById('batch-align-select')?.value || 'keep';

        const lines = this.activeBatchState ? this.activeBatchState.lines : [];
        const baseDx = lines[0] ? (lines[0].dx || 0) : 0;
        const baseDy = lines[0] ? (lines[0].dy || 0) : 0;
        const selIndices = this.activeBatchState?.selectedLineIndices || new Set();

        const savedLines = lines.map((l, i) => {
          const isSelected = selIndices.has(i);
          return {
            text: l.currentText !== undefined ? l.currentText : (l.text || ''),
            dx: +(((l.dx || 0) - baseDx).toFixed(2)),
            dy: +(((l.dy || 0) - baseDy).toFixed(2)),
            fontFamily: isSelected ? domFamily : (l.fontFamily || domFamily),
            fontSize: isSelected ? domSize : (l.fontSize || domSize),
            fontWeight: isSelected ? domBold : (l.fontWeight || domBold),
            fontStyle: isSelected ? domItalic : (l.fontStyle || domItalic),
            fontColor: isSelected ? domColor : (l.fontColor || domColor),
          };
        });

        const snippet = {
          id: 'snip_' + Date.now().toString(36),
          name,
          lines: savedLines,
          fontFamily: savedLines[0]?.fontFamily || domFamily,
          fontSize: savedLines[0]?.fontSize || domSize,
          fontWeight: savedLines[0]?.fontWeight || domBold,
          fontStyle: savedLines[0]?.fontStyle || domItalic,
          fontColor: savedLines[0]?.fontColor || domColor,
          alignment: domAlign,
        };
        this.saveSnippet(snippet);
        if (nameInput) nameInput.value = '';
        this.showToast(`Snippet "${name}" saved`, 'success');
      });
    }

    const loadSnippetBtn = document.getElementById('btn-batch-load-snippet');
    if (loadSnippetBtn) {
      loadSnippetBtn.addEventListener('click', () => {
        const select = document.getElementById('batch-snippet-select');
        const id = select?.value;
        if (!id) return;
        const snippets = this.getSavedSnippets();
        const snippet = snippets.find(s => s.id === id || s.name === id);
        if (!snippet) return;

        // Apply fallback styling
        if (snippet.fontFamily && document.getElementById('batch-font-family')) document.getElementById('batch-font-family').value = snippet.fontFamily;
        if (snippet.fontSize && document.getElementById('batch-font-size')) document.getElementById('batch-font-size').value = snippet.fontSize;
        if (snippet.fontWeight !== undefined && document.getElementById('batch-bold-btn')) {
          document.getElementById('batch-bold-btn').classList.toggle('active', snippet.fontWeight === 'bold');
        }
        if (snippet.fontStyle !== undefined && document.getElementById('batch-italic-btn')) {
          document.getElementById('batch-italic-btn').classList.toggle('active', snippet.fontStyle === 'italic');
        }
        if (snippet.fontColor && document.getElementById('batch-font-color')) document.getElementById('batch-font-color').value = snippet.fontColor;
        if (snippet.alignment && document.getElementById('batch-align-select')) document.getElementById('batch-align-select').value = snippet.alignment;

        // Apply lines (support rich object lines or string lines)
        if (snippet.lines && this.activeBatchState) {
          const defaultFs = snippet.fontSize || 14;
          this.activeBatchState.lines = snippet.lines.map((item, idx) => {
            if (typeof item === 'string') {
              return {
                idx,
                text: item,
                currentText: item,
                originalText: item,
                dx: 0,
                dy: +(idx * Math.round(defaultFs * 1.2)).toFixed(2),
                fontFamily: snippet.fontFamily || 'Helvetica',
                fontSize: defaultFs,
                fontWeight: snippet.fontWeight || 'normal',
                fontStyle: snippet.fontStyle || 'normal',
                fontColor: snippet.fontColor || '#000000',
              };
            }
            return {
              idx,
              text: item.text || '',
              currentText: item.text || '',
              originalText: item.text || '',
              dx: typeof item.dx === 'number' ? item.dx : 0,
              dy: typeof item.dy === 'number' ? item.dy : 0,
              fontFamily: item.fontFamily || snippet.fontFamily || 'Helvetica',
              fontSize: item.fontSize || defaultFs,
              fontWeight: item.fontWeight || snippet.fontWeight || 'normal',
              fontStyle: item.fontStyle || snippet.fontStyle || 'normal',
              fontColor: item.fontColor || snippet.fontColor || '#000000',
            };
          });

          this.activeBatchState.selectedLineIndices = new Set([0]);
          const firstLine = this.activeBatchState.lines[0];
          if (firstLine) {
            if (document.getElementById('batch-font-family')) document.getElementById('batch-font-family').value = firstLine.fontFamily || 'Helvetica';
            if (document.getElementById('batch-font-size')) document.getElementById('batch-font-size').value = firstLine.fontSize || 14;
            if (document.getElementById('batch-bold-btn')) document.getElementById('batch-bold-btn').classList.toggle('active', firstLine.fontWeight === 'bold');
            if (document.getElementById('batch-italic-btn')) document.getElementById('batch-italic-btn').classList.toggle('active', firstLine.fontStyle === 'italic');
            if (document.getElementById('batch-font-color')) document.getElementById('batch-font-color').value = firstLine.fontColor || '#000000';
          }
          this.renderBatchLinesEditor();
          this.renderBatchPreviewStage();
          this.renderBatchMatchHighlights();
          this.updateBatchCoordsLabel();
        }
        this.showToast(`Snippet "${snippet.name}" loaded`, 'info');
      });
    }

    const deleteSnippetBtn = document.getElementById('btn-batch-delete-snippet');
    if (deleteSnippetBtn) {
      deleteSnippetBtn.addEventListener('click', () => {
        const select = document.getElementById('batch-snippet-select');
        const id = select?.value;
        if (!id) return;
        this.deleteSnippet(id);
        this.showToast('Snippet deleted', 'info');
      });
    }

    // Keyboard Arrow Keys navigation for batch preview stage
    window.addEventListener('keydown', (e) => {
      if (!this.activeBatchState) return;
      const widgetEl = document.getElementById('batch-group-widget');
      if (!widgetEl || widgetEl.style.display === 'none') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const tag = document.activeElement ? document.activeElement.tagName : '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
        if (!this.activeBatchState.selectedLineIndices || this.activeBatchState.selectedLineIndices.size === 0) return;

        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        let deltaX = 0, deltaY = 0;
        if (e.key === 'ArrowUp') deltaY = -step;
        else if (e.key === 'ArrowDown') deltaY = step;
        else if (e.key === 'ArrowLeft') deltaX = -step;
        else if (e.key === 'ArrowRight') deltaX = step;

        for (const idx of this.activeBatchState.selectedLineIndices) {
          const line = this.activeBatchState.lines[idx];
          if (line) {
            line.dx = +(((line.dx || 0) + deltaX).toFixed(2));
            line.dy = +(((line.dy || 0) + deltaY).toFixed(2));
          }
        }
        const alignSelect = document.getElementById('batch-align-select');
        if (alignSelect && alignSelect.value !== 'keep') alignSelect.value = 'keep';
        this.renderBatchPreviewStage();
        this.updateBatchCoordsLabel();
      }
    });
  }

  updateActiveLinesStyle(patch) {
    if (!this.activeBatchState || !this.activeBatchState.lines) return;
    const sel = (this.activeBatchState.selectedLineIndices && this.activeBatchState.selectedLineIndices.size > 0)
      ? Array.from(this.activeBatchState.selectedLineIndices)
      : this.activeBatchState.lines.map((_, i) => i);

    for (const idx of sel) {
      const line = this.activeBatchState.lines[idx];
      if (line) {
        Object.assign(line, patch);
      }
    }
    if (patch.fontFamily && document.getElementById('batch-font-family')) {
      document.getElementById('batch-font-family').value = patch.fontFamily;
    }
    if (patch.fontSize && document.getElementById('batch-font-size')) {
      document.getElementById('batch-font-size').value = patch.fontSize;
    }
    if (patch.fontWeight !== undefined && document.getElementById('batch-bold-btn')) {
      document.getElementById('batch-bold-btn').classList.toggle('active', patch.fontWeight === 'bold');
    }
    if (patch.fontStyle !== undefined && document.getElementById('batch-italic-btn')) {
      document.getElementById('batch-italic-btn').classList.toggle('active', patch.fontStyle === 'italic');
    }
    if (patch.fontColor && document.getElementById('batch-font-color')) {
      document.getElementById('batch-font-color').value = patch.fontColor;
    }
    this.renderBatchPreviewStage();
  }

  updateBatchCoordsLabel() {
    const badge = document.getElementById('batch-coords-label');
    if (!badge || !this.activeBatchState) return;
    const sel = Array.from(this.activeBatchState.selectedLineIndices || []);
    if (sel.length === 1) {
      const idx = sel[0];
      const l = this.activeBatchState.lines[idx];
      if (l) {
        badge.textContent = `Line ${idx + 1} Offset: dx=${l.dx || 0}pt, dy=${l.dy || 0}pt`;
        return;
      }
    } else if (sel.length > 1) {
      badge.textContent = `${sel.length} Lines Selected`;
      return;
    }
    badge.textContent = 'No line selected (click a line to move)';
  }

  snapBatchCenter() {
    if (!this.activeBatchState || !this.activeBatchState.lines) return;
    const sourcePage = this.activeBatchState.sourcePageIndex || 0;
    const pageSize = this.pdfEngine.getPageSize(sourcePage) || { width: 612 };
    const pageWidth = pageSize.width;
    const anchorX = this.activeBatchState.anchorOrigX || (this.activeBatchState.matches && this.activeBatchState.matches[0]?.anchorX) || 0;
    const groupOffX = this.activeBatchState.groupOffsetX || 0;

    for (const line of this.activeBatchState.lines) {
      const text = line.currentText !== undefined ? line.currentText : (line.text || '');
      const textW = this.canvasController.measureActualTextWidth({
        text,
        fontSize: line.fontSize || 14,
        fontFamily: line.fontFamily || 'Helvetica',
        fontWeight: line.fontWeight || 'normal',
        fontStyle: line.fontStyle || 'normal',
      });
      line.dx = +(((pageWidth - textW) / 2 - (anchorX + groupOffX)).toFixed(2));
    }
    const alignSelect = document.getElementById('batch-align-select');
    if (alignSelect) alignSelect.value = 'center-page';
    this.activeBatchState.stageOriginX = undefined;
    this.renderBatchPreviewStage();
    this.updateBatchCoordsLabel();
  }

  snapBatchLeft() {
    if (!this.activeBatchState || !this.activeBatchState.lines) return;
    const targets = (this.activeBatchState.selectedLineIndices && this.activeBatchState.selectedLineIndices.size > 1)
      ? Array.from(this.activeBatchState.selectedLineIndices)
      : this.activeBatchState.lines.map((_, i) => i);
    for (const idx of targets) {
      if (this.activeBatchState.lines[idx]) {
        this.activeBatchState.lines[idx].dx = 0;
      }
    }
    const alignSelect = document.getElementById('batch-align-select');
    if (alignSelect) alignSelect.value = 'left';
    this.activeBatchState.stageOriginX = undefined;
    this.renderBatchPreviewStage();
    this.updateBatchCoordsLabel();
  }

  snapBatchDistribute() {
    if (!this.activeBatchState || !this.activeBatchState.lines) return;
    const lines = this.activeBatchState.lines;
    for (let k = 1; k < lines.length; k++) {
      const prevFontSize = lines[k - 1].fontSize || 10;
      lines[k].dy = +(lines[0].dy + k * Math.round(prevFontSize * 1.25)).toFixed(2);
    }
    this.activeBatchState.stageOriginY = undefined;
    this.renderBatchPreviewStage();
    this.updateBatchCoordsLabel();
  }

  renderBatchPreviewStage() {
    const stage = document.getElementById('batch-preview-stage');
    if (!stage || !this.activeBatchState) return;

    const lines = this.activeBatchState.lines || [];
    const stageW = stage.clientWidth || 360;

    if (this.activeBatchState.stageOriginX === undefined || this.activeBatchState.stageOriginY === undefined) {
      let minDx = Infinity, maxRight = -Infinity, minDy = Infinity;
      for (const l of lines) {
        const dx = typeof l.dx === 'number' && !isNaN(l.dx) ? l.dx : 0;
        const dy = typeof l.dy === 'number' && !isNaN(l.dy) ? l.dy : 0;
        const text = l.currentText !== undefined ? l.currentText : (l.text || '');
        const w = this.canvasController.measureActualTextWidth({
          text,
          fontSize: l.fontSize || 14,
          fontFamily: l.fontFamily || 'Helvetica',
          fontWeight: l.fontWeight || 'normal',
          fontStyle: l.fontStyle || 'normal',
        });
        if (dx < minDx) minDx = dx;
        if (dx + w > maxRight) maxRight = dx + w;
        if (dy < minDy) minDy = dy;
      }
      if (!isFinite(minDx)) { minDx = 0; maxRight = 100; minDy = 0; }
      const blockW = Math.max(maxRight - minDx, 20);
      this.activeBatchState.stageOriginX = +(((stageW - blockW) / 2 - minDx).toFixed(1));
      this.activeBatchState.stageOriginY = +(14 - minDy).toFixed(1);
    }

    const stageOriginX = this.activeBatchState.stageOriginX;
    const stageOriginY = this.activeBatchState.stageOriginY;

    const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    stage.innerHTML = `<div class="batch-preview-center-guide"></div>` + lines.map((l, idx) => {
      const isSelected = this.activeBatchState.selectedLineIndices && this.activeBatchState.selectedLineIndices.has(idx);
      const text = l.currentText !== undefined ? l.currentText : (l.text || '');
      const posX = +(stageOriginX + (l.dx || 0)).toFixed(1);
      const posY = +(stageOriginY + (l.dy || 0)).toFixed(1);
      return `<div class="batch-preview-item ${isSelected ? 'selected' : ''}" data-line-index="${idx}" style="left:${posX}px;top:${posY}px;font-family:${l.fontFamily || 'Helvetica'};font-size:${l.fontSize || 14}px;font-weight:${l.fontWeight || 'normal'};font-style:${l.fontStyle || 'normal'};color:${l.fontColor || '#000000'};">${escapeHtml(text || `(Line ${idx + 1})`)}</div>`;
    }).join('');

    stage.querySelectorAll('.batch-preview-item').forEach(el => {
      const lineIdx = parseInt(el.dataset.lineIndex, 10);

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();

        const wasAlreadySelected = this.activeBatchState.selectedLineIndices && this.activeBatchState.selectedLineIndices.has(lineIdx);
        const isSingleSelected = wasAlreadySelected && this.activeBatchState.selectedLineIndices.size === 1;

        if (e.shiftKey) {
          if (wasAlreadySelected) {
            this.activeBatchState.selectedLineIndices.delete(lineIdx);
            if (this.activeBatchState.selectedLineIndices.size === 0) {
              this.activeBatchState.selectedLineIndices.add(lineIdx);
            }
          } else {
            this.activeBatchState.selectedLineIndices.add(lineIdx);
          }
        } else {
          if (!wasAlreadySelected) {
            this.activeBatchState.selectedLineIndices = new Set([lineIdx]);
          }
        }

        const curLine = this.activeBatchState.lines[lineIdx];
        if (curLine) {
          if (document.getElementById('batch-font-family')) document.getElementById('batch-font-family').value = curLine.fontFamily || 'Helvetica';
          if (document.getElementById('batch-font-size')) document.getElementById('batch-font-size').value = curLine.fontSize || 14;
          if (document.getElementById('batch-bold-btn')) document.getElementById('batch-bold-btn').classList.toggle('active', curLine.fontWeight === 'bold');
          if (document.getElementById('batch-italic-btn')) document.getElementById('batch-italic-btn').classList.toggle('active', curLine.fontStyle === 'italic');
          if (document.getElementById('batch-font-color')) document.getElementById('batch-font-color').value = curLine.fontColor || '#000000';
        }

        stage.querySelectorAll('.batch-preview-item').forEach(it => {
          const idx = parseInt(it.dataset.lineIndex, 10);
          it.classList.toggle('selected', this.activeBatchState.selectedLineIndices.has(idx));
        });
        this.updateBatchCoordsLabel();

        const startX = e.clientX;
        const startY = e.clientY;
        const initOffsets = new Map();
        for (const idx of this.activeBatchState.selectedLineIndices) {
          const l = this.activeBatchState.lines[idx];
          if (l) initOffsets.set(idx, { dx: l.dx || 0, dy: l.dy || 0 });
        }

        let hasMoved = false;
        const onPointerMove = (ev) => {
          const deltaX = ev.clientX - startX;
          const deltaY = ev.clientY - startY;
          if (Math.hypot(deltaX, deltaY) > 2) hasMoved = true;
          if (!hasMoved) return;

          for (const [idx, init] of initOffsets) {
            const l = this.activeBatchState.lines[idx];
            if (l) {
              l.dx = +((init.dx + deltaX).toFixed(2));
              l.dy = +((init.dy + deltaY).toFixed(2));
            }
          }
          const alignSelect = document.getElementById('batch-align-select');
          if (alignSelect && alignSelect.value !== 'keep') alignSelect.value = 'keep';
          this.renderBatchPreviewStage();
          this.updateBatchCoordsLabel();
        };

        const onPointerUp = () => {
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);

          if (!hasMoved && isSingleSelected) {
            const input = document.querySelector(`.batch-line-input[data-line-index="${lineIdx}"]`);
            if (input) {
              input.focus();
              input.select();
            }
          }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
      });
    });
  }

  renderBatchLinesEditor() {
    const container = document.getElementById('batch-lines-container');
    if (!container || !this.activeBatchState) return;
    const escapeAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    container.innerHTML = (this.activeBatchState.lines || []).map((line, idx) => `
      <div class="batch-line-row">
        <input type="text" class="batch-line-input form-input" data-line-index="${idx}" value="${escapeAttr(line.currentText !== undefined ? line.currentText : line.text)}" placeholder="Line ${idx + 1}">
        <button class="btn-batch-clear-line" data-line-index="${idx}" title="Clear line" type="button">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.batch-line-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.lineIndex, 10);
        if (this.activeBatchState.lines[idx]) {
          this.activeBatchState.lines[idx].currentText = e.target.value;
          this.activeBatchState.lines[idx].text = e.target.value;
          if (document.getElementById('batch-align-select')?.value === 'center-page') {
            this.snapBatchCenter();
          } else {
            this.renderBatchPreviewStage();
          }
        }
      });
    });

    container.querySelectorAll('.btn-batch-clear-line').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.lineIndex, 10);
        const inp = container.querySelector(`.batch-line-input[data-line-index="${idx}"]`);
        if (inp) {
          inp.value = '';
          if (this.activeBatchState.lines[idx]) {
            this.activeBatchState.lines[idx].currentText = '';
            this.activeBatchState.lines[idx].text = '';
            this.renderBatchPreviewStage();
          }
        }
      });
    });
  }

  renderBatchMatchesList() {
    const container = document.getElementById('batch-matches-list');
    const countBadge = document.getElementById('batch-match-count');
    if (!container || !this.activeBatchState) return;

    const matches = this.activeBatchState.matches || [];
    if (countBadge) {
      countBadge.textContent = `${matches.length} found`;
    }

    container.innerHTML = matches.map(match => {
      const badgeClass = match.matchType === 'source' ? 'batch-badge-source' : (match.matchType === 'exact' ? 'batch-badge-exact' : 'batch-badge-out-of-zone');
      const badgeText = match.matchType === 'source' ? 'Source Selection' : (match.matchType === 'exact' ? 'Exact Position Match' : '⚠️ Different Position (Unchecked)');
      return `
        <div class="batch-match-row">
          <input type="checkbox" class="batch-match-checkbox" data-match-id="${match.id}" ${match.checked ? 'checked' : ''}>
          <div class="batch-match-row-info">
            <span class="batch-match-label">Page ${match.pageIndex + 1}</span>
            <span class="batch-match-pos">x: ${match.anchorX}, y: ${match.anchorY}</span>
          </div>
          <span class="batch-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.batch-match-checkbox').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const matchId = e.target.dataset.matchId;
        const match = this.activeBatchState.matches.find(m => m.id === matchId);
        if (match) {
          match.checked = e.target.checked;
          this.renderBatchMatchHighlights();
          this.updateBatchApplyButtonLabel();
        }
      });
    });

    this.updateBatchApplyButtonLabel();
  }

  updateBatchApplyButtonLabel() {
    const applyBtn = document.getElementById('btn-batch-apply');
    if (!applyBtn || !this.activeBatchState) return;
    const checkedCount = (this.activeBatchState.matches || []).filter(m => m.checked).length;
    applyBtn.textContent = `Apply to ${checkedCount} Page${checkedCount !== 1 ? 's' : ''}`;
    applyBtn.disabled = (checkedCount === 0);
  }

  getSavedSnippets() {
    try {
      return JSON.parse(localStorage.getItem('pdfgod_text_snippets_v1') || '[]');
    } catch (e) {
      return [];
    }
  }

  saveSnippet(snippet) {
    const list = this.getSavedSnippets();
    const idx = list.findIndex(s => s.name.toLowerCase() === snippet.name.toLowerCase() || s.id === snippet.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...snippet };
    } else {
      list.push(snippet);
    }
    localStorage.setItem('pdfgod_text_snippets_v1', JSON.stringify(list));
    this.refreshSnippetsDropdown(snippet.id);
  }

  deleteSnippet(id) {
    let list = this.getSavedSnippets();
    list = list.filter(s => s.id !== id && s.name !== id);
    localStorage.setItem('pdfgod_text_snippets_v1', JSON.stringify(list));
    this.refreshSnippetsDropdown();
  }

  refreshSnippetsDropdown(selectedId = null) {
    const select = document.getElementById('batch-snippet-select');
    if (!select) return;
    const snippets = this.getSavedSnippets();
    select.innerHTML = '<option value="">-- Choose Saved Snippet --</option>';
    snippets.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (selectedId && (s.id === selectedId || s.name === selectedId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  async findMatchingBlocksAcrossPages(selectedAnns) {
    if (!selectedAnns || selectedAnns.length === 0) return [];

    const sortedAnns = [...selectedAnns].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const norm = (s) => {
      const raw = (window.ThaiSupport && window.ThaiSupport.normalizeThaiText)
        ? window.ThaiSupport.normalizeThaiText(String(s || ''))
        : String(s || '');
      return raw.trim().replace(/\s+/g, ' ');
    };

    const sourcePageIndex = sortedAnns[0].pageIndex !== undefined ? sortedAnns[0].pageIndex : this.currentPage;
    const anchorOrigX = sortedAnns[0].origX !== undefined ? sortedAnns[0].origX : sortedAnns[0].x;
    const anchorOrigY = sortedAnns[0].origY !== undefined ? sortedAnns[0].origY : sortedAnns[0].y;

    const pattern = sortedAnns.map((ann) => {
      const origX = ann.origX !== undefined ? ann.origX : ann.x;
      const origY = ann.origY !== undefined ? ann.origY : ann.y;
      return {
        matchText: norm(ann.originalText || ann.text),
        currentText: ann.text,
        origX,
        origY,
        dx: +(origX - anchorOrigX).toFixed(2),
        dy: +(origY - anchorOrigY).toFixed(2),
        fontSize: ann.fontSize || 14,
        fontFamily: ann.fontFamily || 'Helvetica',
        fontWeight: ann.fontWeight || 'normal',
        fontStyle: ann.fontStyle || 'normal',
        fontColor: ann.fontColor || '#000000',
      };
    });

    const M = pattern.length;
    const matches = [];

    // Match #0: the source selection itself
    matches.push({
      id: 'match_source',
      pageIndex: sourcePageIndex,
      anchorX: +(anchorOrigX.toFixed(1)),
      anchorY: +(anchorOrigY.toFixed(1)),
      matchType: 'source',
      checked: true,
      items: sortedAnns.map(a => ({
        kind: 'ann',
        ann: a,
        str: a.originalText || a.text,
        x: a.origX !== undefined ? a.origX : a.x,
        y: a.origY !== undefined ? a.origY : a.y,
        width: a.width,
        height: a.height,
        fontSize: a.fontSize,
        fontFamily: a.fontFamily,
        fontWeight: a.fontWeight,
        fontStyle: a.fontStyle,
        fontColor: a.fontColor,
      }))
    });

    const numPages = this.pdfEngine.getPageCount();

    for (let p = 0; p < numPages; p++) {
      const pdfItems = await this.pdfEngine.getTextItems(p);
      const annItems = this.annotationManager.getAnnotationsForPage(p).filter(a => a.type === 'text');

      const candidates = [
        ...pdfItems.map(it => ({
          kind: 'pdf',
          item: it,
          str: it.str,
          x: it.x,
          y: it.y,
          width: it.width,
          height: it.height,
          rawTx: it.rawTx,
          rawTy: it.rawTy,
          baselineY: it.baselineY,
          fontSize: it.fontSize,
          fontFamily: it.fontFamily,
          fontWeight: it.fontWeight,
          fontStyle: it.fontStyle,
          fontColor: it.fontColor,
        })),
        ...annItems.map(a => ({
          kind: 'ann',
          ann: a,
          str: a.originalText || a.text,
          x: a.origX !== undefined ? a.origX : a.x,
          y: a.origY !== undefined ? a.origY : a.y,
          width: a.width,
          height: a.height,
          fontSize: a.fontSize,
          fontFamily: a.fontFamily,
          fontWeight: a.fontWeight,
          fontStyle: a.fontStyle,
          fontColor: a.fontColor,
        }))
      ];

      const anchorCandidates = candidates.filter(c => norm(c.str) === pattern[0].matchText);

      for (const cand0 of anchorCandidates) {
        if (p === sourcePageIndex) {
          if (cand0.kind === 'ann' && sortedAnns.some(s => s.id === cand0.ann.id)) {
            continue;
          }
          if (cand0.kind === 'pdf' && Math.abs(cand0.x - anchorOrigX) < 1 && Math.abs(cand0.y - anchorOrigY) < 1) {
            continue;
          }
        }

        let matchedRest = [];
        let allMatched = true;

        if (M > 1) {
          for (let k = 1; k < M; k++) {
            const candK = candidates.find(c => {
              if (c === cand0 || matchedRest.includes(c)) return false;
              if (norm(c.str) !== pattern[k].matchText) return false;
              const xDiff = (c.x - cand0.x) - pattern[k].dx;
              const yDiff = (c.y - cand0.y) - pattern[k].dy;
              return Math.abs(xDiff) <= 15 && Math.abs(yDiff) <= 12;
            });
            if (candK) {
              matchedRest.push(candK);
            } else {
              allMatched = false;
              break;
            }
          }
        }

        if (allMatched) {
          const inZone = Math.abs(cand0.x - anchorOrigX) <= 18 && Math.abs(cand0.y - anchorOrigY) <= 18;
          const matchId = `match_p${p}_${Math.round(cand0.y)}_${Math.round(cand0.x)}`;
          if (!matches.some(m => m.id === matchId)) {
            matches.push({
              id: matchId,
              pageIndex: p,
              anchorX: +(cand0.x.toFixed(1)),
              anchorY: +(cand0.y.toFixed(1)),
              matchType: inZone ? 'exact' : 'out-of-zone',
              checked: inZone,
              items: [cand0, ...matchedRest]
            });
          }
        }
      }
    }

    return matches;
  }

  renderBatchMatchHighlights() {
    document.querySelectorAll('.batch-match-highlight').forEach(el => el.remove());
    if (!this.activeBatchState || !this.activeBatchState.matches) return;

    for (const match of this.activeBatchState.matches) {
      const pageWrapper = this.docContainer
        ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${match.pageIndex}"]`)
        : document.querySelector(`.page-wrapper[data-page-index="${match.pageIndex}"]`);
      if (!pageWrapper) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const item of (match.items || [])) {
        const ix = item.x;
        const iy = item.y;
        const iw = item.width || 50;
        const ih = item.height || 14;
        if (ix < minX) minX = ix;
        if (iy < minY) minY = iy;
        if (ix + iw > maxX) maxX = ix + iw;
        if (iy + ih > maxY) maxY = iy + ih;
      }
      if (!isFinite(minX)) continue;

      const hl = document.createElement('div');
      hl.className = `batch-match-highlight ${match.checked ? 'checked' : 'unchecked'}`;
      hl.dataset.matchId = match.id;
      hl.style.position = 'absolute';
      hl.style.left = `${+(minX * this.zoom - 4).toFixed(1)}px`;
      hl.style.top = `${+(minY * this.zoom - 3).toFixed(1)}px`;
      hl.style.width = `${+((maxX - minX) * this.zoom + 8).toFixed(1)}px`;
      hl.style.height = `${+((maxY - minY) * this.zoom + 6).toFixed(1)}px`;
      hl.style.pointerEvents = 'none';
      hl.style.zIndex = '35';

      hl.innerHTML = `<span class="batch-match-badge ${match.checked ? 'checked' : 'unchecked'}">Page ${match.pageIndex + 1}: ${match.checked ? 'Selected' : 'Skipped'}</span>`;
      pageWrapper.appendChild(hl);
    }
  }

  async openBatchGroupEditor() {
    const selectedAnns = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
    if (selectedAnns.length === 0) {
      this.showToast('Please select a text element first', 'warning');
      return;
    }

    const matches = await this.findMatchingBlocksAcrossPages(selectedAnns);
    const sorted = [...selectedAnns].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const anchorX = sorted[0].origX !== undefined ? sorted[0].origX : sorted[0].x;
    const anchorY = sorted[0].origY !== undefined ? sorted[0].origY : sorted[0].y;

    const lines = sorted.map((ann, idx) => ({
      idx,
      text: ann.text || '',
      currentText: ann.text || '',
      originalText: ann.originalText || ann.text || '',
      origX: ann.origX !== undefined ? ann.origX : ann.x,
      origY: ann.origY !== undefined ? ann.origY : ann.y,
      dx: +( (ann.origX !== undefined ? ann.origX : ann.x) - anchorX ).toFixed(2),
      dy: +( (ann.origY !== undefined ? ann.origY : ann.y) - anchorY ).toFixed(2),
      fontFamily: ann.fontFamily || 'Helvetica',
      fontSize: ann.fontSize || 14,
      fontWeight: ann.fontWeight || 'normal',
      fontStyle: ann.fontStyle || 'normal',
      fontColor: ann.fontColor || '#000000',
    }));

    const existingBatchGroupId = sorted.find(a => a.batchGroupId)?.batchGroupId || null;

    let earliestPreRedactionBytes = null;
    for (const ann of sorted) {
      if (ann._preRedactionPdfBytes) {
        earliestPreRedactionBytes = ann._preRedactionPdfBytes;
        break;
      }
    }
    if (!earliestPreRedactionBytes && existingBatchGroupId && this.batchGroups.has(existingBatchGroupId)) {
      earliestPreRedactionBytes = this.batchGroups.get(existingBatchGroupId).earliestPreRedactionBytes;
    }

    this.activeBatchState = {
      sourcePageIndex: sorted[0].pageIndex !== undefined ? sorted[0].pageIndex : this.currentPage,
      anchorOrigX: anchorX,
      anchorOrigY: anchorY,
      selectedAnns: sorted,
      matches,
      lines,
      selectedLineIndices: new Set([0]),
      groupOffsetX: 0,
      groupOffsetY: 0,
      existingBatchGroupId,
      earliestPreRedactionBytes,
    };

    document.body.classList.add('batch-editor-open');
    const widget = document.getElementById('batch-group-widget');
    if (widget) {
      widget.style.display = 'flex';

      const firstLine = lines[0];
      if (firstLine) {
        document.getElementById('batch-font-family').value = firstLine.fontFamily || 'Helvetica';
        document.getElementById('batch-font-size').value = firstLine.fontSize || 14;
        document.getElementById('batch-bold-btn').classList.toggle('active', firstLine.fontWeight === 'bold');
        document.getElementById('batch-italic-btn').classList.toggle('active', firstLine.fontStyle === 'italic');
        document.getElementById('batch-font-color').value = firstLine.fontColor || '#000000';
      }
      document.getElementById('batch-align-select').value = 'keep';

      const revertBtn = document.getElementById('btn-batch-revert');
      if (revertBtn) {
        revertBtn.disabled = !existingBatchGroupId;
      }

      this.renderBatchMatchesList();
      this.renderBatchLinesEditor();
      this.renderBatchPreviewStage();
      this.refreshSnippetsDropdown();
      this.renderBatchMatchHighlights();
      this.updateBatchCoordsLabel();
    }
  }

  async reopenBatchGroupEditor(batchGroupId) {
    if (!batchGroupId) return;
    const groupInfo = this.batchGroups.get(batchGroupId);
    const groupAnns = this.annotationManager.annotations.filter(a => a.batchGroupId === batchGroupId && a.type === 'text');
    if (groupAnns.length === 0) {
      this.showToast('No annotations found for this group', 'warning');
      return;
    }

    const sourcePage = (groupInfo && groupInfo.sourcePageIndex !== undefined)
      ? groupInfo.sourcePageIndex
      : groupAnns[0].pageIndex;

    const sourceAnns = groupAnns.filter(a => a.pageIndex === sourcePage).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const effectiveSourceAnns = sourceAnns.length > 0
      ? sourceAnns
      : groupAnns.filter(a => a.pageIndex === groupAnns[0].pageIndex).sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const anchorX = effectiveSourceAnns[0].origX !== undefined ? effectiveSourceAnns[0].origX : effectiveSourceAnns[0].x;
    const anchorY = effectiveSourceAnns[0].origY !== undefined ? effectiveSourceAnns[0].origY : effectiveSourceAnns[0].y;

    const lines = effectiveSourceAnns.map((ann, idx) => ({
      idx,
      text: ann.text || '',
      currentText: ann.text || '',
      originalText: ann.originalText || ann.text || '',
      origX: ann.origX !== undefined ? ann.origX : ann.x,
      origY: ann.origY !== undefined ? ann.origY : ann.y,
      dx: +(ann.x - anchorX).toFixed(2),
      dy: +(ann.y - anchorY).toFixed(2),
      fontFamily: ann.fontFamily || 'Helvetica',
      fontSize: ann.fontSize || 14,
      fontWeight: ann.fontWeight || 'normal',
      fontStyle: ann.fontStyle || 'normal',
      fontColor: ann.fontColor || '#000000',
    }));

    const numPages = this.pdfEngine.getPageCount();
    const matches = [];
    for (let p = 0; p < numPages; p++) {
      const pageAnns = groupAnns.filter(a => a.pageIndex === p).sort((a, b) => (a.y - b.y) || (a.x - b.x));
      if (pageAnns.length > 0) {
        const pAnchorX = pageAnns[0].origX !== undefined ? pageAnns[0].origX : pageAnns[0].x;
        const pAnchorY = pageAnns[0].origY !== undefined ? pageAnns[0].origY : pageAnns[0].y;
        matches.push({
          id: `match_group_${p}`,
          pageIndex: p,
          anchorX: +(pAnchorX.toFixed(1)),
          anchorY: +(pAnchorY.toFixed(1)),
          matchType: (p === sourcePage ? 'source' : 'exact'),
          checked: true,
          items: pageAnns.map(a => ({
            kind: 'ann',
            ann: a,
            str: a.text,
            x: a.x,
            y: a.y,
            width: a.width,
            height: a.height,
          }))
        });
      }
    }

    this.activeBatchState = {
      isReedit: true,
      batchGroupId,
      existingBatchGroupId: batchGroupId,
      sourcePageIndex: sourcePage,
      anchorOrigX: anchorX,
      anchorOrigY: anchorY,
      lines,
      matches,
      selectedLineIndices: new Set([0]),
      groupOffsetX: 0,
      groupOffsetY: 0,
      earliestPreRedactionBytes: groupInfo ? (groupInfo.earliestPreRedactionBytes || groupInfo.pdfBytesBefore) : null,
    };

    document.body.classList.add('batch-editor-open');
    const widget = document.getElementById('batch-group-widget');
    if (widget) {
      widget.style.display = 'flex';
      const firstLine = lines[0];
      if (firstLine) {
        document.getElementById('batch-font-family').value = firstLine.fontFamily || 'Helvetica';
        document.getElementById('batch-font-size').value = firstLine.fontSize || 14;
        document.getElementById('batch-bold-btn').classList.toggle('active', firstLine.fontWeight === 'bold');
        document.getElementById('batch-italic-btn').classList.toggle('active', firstLine.fontStyle === 'italic');
        document.getElementById('batch-font-color').value = firstLine.fontColor || '#000000';
      }
      const revertBtn = document.getElementById('btn-batch-revert');
      if (revertBtn) revertBtn.disabled = false;

      this.renderBatchMatchesList();
      this.renderBatchLinesEditor();
      this.renderBatchPreviewStage();
      this.refreshSnippetsDropdown();
      this.renderBatchMatchHighlights();
      this.updateBatchCoordsLabel();
    }
  }

  closeBatchGroupEditor() {
    document.body.classList.remove('batch-editor-open');
    const widget = document.getElementById('batch-group-widget');
    if (widget) widget.style.display = 'none';
    document.querySelectorAll('.batch-match-highlight').forEach(el => el.remove());
    this.activeBatchState = null;
  }

  async applyBatchGroupEdit() {
    if (!this.activeBatchState) return;
    const checkedMatches = this.activeBatchState.matches.filter(m => m.checked);
    if (checkedMatches.length === 0) {
      this.showToast('No pages selected to apply', 'warning');
      return;
    }

    const linesInputs = document.querySelectorAll('#batch-lines-container .batch-line-input');
    linesInputs.forEach((inp, idx) => {
      if (this.activeBatchState.lines[idx]) {
        this.activeBatchState.lines[idx].currentText = inp.value;
        this.activeBatchState.lines[idx].text = inp.value;
      }
    });

    const updatedLines = this.activeBatchState.lines || [];
    const alignment = document.getElementById('batch-align-select')?.value || 'keep';
    const groupOffX = this.activeBatchState.groupOffsetX || 0;
    const groupOffY = this.activeBatchState.groupOffsetY || 0;

    const batchGroupId = this.activeBatchState.existingBatchGroupId || ('batch_' + Date.now().toString(36));
    const pdfBytesBefore = new Uint8Array(this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes);
    const earliestBytes = this.activeBatchState.earliestPreRedactionBytes || pdfBytesBefore;

    this.batchGroups.set(batchGroupId, {
      batchGroupId,
      pdfBytesBefore,
      earliestPreRedactionBytes: earliestBytes,
      matches: JSON.parse(JSON.stringify(checkedMatches)),
      sourcePageIndex: this.activeBatchState.sourcePageIndex,
    });

    this.annotationManager.pushHistory('Batch Edit Across Pages', earliestBytes);

    if (this.activeBatchState.isReedit) {
      this.annotationManager.annotations = this.annotationManager.annotations.filter(a => a.batchGroupId !== batchGroupId);
    } else {
      for (const match of checkedMatches) {
        const textsToRedact = [];
        const annIdsToRemove = new Set();
        for (const item of match.items) {
          if (item.kind === 'pdf') {
            textsToRedact.push({
              targetStr: item.str,
              rawTx: item.rawTx,
              rawTy: item.rawTy,
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height
            });
          } else if (item.kind === 'ann' && item.ann) {
            annIdsToRemove.add(item.ann.id);
          }
        }
        if (annIdsToRemove.size > 0) {
          this.annotationManager.annotations = this.annotationManager.annotations.filter(a => !annIdsToRemove.has(a.id));
        }
        if (textsToRedact.length > 0) {
          await this.pdfEngine.redactItemsFromPage(match.pageIndex, { texts: textsToRedact });
        }
      }
    }

    for (const match of checkedMatches) {
      const pageSize = this.pdfEngine.getPageSize(match.pageIndex) || { width: 612 };
      const pageWidth = pageSize.width;

      for (const line of updatedLines) {
        const lineText = line.currentText !== undefined ? line.currentText : (line.text || '');
        if (!lineText || lineText.trim().length === 0) continue;

        const fontSize = line.fontSize || 14;
        let fontFamily = line.fontFamily || 'Helvetica';
        const hasThai = (window.ThaiSupport && window.ThaiSupport.containsThai)
          ? window.ThaiSupport.containsThai(lineText)
          : /[\u0E00-\u0E7F]/.test(lineText);
        const latinFonts = ['Helvetica', 'Times New Roman', 'Courier New', 'Arial', 'Georgia'];
        if (hasThai && (!fontFamily || latinFonts.includes(fontFamily))) {
          fontFamily = 'Sarabun';
        }
        const fontWeight = line.fontWeight || 'normal';
        const fontStyle = line.fontStyle || 'normal';
        const fontColor = line.fontColor || '#000000';

        const textW = this.canvasController.measureActualTextWidth({
          text: lineText,
          fontSize,
          fontFamily,
          fontWeight,
          fontStyle,
        });

        let x;
        if (alignment === 'center-page') {
          x = +(((pageWidth - textW) / 2).toFixed(2));
        } else if (alignment === 'left') {
          x = +(match.anchorX + groupOffX).toFixed(2);
        } else {
          x = +(match.anchorX + groupOffX + (line.dx || 0)).toFixed(2);
        }
        const y = +(match.anchorY + groupOffY + (line.dy || 0)).toFixed(2);

        const isThai = (fontFamily === 'Sarabun') || hasThai;
        const lineHMult = isThai ? 1.45 : 1.15;
        const width = Math.max(Math.round(textW * 1.15 + 14), 40);
        const height = Math.max(Math.round(fontSize * lineHMult + (isThai ? 4 : 0)), 10);

        const newAnn = {
          id: this.annotationManager.generateId(),
          pageIndex: match.pageIndex,
          type: 'text',
          x,
          y,
          origX: +(match.anchorX + (line.dx || 0)).toFixed(2),
          origY: y,
          width,
          height,
          text: lineText,
          originalText: line.originalText || lineText,
          fontSize,
          fontFamily,
          fontWeight,
          fontStyle,
          fontColor,
          backgroundColor: 'transparent',
          isOriginalReplacement: true,
          batchGroupId,
        };
        this.annotationManager.annotations.push(newAnn);
      }
    }

    const affectedPages = Array.from(new Set(checkedMatches.map(m => m.pageIndex)));
    for (const p of affectedPages) {
      const wrapper = this.docContainer ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${p}"]`) : null;
      if (wrapper) {
        const canvas = wrapper.querySelector('.pdf-canvas');
        if (canvas) {
          await this.pdfEngine.renderPage(p, canvas, this.zoom);
        }
      }
    }

    this.closeBatchGroupEditor();

    await this.canvasController.loadTextItemsForActivePage();
    this.canvasController.render();
    this.canvasController.syncTextElements();

    const curPageNewAnns = this.annotationManager.annotations.filter(a => a.batchGroupId === batchGroupId && a.pageIndex === this.currentPage);
    if (curPageNewAnns.length > 0) {
      this.annotationManager.selectedAnnotationIds = new Set(curPageNewAnns.map(a => a.id));
      this.annotationManager.selectedAnnotationId = curPageNewAnns[0].id;
      this.annotationManager.notifySelection();
    }

    this.annotationManager.notifyChange('update');
    this.showToast(`Applied to ${checkedMatches.length} page(s)`, 'success');
  }

  async revertBatchGroup(batchGroupId) {
    if (!batchGroupId) return;
    const groupInfo = this.batchGroups.get(batchGroupId);

    this.annotationManager.annotations = this.annotationManager.annotations.filter(a => a.batchGroupId !== batchGroupId);

    const restoreBytes = groupInfo ? (groupInfo.earliestPreRedactionBytes || groupInfo.pdfBytesBefore) : null;
    if (restoreBytes) {
      await this.pdfEngine.setPdfBytes(restoreBytes);
    }

    const affectedPages = groupInfo && groupInfo.matches
      ? Array.from(new Set(groupInfo.matches.map(m => m.pageIndex)))
      : Array.from({ length: this.pdfEngine.getPageCount() }, (_, i) => i);

    for (const p of affectedPages) {
      const wrapper = this.docContainer ? this.docContainer.querySelector(`.page-wrapper[data-page-index="${p}"]`) : null;
      if (wrapper) {
        const canvas = wrapper.querySelector('.pdf-canvas');
        if (canvas) {
          await this.pdfEngine.renderPage(p, canvas, this.zoom);
        }
      }
    }

    await this.canvasController.loadTextItemsForActivePage();
    this.annotationManager.deselectAll();
    this.canvasController.render();
    this.canvasController.syncTextElements();

    this.batchGroups.delete(batchGroupId);
    this.closeBatchGroupEditor();
    this.showToast('Batch group reverted', 'info');
  }
}

window.UIController = UIController;
