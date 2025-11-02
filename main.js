const { Plugin } = require('obsidian');

class LRUCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

class MediaGalleryPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.thumbnailCache = new LRUCache(200);
        this.intersectionObserver = null;
        this.pendingRequests = new Map();
        this.workerPool = [];
        this.maxWorkers = 4;
    }

    async onload() {
        this.initWorkerPool();

        this.processor = this.registerMarkdownCodeBlockProcessor('memories', async (source, el, ctx) => {
            try {
                const config = this.parseConfig(source);
                await this.createGallery(el, config, ctx);
            } catch (error) {
                console.error('Media Gallery Error:', error);
                el.createEl('div', {
                    text: 'Error loading gallery',
                    cls: 'gallery-error'
                });
            }
        });
        
        this.initIntersectionObserver();
    }

    parseConfig(source) {
        const lines = source.trim().split('\n');
        const config = {
            paths: [],
            sortOrder: 'date-desc',
            enableLazyLoad: true,
            gridSize: 200,
            displayType: 'full',
            limit: 50, // значение по умолчанию для full
            batchSize: 10,
            preloadCount: 3
        };
        
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('paths:')) {
                const pathsStr = line.substring(6).trim();
                config.paths = pathsStr.split(',').map(p => p.trim());
            } else if (line.startsWith('sort:')) {
                config.sortOrder = line.substring(5).trim();
            } else if (line.startsWith('lazy:')) {
                config.enableLazyLoad = line.substring(5).trim() === 'true';
            } else if (line.startsWith('size:')) {
                config.gridSize = parseInt(line.substring(5).trim()) || 200;
            } else if (line.startsWith('type:')) {
                config.displayType = line.substring(5).trim();
            } else if (line.startsWith('limit:')) {
                config.limit = parseInt(line.substring(6).trim()) || 50;
            } else if (line.startsWith('batch:')) {
                config.batchSize = parseInt(line.substring(6).trim()) || 10;
            } else if (line && !line.includes(':')) {
                config.paths = [line];
            }
        }
        
        if (config.paths.length === 0) {
            config.paths = ['./'];
        }
        
        // Устанавливаем limit: 9 по умолчанию для compact, если limit не указан явно
        if (config.displayType === 'compact' && !lines.some(line => line.trim().startsWith('limit:'))) {
            config.limit = 9;
        }
        
        return config;
    }

    initWorkerPool() {
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = this.createThumbnailWorker();
            if (worker) {
                this.workerPool.push({
                    worker,
                    busy: false
                });
            }
        }
    }

    createThumbnailWorker() {
        if (typeof Worker === 'undefined') return null;
        
        const workerCode = `
            self.addEventListener('message', async (e) => {
                const { id, videoPath, timestamp } = e.data;
                try {
                    const response = await fetch(videoPath);
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    
                    const video = document.createElement('video');
                    video.crossOrigin = 'anonymous';
                    video.muted = true;
                    video.src = url;
                    video.currentTime = timestamp;
                    
                    await new Promise((resolve, reject) => {
                        video.onloadeddata = resolve;
                        video.onerror = reject;
                        setTimeout(resolve, 1000);
                    });
                    
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    
                    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                    URL.revokeObjectURL(url);
                    
                    self.postMessage({ id, thumbnail });
                } catch (error) {
                    self.postMessage({ id, error: error.message });
                }
            });
        `;
        
        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            return new Worker(URL.createObjectURL(blob));
        } catch (error) {
            console.warn('Web Workers not supported, falling back to main thread');
            return null;
        }
    }

    async getVideoThumbnailWorker(file, resourcePath) {
        if (this.thumbnailCache.has(file.path)) {
            return this.thumbnailCache.get(file.path);
        }
        
        const availableWorker = this.workerPool.find(w => !w.busy);
        if (!availableWorker) {
            return this.getVideoThumbnailFallback(file, resourcePath);
        }
        
        return new Promise((resolve) => {
            const id = `${file.path}-${Date.now()}`;
            availableWorker.busy = true;
            
            const messageHandler = (e) => {
                if (e.data.id === id) {
                    availableWorker.worker.removeEventListener('message', messageHandler);
                    availableWorker.busy = false;
                    
                    if (e.data.thumbnail) {
                        this.thumbnailCache.set(file.path, e.data.thumbnail);
                        resolve(e.data.thumbnail);
                    } else {
                        resolve(this.getVideoThumbnailFallback(file, resourcePath));
                    }
                }
            };
            
            availableWorker.worker.addEventListener('message', messageHandler);
            availableWorker.worker.postMessage({
                id,
                videoPath: resourcePath,
                timestamp: 1
            });
            
            setTimeout(() => {
                availableWorker.worker.removeEventListener('message', messageHandler);
                availableWorker.busy = false;
                resolve(this.getVideoThumbnailFallback(file, resourcePath));
            }, 5000);
        });
    }

    async getVideoThumbnailFallback(file, resourcePath) {
        if (this.thumbnailCache.has(file.path)) {
            return this.thumbnailCache.get(file.path);
        }
        
        return new Promise((resolve) => {
            const video = document.createElement('video');
            const canvas = document.createElement('canvas');
            
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.src = resourcePath;
            video.currentTime = 1;
            
            let loaded = false;
            
            const cleanup = () => {
                if (!loaded) {
                    video.remove();
                    canvas.remove();
                    resolve(null);
                }
            };
            
            setTimeout(cleanup, 3000);
            
            video.onloadeddata = () => {
                loaded = true;
                try {
                    const ctx = canvas.getContext('2d');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    
                    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                    this.thumbnailCache.set(file.path, thumbnail);
                    
                    resolve(thumbnail);
                } catch (error) {
                    resolve(null);
                } finally {
                    video.remove();
                    canvas.remove();
                }
            };
            
            video.onerror = cleanup;
        });
    }

    async createGallery(el, config, ctx) {
        el.empty();
        el.ctx = ctx;
        
        // Очищаем кэш миниатюр при создании новой галереи
        this.thumbnailCache.clear();
        this.pendingRequests.clear();

        const loadingIndicator = el.createEl('div', { 
            cls: 'gallery-loading',
            text: 'Loading gallery...' 
        });
        
        try {
            const controller = new AbortController();
            ctx.containerEl.onNodeRemoved = () => controller.abort();
            
            const allMediaFiles = await this.loadMediaFiles(config.paths, controller.signal);
            
            if (allMediaFiles.length === 0) {
                loadingIndicator.remove();
                el.createEl('div', {
                    text: 'No media files found',
                    cls: 'gallery-empty'
                });
                return;
            }
            
            const sortedFiles = this.sortFiles(allMediaFiles, config.sortOrder);
            loadingIndicator.remove();
            
            await this.renderGallery(el, sortedFiles, config, controller.signal);
            
        } catch (error) {
            if (error.name !== 'AbortError') {
                loadingIndicator.remove();
                el.createEl('div', {
                    text: `Error: ${error.message}`,
                    cls: 'gallery-error'
                });
            }
        }
    }

    async loadMediaFiles(paths, signal) {
        const allMediaFiles = [];
        
        if (paths.length === 1 && paths[0] === './') {
            const rootFolder = this.app.vault.getRoot();
            allMediaFiles.push(...this.getAllMediaFromRoot(rootFolder));
        } else {
            for (const folderPath of paths) {
                if (signal.aborted) break;
                
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folder) continue;
                
                if (folder.children !== undefined) {
                    const mediaFiles = this.getMediaFiles(folder);
                    allMediaFiles.push(...mediaFiles);
                }
            }
        }
        
        return allMediaFiles;
    }

    async renderGallery(el, files, config, signal) {
        const galleryContainer = el.createEl('div', { cls: 'media-gallery-container' });
        galleryContainer.ctx = el.ctx;
        galleryContainer._config = config;

        const infoBar = galleryContainer.createEl('div', { cls: 'gallery-info-bar' });
        const fileCountText = config.displayType === 'compact' ? 
            `${files.length} files found (showing first ${config.limit})` : 
            `${files.length} files found`;
        infoBar.createEl('span', { text: fileCountText });
        
        const grid = galleryContainer.createEl('div', { 
            cls: 'media-gallery-grid',
            attr: { style: `grid-template-columns: repeat(auto-fill, minmax(${config.gridSize}px, 1fr));` }
        });
        
        const filesToDisplay = config.displayType === 'compact' ? 
            files.slice(0, config.limit) : 
            files;
        
        this.createUploadButton(infoBar, config, filesToDisplay, galleryContainer);
        await this.renderBatchItems(grid, filesToDisplay, config, signal, 0);
    }

    async renderBatchItems(container, files, config, signal, startIndex = 0) {
        const batchSize = config.batchSize || 10;
        const endIndex = Math.min(startIndex + batchSize, files.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            if (signal.aborted) return;
            
            const file = files[i];
            const item = container.createEl('div', { cls: 'gallery-item' });
            
            if (config.enableLazyLoad) {
                item.dataset.file = JSON.stringify({
                    name: file.name,
                    path: file.path,
                    index: i,
                    allFiles: files.map(f => ({ name: f.name, path: f.path }))
                });
                item.classList.add('lazy-load');
                
                const placeholder = item.createEl('div', { cls: 'gallery-placeholder' });
                placeholder.createEl('span', { text: this.getFileTypeIcon(file.name) });
                
                this.intersectionObserver.observe(item);
            } else {
                await this.loadMediaElement(item, file, i, files);
            }
        }
        
        if (endIndex < files.length && !signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 0));
            await this.renderBatchItems(container, files, config, signal, endIndex);
        }
    }

    initIntersectionObserver() {
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const item = entry.target;
                    this.loadMediaElement(item).catch(console.error);
                    this.intersectionObserver.unobserve(item);
                }
            });
        }, {
            rootMargin: '100px 0px',
            threshold: 0.1
        });
    }

    async loadMediaElement(element, file = null, index = null, allMediaFiles = null) {
        if (!file && element.dataset.file) {
            const fileData = JSON.parse(element.dataset.file);
            file = this.app.vault.getAbstractFileByPath(fileData.path);
            index = fileData.index;
            
            if (fileData.allFiles) {
                allMediaFiles = fileData.allFiles.map(fileInfo => 
                    this.app.vault.getAbstractFileByPath(fileInfo.path)
                ).filter(Boolean);
            }
        }
        
        if (!file) return;
        
        const requestKey = file.path;
        if (this.pendingRequests.has(requestKey)) {
            return;
        }
        
        this.pendingRequests.set(requestKey, true);
        
        try {
            element.innerHTML = '';
            element.classList.remove('lazy-load');
            
            const resourcePath = this.app.vault.getResourcePath(file);
            
            if (this.isImage(file.name)) {
                await this.loadImageElement(element, file, resourcePath, allMediaFiles, index);
            } else if (this.isVideo(file.name)) {
                await this.loadVideoElement(element, file, resourcePath, allMediaFiles, index);
            } else if (this.isAudio(file.name)) {
                this.loadAudioElement(element, file, allMediaFiles, index);
            }
        } catch (error) {
            console.error('Error loading media element:', error);
            this.showErrorState(element, file.name);
        } finally {
            this.pendingRequests.delete(requestKey);
        }
    }

    async loadImageElement(element, file, resourcePath, allMediaFiles, index) {
        const img = element.createEl('img', {
            attr: {
                src: resourcePath,
                alt: file.name,
                loading: 'lazy'
            }
        });
        
        requestIdleCallback(() => {
            const mediaElement = img; // или container для видео/аудио
            mediaElement.addEventListener('click', () => {
                const galleryContainer = element.closest('.media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    // Этот callback будет вызван после удаления файла
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer);
            });
        });
    }

    async loadVideoElement(element, file, resourcePath, allMediaFiles, index) {
        const container = element.createEl('div', { cls: 'video-thumbnail-container' });
        
        try {
            const thumbnail = await this.getVideoThumbnailWorker(file, resourcePath);
            
            if (thumbnail) {
                const img = container.createEl('img', {
                    attr: {
                        src: thumbnail,
                        alt: file.name,
                        loading: 'lazy'
                    }
                });
            } else {
                const video = container.createEl('video', {
                    attr: {
                        src: resourcePath,
                        muted: true,
                        preload: 'metadata'
                    }
                });
            }
        } catch (error) {
            const video = container.createEl('video', {
                attr: {
                    src: resourcePath,
                    muted: true,
                    preload: 'metadata'
                }
            });
        }
        
        const playIcon = container.createEl('div', { cls: 'video-play-icon' });
        playIcon.innerHTML = '▶';
        
        requestIdleCallback(() => {
            const mediaElement = img; // или container для видео/аудио
            mediaElement.addEventListener('click', () => {
                const galleryContainer = element.closest('.media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    // Этот callback будет вызван после удаления файла
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer);
            });
        });
    }

    loadAudioElement(element, file, allMediaFiles, index) {
        const container = element.createEl('div', { cls: 'audio-thumbnail-container' });
        const icon = container.createEl('div', { cls: 'audio-icon' });
        icon.innerHTML = '🎵';
        
        const fileName = container.createEl('div', { cls: 'audio-filename' });
        fileName.textContent = file.name;
        
        requestIdleCallback(() => {
            const mediaElement = img; // или container для видео/аудио
            mediaElement.addEventListener('click', () => {
                const galleryContainer = element.closest('.media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    // Этот callback будет вызван после удаления файла
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer);
            });
        });
    }

    async refreshCurrentGallery(galleryContainer) {
        if (!galleryContainer) return;
        
        try {
            const parentEl = galleryContainer.parentElement;
            const config = galleryContainer._config;
            const ctx = galleryContainer.ctx;
            
            if (parentEl && config && ctx) {
                // Добавляем индикатор обновления
                galleryContainer.classList.add('gallery-refreshing');
                
                // Сохраняем позицию прокрутки
                const scrollPos = window.scrollY;
                
                // Очищаем и пересоздаем галерею с новыми данными
                parentEl.empty();
                await this.createGallery(parentEl, config, ctx);
                
                // Восстанавливаем позицию прокрутки
                window.scrollTo(0, scrollPos);
                
                // Убираем индикатор
                galleryContainer.classList.remove('gallery-refreshing');
            }
        } catch (error) {
            console.error('Error refreshing gallery:', error);
            if (galleryContainer) {
                galleryContainer.classList.remove('gallery-refreshing');
            }
        }
    }

    showErrorState(element, filename) {
        element.innerHTML = '';
        const errorDiv = element.createEl('div', { cls: 'gallery-error-state' });
        errorDiv.createEl('div', { text: '❌' });
        errorDiv.createEl('div', { 
            text: filename,
            cls: 'gallery-error-filename'
        });
    }

    getAllMediaFromRoot(folder) {
        const mediaFiles = [];
        const traverse = (currentFolder) => {
            if (!currentFolder.children) return;
            
            for (const child of currentFolder.children) {
                if (child.children !== undefined) {
                    traverse(child);
                } else {
                    if (this.isMediaFile(child.name)) {
                        mediaFiles.push(child);
                    }
                }
            }
        };
        
        traverse(folder);
        return mediaFiles;
    }

    getMediaFiles(folder) {
        const mediaFiles = [];
        
        for (const child of folder.children) {
            if (child.children === undefined && this.isMediaFile(child.name)) {
                mediaFiles.push(child);
            }
        }
        
        return mediaFiles;
    }

    isMediaFile(filename) {
        return this.isImage(filename) || this.isVideo(filename) || this.isAudio(filename);
    }

    isImage(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'ico'].includes(ext);
    }

    isVideo(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'm4v', 'mpg', 'mpeg', 'm2v', 'asf'].includes(ext);
    }

    isAudio(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'au'].includes(ext);
    }

    getFileTypeIcon(filename) {
        if (this.isImage(filename)) return '🖼️';
        if (this.isVideo(filename)) return '🎬';
        if (this.isAudio(filename)) return '🎵';
        return '📄';
    }

    sortFiles(files, sortOrder) {
        switch (sortOrder) {
            case 'date-asc':
                return files.sort((a, b) => a.stat.mtime - b.stat.mtime);
            case 'date-desc':
                return files.sort((a, b) => b.stat.mtime - a.stat.mtime);
            case 'random':
                return this.shuffleArray([...files]);
            case 'name-asc':
            default:
                return files.sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    createUploadButton(infoBar, config, files, galleryContainer) {
        const uploadBtn = infoBar.createEl('button', {
            text: '📁 Upload Media',
            cls: 'gallery-upload-btn'
        });
        
        uploadBtn.addEventListener('click', () => {
            this.showUploadForm(config, files, galleryContainer);
        });
    }

    showUploadForm(config, files, galleryContainer) {
        // Создание модального окна для загрузки
        const overlay = document.createElement('div');
        overlay.className = 'upload-form-overlay';
        
        const form = document.createElement('div');
        form.className = 'upload-form';
        
        // Заголовок
        const title = form.createEl('h3');
        title.textContent = 'Upload Media Files';
        
        // Выбор пути
        const pathSection = form.createEl('div');
        pathSection.className = 'upload-path-section';
        pathSection.createEl('label', { text: 'Destination Folder:' });
        
        const pathSelect = pathSection.createEl('select');
        pathSelect.className = 'upload-path-select';
        
        config.paths.forEach(path => {
            const option = pathSelect.createEl('option');
            option.value = path;
            option.textContent = path;
        });
        
        // Область для загрузки
        const dropArea = form.createEl('div');
        dropArea.className = 'upload-drop-area';
        dropArea.innerHTML = `
            <div class="drop-area-content">
                <div class="drop-icon">📁</div>
                <p>Drag and drop files here or click to browse</p>
                <p class="drop-hint">Supports: Images, Videos, Audio</p>
                <p class="drop-hint">Or press Ctrl+V to paste from clipboard</p>
            </div>
        `;
        
        // Кнопки
        const buttonSection = form.createEl('div');
        buttonSection.className = 'upload-button-section';
        
        const cancelBtn = buttonSection.createEl('button', {
            text: 'Cancel',
            cls: 'upload-cancel-btn'
        });
        
        const uploadBtn = buttonSection.createEl('button', {
            text: 'Upload Files',
            cls: 'upload-confirm-btn'
        });
        uploadBtn.disabled = true;
        
        form.appendChild(pathSection);
        form.appendChild(dropArea);
        form.appendChild(buttonSection);
        overlay.appendChild(form);
        document.body.appendChild(overlay);
        
        // Обработчики событий
        this.setupUploadHandlers(form, dropArea, pathSelect, uploadBtn, cancelBtn, overlay, config, galleryContainer);
    }

    setupUploadHandlers(form, dropArea, pathSelect, uploadBtn, cancelBtn, overlay, config, galleryContainer) {
        let selectedFiles = [];
        
        // Обработчик выбора файлов через клик
        dropArea.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.multiple = true;
            fileInput.accept = 'image/*,video/*,audio/*';
            fileInput.addEventListener('change', (e) => {
                const newFiles = Array.from(e.target.files);
                selectedFiles = [...selectedFiles, ...newFiles];
                this.updateDropArea(dropArea, selectedFiles);
                this.updateFileList(form, selectedFiles); // Обновляем список файлов
                uploadBtn.disabled = selectedFiles.length === 0;
            });
            fileInput.click();
        });
        
        // Обработчик drag and drop
        dropArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropArea.classList.add('dragover');
        });
        
        dropArea.addEventListener('dragleave', () => {
            dropArea.classList.remove('dragover');
        });
        
        dropArea.addEventListener('drop', (e) => {
            e.preventDefault();
            dropArea.classList.remove('dragover');
            const newFiles = Array.from(e.dataTransfer.files);
            selectedFiles = [...selectedFiles, ...newFiles];
            this.updateDropArea(dropArea, selectedFiles);
            this.updateFileList(form, selectedFiles); // Обновляем список файлов
            uploadBtn.disabled = selectedFiles.length === 0;
        });
        
        // Обработчик вставки (Ctrl+V)
        const pasteHandler = (e) => {
            if (e.clipboardData && e.clipboardData.files.length > 0) {
                const newFiles = Array.from(e.clipboardData.files);
                selectedFiles = [...selectedFiles, ...newFiles];
                this.updateDropArea(dropArea, selectedFiles);
                this.updateFileList(form, selectedFiles); // Обновляем список файлов
                uploadBtn.disabled = selectedFiles.length === 0;
                e.preventDefault();
            }
        };
        
        document.addEventListener('paste', pasteHandler);
        
        // Кнопка отмены
        cancelBtn.addEventListener('click', () => {
            document.removeEventListener('paste', pasteHandler);
            overlay.remove();
        });
        
        // Кнопка загрузки
        uploadBtn.addEventListener('click', async () => {
            if (selectedFiles.length > 0) {
                await this.handleFileUpload(selectedFiles, pathSelect.value, config, galleryContainer);
                document.removeEventListener('paste', pasteHandler);
                overlay.remove();
            }
        });
        
        // Закрытие по клику вне формы
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.removeEventListener('paste', pasteHandler);
                overlay.remove();
            }
        });

        // Инициализируем список файлов при открытии формы
        this.updateFileList(form, selectedFiles);
    }

    updateDropArea(dropArea, files) {
        dropArea.innerHTML = '';
        
        const content = dropArea.createEl('div');
        content.className = 'drop-area-content';
        
        if (files.length > 0) {
            const icon = content.createEl('div');
            icon.className = 'drop-icon';
            icon.textContent = '✅';
            
            const text = content.createEl('p');
            text.textContent = `${files.length} file(s) selected`;
            
            const hint = content.createEl('p');
            hint.className = 'drop-hint';
            hint.textContent = 'Click to select more files or drag and drop additional files';
            
        } else {
            const icon = content.createEl('div');
            icon.className = 'drop-icon';
            icon.textContent = '📁';
            
            const text = content.createEl('p');
            text.textContent = 'Drag and drop files here or click to browse';
            
            const hint = content.createEl('p');
            hint.className = 'drop-hint';
            hint.textContent = 'Supports: Images, Videos, Audio';
            
            const hint2 = content.createEl('p');
            hint2.className = 'drop-hint';
            hint2.textContent = 'Or press Ctrl+V to paste from clipboard';
        }
        
        if (files.length > 0) {
            dropArea.classList.add('has-files');
            
            // Создаем контейнер для списка файлов ПОД областью загрузки
            const fileListContainer = dropArea.parentElement.querySelector('.upload-file-list-container');
            if (!fileListContainer) {
                const newFileListContainer = document.createElement('div');
                newFileListContainer.className = 'upload-file-list-container';
                dropArea.parentElement.insertBefore(newFileListContainer, dropArea.nextSibling);
            }
            
            this.updateFileList(dropArea.parentElement, files);
        } else {
            dropArea.classList.remove('has-files');
            // Удаляем контейнер списка файлов, если нет файлов
            const fileListContainer = dropArea.parentElement.querySelector('.upload-file-list-container');
            if (fileListContainer) {
                fileListContainer.remove();
            }
        }
    }

    updateFileList(container, files) {
        let fileListContainer = container.querySelector('.upload-file-list-container');
        if (!fileListContainer) {
            fileListContainer = document.createElement('div');
            fileListContainer.className = 'upload-file-list-container';
            const dropArea = container.querySelector('.upload-drop-area');
            container.insertBefore(fileListContainer, dropArea.nextSibling);
        }
        
        fileListContainer.innerHTML = '';
        
        const title = fileListContainer.createEl('div');
        title.className = 'upload-file-list-title';
        title.textContent = 'Selected Files:';
        
        const fileList = fileListContainer.createEl('div');
        fileList.className = 'upload-file-list';
        
        files.forEach((file, index) => {
            const fileItem = fileList.createEl('div');
            fileItem.className = 'upload-file-item';
            
            const fileIcon = fileItem.createEl('span');
            fileIcon.className = 'upload-file-icon';
            fileIcon.textContent = this.getFileTypeIcon(file.name);
            
            const fileName = fileItem.createEl('span');
            fileName.textContent = file.name;
            fileName.className = 'upload-file-name';
            
            const fileSize = fileItem.createEl('span');
            fileSize.className = 'upload-file-size';
            fileSize.textContent = this.formatFileSize(file.size);
            
            const removeBtn = fileItem.createEl('button');
            removeBtn.textContent = '✕';
            removeBtn.className = 'upload-remove-file';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                files.splice(index, 1);
                this.updateDropArea(container.querySelector('.upload-drop-area'), files);
            });
        });
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    async handleFileUpload(files, targetPath, config, galleryContainer) {
        const loadingIndicator = galleryContainer.createEl('div', {
            cls: 'upload-loading',
            text: `Uploading ${files.length} file(s)...`
        });
        
        try {
            for (const file of files) {
                await this.saveFileToVault(file, targetPath);
            }
            
            loadingIndicator.remove();
            
            // Обновляем галерею
            await this.refreshGallery(galleryContainer, config);
            
        } catch (error) {
            loadingIndicator.remove();
            console.error('Upload error:', error);
            // Показать ошибку
        }
    }

    async saveFileToVault(file, targetPath) {
        const arrayBuffer = await file.arrayBuffer();
        const fileName = this.getUniqueFileName(targetPath, file.name);
        const fullPath = `${targetPath}/${fileName}`;
        
        await this.app.vault.createBinary(fullPath, arrayBuffer);
    }

    getUniqueFileName(folderPath, fileName) {
        const fileExtension = fileName.split('.').pop();
        const baseName = fileName.substring(0, fileName.length - fileExtension.length - 1);
        
        let newName = fileName;
        let counter = 1;
        
        // Проверяем существование файла и добавляем суффикс если нужно
        while (this.app.vault.getAbstractFileByPath(`${folderPath}/${newName}`)) {
            newName = `${baseName}_${counter}.${fileExtension}`;
            counter++;
        }
        
        return newName;
    }

    async refreshGallery(container, config) {
        const parentEl = container.parentElement;
        const ctx = parentEl.ctx;
        
        parentEl.empty();
        await this.createGallery(parentEl, config, ctx);
    }

    onunload() {
        const styles = document.getElementById('media-gallery-styles');
        if (styles) styles.remove();
        const lightboxStyles = document.getElementById('media-lightbox-styles');
        if (lightboxStyles) lightboxStyles.remove();
        
        const lightbox = document.getElementById('media-lightbox-overlay');
        if (lightbox) lightbox.remove();
        
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }
        
        this.workerPool.forEach(workerInfo => {
            workerInfo.worker.terminate();
        });
        this.workerPool = [];
        
        this.thumbnailCache.clear();
        this.pendingRequests.clear();
    }
}

