export function createContentRenderer({
    container,
    statusPanel,
    screen,
    onStatus,
    createImage = () => new Image()
}) {
    let activeScreen = screen;
    let totalScreens = 2;
    let displayedImage = container.querySelector('#panorama');
    let latestRequest = 0;
    let calibrationEnabled = false;
    let calibrationOverlay = null;
    let activeAlignment = { horizontal: 0, vertical: 0, scale: 1 };

    function ensureCalibrationOverlay() {
        if (calibrationOverlay) {
            return;
        }

        if (typeof document === 'undefined') {
            return;
        }

        const overlay = document.createElement('div');

        overlay.className = 'calibration-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.hidden = true;
        overlay.append(createCalibrationGrid());

        calibrationOverlay = overlay;
    }

    function createCalibrationGrid() {
        const svgNamespace = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNamespace, 'svg');
        const panoramaWidth = totalScreens * 1000;

        svg.setAttribute('viewBox', `0 0 ${panoramaWidth} 1000`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'calibration-grid');

        for (let x = 0; x <= panoramaWidth; x += 100) {
            const line = document.createElementNS(svgNamespace, 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', '0');
            line.setAttribute('x2', x);
            line.setAttribute('y2', '1000');
            line.setAttribute('class', x > 0 && x < panoramaWidth && x % 1000 === 0
                ? 'calibration-center-line'
                : 'calibration-line');

            svg.append(line);
        }

        for (let y = 0; y <= 1000; y += 100) {
            const line = document.createElementNS(svgNamespace, 'line');
            line.setAttribute('x1', '0');
            line.setAttribute('y1', y);
            line.setAttribute('x2', panoramaWidth);
            line.setAttribute('y2', y);
            line.setAttribute('class', 'calibration-line');

            svg.append(line);
        }

        for (let x = 500; x < panoramaWidth; x += 500) {
            for (let y = 500; y < 1000; y += 500) {
                const label = document.createElementNS(svgNamespace, 'text');
                label.setAttribute('x', x + 6);
                label.setAttribute('y', y - 6);
                label.setAttribute('class', 'calibration-label');
                label.textContent = `${x},${y}`;

                svg.append(label);
            }
        }

        return svg;
    }

    function updateCalibrationPosition() {
        if (!calibrationOverlay) {
            return;
        }

        const offset = (activeScreen - 1) * 100;
        calibrationOverlay.style.left = offset === 0 ? '0' : `-${offset}%`;
        calibrationOverlay.style.width = `${totalScreens * 100}%`;
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

    function applyAlignment(image) {
        image.style.transformOrigin = '50% 50%';
        image.style.transform = `translate(${activeAlignment.horizontal}px, ${activeAlignment.vertical}px) scale(${activeAlignment.scale})`;
    }

    function render(content) {
        if (content?.contentType !== 'image'
            || typeof content.imageUrl !== 'string'
            || typeof content.updateId !== 'string'
            || !content.updateId) {
            onStatus('Connection error: Invalid content update', 'error');
            return;
        }

        const request = ++latestRequest;
        onStatus('Loading panorama');

        const image = createImage();
        image.id = 'panorama';
        image.alt = `Panorama screen ${activeScreen}`;

        image.onload = () => {
            if (latestRequest !== request) {
                return;
            }

            image.style.width = `${totalScreens * 100}%`;
            image.style.left = activeScreen === 1 ? '0' : `${-(activeScreen - 1) * 100}%`;
            applyAlignment(image);

            if (displayedImage?.parentNode === container) {
                container.replaceChild(image, displayedImage);
            } else {
                container.insertBefore(image, statusPanel);
            }

            displayedImage = image;

            ensureCalibrationOverlay();

            if (calibrationOverlay && calibrationOverlay.parentNode !== container) {
                container.append(calibrationOverlay);
            }

            if (calibrationOverlay) {
                calibrationOverlay.hidden = !calibrationEnabled;
            }

            updateCalibrationPosition();

            onStatus(`Display ready - Screen ${activeScreen}`, 'ready');
        };

        image.onerror = () => {
            if (latestRequest === request) {
                onStatus('Connection error: Panorama failed to load', 'error');
            }
        };

        image.src = content.imageUrl;
    }

    render.setScreen = (nextScreen) => {
        if (!Number.isInteger(nextScreen) || nextScreen < 1 || nextScreen > totalScreens) {
            throw new RangeError(`Panorama screen must be between 1 and ${totalScreens}`);
        }

        activeScreen = nextScreen;

        if (displayedImage) {
            displayedImage.alt = `Panorama screen ${activeScreen}`;
            displayedImage.style.left = activeScreen === 1 ? '0' : `${-(activeScreen - 1) * 100}%`;
            displayedImage.style.width = `${totalScreens * 100}%`;
            applyAlignment(displayedImage);
        }

        updateCalibrationPosition();
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
        if (displayedImage) {
            applyAlignment(displayedImage);
        }
        return true;
    };

    render.setCalibration = setCalibration;

    render.setScreenCount = (count) => {
        if (!Number.isInteger(count) || count < 2 || count > 12) {
            throw new RangeError('Panorama screen count must be between 2 and 12');
        }
        if (activeScreen > count) {
            throw new RangeError('Assigned screen is outside the configured screen count');
        }
        totalScreens = count;
        if (displayedImage) {
            displayedImage.style.width = `${totalScreens * 100}%`;
            displayedImage.style.left = activeScreen === 1 ? '0' : `${-(activeScreen - 1) * 100}%`;
        }
        if (calibrationOverlay) {
            calibrationOverlay.replaceChildren(createCalibrationGrid());
        }
        updateCalibrationPosition();
    };

    return render;
}