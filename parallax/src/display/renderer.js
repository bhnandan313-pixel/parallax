import {
    calculateSourceRegion,
    createDefaultLayout,
    getScreenGeometry,
    validateDisplayLayout
} from './geometry.js';
import {
    expectedPlaybackPosition,
    PLAYBACK_DRIFT_THRESHOLD_SECONDS
} from '../media/playback.js';

export function createContentRenderer({
    container,
    statusPanel,
    screen,
    onStatus,
    createImage = () => new Image(),
    createVideo = () => document.createElement('video'),
    createCanvas = () => document.createElement('canvas'),
    requestFrame = (callback) => globalThis.requestAnimationFrame
        ? globalThis.requestAnimationFrame(callback)
        : setTimeout(callback, 16),
    cancelFrame = (handle) => globalThis.cancelAnimationFrame
        ? globalThis.cancelAnimationFrame(handle)
        : clearTimeout(handle),
    scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
    cancelTimeout = (handle) => clearTimeout(handle),
    now = () => Date.now(),
    getViewport = () => ({
        width: container.clientWidth || globalThis.innerWidth || 1000,
        height: container.clientHeight || globalThis.innerHeight || 1000,
        orientation: globalThis.screen?.orientation?.type?.startsWith('portrait')
            ? 'portrait'
            : globalThis.screen?.orientation?.type?.startsWith('landscape')
                ? 'landscape'
                : null
    })
}) {
    let activeScreen = screen;
    let totalScreens = 2;
    let displayedCanvas = null;
    let currentContent = null;
    let loadedImage = null;
    let loadedVideo = null;
    let preloadedSource = null;
    let activeMediaUrl = null;
    let playbackTimeline = null;
    let serverTimeOffset = 0;
    let frameHandle = null;
    let playbackStartTimer = null;
    let transitionTimer = null;
    let transitionUpdateId = null;
    let latestRequest = 0;
    let calibrationEnabled = false;
    let calibrationOverlay = null;
    let activeAlignment = { horizontal: 0, vertical: 0, scale: 1 };
    let layout = createDefaultLayout(totalScreens);
    let screenEnabled = true;
    const canvas = createCanvas();
    canvas.id = 'panorama';
    canvas.setAttribute('aria-label', `Panorama screen ${activeScreen}`);

    function getActiveGeometry() {
        return getScreenGeometry(layout, activeScreen);
    }

    function ensureCalibrationOverlay() {
        if (calibrationOverlay || typeof document === 'undefined') {
            return;
        }
        calibrationOverlay = document.createElement('div');
        calibrationOverlay.className = 'calibration-overlay';
        calibrationOverlay.setAttribute('aria-hidden', 'true');
        calibrationOverlay.hidden = true;
        calibrationOverlay.append(createCalibrationGrid());
    }

    function createCalibrationGrid() {
        const svgNamespace = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNamespace, 'svg');
        const gridWidth = layout.columns * 1000;
        const gridHeight = layout.rows * 1000;
        svg.setAttribute('viewBox', `0 0 ${gridWidth} ${gridHeight}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'calibration-grid');
        const geometry = getActiveGeometry();
        const group = document.createElementNS(svgNamespace, 'g');
        const centerX = geometry.column * 1000 + 500;
        const centerY = geometry.row * 1000 + 500;
        group.setAttribute('transform', `rotate(${geometry.rotation} ${centerX} ${centerY})`);

        for (let x = 0; x <= gridWidth; x += 100) {
            const line = document.createElementNS(svgNamespace, 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', '0');
            line.setAttribute('x2', x);
            line.setAttribute('y2', gridHeight);
            line.setAttribute('class', x > 0 && x < gridWidth && x % 1000 === 0
                ? 'calibration-center-line'
                : 'calibration-line');
            group.append(line);
        }
        for (let y = 0; y <= gridHeight; y += 100) {
            const line = document.createElementNS(svgNamespace, 'line');
            line.setAttribute('x1', '0');
            line.setAttribute('y1', y);
            line.setAttribute('x2', gridWidth);
            line.setAttribute('y2', y);
            line.setAttribute('class', 'calibration-line');
            group.append(line);
        }
        for (let x = 500; x < gridWidth; x += 500) {
            for (let y = 500; y < gridHeight; y += 500) {
                const label = document.createElementNS(svgNamespace, 'text');
                label.setAttribute('x', x + 6);
                label.setAttribute('y', y - 6);
                label.setAttribute('class', 'calibration-label');
                label.textContent = `${x},${y}`;
                group.append(label);
            }
        }
        svg.append(group);
        svg.setAttribute('viewBox', `${geometry.column * 1000} ${geometry.row * 1000} 1000 1000`);
        return svg;
    }

    function updateCalibrationPosition() {
        if (!calibrationOverlay) {
            return;
        }
        calibrationOverlay.style.left = '0';
        calibrationOverlay.style.top = '0';
        calibrationOverlay.style.width = '100%';
        calibrationOverlay.style.height = '100%';
        const grid = calibrationOverlay.querySelector('svg');
        const geometry = getActiveGeometry();
        grid?.setAttribute(
            'viewBox',
            `${geometry.column * 1000} ${geometry.row * 1000} 1000 1000`
        );
        grid?.firstElementChild?.setAttribute(
            'transform',
            `rotate(${geometry.rotation} ${geometry.column * 1000 + 500} ${geometry.row * 1000 + 500})`
        );
    }

    function setCalibration(enabled) {
        calibrationEnabled = Boolean(enabled);
        ensureCalibrationOverlay();
        if (!calibrationOverlay) {
            return;
        }
        calibrationOverlay.hidden = !calibrationEnabled;
        updateCalibrationPosition();
    }

    function getCanvasDimensions() {
        const viewport = getViewport();
        const geometry = getActiveGeometry();
        let orientation = geometry.orientation;
        if (orientation === 'auto') {
            orientation = viewport.orientation
                ?? (viewport.width >= viewport.height ? 'landscape' : 'portrait');
        }
        const landscape = orientation === 'landscape';
        const width = Math.max(1, Math.round(landscape
            ? Math.max(viewport.width, viewport.height)
            : Math.min(viewport.width, viewport.height)));
        const height = Math.max(1, Math.round(landscape
            ? Math.min(viewport.width, viewport.height)
            : Math.max(viewport.width, viewport.height)));
        const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
        return {
            width: Math.round(width * ratio),
            height: Math.round(height * ratio),
            ratio
        };
    }

    function paint(image) {
        if (!screenEnabled) {
            return;
        }
        const dimensions = getCanvasDimensions();
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        const context = canvas.getContext('2d');
        if (!context) {
            onStatus('Connection error: Canvas rendering is unavailable', 'error');
            return;
        }
        const region = calculateSourceRegion(
            layout,
            activeScreen,
            image.naturalWidth || image.videoWidth || image.width,
            image.naturalHeight || image.videoHeight || image.height
        );
        const rotation = region.rotation * Math.PI / 180;
        const rotatedAspect = region.rotation % 180 === 0
            ? region.width / region.height
            : region.height / region.width;
        const canvasAspect = canvas.width / canvas.height;
        const fitWidth = rotatedAspect > canvasAspect
            ? canvas.width
            : canvas.height * rotatedAspect;
        const fitHeight = fitWidth / rotatedAspect;
        const sourceWidth = region.rotation % 180 === 0 ? fitWidth : fitHeight;
        const sourceHeight = region.rotation % 180 === 0 ? fitHeight : fitWidth;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.save();
        context.translate(
            canvas.width / 2 + activeAlignment.horizontal * dimensions.ratio,
            canvas.height / 2 + activeAlignment.vertical * dimensions.ratio
        );
        context.rotate(rotation);
        context.scale(activeAlignment.scale, activeAlignment.scale);
        context.drawImage(
            image,
            region.x,
            region.y,
            region.width,
            region.height,
            -sourceWidth / 2,
            -sourceHeight / 2,
            sourceWidth,
            sourceHeight
        );
        context.restore();
        canvas.setAttribute('aria-label', `Panorama screen ${activeScreen}`);
        ensureCalibrationOverlay();
        if (calibrationOverlay && calibrationOverlay.parentNode !== container) {
            container.append(calibrationOverlay);
        }
        if (calibrationOverlay) {
            calibrationOverlay.hidden = !calibrationEnabled;
        }
        updateCalibrationPosition();
    }

    function redraw() {
        const source = loadedVideo ?? loadedImage;
        if (source && screenEnabled) {
            paint(source);
        }
    }

    function attachCanvas() {
        if (displayedCanvas?.parentNode === container) {
            if (displayedCanvas !== canvas) {
                container.replaceChild(canvas, displayedCanvas);
            }
        } else {
            container.insertBefore(canvas, statusPanel);
        }
        displayedCanvas = canvas;
    }

    function stopVideoFrames() {
        if (frameHandle !== null) {
            cancelFrame(frameHandle);
            frameHandle = null;
        }
        if (playbackStartTimer !== null) {
            cancelTimeout(playbackStartTimer);
            playbackStartTimer = null;
        }
    }

    function cancelContentTransition() {
        if (transitionTimer !== null) {
            cancelTimeout(transitionTimer);
            transitionTimer = null;
        }
    }

    function scheduleContentTransition(content) {
        if (!content?.updateId || content.updateId === transitionUpdateId) {
            return;
        }
        cancelContentTransition();
        const transition = content.transition;
        if (!['fade', 'slide-left', 'slide-right'].includes(transition)
            || typeof canvas.animate !== 'function') {
            transitionUpdateId = content.updateId;
            return;
        }
        const startAt = Number.isFinite(content.transitionAt)
            ? content.transitionAt
            : now() + serverTimeOffset;
        const delay = Math.max(0, startAt - (now() + serverTimeOffset));
        const begin = () => {
            transitionTimer = null;
            if (currentContent?.updateId !== content.updateId || !screenEnabled) {
                return;
            }
            const frames = transition === 'fade'
                ? [{ opacity: 0 }, { opacity: 1 }]
                : transition === 'slide-left'
                    ? [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]
                    : [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }];
            canvas.animate(frames, {
                duration: 450,
                easing: 'ease-out'
            });
            transitionUpdateId = content.updateId;
        };
        if (delay > 0) {
            transitionTimer = scheduleTimeout(begin, delay);
        } else {
            begin();
        }
    }

    function releaseVideo(video) {
        if (!video) {
            return;
        }
        video.pause?.();
        video.removeAttribute?.('src');
        video.load?.();
    }

    function discardPreloadedSource() {
        if (preloadedSource?.mediaType === 'video') {
            releaseVideo(preloadedSource.source);
        }
        preloadedSource = null;
    }

    function takePreloadedSource(mediaType, mediaUrl) {
        if (preloadedSource?.mediaType === mediaType
            && preloadedSource.mediaUrl === mediaUrl) {
            const warmed = preloadedSource;
            preloadedSource = null;
            return warmed;
        }
        discardPreloadedSource();
        return null;
    }

    function synchronizeVideo() {
        const video = loadedVideo;
        const timeline = playbackTimeline;
        if (!video || !timeline || !screenEnabled || video.readyState < 2) {
            return;
        }
        if (timeline.status !== 'playing') {
            stopVideoFrames();
            video.pause();
            if (Math.abs(video.currentTime - timeline.positionSeconds)
                > PLAYBACK_DRIFT_THRESHOLD_SECONDS) {
                video.currentTime = timeline.positionSeconds;
            }
            paint(video);
            return;
        }
        const serverNow = now() + serverTimeOffset;
        if (serverNow < timeline.startedAt) {
            video.pause();
            if (Math.abs(video.currentTime - timeline.positionSeconds)
                > PLAYBACK_DRIFT_THRESHOLD_SECONDS) {
                video.currentTime = timeline.positionSeconds;
            }
            stopVideoFrames();
            playbackStartTimer = scheduleTimeout(
                synchronizeVideo,
                Math.max(0, timeline.startedAt - serverNow)
            );
            paint(video);
            return;
        }
        const target = expectedPlaybackPosition(timeline, serverNow);
        if (Math.abs(video.currentTime - target) > PLAYBACK_DRIFT_THRESHOLD_SECONDS) {
            video.currentTime = target;
        }
        const playResult = video.play();
        if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(() => onStatus('Video playback could not start', 'error'));
        }
        if (frameHandle === null) {
            const drawFrame = () => {
                frameHandle = null;
                if (!loadedVideo || !screenEnabled || playbackTimeline?.status !== 'playing') {
                    return;
                }
                const clock = now() + serverTimeOffset;
                const expected = expectedPlaybackPosition(playbackTimeline, clock);
                if (Math.abs(loadedVideo.currentTime - expected)
                    > PLAYBACK_DRIFT_THRESHOLD_SECONDS) {
                    loadedVideo.currentTime = expected;
                }
                paint(loadedVideo);
                frameHandle = requestFrame(drawFrame);
            };
            frameHandle = requestFrame(drawFrame);
        }
        paint(video);
    }

    function render(content = currentContent) {
        const mediaUrl = content?.contentType === 'image'
            ? content.imageUrl
            : content?.contentType === 'video' ? content.videoUrl : null;
        if (!content || !['image', 'video'].includes(content.contentType)
            || typeof mediaUrl !== 'string'
            || typeof content.updateId !== 'string'
            || !content.updateId) {
            onStatus('Connection error: Invalid content update', 'error');
            return;
        }
        if (content.contentType === 'video' && loadedVideo && activeMediaUrl === mediaUrl) {
            currentContent = content;
            redraw();
            synchronizeVideo();
            scheduleContentTransition(content);
            return;
        }
        const request = ++latestRequest;
        if (!screenEnabled) {
            currentContent = content;
            onStatus(`Screen disabled - Screen ${activeScreen}`);
            return;
        }
        onStatus(content.contentType === 'video' ? 'Loading video panorama' : 'Loading panorama');
        const activateSource = (source) => {
            if (latestRequest !== request) {
                return;
            }
            const oldVideo = loadedVideo;
            stopVideoFrames();
            loadedImage = content.contentType === 'image' ? source : null;
            loadedVideo = content.contentType === 'video' ? source : null;
            if (preloadedSource?.source === source) {
                preloadedSource = null;
            }
            activeMediaUrl = mediaUrl;
            currentContent = content;
            if (content.contentType === 'video') {
                source.onended = () => {
                    paint(source);
                    stopVideoFrames();
                };
            }
            paint(source);
            attachCanvas();
            scheduleContentTransition(content);
            onStatus(`Display ready - Screen ${activeScreen}`, 'ready');
            if (oldVideo && oldVideo !== source) {
                releaseVideo(oldVideo);
            }
            if (content.contentType === 'video') {
                synchronizeVideo();
            }
        };
        const failSource = () => {
            if (latestRequest === request) {
                onStatus(content.contentType === 'video'
                    ? 'Connection error: Video failed to load'
                    : 'Connection error: Panorama failed to load', 'error');
            }
        };
        if (content.contentType === 'image') {
            const warmed = takePreloadedSource(content.contentType, mediaUrl);
            const image = warmed?.source ?? createImage();
            image.onload = () => activateSource(image);
            image.onerror = failSource;
            if (warmed?.loaded || (image.complete && image.naturalWidth > 0)) {
                activateSource(image);
            } else if (!warmed) {
                image.src = mediaUrl;
            }
            return;
        }
        const warmed = takePreloadedSource(content.contentType, mediaUrl);
        const video = warmed?.source ?? createVideo();
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.onloadeddata = () => activateSource(video);
        video.onerror = failSource;
        if (warmed && video.readyState >= 2) {
            activateSource(video);
        } else if (!warmed) {
            video.src = mediaUrl;
            video.load?.();
        }
    }

    render.preload = (media) => {
        if (!media || !['image', 'video'].includes(media.mediaType)
            || typeof media.mediaUrl !== 'string'
            || media.mediaUrl.length > 2048) {
            return false;
        }
        if (media.mediaUrl === activeMediaUrl
            || (preloadedSource?.mediaUrl === media.mediaUrl
                && preloadedSource.mediaType === media.mediaType)) {
            return true;
        }
        discardPreloadedSource();
        const source = media.mediaType === 'image' ? createImage() : createVideo();
        const warmed = {
            mediaType: media.mediaType,
            mediaUrl: media.mediaUrl,
            source,
            loaded: false
        };
        preloadedSource = warmed;
        const markLoaded = () => {
            warmed.loaded = true;
        };
        source.onload = markLoaded;
        source.onloadeddata = markLoaded;
        source.onerror = () => {
            if (preloadedSource === warmed) {
                preloadedSource = null;
            }
        };
        if (media.mediaType === 'video') {
            source.preload = 'auto';
            source.muted = true;
            source.playsInline = true;
            source.crossOrigin = 'anonymous';
        }
        source.src = media.mediaUrl;
        source.load?.();
        return true;
    };

    render.setPlayback = (timeline) => {
        if (!timeline || !['playing', 'paused', 'stopped'].includes(timeline.status)
            || !Number.isFinite(timeline.positionSeconds)
            || !Number.isFinite(timeline.serverNow)
            || (timeline.status === 'playing' && !Number.isFinite(timeline.startedAt))) {
            return false;
        }
        playbackTimeline = { ...timeline };
        serverTimeOffset = timeline.serverNow - now();
        if (currentContent) {
            scheduleContentTransition(currentContent);
        }
        if (loadedVideo && timeline.mediaId === currentContent?.mediaId) {
            synchronizeVideo();
        }
        return true;
    };

    render.getPlaybackReport = () => loadedVideo && currentContent?.mediaId
        ? { mediaId: currentContent.mediaId, positionSeconds: loadedVideo.currentTime }
        : null;

    render.setScreen = (nextScreen) => {
        if (!Number.isInteger(nextScreen) || nextScreen < 1 || nextScreen > totalScreens) {
            throw new RangeError(`Panorama screen must be between 1 and ${totalScreens}`);
        }
        activeScreen = nextScreen;
        if (displayedCanvas) {
            displayedCanvas.setAttribute('aria-label', `Panorama screen ${activeScreen}`);
        }
        updateCalibrationPosition();
        redraw();
    };

    render.setLayout = (nextLayout) => {
        if (!validateDisplayLayout(nextLayout, totalScreens)) {
            throw new TypeError('Invalid display layout');
        }
        layout = nextLayout;
        updateCalibrationPosition();
        redraw();
    };

    render.setScreenEnabled = (enabled) => {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('Screen enabled state must be a boolean');
        }
        screenEnabled = enabled;
        if (!screenEnabled) {
            latestRequest += 1;
            canvas.hidden = true;
            loadedVideo?.pause();
            stopVideoFrames();
            cancelContentTransition();
            discardPreloadedSource();
            if (calibrationOverlay) {
                calibrationOverlay.hidden = true;
            }
            onStatus(`Screen disabled - Screen ${activeScreen}`);
        } else {
            canvas.hidden = false;
            if (loadedImage) {
                redraw();
            } else if (currentContent) {
                render(currentContent);
            }
        }
    };

    render.setAlignment = (settings) => {
        if (!settings
            || !Number.isFinite(settings.horizontal)
            || settings.horizontal < -50
            || settings.horizontal > 50
            || !Number.isFinite(settings.vertical)
            || settings.vertical < -50
            || settings.vertical > 50
            || !Number.isFinite(settings.scale)
            || settings.scale < 0.95
            || settings.scale > 1.05) {
            return false;
        }
        activeAlignment = {
            horizontal: settings.horizontal,
            vertical: settings.vertical,
            scale: settings.scale
        };
        redraw();
        return true;
    };

    render.setCalibration = setCalibration;
    render.refresh = redraw;
    render.setScreenCount = (count) => {
        if (!Number.isInteger(count) || count < 2 || count > 12) {
            throw new RangeError('Panorama screen count must be between 2 and 12');
        }
        if (activeScreen > count) {
            throw new RangeError('Assigned screen is outside the configured screen count');
        }
        if (totalScreens !== count) {
            totalScreens = count;
            layout = createDefaultLayout(count);
        }
        if (calibrationOverlay) {
            calibrationOverlay.replaceChildren(createCalibrationGrid());
        }
        updateCalibrationPosition();
        redraw();
    };

    return render;
}