function deleteCurrentFile(state) {
    const currentFile = state.mediaFiles[state.currentIndex];
    if (!currentFile) return;
    
    if (confirm(`Are you sure you want to delete "${currentFile.name}"?`)) {
        try {
            // Удаляем файл из хранилища Obsidian
            state.app.vault.delete(currentFile);
            
            // Удаляем файл из списка
            state.mediaFiles.splice(state.currentIndex, 1);
            
            if (state.mediaFiles.length === 0) {
                closeLightbox(state);
                new Notice('File deleted. Gallery is now empty.');
            } else {
                // Переходим к следующему или предыдущему файлу
                state.currentIndex = Math.min(state.currentIndex, state.mediaFiles.length - 1);
                updateMedia(state, state.fileLink, state.fileMeta);
                updateThumbnails(state);
                new Notice('File deleted successfully.');
            }
            
            // ВСЕГДА обновляем родительскую галерею после удаления
            if (state.galleryContainer && state.onFileDeleted) {
                // Добавляем небольшую задержку для гарантии обновления
                setTimeout(() => {
                    state.onFileDeleted();
                }, 100);
            }
            
        } catch (error) {
            console.error('Error deleting file:', error);
            new Notice('Error deleting file: ' + error.message);
        }
    }
}

function updateThumbnails(state) {
    const thumbContainer = document.getElementById('lightbox-thumbnails');
    if (!thumbContainer) return;
    
    thumbContainer.innerHTML = '';
    
    const maxVisibleThumbs = Math.min(state.mediaFiles.length, 20);
    const startThumb = Math.max(0, state.currentIndex - Math.floor(maxVisibleThumbs / 2));
    const endThumb = Math.min(state.mediaFiles.length, startThumb + maxVisibleThumbs);
    
    for (let i = startThumb; i < endThumb; i++) {
        const file = state.mediaFiles[i];
        const thumb = document.createElement('div');
        thumb.className = 'lightbox-thumb';
        thumb.dataset.index = i;
        
        const resourcePath = state.app.vault.getResourcePath(file);
        
        if (isImage(file.name)) {
            const img = document.createElement('img');
            img.src = resourcePath;
            img.alt = file.name;
            thumb.appendChild(img);
        } else if (isVideo(file.name)) {
            const video = document.createElement('video');
            video.src = resourcePath;
            video.muted = true;
            video.currentTime = 1;
            thumb.appendChild(video);
        } else if (isAudio(file.name)) {
            const audioThumb = document.createElement('div');
            audioThumb.className = 'audio-thumb';
            audioThumb.textContent = '🎵';
            thumb.appendChild(audioThumb);
        }
        
        thumb.addEventListener('click', () => {
            state.currentIndex = i;
            state.randomMode = false;
            updateRandomButton(state, state.randomBtn);
            updateMedia(state, state.fileLink, state.fileMeta);
        });
        
        thumbContainer.appendChild(thumb);
    }
}

