const { Plugin } = require('obsidian');

class MediaGalleryPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.thumbnailCache = new Map();
        this.intersectionObserver = null;
    }

    async onload() {
        this.processor = this.registerMarkdownCodeBlockProcessor('memories', async (source, el, ctx) => {
            const lines = source.trim().split('\n');
            
            // Parse options
            let paths = [];
            let sortOrder = 'date-desc';
            let enableLazyLoad = true;
            let gridSize = 200;
            let displayType = 'full'; // default to full
            let limit = 3; // default limit for compact mode
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('paths:')) {
                    const pathsStr = line.substring(6).trim();
                    paths = pathsStr.split(',').map(p => p.trim());
                } else if (line.startsWith('sort:')) {
                    sortOrder = line.substring(5).trim();
                } else if (line.startsWith('lazy:')) {
                    enableLazyLoad = line.substring(5).trim() === 'true';
                } else if (line.startsWith('size:')) {
                    gridSize = parseInt(line.substring(5).trim()) || 200;
                } else if (line.startsWith('type:')) {
                    displayType = line.substring(5).trim();
                } else if (line.startsWith('limit:')) {
                    limit = parseInt(line.substring(6).trim()) || 3;
                } else if (line && !line.includes(':')) {
                    paths = [line];
                }
            }
            
            // Default to current folder if no paths specified
            if (paths.length === 0) {
                paths = ['./'];
            }
            
            await this.createGallery(el, paths, sortOrder, ctx, enableLazyLoad, gridSize, displayType, limit);
        });
        
        // Initialize intersection observer for lazy loading
        this.initIntersectionObserver();
    }

    onunload() {
        const styles = document.getElementById('media-gallery-styles');
        if (styles) styles.remove();
        const lightboxStyles = document.getElementById('media-lightbox-styles');
        if (lightboxStyles) lightboxStyles.remove();
        
        // Remove any open lightbox
        const lightbox = document.getElementById('media-lightbox-overlay');
        if (lightbox) lightbox.remove();
        
        // Cleanup intersection observer
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }
        
        // Clear thumbnail cache
        this.thumbnailCache.clear();
    }

    initIntersectionObserver() {
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.loadMediaElement(entry.target);
                    this.intersectionObserver.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: '50px'
        });
    }

    async createGallery(el, paths, sortOrder, ctx, enableLazyLoad, gridSize, displayType, limit) {
        el.empty();
        let allMediaFiles = [];
        
        // Handle "./" to get all folders from root
        if (paths.length === 1 && paths[0] === './') {
            const rootFolder = this.app.vault.getRoot();
            allMediaFiles = this.getAllMediaFromRoot(rootFolder);
        } else {
            // Get media from specified paths
            for (const folderPath of paths) {
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folder) {
                    el.createEl('div', {
                        text: `Folder not found: ${folderPath}`,
                        cls: 'gallery-error'
                    });
                    continue;
                }
                
                if (folder.children !== undefined) {
                    const mediaFiles = this.getMediaFiles(folder);
                    allMediaFiles.push(...mediaFiles);
                }
            }
        }
        
        // Sort files
        allMediaFiles = this.sortFiles(allMediaFiles, sortOrder);
        
        if (allMediaFiles.length === 0) {
            el.createEl('div', {
                text: 'No media files found',
                cls: 'gallery-empty'
            });
            return;
        }
        
        // Create gallery container
        const galleryContainer = el.createEl('div', { cls: 'media-gallery-container' });
        
        // Add info bar
        const infoBar = galleryContainer.createEl('div', { cls: 'gallery-info-bar' });
        const fileCountText = displayType === 'compact' ? 
            `${allMediaFiles.length} files found (showing first ${limit})` : 
            `${allMediaFiles.length} files found`;
        infoBar.createEl('span', { text: fileCountText });
        
        // Create gallery grid
        const grid = galleryContainer.createEl('div', { 
            cls: 'media-gallery-grid',
            attr: { style: `grid-template-columns: repeat(auto-fill, minmax(${gridSize}px, 1fr));` }
        });
        
        // Determine which files to display
        const filesToDisplay = displayType === 'compact' ? 
            allMediaFiles.slice(0, limit) : 
            allMediaFiles;
        
        // Create items with lazy loading support
        filesToDisplay.forEach((file, index) => {
            const item = grid.createEl('div', { cls: 'gallery-item' });
            
            if (enableLazyLoad) {
                item.dataset.file = JSON.stringify({
                    name: file.name,
                    path: file.path,
                    index: index,
                    allFiles: allMediaFiles.map(f => ({ name: f.name, path: f.path }))
                });
                item.classList.add('lazy-load');
                this.intersectionObserver.observe(item);
                
                // Add placeholder
                const placeholder = item.createEl('div', { cls: 'gallery-placeholder' });
                placeholder.createEl('span', { text: this.getFileTypeIcon(file.name) });
            } else {
                this.loadMediaElement(item, file, index, allMediaFiles);
            }
        });
        
        // Add CSS
        this.addStyles();
    }

    async loadMediaElement(element, file = null, index = null, allMediaFiles = null) {
        if (!file && element.dataset.file) {
            const fileData = JSON.parse(element.dataset.file);
            file = this.app.vault.getAbstractFileByPath(fileData.path);
            index = fileData.index;
            // Get all media files for lightbox from dataset if available
            if (fileData.allFiles) {
                allMediaFiles = fileData.allFiles.map(fileInfo => 
                    this.app.vault.getAbstractFileByPath(fileInfo.path)
                ).filter(Boolean);
            } else {
                // Fallback: get all media files from container
                const container = element.closest('.media-gallery-container');
                allMediaFiles = Array.from(container.querySelectorAll('.gallery-item')).map(item => {
                    const data = JSON.parse(item.dataset.file || '{}');
                    return this.app.vault.getAbstractFileByPath(data.path);
                }).filter(Boolean);
            }
        }
        
        if (!file) return;
        
        // Remove placeholder
        element.innerHTML = '';
        element.classList.remove('lazy-load');
        
        const resourcePath = this.app.vault.getResourcePath(file);
        
        if (this.isImage(file.name)) {
            const img = element.createEl('img', {
                attr: {
                    src: resourcePath,
                    alt: file.name,
                    loading: 'lazy'
                }
            });
            
            img.addEventListener('click', () => {
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0);
            });
            
        } else if (this.isVideo(file.name)) {
            const thumbnail = await this.getVideoThumbnail(file, resourcePath);
            
            const container = element.createEl('div', { cls: 'video-thumbnail-container' });
            
            if (thumbnail) {
                const img = container.createEl('img', {
                    attr: {
                        src: thumbnail,
                        alt: file.name
                    }
                });
            } else {
                // Fallback to video element
                const video = container.createEl('video', {
                    attr: {
                        src: resourcePath,
                        muted: true,
                        preload: 'metadata'
                    }
                });
            }
            
            // Add play icon overlay
            const playIcon = container.createEl('div', { cls: 'video-play-icon' });
            playIcon.innerHTML = '▶';
            
            container.addEventListener('click', () => {
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0);
            });
            
        } else if (this.isAudio(file.name)) {
            const container = element.createEl('div', { cls: 'audio-thumbnail-container' });
            const icon = container.createEl('div', { cls: 'audio-icon' });
            icon.innerHTML = '🎵';
            
            const fileName = container.createEl('div', { cls: 'audio-filename' });
            fileName.textContent = file.name;
            
            container.addEventListener('click', () => {
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0);
            });
        }
    }

    async getVideoThumbnail(file, resourcePath) {
        // Check cache first
        if (this.thumbnailCache.has(file.path)) {
            return this.thumbnailCache.get(file.path);
        }
        
        return new Promise((resolve) => {
            const video = document.createElement('video');
            const canvas = document.createElement('canvas');
            
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.src = resourcePath;
            video.currentTime = 1; // Get frame at 1 second
            
            video.onloadeddata = () => {
                const ctx = canvas.getContext('2d');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                
                ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                
                const thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                this.thumbnailCache.set(file.path, thumbnail);
                
                video.remove();
                canvas.remove();
                
                resolve(thumbnail);
            };
            
            video.onerror = () => {
                video.remove();
                canvas.remove();
                resolve(null);
            };
        });
    }

    getAllMediaFromRoot(folder) {
        const mediaFiles = [];
        const traverse = (currentFolder) => {
            if (!currentFolder.children) return;
            
            for (const child of currentFolder.children) {
                if (child.children !== undefined) {
                    // It's a folder, recurse into it
                    traverse(child);
                } else {
                    // It's a file, check if it's media
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

    addStyles() {
        if (document.getElementById('media-gallery-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'media-gallery-styles';
        style.textContent = `
            .media-gallery-container {
                width: 100%;
                padding: 10px;
            }
            
            .gallery-info-bar {
                margin-bottom: 10px;
                padding: 8px 12px;
                background: var(--background-secondary);
                border-radius: 4px;
                color: var(--text-muted);
                font-size: 14px;
            }
            
            .media-gallery-grid {
                display: grid;
                gap: 15px;
            }
            
            .gallery-item {
                aspect-ratio: 1;
                overflow: hidden;
                border-radius: 8px;
                cursor: pointer;
                background: var(--background-secondary);
                transition: transform 0.2s, box-shadow 0.2s;
                position: relative;
            }
            
            .gallery-item:hover {
                transform: scale(1.05);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            
            .gallery-item img,
            .gallery-item video {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            
            .gallery-placeholder {
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: var(--background-modifier-hover);
                color: var(--text-muted);
                font-size: 24px;
            }
            
            .video-thumbnail-container,
            .audio-thumbnail-container {
                width: 100%;
                height: 100%;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .video-play-icon {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 40px;
                height: 40px;
                background: rgba(0, 0, 0, 0.7);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 16px;
                pointer-events: none;
            }
            
            .audio-thumbnail-container {
                flex-direction: column;
                padding: 10px;
                text-align: center;
            }
            
            .audio-icon {
                font-size: 32px;
                margin-bottom: 8px;
            }
            
            .audio-filename {
                font-size: 12px;
                color: var(--text-muted);
                word-break: break-word;
            }
            
            .gallery-error,
            .gallery-empty {
                padding: 20px;
                text-align: center;
                color: var(--text-muted);
            }
        `;
        
        document.head.appendChild(style);
    }
}

// Enhanced lightbox implementation with performance optimizations
function openMediaLightbox(app, mediaFiles, startIndex) {
    // Remove any existing lightbox
    const existing = document.getElementById('media-lightbox-overlay');
    if (existing) existing.remove();

    const state = {
        currentIndex: startIndex,
        randomMode: false,
        mediaFiles: mediaFiles,
        app: app,
        slideshowInterval: null,
        slideshowActive: false
    };

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'media-lightbox-overlay';

    // Top bar with enhanced controls
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

    fileInfo.appendChild(fileLink);
    fileInfo.appendChild(fileMeta);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'lightbox-close-box';
    infoDiv.addEventListener('click', () => closeLightbox(state));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => closeLightbox(state));

    rightControls.appendChild(fileInfo);
    infoDiv.appendChild(closeBtn);
    rightControls.appendChild(infoDiv);

    topBar.appendChild(leftControls);
    topBar.appendChild(rightControls);

    // Main area
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

    // Enhanced thumbnails with virtualization for large galleries
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'lightbox-thumbnails';
    thumbContainer.id = 'lightbox-thumbnails';

    // Only render visible thumbnails for performance
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
            // Use cached thumbnail if available
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

    // Add enhanced styles
    addLightboxStyles();

    // Store references for cleanup
    state.randomBtn = randomBtn;
    state.slideshowBtn = slideshowBtn;
    state.fileLink = fileLink;
    state.fileMeta = fileMeta;
    state.intervalInput = intervalInput;

    // Update initial media
    updateMedia(state, fileLink, fileMeta);

    // Enhanced event listeners
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

    // Store cleanup function
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
}

function toggleSlideshow(state, slideshowBtn, intervalInput) {
    if (state.slideshowActive) {
        // Stop slideshow
        clearInterval(state.slideshowInterval);
        state.slideshowInterval = null;
        state.slideshowActive = false;
        slideshowBtn.textContent = '▶ Slideshow';
        slideshowBtn.classList.remove('active');
        intervalInput.disabled = false;
    } else {
        // Start slideshow
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

        // Enhanced zoom and pan functionality
        let zoomLevel = 1;
        let panX = 0;
        let panY = 0;

        const updateTransform = () => {
            img.style.transform = `scale(${zoomLevel}) translate(${panX}px, ${panY}px)`;
            img.style.cursor = zoomLevel > 1 ? 'move' : 'zoom-in';
        };

        img.addEventListener('click', (e) => {
            e.preventDefault();
            zoomLevel = Math.min(zoomLevel + 1, 5); // Max zoom 5x
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

        // Enhanced wheel zoom
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

        // Enhanced panning
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

    // Update active thumbnail
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

function addLightboxStyles() {
    if (document.getElementById('media-lightbox-styles')) return;

    const style = document.createElement('style');
    style.id = 'media-lightbox-styles';
    style.textContent = `
        #media-lightbox-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: var(--background-primary);
            z-index: 9999;
            display: flex;
            flex-direction: column;
        }

        .lightbox-topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background: var(--background-secondary);
            border-bottom: 1px solid var(--background-modifier-border);
            z-index: 10000;
            gap: 15px;
            min-height: 60px;
        }

        .lightbox-controls-left,
        .lightbox-controls-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .lightbox-file-info {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
        }

        .lightbox-file-meta {
            font-size: 12px;
            color: var(--text-muted);
        }

        .lightbox-slideshow-container {
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .lightbox-interval-input {
            width: 60px;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid var(--background-modifier-border);
            background: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
        }

        .lightbox-interval-input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .lightbox-random-btn,
        .lightbox-slideshow-btn,
        .lightbox-close-btn {
            background: var(--interactive-normal);
            color: var(--text-normal);
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
            white-space: nowrap;
        }

        .lightbox-close-box {
            height: 40px;
            transform: translate(20px, -15px);
            cursor: pointer;
            padding: 14px 14px 0px 0px;
        }

        .lightbox-random-btn:hover,
        .lightbox-slideshow-btn:hover,
        .lightbox-close-btn:hover,
        .lightbox-close-box:hover .lightbox-close-btn {
            background: var(--interactive-hover);
        }

        .lightbox-random-btn.active,
        .lightbox-slideshow-btn.active {
            background: var(--interactive-accent);
            color: white;
        }

        .lightbox-file-link {
            color: var(--text-normal);
            text-decoration: none;
            padding: 8px 16px;
            border-radius: 6px;
            background: var(--interactive-normal);
            transition: background 0.2s;
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .lightbox-file-link:hover {
            background: var(--interactive-hover);
            text-decoration: underline;
        }

        .lightbox-close-btn {
            font-size: 20px;
            width: 40px;
            height: 40px;
            padding: 0;
        }

        .lightbox-main {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            background: var(--background-primary);
            overflow: hidden;
        }

        .lightbox-media-container {
            max-width: 100%;
            max-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .lightbox-media-container img,
        .lightbox-media-container video {
            max-width: 100%;
            max-height: 80vh;
            object-fit: contain;
        }

        .lightbox-media-container img {
            transform-origin: center center;
            user-select: none;
        }

        .lightbox-audio-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
            padding: 40px;
            background: var(--background-secondary);
            border-radius: 12px;
        }

        .lightbox-audio-icon {
            font-size: 64px;
        }

        .lightbox-audio-filename {
            font-size: 18px;
            color: var(--text-normal);
            text-align: center;
            word-break: break-word;
        }

        .lightbox-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(0, 0, 0, 0.5);
            color: white;
            border: none;
            font-size: 48px;
            width: 60px;
            height: 60px;
            cursor: pointer;
            border-radius: 50%;
            transition: background 0.2s;
            z-index: 10;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }

        .lightbox-nav span {
            display: block;
            line-height: 1;
            transform: translateY(-5px);
        }

        .lightbox-nav:hover {
            background: rgba(0, 0, 0, 0.8);
        }

        .lightbox-prev {
            left: 20px;
        }

        .lightbox-next {
            right: 20px;
        }

        .lightbox-thumbnails {
            display: flex;
            gap: 10px;
            padding: 15px;
            overflow-x: auto;
            background: var(--background-secondary);
            max-height: 110px;
            border-top: 1px solid var(--background-modifier-border);
        }

        .lightbox-thumb {
            flex-shrink: 0;
            width: 80px;
            height: 80px;
            cursor: pointer;
            border-radius: 4px;
            overflow: hidden;
            border: 2px solid transparent;
            transition: border-color 0.2s, transform 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .lightbox-thumb:hover {
            transform: scale(1.1);
        }

        .lightbox-thumb.active {
            border-color: var(--interactive-accent);
        }

        .lightbox-thumb img,
        .lightbox-thumb video {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .audio-thumb {
            font-size: 24px;
            color: var(--text-muted);
        }
    `;

    document.head.appendChild(style);
}

module.exports = MediaGalleryPlugin;
