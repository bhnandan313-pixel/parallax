export function createContentRenderer({
    container,
    statusPanel,
    screen,
    onStatus,
    createImage = () => new Image()
}) {
    let activeScreen = screen;
    let displayedImage = container.querySelector('#panorama');
    let latestRequest = 0;

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

            image.style.left = activeScreen === 1 ? '0' : '-100%';
            if (displayedImage?.parentNode === container) {
                container.replaceChild(image, displayedImage);
            } else {
                container.insertBefore(image, statusPanel);
            }
            displayedImage = image;
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
        if (nextScreen !== 1 && nextScreen !== 2) {
            throw new RangeError('Panorama screen must be 1 or 2');
        }
        activeScreen = nextScreen;
        if (displayedImage) {
            displayedImage.alt = `Panorama screen ${activeScreen}`;
            displayedImage.style.left = activeScreen === 1 ? '0' : '-100%';
        }
    };

    return render;
}