function openMediaLightbox(app, mediaFiles, startIndex, onFileDeleted, galleryContainer) {
    const existing = document.getElementById('media-lightbox-overlay');
    if (existing) existing.remove();

    const state = {
        currentIndex: startIndex,
        randomMode: false,
        mediaFiles: mediaFiles,
        app: app,
        slideshowInterval: null,
        slideshowActive: false,
        onFileDeleted: onFileDeleted,
        galleryContainer: galleryContainer
    };

    const overlay = document.createElement('div');
    overlay.id = 'media-lightbox-overlay';

    const topBar = document.createElement('div');
    topBar.className = 'lightbox-topbar';

    const leftControls = document.createElement('div');
    leftControls.className = 'lightbox-controls-left';

    const randomBtn = document.createElement('button');
    randomBtn.className = 'lightbox-random-btn';
    randomBtn.textContent = '🎲 Random';
    randomBtn.addEventListener('click', () => toggleRandom(state, randomBtn));

    const slideshowContainer = document.createElement('div');
    slideshowContainer.className = 'lightbox-slideshow-container';

    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.className = 'lightbox-interval-input';
    intervalInput.value = '3';
    intervalInput.min = '1';
    intervalInput.max = '60';
    intervalInput.placeholder = 'sec';

    const slideshowBtn = document.createElement('button');
    slideshowBtn.className = 'lightbox-slideshow-btn';
    slideshowBtn.textContent = '▶ Slideshow';
    slideshowBtn.addEventListener('click', () => toggleSlideshow(state, slideshowBtn, intervalInput));

    slideshowContainer.appendChild(intervalInput);
    slideshowContainer.appendChild(slideshowBtn);

    leftControls.appendChild(randomBtn);
    leftControls.appendChild(slideshowContainer);

    const rightControls = document.createElement('div');
    rightControls.className = 'lightbox-controls-right';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'lightbox-delete-btn';
    deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.addEventListener('click', () => deleteCurrentFile(state));

    const fileInfo = document.createElement('div');
    fileInfo.className = 'lightbox-file-info';
    
    const fileLink = document.createElement('a');
    fileLink.className = 'lightbox-file-link';
    fileLink.textContent = mediaFiles[startIndex].name;
    fileLink.href = '#';
    fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        openFileInExplorer(app, state);
    });

    const fileMeta = document.createElement('div');
    fileMeta.className = 'lightbox-file-meta';
    updateFileMeta(fileMeta, mediaFiles[startIndex]);

    fileInfo.appendChild(fileMeta);
    fileInfo.appendChild(fileLink);
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'lightbox-close-box';
    infoDiv.addEventListener('click', () => closeLightbox(state));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => closeLightbox(state));

    rightControls.appendChild(fileInfo);
    rightControls.appendChild(deleteBtn);
    infoDiv.appendChild(closeBtn);
    rightControls.appendChild(infoDiv);

    topBar.appendChild(leftControls);
    topBar.appendChild(rightControls);

    const mainArea = document.createElement('div');
    mainArea.className = 'lightbox-main';

    const mediaContainer = document.createElement('div');
    mediaContainer.className = 'lightbox-media-container';
    mediaContainer.id = 'lightbox-media-container';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'lightbox-nav lightbox-prev';
    const prevArrow = document.createElement('span');
    prevArrow.textContent = '‹';
    prevBtn.appendChild(prevArrow);
    prevBtn.addEventListener('click', () => navigate(state, -1));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'lightbox-nav lightbox-next';
    const nextArrow = document.createElement('span');
    nextArrow.textContent = '›';
    nextBtn.appendChild(nextArrow);
    nextBtn.addEventListener('click', () => navigate(state, 1));

    mainArea.appendChild(prevBtn);
    mainArea.appendChild(mediaContainer);
    mainArea.appendChild(nextBtn);

    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'lightbox-thumbnails';
    thumbContainer.id = 'lightbox-thumbnails';

    const maxVisibleThumbs = Math.min(mediaFiles.length, 20);
    const startThumb = Math.max(0, startIndex - Math.floor(maxVisibleThumbs / 2));
    const endThumb = Math.min(mediaFiles.length, startThumb + maxVisibleThumbs);

    for (let i = startThumb; i < endThumb; i++) {
        const file = mediaFiles[i];
        const thumb = document.createElement('div');
        thumb.className = 'lightbox-thumb';
        thumb.dataset.index = i;

        const resourcePath = app.vault.getResourcePath(file);

        if (isImage(file.name)) {
            const img = document.createElement('img');
            img.src = resourcePath;
            img.alt = file.name;
            thumb.appendChild(img);
        } else if (isVideo(file.name)) {
            const video = document.createElement('video');
            video.src = resourcePath;
            video.muted = true;
            video.currentTime = 1;
            thumb.appendChild(video);
        } else if (isAudio(file.name)) {
            const audioThumb = document.createElement('div');
            audioThumb.className = 'audio-thumb';
            audioThumb.textContent = '🎵';
            thumb.appendChild(audioThumb);
        }

        thumb.addEventListener('click', () => {
            state.currentIndex = i;
            state.randomMode = false;
            updateRandomButton(state, randomBtn);
            updateMedia(state, fileLink, fileMeta);
        });

        thumbContainer.appendChild(thumb);
    }

    overlay.appendChild(topBar);
    overlay.appendChild(mainArea);
    overlay.appendChild(thumbContainer);
    document.body.appendChild(overlay);

    state.randomBtn = randomBtn;
    state.slideshowBtn = slideshowBtn;
    state.fileLink = fileLink;
    state.fileMeta = fileMeta;
    state.intervalInput = intervalInput;

    updateMedia(state, fileLink, fileMeta);

    const keyHandler = (e) => {
        if (e.key === 'ArrowLeft') navigate(state, -1);
        if (e.key === 'ArrowRight') navigate(state, 1);
        if (e.key === 'Escape') closeLightbox(state);
        if (e.key === ' ') {
            e.preventDefault();
            toggleSlideshow(state, slideshowBtn, intervalInput);
        }
    };

    document.addEventListener('keydown', keyHandler);

    const wheelHandler = (e) => {
        if (document.querySelector('img:hover, video:hover')) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            navigate(state, 1);
        } else if (e.deltaY < 0) {
            navigate(state, -1);
        }
    };

    mainArea.addEventListener('wheel', wheelHandler, { passive: false });

    overlay.dataset.cleanup = 'true';
    overlay.addEventListener('cleanup', () => {
        document.removeEventListener('keydown', keyHandler);
        mainArea.removeEventListener('wheel', wheelHandler);
        if (state.slideshowInterval) {
            clearInterval(state.slideshowInterval);
        }
    });
}

