import {
    calculateSourceRegion,
    createDefaultLayout,
    getScreenGeometry,
    validateDisplayLayout
} from './geometry.js';
import {
    correctPlaybackDrift,
    expectedPlaybackPosition
} from '../media/playback.js';
import { DEFAULT_AUDIO_SETTINGS, getDeviceAudioState } from '../media/audio.js';
import { resolveParallaxMediaUrl } from '../core/media-url.js';

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
    onPlaybackStatus = () => {},
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
    let cancelPendingFrame = null;
    let playbackStartTimer = null;
    let transitionTimer = null;
    let transitionUpdateId = null;
    let latestRequest = 0;
    let calibrationEnabled = false;
    let calibrationOverlay = null;
    let activeAlignment = { horizontal: 0, vertical: 0, scale: 1 };
    let layout = createDefaultLayout(totalScreens);
    let screenEnabled = true;
    let audioSettings = { ...DEFAULT_AUDIO_SETTINGS };
    let deviceId = null;
    let deviceVolume = 1;
    let deviceAudioEnabled = false;
    let playbackStatus = 'Paused';
    let bufferingState = 'idle';
    let bufferingTimer = null;
    let lastSeekAt = null;
    let lastSuccessfulSynchronization = null;
    let lastDriftCheckAt = 0;
    let recoveryActive = false;
    let lastFallbackFrameAt = 0;
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
        const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
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
        if (canvas.width !== dimensions.width) {
            canvas.width = dimensions.width;
        }
        if (canvas.height !== dimensions.height) {
            canvas.height = dimensions.height;
        }
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
            cancelPendingFrame?.(frameHandle);
            frameHandle = null;
            cancelPendingFrame = null;
        }
        if (playbackStartTimer !== null) {
            cancelTimeout(playbackStartTimer);
            playbackStartTimer = null;
        }
    }

    function scheduleVideoFrame(video, callback) {
        if (typeof video.requestVideoFrameCallback === 'function') {
            frameHandle = video.requestVideoFrameCallback(callback);
            cancelPendingFrame = (handle) => video.cancelVideoFrameCallback?.(handle);
        } else {
            const drawAtVideoRate = (timestamp) => {
                const frameTime = Number.isFinite(timestamp) ? timestamp : now();
                if (frameTime - lastFallbackFrameAt >= 33 || lastFallbackFrameAt === 0) {
                    lastFallbackFrameAt = frameTime;
                    callback();
                    return;
                }
                frameHandle = requestFrame(drawAtVideoRate);
            };
            frameHandle = requestFrame(drawAtVideoRate);
            cancelPendingFrame = cancelFrame;
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
        video.onloadedmetadata = null;
        video.onended = null;
        video.onloadeddata = null;
        video.oncanplay = null;
        video.onplaying = null;
        video.onpause = null;
        video.onwaiting = null;
        video.onstalled = null;
        video.onprogress = null;
        video.ontimeupdate = null;
        video.onerror = null;
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
        if (!video || !timeline || !screenEnabled) {
            return;
        }
        const audio = getDeviceAudioState({
            settings: audioSettings,
            deviceId,
            globalVolume: timeline.volume,
            deviceVolume,
            enabled: deviceAudioEnabled
        });
        video.volume = audio.volume;
        video.muted = audio.muted;
        if (video.readyState < 2) {
            setPlaybackStatus('Buffering');
            return;
        }
        if (timeline.status !== 'playing') {
            stopVideoFrames();
            video.pause();
            if (Math.abs(video.currentTime - timeline.positionSeconds) > 0.1
                && !video.seeking) {
                video.currentTime = timeline.positionSeconds;
                lastSuccessfulSynchronization = now();
            }
            video.playbackRate = 1;
            bufferingState = 'idle';
            setPlaybackStatus(timeline.status === 'paused' ? 'Paused' : 'Stopped');
            paint(video);
            return;
        }
        const serverNow = now() + serverTimeOffset;
        if (serverNow < timeline.startedAt) {
            video.pause();
            if (Math.abs(video.currentTime - timeline.positionSeconds) > 0.1
                && !video.seeking) {
                video.currentTime = timeline.positionSeconds;
                lastSuccessfulSynchronization = now();
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
        applyPlaybackCorrection(video, target, serverNow);
        const playResult = video.play();
        if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(() => {
                setPlaybackStatus('Error');
                onStatus('Video playback could not start', 'error');
            });
        }
        if (frameHandle === null) {
            const drawFrame = () => {
                frameHandle = null;
                cancelPendingFrame = null;
                if (loadedVideo !== video
                    || !screenEnabled
                    || playbackTimeline?.status !== 'playing') {
                    return;
                }
                const clock = now() + serverTimeOffset;
                const expected = expectedPlaybackPosition(playbackTimeline, clock);
                if (clock - lastDriftCheckAt >= 1000) {
                    lastDriftCheckAt = clock;
                    applyPlaybackCorrection(video, expected, clock);
                }
                paint(video);
                scheduleVideoFrame(video, drawFrame);
            };
            scheduleVideoFrame(video, drawFrame);
        }
        setPlaybackStatus(bufferingState === 'buffering' || video.paused
            ? 'Buffering'
            : 'Playing');
        paint(video);
    }

    function setPlaybackStatus(status) {
        if (playbackStatus === status) {
            return;
        }
        playbackStatus = status;
        onPlaybackStatus(status);
    }

    function applyPlaybackCorrection(video, target, serverNow) {
        const result = correctPlaybackDrift(video, target, {
            now: serverNow,
            lastSeekAt
        });
        lastSeekAt = result.lastSeekAt;
        const drift = target - video.currentTime;
        if (result.action !== 'none' || Math.abs(drift) < 0.1) {
            lastSuccessfulSynchronization = now();
        }
        return result;
    }

    function clearBufferingTimer() {
        if (bufferingTimer !== null) {
            cancelTimeout(bufferingTimer);
            bufferingTimer = null;
        }
    }

    function beginBuffering(video) {
        bufferingState = 'buffering';
        setPlaybackStatus('Buffering');
        if (bufferingTimer !== null) {
            return;
        }
        const startingPosition = video.currentTime;
        bufferingTimer = scheduleTimeout(() => {
            bufferingTimer = null;
            if (loadedVideo !== video || playbackTimeline?.status !== 'playing') {
                return;
            }
            if (video.currentTime === startingPosition || video.paused) {
                recoverVideo(video);
            }
        }, 2500);
    }

    function recoverVideo(video) {
        if (recoveryActive || loadedVideo !== video || playbackTimeline?.status !== 'playing') {
            return;
        }
        recoveryActive = true;
        setPlaybackStatus('Recovering');
        const serverNow = now() + serverTimeOffset;
        const target = expectedPlaybackPosition(playbackTimeline, serverNow);
        if (video.readyState >= 2) {
            applyPlaybackCorrection(video, target, serverNow);
            const result = video.play();
            if (result && typeof result.catch === 'function') {
                result.catch(() => {
                    recoveryActive = false;
                    setPlaybackStatus('Error');
                    onStatus('Video recovery could not resume playback', 'error');
                });
            }
        }
        clearBufferingTimer();
        bufferingTimer = scheduleTimeout(() => {
            bufferingTimer = null;
            recoveryActive = false;
            if (loadedVideo === video && bufferingState === 'buffering') {
                setPlaybackStatus('Stalled');
            }
        }, 4000);
    }

    function watchVideo(video) {
        video.onloadedmetadata = () => {
            bufferingState = video.readyState >= 3 ? 'idle' : 'buffering';
        };
        video.oncanplay = () => {
            bufferingState = 'idle';
            if (playbackTimeline?.status === 'playing') {
                synchronizeVideo();
            }
        };
        video.onplaying = () => {
            clearBufferingTimer();
            bufferingState = 'idle';
            recoveryActive = false;
            setPlaybackStatus('Playing');
        };
        video.onpause = () => {
            if (playbackTimeline?.status !== 'playing') {
                setPlaybackStatus(playbackTimeline?.status === 'stopped' ? 'Stopped' : 'Paused');
            } else if (screenEnabled
                && now() + serverTimeOffset >= playbackTimeline.startedAt) {
                beginBuffering(video);
            }
        };
        video.onwaiting = () => beginBuffering(video);
        video.onstalled = () => beginBuffering(video);
        video.onprogress = () => {
            if (video.readyState >= 3) {
                bufferingState = 'idle';
            }
        };
        video.ontimeupdate = () => {
            if (playbackTimeline?.status !== 'playing') {
                return;
            }
            const serverNow = now() + serverTimeOffset;
            const expected = expectedPlaybackPosition(playbackTimeline, serverNow);
            if (serverNow - lastDriftCheckAt >= 1000) {
                lastDriftCheckAt = serverNow;
                applyPlaybackCorrection(video, expected, serverNow);
            }
        };
        video.onerror = () => {
            bufferingState = 'error';
            setPlaybackStatus('Error');
            onStatus('Connection error: Video failed to load', 'error');
        };
    }

    function render(content = currentContent) {
        const sourceUrl = content?.contentType === 'image'
            ? content.imageUrl
            : content?.contentType === 'video' ? content.videoUrl : null;
        if (!content || !['image', 'video'].includes(content.contentType)
            || typeof sourceUrl !== 'string'
            || typeof content.updateId !== 'string'
            || !content.updateId) {
            onStatus('Connection error: Invalid content update', 'error');
            return;
        }
        const mediaUrl = resolveParallaxMediaUrl(sourceUrl);
        if (activeMediaUrl === mediaUrl) {
            currentContent = content;
            redraw();
            if (loadedVideo) {
                synchronizeVideo();
            }
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
            clearBufferingTimer();
            bufferingState = 'idle';
            recoveryActive = false;
            loadedImage = content.contentType === 'image' ? source : null;
            loadedVideo = content.contentType === 'video' ? source : null;
            if (preloadedSource?.source === source) {
                preloadedSource = null;
            }
            activeMediaUrl = mediaUrl;
            currentContent = content;
            if (content.contentType === 'video') {
                source.preload = 'auto';
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
        watchVideo(video);
        video.onloadeddata = () => activateSource(video);
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
        const mediaUrl = resolveParallaxMediaUrl(media.mediaUrl);
        if (mediaUrl === activeMediaUrl
            || (preloadedSource?.mediaUrl === mediaUrl
                && preloadedSource.mediaType === media.mediaType)) {
            return true;
        }
        discardPreloadedSource();
        const source = media.mediaType === 'image' ? createImage() : createVideo();
        const warmed = {
            mediaType: media.mediaType,
            mediaUrl,
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
            source.preload = 'metadata';
            source.muted = true;
            source.playsInline = true;
            source.crossOrigin = 'anonymous';
        }
        source.src = mediaUrl;
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

    render.setAudioSettings = (settings, nextDeviceId, localPreferences = {}) => {
        audioSettings = { ...settings };
        deviceId = nextDeviceId;
        deviceVolume = Number.isFinite(localPreferences.volume)
            ? Math.min(1, Math.max(0, localPreferences.volume))
            : 1;
        deviceAudioEnabled = localPreferences.enabled === true;
        synchronizeVideo();
        return true;
    };

    render.getPlaybackReport = () => {
        if (!loadedVideo || !currentContent?.mediaId) {
            return null;
        }
        const expectedPositionSeconds = playbackTimeline
            ? expectedPlaybackPosition(playbackTimeline, now() + serverTimeOffset)
            : null;
        const driftSeconds = Number.isFinite(expectedPositionSeconds)
            ? expectedPositionSeconds - loadedVideo.currentTime
            : null;
        return {
            mediaId: currentContent.mediaId,
            positionSeconds: loadedVideo.currentTime,
            expectedPositionSeconds,
            driftSeconds,
            status: playbackStatus,
            readyState: loadedVideo.readyState,
            networkState: loadedVideo.networkState,
            bufferingState,
            playbackRate: loadedVideo.playbackRate,
            muted: loadedVideo.muted,
            volume: loadedVideo.volume,
            lastSuccessfulSynchronization
        };
    };

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
            clearBufferingTimer();
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

    render.dispose = () => {
        stopVideoFrames();
        clearBufferingTimer();
        cancelContentTransition();
        releaseVideo(loadedVideo);
        discardPreloadedSource();
        loadedVideo = null;
        loadedImage = null;
        activeMediaUrl = null;
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
