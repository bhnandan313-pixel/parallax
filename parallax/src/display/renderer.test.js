import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentRenderer } from './renderer.js';

class FakeImage {
    style = {};
    parentNode = null;
    onload = null;
    onerror = null;
    src = '';
    id = '';
    alt = '';

    load() {
        this.onload();
    }

    fail() {
        this.onerror();
    }
}

class FakeContainer {
    children = [];

    querySelector(selector) {
        return this.children.find((child) => child.id === selector.slice(1)) ?? null;
    }

    insertBefore(image, reference) {
        const index = this.children.indexOf(reference);
        this.children.splice(index === -1 ? this.children.length : index, 0, image);
        image.parentNode = this;
    }

    replaceChild(image, previousImage) {
        const index = this.children.indexOf(previousImage);
        this.children[index] = image;
        previousImage.parentNode = null;
        image.parentNode = this;
    }
}

function setupRenderer(screen) {
    const container = new FakeContainer();
    const statusPanel = { id: 'status' };
    container.insertBefore(statusPanel, null);
    const images = [];
    const statuses = [];
    const render = createContentRenderer({
        container,
        statusPanel,
        screen,
        onStatus: (...status) => statuses.push(status),
        createImage: () => {
            const image = new FakeImage();
            images.push(image);
            return image;
        }
    });
    return { container, images, render, statuses };
}

test('preloads content, splits each screen correctly, and keeps the old image on failure', () => {
    for (const screen of [1, 2]) {
        const { container, images, render } = setupRenderer(screen);
        render({
            contentType: 'image',
            imageUrl: '/first.jpg',
            updateId: 'first'
        });

        assert.equal(container.querySelector('#panorama'), null);
        images[0].load();
        assert.equal(container.querySelector('#panorama'), images[0]);
        assert.equal(images[0].style.left, screen === 1 ? '0' : '-100%');
        assert.equal(images[0].style.transform, 'translate(0px, 0px) scale(1)');
        assert.equal(images[0].style.transformOrigin, '50% 50%');

        assert.equal(render.setAlignment({
            horizontal: 18,
            vertical: -12,
            scale: 1.04
        }), true);
        assert.equal(
            images[0].style.transform,
            'translate(18px, -12px) scale(1.04)'
        );

        render({
            contentType: 'image',
            imageUrl: '/second.jpg',
            updateId: 'second'
        });
        assert.equal(container.querySelector('#panorama'), images[0]);
        images[1].fail();
        assert.equal(container.querySelector('#panorama'), images[0]);
    }
});

test('rejects invalid alignment settings without changing the displayed transform', () => {
    const { images, render } = setupRenderer(2);
    render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'first' });
    images[0].load();

    assert.equal(render.setAlignment({
        horizontal: 51,
        vertical: 0,
        scale: 1
    }), false);
    assert.equal(images[0].style.transform, 'translate(0px, 0px) scale(1)');
});

test('does not let an older image load replace a newer update', () => {
    const { container, images, render } = setupRenderer(1);
    render({ contentType: 'image', imageUrl: '/slow.jpg', updateId: 'older' });
    render({ contentType: 'image', imageUrl: '/fast.jpg', updateId: 'newer' });

    images[1].load();
    images[0].load();

    assert.equal(container.querySelector('#panorama'), images[1]);
});

test('uses request order even when update IDs are repeated', () => {
    const { container, images, render } = setupRenderer(1);
    render({ contentType: 'image', imageUrl: '/slow.jpg', updateId: 'same-id' });
    render({ contentType: 'image', imageUrl: '/fast.jpg', updateId: 'same-id' });

    images[1].load();
    images[0].load();

    assert.equal(container.querySelector('#panorama'), images[1]);
});