function updateFileMeta(fileMeta, file) {
    const fileSize = (file.stat.size / 1024).toFixed(1) + ' KB';
    const modDate = new Date(file.stat.mtime).toLocaleDateString();
    fileMeta.textContent = `${fileSize} • ${modDate}`;
}

function closeLightbox(state) {
    if (state && state.slideshowInterval) {
        clearInterval(state.slideshowInterval);
    }

    const overlay = document.getElementById('media-lightbox-overlay');
    if (overlay) {
        overlay.dispatchEvent(new Event('cleanup'));
        overlay.remove();
    }
    
    // Принудительно обновляем галерею при закрытии лайтбокса
    // на случай, если были какие-то изменения
    if (state && state.galleryContainer && state.onFileDeleted) {
        setTimeout(() => {
            state.onFileDeleted();
        }, 100);
    }
}

function toggleSlideshow(state, slideshowBtn, intervalInput) {
    if (state.slideshowActive) {
        clearInterval(state.slideshowInterval);
        state.slideshowInterval = null;
        state.slideshowActive = false;
        slideshowBtn.textContent = '▶ Slideshow';
        slideshowBtn.classList.remove('active');
        intervalInput.disabled = false;
    } else {
        const interval = parseInt(intervalInput.value) || 3;
        state.slideshowActive = true;
        slideshowBtn.textContent = '⏸ Stop';
        slideshowBtn.classList.add('active');
        intervalInput.disabled = true;

        state.slideshowInterval = setInterval(() => {
            navigate(state, 1);
        }, interval * 1000);
    }
}

function openFileInExplorer(app, state) {
    const file = state.mediaFiles[state.currentIndex];
    if (file) {
        app.showInFolder(file.path);
    }
}

function toggleRandom(state, randomBtn) {
    state.randomMode = !state.randomMode;
    updateRandomButton(state, randomBtn);
}

function updateRandomButton(state, randomBtn) {
    if (state.randomMode) {
        randomBtn.classList.add('active');
        randomBtn.textContent = '🎲 Random (ON)';
    } else {
        randomBtn.classList.remove('active');
        randomBtn.textContent = '🎲 Random';
    }
}

function getRandomIndex(state) {
    let newIndex;
    do {
        newIndex = Math.floor(Math.random() * state.mediaFiles.length);
    } while (newIndex === state.currentIndex && state.mediaFiles.length > 1);
    return newIndex;
}

function navigate(state, direction) {
    if (state.randomMode) {
        state.currentIndex = getRandomIndex(state);
    } else {
        state.currentIndex = (state.currentIndex + direction + state.mediaFiles.length) % state.mediaFiles.length;
    }

    updateMedia(state, state.fileLink, state.fileMeta);
}

function updateMedia(state, fileLink, fileMeta) {
    const container = document.getElementById('lightbox-media-container');
    if (!container) return;

    container.innerHTML = '';
    const file = state.mediaFiles[state.currentIndex];
    const resourcePath = state.app.vault.getResourcePath(file);

    if (fileLink) {
        fileLink.textContent = file.name;
        updateFileMeta(fileMeta, file);
    }

    if (isImage(file.name)) {
        const img = document.createElement('img');
        img.src = resourcePath;
        img.alt = file.name;

        let zoomLevel = 1;
        let panX = 0;
        let panY = 0;

        const updateTransform = () => {
            img.style.transform = `scale(${zoomLevel}) translate(${panX}px, ${panY}px)`;
            img.style.cursor = zoomLevel > 1 ? 'move' : 'zoom-in';
        };

        img.addEventListener('click', (e) => {
            e.preventDefault();
            zoomLevel = Math.min(zoomLevel + 1, 5);
            updateTransform();
        });

        img.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            zoomLevel = Math.max(1, zoomLevel - 1);
            if (zoomLevel === 1) {
                panX = 0;
                panY = 0;
            }
            updateTransform();
        });

        const wheelHandler = (e) => {
            if (!document.querySelector('img:hover')) return;
            e.preventDefault();
            
            const delta = e.deltaY < 0 ? 0.2 : -0.2;
            const newZoom = Math.max(1, Math.min(5, zoomLevel + delta));
            
            if (newZoom !== zoomLevel) {
                zoomLevel = newZoom;
                if (zoomLevel === 1) {
                    panX = 0;
                    panY = 0;
                }
                updateTransform();
            }
        };

        img.addEventListener('wheel', wheelHandler, { passive: false });

        img.addEventListener('mousemove', (e) => {
            if (zoomLevel > 1) {
                const rect = container.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const displayWidth = img.offsetWidth;
                const displayHeight = img.offsetHeight;

                const scaledWidth = displayWidth * zoomLevel;
                const scaledHeight = displayHeight * zoomLevel;

                const maxPanX = Math.max(0, (scaledWidth - displayWidth) / 2);
                const maxPanY = Math.max(0, (scaledHeight - displayHeight) / 2);

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const normalizedX = (mouseX - centerX) / centerX;
                const normalizedY = (mouseY - centerY) / centerY;

                const dampingFactor = 1 / Math.sqrt(zoomLevel);

                panX = -normalizedX * maxPanX * dampingFactor;
                panY = -normalizedY * maxPanY * dampingFactor;

                updateTransform();
            }
        });

        img.style.transition = 'transform 0.1s ease-out';
        container.appendChild(img);

    } else if (isVideo(file.name)) {
        const video = document.createElement('video');
        video.src = resourcePath;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.style.maxWidth = '100%';
        video.style.maxHeight = '80vh';
        container.appendChild(video);

    } else if (isAudio(file.name)) {
        const audioContainer = document.createElement('div');
        audioContainer.className = 'lightbox-audio-container';
        
        const audioIcon = document.createElement('div');
        audioIcon.className = 'lightbox-audio-icon';
        audioIcon.textContent = '🎵';
        
        const audio = document.createElement('audio');
        audio.src = resourcePath;
        audio.controls = true;
        audio.autoplay = true;
        
        const fileName = document.createElement('div');
        fileName.className = 'lightbox-audio-filename';
        fileName.textContent = file.name;
        
        audioContainer.appendChild(audioIcon);
        audioContainer.appendChild(fileName);
        audioContainer.appendChild(audio);
        container.appendChild(audioContainer);
    }

    const thumbs = document.querySelectorAll('.lightbox-thumb');
    thumbs.forEach((thumb, index) => {
        const thumbIndex = parseInt(thumb.dataset.index);
        if (thumbIndex === state.currentIndex) {
            thumb.classList.add('active');
            thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        } else {
            thumb.classList.remove('active');
        }
    });
}

function isImage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'ico'].includes(ext);
}

function isVideo(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'm4v', 'mpg', 'mpeg', 'm2v', 'asf'].includes(ext);
}

function isAudio(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'au'].includes(ext);
}


// Добавляем стили при загрузке плагина
MediaGalleryPlugin.prototype.loadStyles = function() {
    if (document.getElementById('media-gallery-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'media-gallery-styles';
    style.textContent = require('../styles.css');
    document.head.appendChild(style);
};

module.exports = MediaGalleryPlugin;